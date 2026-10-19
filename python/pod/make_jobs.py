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
REFS = {
    "cb_en": pick_refs("en", 4) if "en" in langs else [],
    "cb_hi": pick_refs("hi", 3) if "hi" in langs else [],
    "f5_hi": pick_refs("hi", 3) if "hi" in langs else [],
    # Gujarati: own refs first; with fewer than 3, borrow Hindi refs (the voice is what matters).
    "f5_gu": (pick_refs("gu", 5) + pick_refs("hi", 2))[:5] if "gu" in langs else [],
}
assert not (set(sum(REFS.values(), [])) & TEST), "a test clip was picked as a voice reference"
for k, v in REFS.items():
    if not v and any(k.endswith(l) or (k == "f5_gu" and l == "gu") for l in langs):
        print(f"warning: no reference clips for {k}", flush=True)

for rid in set(sum(REFS.values(), [])):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{REAL}/48k/{rid}.wav", "-af",
                    "highpass=f=70,afftdn=nf=-28,loudnorm=I=-20:TP=-2:LRA=11", "-ar", "24000", "-ac", "1",
                    f"{W}/refs/{rid}.wav"], check=True)

prompts = {l: [(p["roman"], p["native"] or p["roman"]) for p in manifest["prompts"] if p["lang"] == l and (l == "en" or p["native"])]
           for l in ("en", "hi", "gu")}
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


def cycle(refs, i):
    return refs[i % len(refs)]


if REFS["cb_en"]:
    for i, (t, g) in enumerate(prompts["en"]):
        for k in range(3):
            add("cb_en", "en", i, k, t, g, cycle(REFS["cb_en"], i + k), **cb_params())
        add("cb_mtl", "en", i, 3, t, g, cycle(REFS["cb_en"], i + 3), language_id="en", **cb_params())
for i, (t, g) in enumerate(prompts["hi"]):
    for k, ref in enumerate(REFS["f5_hi"]):
        add("f5", "hi", i, k, t, g, ref, speed=round(random.uniform(0.8, 1.2), 2))
    for k in range(2 if REFS["cb_hi"] else 0):
        add("cb_mtl", "hi", i, 3 + k, t, g, cycle(REFS["cb_hi"], i + k), language_id="hi", **cb_params())
for i, (t, g) in enumerate(prompts["gu"]):
    for k, ref in enumerate(REFS["f5_gu"]):
        add("f5", "gu", i, k, t, g, ref, speed=round(random.uniform(0.8, 1.2), 2))

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
