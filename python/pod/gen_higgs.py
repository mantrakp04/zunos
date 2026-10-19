"""Higgs TTS 3 (bosonai/higgs-tts-3-4b) client: zero-shot cloning through an SGLang-Omni server.

    python gen_higgs.py <jobs.jsonl> <shard dir> <base url> [concurrency]

run.py starts the server (`sgl-omni serve`, its own env, CUDA >= 13 host) and waits for it. Each job posts
/v1/audio/speech with the rotating user reference and its transcript. Higgs has no duration control, only
coarse pace tokens, so the nearest token is prepended and post.py fits the take to the job's target length
with pitch-preserving tempo. The request's `speed` field is never used: the server resamples for it, which
shifts pitch. Output: <shard dir>/raw/<id>.wav (or tts/<id>.wav for TTS+VC jobs), 24 kHz.
"""
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

jobs_path, out, base = sys.argv[1], sys.argv[2], sys.argv[3].rstrip("/")
conc = int(sys.argv[4]) if len(sys.argv) > 4 else 12
jobs = [json.loads(l) for l in open(jobs_path, encoding="utf-8")]
os.makedirs(f"{out}/raw", exist_ok=True)
os.makedirs(f"{out}/tts", exist_ok=True)

# Pace multipliers of the model's prosody tokens (model card): token -> approximate speed factor.
PACE = [(0.65, "<|prosody:speed_very_slow|>"), (0.85, "<|prosody:speed_slow|>"), (1.0, ""),
        (1.2, "<|prosody:speed_fast|>"), (1.4, "<|prosody:speed_very_fast|>")]


def pace_token(f):
    return min(PACE, key=lambda p: abs(p[0] - f))[1]


def dest(j):
    return f"{out}/{'tts' if j['engine'].split('@')[0] == 'vc' else 'raw'}/{j['id']}.wav"


def one(j):
    p = dest(j)
    if os.path.exists(p):
        return True
    if j["engine"].split("@")[0] == "vc":
        v = j.get("tts_voice") or {}
        refs = [{"audio_path": v["audio"], "text": v.get("text", "")}] if v.get("audio") else []
    else:
        refs = [{"audio_path": j["ref"], "text": j.get("ref_text", "")}]
    body = {"model": "bosonai/higgs-tts-3-4b", "voice": "default", "input": pace_token(j["pace"]) + j["tts_text"],
            "references": refs, "temperature": 0.8, "top_k": 50, "seed": j["seed"], "response_format": "wav",
            "max_new_tokens": 1024}
    req = urllib.request.Request(f"{base}/v1/audio/speech", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
    except Exception as e:
        print("FAIL", j["id"], e, flush=True)
        return False
    with open(p + ".tmp.wav", "wb") as f:
        f.write(data)
    os.replace(p + ".tmp.wav", p)
    return True


with ThreadPoolExecutor(conc) as pool:
    ok = sum(pool.map(one, jobs))
print(f"higgs DONE {ok}/{len(jobs)}", flush=True)
