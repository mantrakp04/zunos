import os
import warnings

import numpy as np

warnings.filterwarnings("ignore")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

RATE = 16000
CHUNK = 28 * RATE
LANGS = ("en", "hi", "gu")


class Model:
    """A fine-tuned Whisper checkpoint (HF format) decoded with beam search on the Mac GPU.

    Final decoding is HF transformers on MPS with num_beams=4: whisper.cpp scores about 5 points
    worse with the same weights and mlx_whisper has no beam search.
    """

    def __init__(self, path, device="mps", beams=4):
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        self.torch, self.device, self.beams, self.path = torch, device, beams, path
        self.proc = WhisperProcessor.from_pretrained(path)
        self.model = WhisperForConditionalGeneration.from_pretrained(path, torch_dtype=torch.float16).to(device).eval()
        self.model.generation_config.forced_decoder_ids = None
        self.lang_ids = {self.proc.tokenizer.convert_tokens_to_ids(f"<|{l}|>"): l for l in LANGS}

    def warmup(self):
        self.transcribe(np.zeros(RATE, dtype=np.float32))

    def _decode(self, chunk, beams):
        torch = self.torch
        f = self.proc.feature_extractor(chunk, sampling_rate=RATE, return_tensors="pt").input_features
        with torch.inference_mode():
            g = self.model.generate(f.to(self.device, torch.float16), task="transcribe", max_new_tokens=220, num_beams=beams)
        text = self.proc.tokenizer.decode(g[0], skip_special_tokens=True).strip()
        lang = self.lang_ids.get(int(g[0][1]), "?") if g.shape[1] > 1 else "?"
        return text, lang

    def transcribe(self, audio, beams=None):
        """16 kHz mono float32 → (text, language). Long audio is decoded in 28 s chunks."""
        texts, langs = [], []
        for s in range(0, max(len(audio), 1), CHUNK):
            chunk = audio[s:s + CHUNK]
            if len(chunk) < RATE // 2:
                continue
            text, lang = self._decode(chunk, beams or self.beams)
            texts.append(text)
            langs.append(lang)
        # The language of the longest stretch wins; ties go to the first chunk.
        lang = max(langs, key=langs.count) if langs else "?"
        return " ".join(texts), lang


class FastModel:
    """MLX version of the same weights: greedy only, about 3x faster, slightly less accurate."""

    def __init__(self, path):
        import mlx_whisper

        self.mlx_whisper, self.path = mlx_whisper, path

    def warmup(self):
        self.transcribe(np.zeros(RATE, dtype=np.float32))

    def transcribe(self, audio, beams=None):
        out = self.mlx_whisper.transcribe(audio, path_or_hf_repo=self.path, task="transcribe",
                                          condition_on_previous_text=False, temperature=0.0)
        return out["text"].strip(), out.get("language") or "?"


def check_level(audio):
    """None if the audio is usable, else an error code.

    macOS returns pure silence (peak 0) when the app lacks microphone permission, and Whisper then
    outputs "you".
    """
    if len(audio) == 0 or float(np.abs(audio).max()) == 0.0:
        return "mic_blocked"
    level = 20 * np.log10(np.sqrt(np.mean(audio ** 2)) + 1e-12)
    if level < -60:
        return "too_quiet"
    return None
