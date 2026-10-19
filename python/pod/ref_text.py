"""Native-script text for voice-reference clips.

IndicF5 and Chatterbox expect the reference transcript in the script of the language (Devanagari,
Gujarati). The app stores romanized text, so for Hindi/Gujarati train clips without native_text this
transcribes them with base Whisper large-v3 forced to the language. English refs use their text.
Updates manifest.json's ref_text in place.
"""
import json
import os

import soundfile as sf
import torch
from transformers import WhisperForConditionalGeneration, WhisperProcessor

W = os.environ.get("ZUNOS_DATA", "/workspace/data")
manifest = json.load(open(f"{W}/manifest.json", encoding="utf-8"))
ref_text = manifest.setdefault("ref_text", {})
todo = []
for c in manifest["clips"]:
    if c["split"] != "train" or c["id"] in ref_text:
        continue
    if c["lang"] == "en":
        ref_text[c["id"]] = c["text"]
    elif c.get("native_text"):
        ref_text[c["id"]] = c["native_text"]
    elif 4 <= c["seconds"] <= 29:
        todo.append(c)

if todo:
    proc = WhisperProcessor.from_pretrained("openai/whisper-large-v3")
    model = WhisperForConditionalGeneration.from_pretrained("openai/whisper-large-v3", torch_dtype=torch.float16).cuda().eval()
    for c in todo:
        a, sr = sf.read(f"{W}/real/final/16k/{c['id']}.wav", dtype="float32")
        f = proc.feature_extractor(a, sampling_rate=16000, return_tensors="pt").input_features.cuda().half()
        with torch.inference_mode():
            g = model.generate(f, language=c["lang"], task="transcribe", max_new_tokens=220)
        ref_text[c["id"]] = proc.batch_decode(g, skip_special_tokens=True)[0].strip()
        print(c["id"], ref_text[c["id"]][:60], flush=True)
    del model
    torch.cuda.empty_cache()

json.dump(manifest, open(f"{W}/manifest.json", "w", encoding="utf-8"), ensure_ascii=False)
print("ref_text:", len(ref_text), "clips", flush=True)
