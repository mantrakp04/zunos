"""Dry-run generator (macOS only): the system `say` voice reads the sentence. Exercises the pipeline on the
Mac without a GPU; never used on a pod.

    python gen_say.py <jobs.jsonl> <shard dir> <worker> <workers>

Rate follows the job's pace (words/minute from the target duration). TTS+VC jobs go to tts/, others raw/.
"""
import json
import os
import subprocess
import sys

jobs_path, out, worker, workers = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
VOICES = {"en": "Samantha", "hi": "Lekha"}
for sub in ("raw", "tts"):
    os.makedirs(f"{out}/{sub}", exist_ok=True)
for j in [json.loads(l) for l in open(jobs_path, encoding="utf-8")][worker::workers]:
    p = f"{out}/{'tts' if j['engine'].split('@')[0] == 'vc' else 'raw'}/{j['id']}.wav"
    if os.path.exists(p):
        continue
    wpm = max(90, min(320, int(len(j["tts_text"].split()) / j["target_s"] * 60)))
    cmd = ["say", "-r", str(wpm), "-o", p + ".tmp.wav", "--data-format=LEI16@22050", j["tts_text"]]
    if j["lang"] in VOICES:
        cmd[1:1] = ["-v", VOICES[j["lang"]]]
    subprocess.run(cmd, check=True)
    os.replace(p + ".tmp.wav", p)
print("say DONE", flush=True)
