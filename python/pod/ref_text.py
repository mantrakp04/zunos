"""Native-script transcripts of the candidate voice references (train clips of 3-10 s).

    python ref_text.py <work> [asr model id]      writes <work>/data/ref_text.json {clip id: text}

Cloning TTS models condition on the reference's transcript, in the language's own script. The app stores
what the user reads in their script (romanized Hindi, Gujarati...), so for those clips this uses native_text
when the app has it and otherwise transcribes the clip with Whisper forced to the language. Clips already in
native script (or English) use their own text. Test and dev clips are skipped: they are never references.
"""
import json
import os
import sys

import soundfile as sf
import torch
from zunos_core.scoring import is_latin

work = sys.argv[1]
model_id = sys.argv[2] if len(sys.argv) > 2 else "openai/whisper-large-v3"
D = f"{work}/data"
cfg = json.load(open(f"{D}/cfg.json"))["gen"]["refs"]
out_path = f"{D}/ref_text.json"
ref_text = json.load(open(out_path, encoding="utf-8")) if os.path.exists(out_path) else {}
rows = [json.loads(l) for l in open(f"{D}/real.jsonl", encoding="utf-8")]
todo = []
for c in rows:
    if c["split"] != "train" or c["id"] in ref_text or not (cfg["min_s"] <= c["seconds"] <= cfg["max_s"]):
        continue
    if c["lang"] == "en" or not is_latin(c["text"]):
        ref_text[c["id"]] = c["text"]
    elif c.get("native_text"):
        ref_text[c["id"]] = c["native_text"]
    else:
        todo.append(c)

if todo:
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if dev == "cuda" else torch.float32
    proc = WhisperProcessor.from_pretrained(model_id)
    model = WhisperForConditionalGeneration.from_pretrained(model_id, torch_dtype=dtype).to(dev).eval()
    for c in todo:
        a, sr = sf.read(c["path"], dtype="float32")
        f = proc.feature_extractor(a, sampling_rate=16000, return_tensors="pt").input_features.to(dev, dtype)
        with torch.inference_mode():
            g = model.generate(f, language=c["lang"], task="transcribe", max_new_tokens=220, num_beams=4)  # greedy breaks on transformers 5.20
        ref_text[c["id"]] = proc.batch_decode(g, skip_special_tokens=True)[0].strip()
        print(c["id"], ref_text[c["id"]][:60], flush=True)

json.dump(ref_text, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("ref_text:", len(ref_text), "clips", flush=True)
