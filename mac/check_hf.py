import json, os, sys, time
import numpy as np, soundfile as sf, torch
from transformers import WhisperForConditionalGeneration, WhisperProcessor

sys.path.insert(0, "/Users/barreloflube/voice-data/pod")
from textnorm import fuzzy, wer

path, beams = os.path.expanduser(sys.argv[1]), int(sys.argv[2])
TEST = {"para-en-02", "para-en-05", "para-en-07", "twister-05-en-31", "para-hi-11", "para-hi-12", "para-hi-13", "para-hi-15",
        "twister-08-hi-34", "para-gu-19", "para-gu-22", "para-gu-23", "para-gu-24"}
D = os.path.expanduser("~/voice-data/data/final")
rows = [json.loads(l) for l in open(f"{D}/transcripts.jsonl") if json.loads(l)["id"] in TEST]
proc = WhisperProcessor.from_pretrained(path)
model = WhisperForConditionalGeneration.from_pretrained(path, torch_dtype=torch.float16).to("mps").eval()
model.generation_config.forced_decoder_ids = None
tot, t0, audio = {}, time.time(), 0
with torch.inference_mode():
    for r in rows:
        a, _ = sf.read(f"{D}/16k/{r['id']}.wav", dtype="float32")
        f = proc.feature_extractor(a, sampling_rate=16000, return_tensors="pt").input_features.to("mps", torch.float16)
        g = model.generate(f, task="transcribe", max_new_tokens=220, num_beams=beams)
        hyp = proc.tokenizer.decode(g[0], skip_special_tokens=True).strip()
        audio += r["seconds"]
        n = len(fuzzy(r["text"]).split())
        e = wer(fuzzy(hyp), fuzzy(r["text"]))
        a_ = tot.setdefault(r["lang"], [0, 0]); a_[0] += e * n; a_[1] += n
        print(f"{r['id']:18} {e:6.1%} {hyp[:80]}", flush=True)
res = {k: round(v[0] / v[1], 3) for k, v in tot.items()}
print(res, "avg", round(sum(res.values()) / 3, 3), f"| {audio:.0f}s audio in {time.time() - t0:.0f}s")
