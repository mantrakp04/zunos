"""Plan the synthetic speech: voice references, sentences, pace, and one job per (sentence, path).

    python make_jobs.py <work>        reads <work>/data/{manifest.json, real.jsonl, cfg.json, ref_text.json}

Writes:
  data/refs/<clip>.wav            24 kHz loudness-normalized references (train clips only, 3-10 s)
  data/pace.json                  the user's letters/second per language (train clips)
  data/shards.json                [{lang, engine, key, jobs, n}] one shard per language and generation path
  data/jobs/<key>.jsonl           the shard's jobs

A shard's key (config.digest) covers everything that determines its audio, so cache.py can hand back a shard
made by an earlier run. References rotate: sentence i of a language uses reference (i + offset) mod n, with a
per-path offset, so every reference voices a slice of the corpus and the paths don't pair the same ones.
"""
import hashlib
import json
import os
import random
import re
import subprocess
import sys

import config
import corpus
import pace
import variability
from data import read_jsonl, speaker_clips

GEN_VERSION = 4  # bump when generation or post-processing changes what a shard sounds like

work = sys.argv[1]
D = f"{work}/data"
os.makedirs(f"{D}/refs", exist_ok=True)
os.makedirs(f"{D}/jobs", exist_ok=True)
manifest = json.load(open(f"{D}/manifest.json", encoding="utf-8"))
cfg = json.load(open(f"{D}/cfg.json", encoding="utf-8"))
gen = cfg["gen"]
real = read_jsonl(f"{D}/real.jsonl")
ref_text = json.load(open(f"{D}/ref_text.json", encoding="utf-8")) if os.path.exists(f"{D}/ref_text.json") else {}
langs = manifest["langs"]
TEST = {c["id"] for c in real if c["split"] == "test"}
guard = corpus.TestGuard(real)
# Everything taken from the user's audio comes from these clips only (gen.real_minutes / the variants' real_minutes).
SPK_MIN = config.speaker_minutes(cfg)
spk = speaker_clips(real, SPK_MIN)
SCRIPT = {lang: config.label_script(cfg, lang) for lang in langs}


def label_text(c):
    """The clip's text in the script synthetic labels use (pace is measured on the label script)."""
    return (c.get("native_text") or c["text"]) if SCRIPT.get(c["lang"]) == "native" else c["text"]


def src48(cid):
    p = f"{D}/real/48k/{cid}.wav"
    return p if os.path.exists(p) else f"{D}/real/16k/{cid}.wav"


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()[:16]


rates = pace.measure([dict(c, text=label_text(c)) for c in spk], lambda c: c["path"])
json.dump(rates, open(f"{D}/pace.json", "w"), indent=1)


def pick_refs(lang):
    r = gen["refs"]
    pool = [c for c in spk if c["lang"] == lang and r["min_s"] <= c["seconds"] <= r["max_s"]]
    pool.sort(key=lambda c: hashlib.sha256(c["id"].encode()).hexdigest())  # spread over sessions, stable
    return [c["id"] for c in pool[: r["per_lang"]]]


REFS = {}
for lang in langs:
    src_lang = gen["refs"].get("from", {}).get(lang, lang)
    own = pick_refs(src_lang if src_lang in langs else lang)
    if len(own) < 3 and gen["refs"]["borrow"]:
        # Few clips of this language: the voice matters more than the language of the reference.
        own += [x for l in langs if l != lang for x in pick_refs(l)][: gen["refs"]["per_lang"] - len(own)]
    REFS[lang] = own
REFS_BY_SOURCE = {l: pick_refs(l) for l in langs}
ALL_REFS = set(sum(REFS.values(), [])) | set(sum(REFS_BY_SOURCE.values(), []))
assert not (ALL_REFS & TEST), "a test clip was picked as a voice reference"
assert all(next(c for c in real if c["id"] == x)["split"] == "train" for x in ALL_REFS), "refs must be train clips"
assert ALL_REFS <= {c["id"] for c in spk}, "a voice reference outside the speaker subset (gen.real_minutes)"

for rid in sorted(ALL_REFS):
    out = f"{D}/refs/{rid}.wav"
    if not os.path.exists(out):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src48(rid), "-af",
                        "highpass=f=70,loudnorm=I=-20:TP=-2:LRA=11", "-ar", "24000", "-ac", "1", out], check=True)
REF_SHA = {rid: sha(src48(rid)) for rid in ALL_REFS}


def engine_params(engine, lang):
    engine = config.base_engine(engine)
    if engine == "vc":
        tts = config.vc_tts(gen, lang)
        return {"vc": dict(gen["vc"], tts=tts, voices=gen["vc"]["voices"].get(lang)), "tts": tts, "tts_params": gen.get(tts, {})}
    return gen.get(engine, {})


safe = lambda s: re.sub(r"[^A-Za-z0-9_-]", "_", s)
shards, summary = [], {}
for lang in langs:
    engines = config.engines_for(gen, lang)
    sents, info = corpus.sentences(lang, manifest, gen, guard, SCRIPT[lang])
    own = [c for c in spk if c["lang"] == lang]
    summary[lang] = dict(info, sentences=len(sents), refs=len(REFS[lang]), engines=engines, pace=rates.get(lang),
                         speaker_minutes=SPK_MIN, speaker_clips=len(own), speaker_audio_min=round(sum(c["seconds"] for c in own) / 60, 1))
    if not engines or not sents or not REFS[lang]:
        print(f"{lang}: no synthetic speech ({'no path' if not engines else 'no sentences' if not sents else 'no references'})", flush=True)
        continue
    cps = rates.get(lang, {}).get("cps") or pace.FALLBACK_CPS
    for e_i, engine in enumerate(engines):
        # "omnivoice@hi": this path clones from the user's Hindi references instead of this language's.
        ref_lang = engine.split("@", 1)[1] if "@" in engine else None
        refs = REFS_BY_SOURCE[ref_lang] if ref_lang in REFS_BY_SOURCE else REFS[lang]
        key = config.digest(GEN_VERSION, lang, engine, engine_params(engine, lang), sents,
                            [(r, REF_SHA[r], ref_text.get(r, "")) for r in refs], gen["pace"], round(cps, 1),
                            gen["takes"], gen["variability"])
        rng = random.Random(key)
        jobs = []
        offset = rng.randrange(len(refs)) + e_i * 7
        for i, (sid, label, tts) in enumerate(sents):
            for t in range(gen["takes"]):
                ref = refs[(i + offset + t * 3) % len(refs)]
                f = pace.factor(rng, gen["pace"], lang)
                seed = rng.randrange(2 ** 31)
                # The take's style: text edits (TTS input only) and, for OmniVoice, inpainting effects. The label
                # stays the clean sentence; the duration follows the edited text's length at the same pace.
                v = variability.plan(random.Random(seed), lang, tts, gen["variability"])
                scale = pace.letters(v["tts_text"]) / max(1, pace.letters(tts))
                job = dict(id=safe(f"{lang}-{engine}-{sid}-{t}"), sid=sid, lang=lang, engine=engine, label=label,
                           tts_text=v["tts_text"], clean_tts=tts, edits=v["edits"], effects=v["effects"],
                           denoise=v["denoise"], ref=f"{D}/refs/{ref}.wav", ref_id=ref, ref_text=ref_text.get(ref, ""),
                           pace=f, target_s=round(pace.target_seconds(label, cps, f) * scale, 2), seed=seed)
                if config.base_engine(engine) == "vc":
                    voices = gen["vc"]["voices"].get(lang) or []
                    job["tts_voice"] = voices[i % len(voices)] if voices else None  # {audio, text} | {instruct} | None
                jobs.append(job)
        path = f"{D}/jobs/{key}.jsonl"
        with open(path, "w", encoding="utf-8") as f:
            for j in jobs:
                f.write(json.dumps(j, ensure_ascii=False) + "\n")
        shards.append(dict(lang=lang, engine=engine, key=key, jobs=path, n=len(jobs)))

json.dump(shards, open(f"{D}/shards.json", "w"), indent=1)
json.dump(summary, open(f"{D}/gen_summary.json", "w"), indent=1, ensure_ascii=False)
for lang, s in summary.items():
    print(lang, json.dumps(s, ensure_ascii=False), flush=True)
