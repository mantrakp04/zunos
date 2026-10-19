import json, os, subprocess, sys, time
sys.path.insert(0, "/Users/barreloflube/voice-data/pod")
from textnorm import fuzzy, wer
model, beams, extra = sys.argv[1], sys.argv[2], sys.argv[3:]
TEST = {"para-en-02", "para-en-05", "para-en-07", "twister-05-en-31", "para-hi-11", "para-hi-12", "para-hi-13", "para-hi-15",
        "twister-08-hi-34", "para-gu-19", "para-gu-22", "para-gu-23", "para-gu-24"}
D = os.path.expanduser("~/voice-data/data/final")
rows = [json.loads(l) for l in open(f"{D}/transcripts.jsonl") if json.loads(l)["id"] in TEST]
tot, t0, audio = {}, time.time(), 0
for r in rows:
    out = subprocess.run(["whisper-cli", "-m", model, "-f", f"{D}/16k/{r['id']}.wav", "-l", "auto", "-bs", beams, "-nt", "-np"] + extra,
                         capture_output=True, text=True).stdout
    hyp = " ".join(l.strip() for l in out.splitlines() if l.strip())
    audio += r["seconds"]
    n = len(fuzzy(r["text"]).split())
    a = tot.setdefault(r["lang"], [0, 0]); a[0] += wer(fuzzy(hyp), fuzzy(r["text"])) * n; a[1] += n
    print(f"{r['id']:18} {wer(fuzzy(hyp), fuzzy(r['text'])):6.1%} {hyp[:80]}")
res = {k: round(v[0] / v[1], 3) for k, v in tot.items()}
print(res, "avg", round(sum(res.values()) / 3, 3), f"| {audio:.0f}s audio in {time.time() - t0:.0f}s")
