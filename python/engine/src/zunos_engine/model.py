import os
import warnings

import numpy as np

warnings.filterwarnings("ignore")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

RATE = 16000
CHUNK = 28 * RATE


def enabled_languages():
    """The languages switched on in the app (its database, read-only), or None when it can't be read."""
    import sqlite3

    from .eval import APP_DIR

    try:
        db = sqlite3.connect(f"file:{APP_DIR}/zunos.db?mode=ro", uri=True)
        langs = [r[0] for r in db.execute("SELECT code FROM languages WHERE enabled = 1")]
        return langs or None
    except Exception:
        return None


# Qwen3-ASR prints language names; Whisper codes for the ones it knows.
QWEN_CODES = {"Chinese": "zh", "English": "en", "Cantonese": "yue", "Arabic": "ar", "German": "de", "French": "fr",
              "Spanish": "es", "Portuguese": "pt", "Indonesian": "id", "Italian": "it", "Korean": "ko", "Russian": "ru",
              "Thai": "th", "Vietnamese": "vi", "Japanese": "ja", "Turkish": "tr", "Hindi": "hi", "Malay": "ms",
              "Dutch": "nl", "Swedish": "sv", "Danish": "da", "Finnish": "fi", "Polish": "pl", "Czech": "cs",
              "Filipino": "tl", "Persian": "fa", "Greek": "el", "Romanian": "ro", "Hungarian": "hu", "Macedonian": "mk",
              "Gujarati": "gu", "Tamil": "ta"}


class Model:
    """A fine-tuned checkpoint (HF format) decoded with beam search on the Mac GPU: Whisper, Qwen3-ASR
    (config.json model_type "qwen3_asr", transformers' native Qwen3ASRForConditionalGeneration), or
    Indic-Transcribe-Flex ("indic_canary", its own code in the folder; needs sentencepiece).

    Final decoding is HF transformers on MPS with num_beams=4: whisper.cpp scores about 5 points
    worse with the same weights and mlx_whisper has no beam search.

    Whisper's language detection is restricted to `langs` (default: the languages enabled in the app):
    over all 99 languages base Whisper calls Hindi Urdu and Gujarati Punjabi.
    """

    def __init__(self, path, device="mps", beams=4, langs=None):
        import json

        import torch

        self.torch, self.device, self.beams, self.path = torch, device, beams, path
        self.kind = json.load(open(os.path.join(path, "config.json"))).get("model_type", "whisper")
        if self.kind == "indic_canary":
            # Indic-Transcribe-Flex fine-tuned by python/pod/asr_flex.py: plain PyTorch, its code ships in the
            # model folder (reviewed upstream code, appended last to sys.path so it can't shadow packages).
            import sys

            if path not in sys.path:
                sys.path.append(path)
            from indic_transcribe import LANGUAGES, IndicTranscribe

            meta = json.load(open(os.path.join(path, "zunos.json")))
            self.modes = meta.get("modes", {})
            self.asr = IndicTranscribe.from_pretrained(path, device=device, dtype=torch.float32)
            self.allowed_codes = [l for l in (langs or enabled_languages() or list(self.modes)) if l in LANGUAGES] or None
            return
        if self.kind == "qwen3_asr":
            from transformers import AutoProcessor, Qwen3ASRForConditionalGeneration

            self.proc = AutoProcessor.from_pretrained(path)
            self.model = Qwen3ASRForConditionalGeneration.from_pretrained(path, dtype=torch.float16).to(device).eval()
            return
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        from transformers.models.whisper.tokenization_whisper import LANGUAGES

        self.proc = WhisperProcessor.from_pretrained(path)
        self.model = WhisperForConditionalGeneration.from_pretrained(path, torch_dtype=torch.float16).to(device).eval()
        self.model.generation_config.forced_decoder_ids = None
        self.lang_ids = {self.proc.tokenizer.convert_tokens_to_ids(f"<|{l}|>"): l for l in LANGUAGES}
        allowed = [l for l in (langs or enabled_languages() or []) if l in LANGUAGES]
        self.allowed = [self.proc.tokenizer.convert_tokens_to_ids(f"<|{l}|>") for l in allowed]

    def warmup(self):
        self.transcribe(np.zeros(RATE, dtype=np.float32))

    def _language(self, f):
        """The most likely language token among the allowed ones (None = let generate detect freely)."""
        if len(self.allowed) < 1:
            return None
        torch = self.torch
        sot = self.proc.tokenizer.convert_tokens_to_ids("<|startoftranscript|>")
        enc = self.model.get_encoder()(f)
        logits = self.model(encoder_outputs=enc, decoder_input_ids=torch.tensor([[sot]], device=f.device)).logits[0, -1]
        return self.lang_ids[self.allowed[int(logits[self.allowed].argmax())]]

    def _decode(self, chunk, beams):
        torch = self.torch
        if self.kind == "indic_canary":
            with torch.inference_mode():
                # Its own language ID calls Hindi Urdu: identify among the user's languages only.
                lang = self.asr.identify(chunk, topk=1, allowed_langs=self.allowed_codes)[0][0]
                text = self.asr.transcribe(chunk, lang=lang, mode=self.modes.get(lang, "native"), num_beams=beams, do_sample=False)
            return text.strip(), lang
        if self.kind == "qwen3_asr":
            inputs = self.proc.apply_transcription_request(audio=chunk).to(self.device, torch.float16)
            with torch.inference_mode():
                g = self.model.generate(**inputs, max_new_tokens=256, num_beams=beams, do_sample=False)
            raw = self.proc.decode(g[:, inputs["input_ids"].shape[1]:])[0]
            name, _, text = raw.partition("<asr_text>")
            text = (text if _ else raw).replace("<|im_end|>", "").replace("<|endoftext|>", "").strip()
            return text, QWEN_CODES.get(name.replace("language", "").strip(), "?")
        f = self.proc.feature_extractor(chunk, sampling_rate=RATE, return_tensors="pt").input_features.to(self.device, torch.float16)
        with torch.inference_mode():
            lang = self._language(f)
            # Only the dict output keeps the decoder prompt (<|startoftranscript|><|lang|>...), which
            # is where the detected language is.
            kw = dict(task="transcribe", max_new_tokens=220, return_dict_in_generate=True, **({"language": lang} if lang else {}))
            try:
                g = self.model.generate(f, num_beams=beams, **kw).sequences
            except AttributeError as e:  # transformers 5.20 greedy Whisper bug (EncoderDecoderCache.layers)
                if "layers" not in str(e) or beams > 1:
                    raise
                g = self.model.generate(f, num_beams=2, **kw).sequences
        text = self.proc.tokenizer.decode(g[0], skip_special_tokens=True).strip()
        lang = lang or (self.lang_ids.get(int(g[0][1]), "?") if g.shape[1] > 1 else "?")
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
