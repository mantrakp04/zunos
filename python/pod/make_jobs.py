"""Build the voice-cloning job list from the dataset the app uploaded.

Reads /workspace/data/manifest.json (written by run.py from the app's dataset):
  clips:   [{id, lang, split, text, native_text, seconds}]   audio in real/final/{16k,48k}/<id>.wav
  prompts: [{id, lang, roman, native}]                        dictation sentences to synthesize
  ref_text: {clip_id: native-script text}                     filled in by ref_text.py when missing

Writes refs/<clip>.wav (24 kHz, loudness-normalized), jobs.jsonl and real.jsonl. Test clips are never
used as voice references and never trained on.
"""
import json
import os
import random
import subprocess
from collections import Counter

random.seed(7)
W = os.environ.get("ZUNOS_DATA", "/workspace/data")
REAL = f"{W}/real/final"
os.makedirs(f"{W}/refs", exist_ok=True)

manifest = json.load(open(f"{W}/manifest.json", encoding="utf-8"))
cfg = manifest.get("cfg", {})
clips = manifest["clips"]
TEST = {c["id"] for c in clips if c["split"] == "test"}
ref_text = manifest.get("ref_text", {})


def pick_refs(lang, n):
    """The n train clips of a language closest to 12 s (TTS references work best around 6-15 s)."""
    pool = [c for c in clips if c["lang"] == lang and c["split"] == "train" and c["id"] in ref_text]
    pool.sort(key=lambda c: abs(c["seconds"] - 12))
    return [c["id"] for c in pool[:n]]


langs = manifest["langs"]
# Which voice-cloning model can read which language. Languages neither covers are trained on the
# user's real recordings only.
F5_LANGS = {"as", "bn", "gu", "hi", "kn", "ml", "mr", "or", "pa", "ta", "te"}  # IndicF5
CB_LANGS = {"ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no", "pl",
            "pt", "ru", "sv", "sw", "tr", "zh"}  # Chatterbox multilingual
TAKES = 5  # synthetic takes per sentence (English: 3 Chatterbox + 1 multilingual, as in v3a)


def refs_for(lang, n):
    """Own references first; borrow the user's other languages when short (the voice is what matters)."""
    own = pick_refs(lang, n)
    others = [r for l in langs if l != lang for r in pick_refs(l, n)]
    return (own + [r for r in others if r not in own])[:n]


def plan(lang):
    """[(engine, takes)] for a language."""
    if lang == "en":
        return [("cb_en", 3), ("cb_mtl", 1)]
    f5, cb = lang in F5_LANGS, lang in CB_LANGS
    if f5 and cb:
        return [("f5", 3), ("cb_mtl", TAKES - 3)]
    if f5:
        return [("f5", TAKES)]
    if cb:
        return [("cb_mtl", TAKES)]
    return []


PLANS = {l: plan(l) for l in langs}
REFS = {(l, e): refs_for(l, n) for l, p in PLANS.items() for e, n in p}
assert not (set(sum(REFS.values(), [])) & TEST), "a test clip was picked as a voice reference"
for (l, e), v in REFS.items():
    if not v:
        print(f"warning: no reference clips for {e} {l}", flush=True)
for l, p in PLANS.items():
    if not p:
        print(f"{l}: no voice-cloning model reads it; training on real recordings only", flush=True)

for rid in set(sum(REFS.values(), [])):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{REAL}/48k/{rid}.wav", "-af",
                    "highpass=f=70,afftdn=nf=-28,loudnorm=I=-20:TP=-2:LRA=11", "-ar", "24000", "-ac", "1",
                    f"{W}/refs/{rid}.wav"], check=True)

# (target the model learns to write, text the TTS reads). Romanized prompts carry native script for the
# TTS; others are read as written.
prompts = {l: [(p["roman"], p["native"] or p["roman"]) for p in manifest["prompts"] if p["lang"] == l] for l in langs}
limit = int(cfg.get("sentences_per_lang", 0)) or None
for l in prompts:
    prompts[l] = prompts[l][:limit]

jobs = []


def add(engine, lang, i, k, target, gen_text, ref, **params):
    jobs.append(dict(id=f"{lang}-{i:03d}-{engine}-{k}", engine=engine, lang=lang, target=target, gen_text=gen_text,
                     ref=f"{W}/refs/{ref}.wav", ref_text=ref_text.get(ref, ""), **params))


def cb_params():
    return dict(exaggeration=round(random.uniform(0.25, 0.95), 2), cfg_weight=round(random.uniform(0.2, 0.7), 2),
                temperature=round(random.uniform(0.7, 1.0), 2))


for lang, steps in PLANS.items():
    for i, (target, gen_text) in enumerate(prompts[lang]):
        k = 0
        for engine, takes in steps:
            refs = REFS[(lang, engine)]
            # IndicF5 reads native script only; skip prompts that only exist in English letters.
            if not refs or (engine == "f5" and gen_text == target and lang != "en"):
                k += takes
                continue
            for t in range(takes):
                ref = refs[(i + t) % len(refs)] if engine != "f5" else refs[t % len(refs)]
                if engine == "f5":
                    add("f5", lang, i, k, target, gen_text, ref, speed=round(random.uniform(0.8, 1.2), 2))
                elif engine == "cb_en":
                    add("cb_en", lang, i, k, target, gen_text, ref, **cb_params())
                else:
                    add("cb_mtl", lang, i, k, target, gen_text, ref, language_id=lang, **cb_params())
                k += 1

random.shuffle(jobs)
with open(f"{W}/jobs.jsonl", "w", encoding="utf-8") as f:
    for j in jobs:
        f.write(json.dumps(j, ensure_ascii=False) + "\n")
with open(f"{W}/real.jsonl", "w", encoding="utf-8") as f:
    for c in clips:
        f.write(json.dumps(dict(id=c["id"], lang=c["lang"], kind=c.get("kind", "para"), seconds=c["seconds"],
                                text=c["text"], split=c["split"]), ensure_ascii=False) + "\n")
print(Counter(j["engine"] + ":" + j["lang"] for j in jobs), len(jobs), flush=True)
print(Counter(c["split"] + ":" + c["lang"] for c in clips), flush=True)
