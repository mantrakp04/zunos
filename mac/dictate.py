import os, queue, subprocess, sys, time, warnings
import numpy as np
import sounddevice as sd

warnings.filterwarnings("ignore")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
RATE = 16000
FAST = "--fast" in sys.argv
HF = os.path.expanduser("~/voice-data/models/final-hf")
MLX = os.path.expanduser("~/voice-data/models/final-mlx")

print("Loading your model…", flush=True)
if FAST:
    import mlx_whisper

    def transcribe(audio):
        out = mlx_whisper.transcribe(audio, path_or_hf_repo=MLX, task="transcribe", condition_on_previous_text=False, temperature=0.0)
        return out["text"].strip(), out.get("language")
else:
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    proc = WhisperProcessor.from_pretrained(HF)
    model = WhisperForConditionalGeneration.from_pretrained(HF, torch_dtype=torch.float16).to("mps").eval()
    model.generation_config.forced_decoder_ids = None
    lang_ids = {proc.tokenizer.convert_tokens_to_ids(f"<|{l}|>"): l for l in ["en", "hi", "gu"]}

    def transcribe(audio):
        texts = []
        for s in range(0, max(len(audio), 1), 28 * RATE):
            chunk = audio[s:s + 28 * RATE]
            if len(chunk) < RATE // 2:
                continue
            f = proc.feature_extractor(chunk, sampling_rate=RATE, return_tensors="pt").input_features.to("mps", torch.float16)
            with torch.inference_mode():
                g = model.generate(f, task="transcribe", max_new_tokens=220, num_beams=4)
            texts.append(proc.tokenizer.decode(g[0], skip_special_tokens=True).strip())
            lang = lang_ids.get(int(g[0][1]), "?") if g.shape[1] > 1 else "?"
        return " ".join(texts), (lang if texts else "?")

transcribe(np.zeros(RATE, dtype=np.float32))
print(f"Ready ({'fast' if FAST else 'accurate'} mode). Press Enter to start talking, Enter again to stop. Ctrl+C to quit.\n")

while True:
    try:
        input("⏎ start ")
    except (KeyboardInterrupt, EOFError):
        print()
        break
    q = queue.Queue()
    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", callback=lambda d, *_: q.put(d[:, 0].copy())):
        print("● listening… press Enter to stop", flush=True)
        input()
    chunks = []
    while not q.empty():
        chunks.append(q.get())
    audio = np.concatenate(chunks) if chunks else np.zeros(RATE, np.float32)
    peak = float(np.abs(audio).max())
    level = 20 * np.log10(np.sqrt(np.mean(audio ** 2)) + 1e-12)
    if peak == 0.0:
        print("✗ The microphone gave pure silence. macOS is blocking it for this terminal app.\n"
              "  System Settings → Privacy & Security → Microphone → turn on your terminal app, then restart it.\n")
        continue
    if level < -60:
        print(f"✗ Too quiet to hear anything (level {level:.0f} dB). Check the input device in System Settings → Sound.\n")
        continue
    t0 = time.time()
    text, lang = transcribe(audio)
    subprocess.run("pbcopy", input=text.encode())
    print(f"[{lang}, {len(audio) / RATE:.1f}s in {time.time() - t0:.1f}s, copied]\n{text}\n")
