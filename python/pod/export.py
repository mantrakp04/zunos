"""Package a trained variant for the Mac: the merged fp16 checkpoint plus its scores.

    python export.py <model dir> <out dir> <variant dir>

train.py already saves a merged fp16 Hugging Face checkpoint (LoRA folded in). This copies it, checks it loads
with the class the Mac uses for its family, and writes score.json (what the app shows) and report.json (the
full variant report). Whisper checkpoints load in python/engine's Model (HF transformers on MPS, beam 4).
"""
import json
import os
import shutil
import sys

import torch

src, dst, variant = sys.argv[1], sys.argv[2], sys.argv[3]
shutil.rmtree(dst, ignore_errors=True)
shutil.copytree(src, dst)
rep = json.load(open(f"{variant}/report.json"))
cfgj = json.load(open(f"{dst}/config.json"))
if cfgj.get("model_type") == "whisper":
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    m = WhisperForConditionalGeneration.from_pretrained(dst, torch_dtype=torch.float16)
    assert m.config.use_cache and m.generation_config.forced_decoder_ids is None
    WhisperProcessor.from_pretrained(dst)
    family = "whisper"
else:
    family = cfgj.get("model_type", "unknown")
json.dump(dict(step=rep["steps"], score=rep["test"]["avg"], res={l: s["wer"] for l, s in rep["test"]["langs"].items()},
               family=family, base=rep["base"], method=rep["method"], variant=rep["variant"]), open(f"{dst}/score.json", "w"))
shutil.copy(f"{variant}/report.json", f"{dst}/report.json")
print("exported", dst, family, sum(os.path.getsize(f"{dst}/{f}") for f in os.listdir(dst)) // 2 ** 20, "MB")
