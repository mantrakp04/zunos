import sys, torch, shutil, os
from transformers import WhisperForConditionalGeneration, WhisperProcessor

src, dst = sys.argv[1], sys.argv[2]
m = WhisperForConditionalGeneration.from_pretrained(src, torch_dtype=torch.float16)
m.config.use_cache = True
m.save_pretrained(dst, safe_serialization=True)
WhisperProcessor.from_pretrained(src).save_pretrained(dst)
if os.path.exists(f"{src}/score.json"):
    shutil.copy(f"{src}/score.json", dst)
print("exported", dst, sum(os.path.getsize(f"{dst}/{f}") for f in os.listdir(dst)) // 2**20, "MB")
