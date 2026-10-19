"""Terminal dictation: Enter to start, Enter to stop; the text is printed and copied.

    uv run zunos-dictate <model-dir> [--fast <mlx-dir>]
"""
import argparse
import os
import queue
import subprocess
import time

import numpy as np

from .model import RATE, FastModel, Model, check_level

MESSAGES = {
    "mic_blocked": "✗ The microphone gave pure silence. macOS is blocking it for this terminal app.\n"
                   "  System Settings → Privacy & Security → Microphone → turn on your terminal app, then restart it.",
    "too_quiet": "✗ Too quiet to hear anything. Check the input device in System Settings → Sound.",
}


def main():
    import sounddevice as sd

    ap = argparse.ArgumentParser()
    ap.add_argument("model", help="HF model dir (accurate mode)")
    ap.add_argument("--fast", metavar="MLX_DIR", help="use the MLX model instead (faster, less accurate)")
    a = ap.parse_args()

    print("Loading your model…", flush=True)
    model = FastModel(os.path.expanduser(a.fast)) if a.fast else Model(os.path.expanduser(a.model))
    model.warmup()
    print(f"Ready ({'fast' if a.fast else 'accurate'} mode). Press Enter to start talking, Enter again to stop. Ctrl+C to quit.\n")

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
        if err := check_level(audio):
            print(MESSAGES[err] + "\n")
            continue
        t0 = time.time()
        text, lang = model.transcribe(audio)
        subprocess.run("pbcopy", input=text.encode())
        print(f"[{lang}, {len(audio) / RATE:.1f}s in {time.time() - t0:.1f}s, copied]\n{text}\n")


if __name__ == "__main__":
    main()
