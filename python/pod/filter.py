import json, os, glob
import numpy as np, soundfile as sf, librosa, torch
from concurrent.futures import ThreadPoolExecutor
from transformers import WhisperForConditionalGeneration, WhisperProcessor
from zunos_core.scoring import synth_score

W = "/workspace/data"
OUT16 = f"{W}/synth16"
os.makedirs(OUT16, exist_ok=True)
jobs = {j["id"]: j for j in map(json.loads, open(f"{W}/jobs.jsonl", encoding="utf-8"))}
seen = {}
if os.path.exists(f"{W}/synth_scored.jsonl"):
    for l in open(f"{W}/synth_scored.jsonl", encoding="utf-8"):
        r = json.loads(l)
        seen[r["id"]] = r
todo = [os.path.basename(p)[:-4] for p in glob.glob(f"{W}/synth/*.wav") if not p.endswith(".tmp.wav")]
todo = [i for i in todo if i not in seen and i in jobs]
print("to score", len(todo), "already", len(seen), flush=True)

def load(i):
    a, sr = sf.read(f"{W}/synth/{i}.wav", dtype="float32")
    if a.ndim > 1:
        a = a.mean(1)
    a = librosa.resample(a, orig_sr=sr, target_sr=16000)
    a, _ = librosa.effects.trim(a, top_db=40)
    a = np.pad(a, (1600, 3200))
    peak = np.abs(a).max() or 1
    a = (a / peak * 0.7).astype(np.float32)
    sf.write(f"{OUT16}/{i}.wav", a, 16000)
    return i, a

proc = WhisperProcessor.from_pretrained("openai/whisper-large-v3-turbo")
model = WhisperForConditionalGeneration.from_pretrained("openai/whisper-large-v3-turbo", torch_dtype=torch.float16).cuda().eval()
out = open(f"{W}/synth_scored.jsonl", "a", encoding="utf-8")
pool = ThreadPoolExecutor(12)
for lang in sorted({j["lang"] for j in jobs.values()}):
    ids = [i for i in todo if jobs[i]["lang"] == lang]
    for b in range(0, len(ids), 48):
        batch = list(pool.map(load, ids[b:b + 48]))
        feats = proc.feature_extractor([a for _, a in batch], sampling_rate=16000, return_tensors="pt").input_features
        with torch.inference_mode():
            gen = model.generate(feats.cuda().half(), language=lang, task="transcribe", max_new_tokens=200)
        hyps = proc.batch_decode(gen, skip_special_tokens=True)
        for (i, a), h in zip(batch, hyps):
            j = jobs[i]
            dur = len(a) / 16000
            score = synth_score(h, j["target"], lang)
            cps = len(j["target"]) / max(dur - 0.3, 0.1)
            r = dict(id=i, lang=lang, engine=j["engine"], dur=round(dur, 2), score=round(score, 3), cps=round(cps, 1), hyp=h,
                     text=j["target"], path=f"{OUT16}/{i}.wav")
            out.write(json.dumps(r, ensure_ascii=False) + "\n")
        out.flush()
        print(lang, b + len(batch), "/", len(ids), flush=True)
print("FILTER DONE", flush=True)
