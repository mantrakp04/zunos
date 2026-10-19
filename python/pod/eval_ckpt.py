import json, sys, torch, numpy as np, soundfile as sf
from transformers import WhisperForConditionalGeneration, WhisperProcessor
from zunos_core.textnorm import basic, fuzzy, wer

def load(p):
    a, _ = sf.read(p, dtype="float32")
    return a.mean(1) if a.ndim > 1 else a

real = [json.loads(l) for l in open("/workspace/data/real.jsonl", encoding="utf-8")]
test = [dict(r, path=f"/workspace/data/real/final/16k/{r['id']}.wav") for r in real if r["split"] == "test"]

def soup(paths, out):
    models = [WhisperForConditionalGeneration.from_pretrained(p, torch_dtype=torch.float32) for p in paths]
    sd = models[0].state_dict()
    for k in sd:
        if sd[k].is_floating_point():
            sd[k] = sum(m.state_dict()[k] for m in models) / len(models)
    models[0].load_state_dict(sd)
    models[0].save_pretrained(out, safe_serialization=True)
    WhisperProcessor.from_pretrained(paths[0]).save_pretrained(out)

def score(path, beams=1):
    proc = WhisperProcessor.from_pretrained(path)
    model = WhisperForConditionalGeneration.from_pretrained(path, torch_dtype=torch.float16).cuda().eval()
    model.generation_config.forced_decoder_ids = None
    hyps = []
    with torch.inference_mode():
        for r in test:
            f = proc.feature_extractor(load(r["path"]), sampling_rate=16000, return_tensors="pt").input_features.cuda().half()
            g = model.generate(f, task="transcribe", max_new_tokens=220, num_beams=beams)
            hyps.append(proc.tokenizer.decode(g[0], skip_special_tokens=True))
    res = {}
    for l in ["en", "hi", "gu"]:
        rs = [(r, h) for r, h in zip(test, hyps) if r["lang"] == l]
        n = sum(len(fuzzy(r["text"]).split()) for r, _ in rs)
        res[l] = round(sum(wer(fuzzy(h), fuzzy(r["text"])) * len(fuzzy(r["text"]).split()) for r, h in rs) / n, 3)
    res["avg"] = round((res["en"] + res["hi"] + res["gu"]) / 3, 3)
    del model
    torch.cuda.empty_cache()
    return res

if sys.argv[1] == "soup":
    soup(sys.argv[3:], sys.argv[2])
else:
    for p in sys.argv[2:]:
        for b in [1, 4]:
            print(p.split("/")[-2] if p.endswith("best") else p.split("/")[-1], f"beams={b}", score(p, b), flush=True)
