"""Finish a shard's takes: raw TTS/VC output -> 16 kHz FLAC the judge and the trainer read.

    python post.py <jobs.jsonl> <shard dir>        writes <shard dir>/audio/<id>.flac and takes.jsonl

Per take: mono, 16 kHz, silence trimmed (40 dB) with short pads, peak normalized to 0.7. (Only the dry run's
`say` is tempo-fitted to the target length.) Takes shorter than 0.5 s or longer than 29 s are
dropped (Whisper's window is 30 s).
"""
import json
import os
import sys

import librosa
import numpy as np
import soundfile as sf

import config
from pace import speech_seconds
from tempo import tempo

jobs_path, shard = sys.argv[1], sys.argv[2]
gen = json.load(open(os.path.join(os.path.dirname(os.path.dirname(jobs_path)), "cfg.json")))["gen"]
# Only the Mac dry run's `say` is fitted to the target length; post-hoc tempo was dropped for real engines
# (the variability study: model duration sounds natural, WSOLA doesn't add anything the judge keeps).
FIT = {"say"}
os.makedirs(f"{shard}/audio", exist_ok=True)
rows = []
for j in map(json.loads, open(jobs_path, encoding="utf-8")):
    raw = f"{shard}/raw/{j['id']}.wav"
    if not os.path.exists(raw):
        continue
    a, sr = sf.read(raw, dtype="float32", always_2d=True)
    a = librosa.resample(a.mean(1), orig_sr=sr, target_sr=16000) if sr != 16000 else a.mean(1)
    a, _ = librosa.effects.trim(a, top_db=40)
    if len(a) < 8000:
        continue
    e = config.base_engine(j["engine"])
    tts_engine = config.vc_tts(gen, j["lang"]) if e == "vc" else e
    if tts_engine in FIT:
        rate = speech_seconds(a, 16000) / j["target_s"]
        if abs(rate - 1) > 0.08:
            a = tempo(a, float(np.clip(rate, 0.7, 1.4)), 16000)
    a = np.pad(a, (1600, 3200))
    a = (a / (np.abs(a).max() or 1) * 0.7).astype(np.float32)
    dur = len(a) / 16000
    if dur > 29 or dur < 0.5:
        continue
    path = f"{shard}/audio/{j['id']}.flac"
    sf.write(path, a, 16000)
    rows.append(dict(id=j["id"], sid=j["sid"], lang=j["lang"], engine=j["engine"], text=j["label"], tts_text=j["tts_text"],
                     clean_tts=j.get("clean_tts", j["tts_text"]), edits=j.get("edits", []), effects=[e["kind"] for e in j.get("effects", [])],
                     denoise=j.get("denoise", True), ref_id=j["ref_id"],
                     pace=j["pace"], target_s=j["target_s"], dur=round(dur, 2),
                     speech_s=round(speech_seconds(a, 16000), 2), file=f"audio/{j['id']}.flac"))
with open(f"{shard}/takes.jsonl", "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(f"post: {len(rows)} takes in {shard}", flush=True)
