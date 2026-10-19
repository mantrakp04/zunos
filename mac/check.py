import json, sys, time, os
import mlx_whisper

sys.path.insert(0, "/Users/barreloflube/voice-data/pod")
from textnorm import basic, fuzzy, wer

model = sys.argv[1]
TEST = {"para-en-02", "para-en-05", "para-en-07", "twister-05-en-31", "para-hi-11", "para-hi-12", "para-hi-13", "para-hi-15",
        "twister-08-hi-34", "para-gu-19", "para-gu-22", "para-gu-23", "para-gu-24"}
D = os.path.expanduser("~/voice-data/data/final")
rows = [json.loads(l) for l in open(f"{D}/transcripts.jsonl") if json.loads(l)["id"] in TEST]
tot = {}
t0 = time.time()
audio_s = 0
for r in rows:
    out = mlx_whisper.transcribe(f"{D}/16k/{r['id']}.wav", path_or_hf_repo=model, task="transcribe",
                                 condition_on_previous_text=False, temperature=0.0)
    hyp = out["text"].strip()
    audio_s += r["seconds"]
    n = len(fuzzy(r["text"]).split())
    e = wer(fuzzy(hyp), fuzzy(r["text"]))
    a = tot.setdefault(r["lang"], [0, 0])
    a[0] += e * n
    a[1] += n
    print(f"{r['id']:18} {out.get('language')} {e:6.1%}  {hyp[:90]}")
el = time.time() - t0
print({k: f"{v[0] / v[1]:.1%}" for k, v in tot.items()}, f"| {audio_s:.0f}s of audio in {el:.0f}s ({audio_s / el:.1f}x real time)")
