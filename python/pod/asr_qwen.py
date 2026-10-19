"""Qwen3-ASR backend for train.py (native transformers >= 5.13, checkpoint Qwen/Qwen3-ASR-1.7B-hf).

Not the `qwen-asr` package or its finetuning/qwen3_asr_sft.py: that script masks prompts wrongly under left
padding (QwenLM/Qwen3-ASR #70, #216) and scales the loss by grad_acc, and its bundled backend skips the
audio encoder's 8 s attention windows off CUDA (#103). Here each example is a chat
(user: audio, assistant: "language <Name><asr_text><text>") and only the assistant tokens are trained
(return_assistant_tokens_mask). The model writes the label's script: romanized Hindi when the user's
clips are romanized. Hindi is a supported language; Gujarati and Tamil are not, though their names work as
plain text in a training target (untested; compare against Whisper before relying on it).

Full fine-tune (everything trains, as upstream) or LoRA on the language model's projections only (the
audio encoder's q/k/v names would otherwise match too). Decoding at test time: language detected, raw
output split at <asr_text> (no repetition fixing, which would change what is scored).
"""
import numpy as np
import torch

BASES = {"qwen3-asr-1.7b": "Qwen/Qwen3-ASR-1.7B-hf", "qwen3-asr-0.6b": "Qwen/Qwen3-ASR-0.6B-hf"}
# Language names Qwen3-ASR prints (config.support_languages), plus names for languages it doesn't know.
NAMES = {"zh": "Chinese", "en": "English", "yue": "Cantonese", "ar": "Arabic", "de": "German", "fr": "French",
         "es": "Spanish", "pt": "Portuguese", "id": "Indonesian", "it": "Italian", "ko": "Korean", "ru": "Russian",
         "th": "Thai", "vi": "Vietnamese", "ja": "Japanese", "tr": "Turkish", "hi": "Hindi", "ms": "Malay",
         "nl": "Dutch", "sv": "Swedish", "da": "Danish", "fi": "Finnish", "pl": "Polish", "cs": "Czech",
         "tl": "Filipino", "fa": "Persian", "el": "Greek", "ro": "Romanian", "hu": "Hungarian", "mk": "Macedonian",
         "gu": "Gujarati", "ta": "Tamil", "mr": "Marathi", "bn": "Bengali", "te": "Telugu", "kn": "Kannada",
         "ml": "Malayalam", "pa": "Punjabi", "ur": "Urdu", "ne": "Nepali"}
LORA_RE = r".*language_model.*\.({})$"
LORA_TARGETS = {"attn": "q_proj|k_proj|v_proj|o_proj", "attn+mlp": "q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj"}


def parse(raw):
    """Text after <asr_text>, without the end token (raw decoder output, nothing else changed)."""
    text = raw.split("<asr_text>", 1)[1] if "<asr_text>" in raw else raw
    for t in ("<|im_end|>", "<|endoftext|>"):
        text = text.replace(t, "")
    return text.strip()


class QwenASRBackend:
    family = "qwen3asr"

    def __init__(self, cfg, device, dtype):
        from transformers import AutoProcessor, Qwen3ASRForConditionalGeneration

        self.cfg, self.device, self.dtype = cfg, device, dtype
        self.base = BASES.get(cfg["base"].lower(), cfg["base"])
        self.proc = AutoProcessor.from_pretrained(self.base)
        model = Qwen3ASRForConditionalGeneration.from_pretrained(self.base, dtype=torch.float32)
        if cfg["gc"]:
            model.config.use_cache = False
            model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        if cfg["method"] == "lora":
            from peft import LoraConfig, get_peft_model

            lc = cfg["lora"]
            target = LORA_RE.format(LORA_TARGETS.get(lc["targets"], lc["targets"]))
            if cfg["gc"]:
                model.enable_input_require_grads()
            model = get_peft_model(model, LoraConfig(r=lc["r"], lora_alpha=lc["alpha"], lora_dropout=lc["dropout"],
                                                     target_modules=target, bias="none"))
        self.model = model.to(device)

    def train_mode(self):
        self.model.train()

    def params(self):
        return [p for p in self.model.parameters() if p.requires_grad]

    def example(self, audio, text, lang):
        return np.asarray(audio[: 30 * 16000], np.float32), f"language {NAMES.get(lang, lang)}<asr_text>{text.strip()}"

    def collate(self, batch):
        convs = [[{"role": "user", "content": [{"type": "audio", "audio": a}]},
                  {"role": "assistant", "content": [{"type": "text", "text": t}]}] for a, t in batch]
        inp = self.proc.apply_chat_template(convs, tokenize=True, return_dict=True, return_tensors="pt", padding=True,
                                            return_assistant_tokens_mask=True)
        mask = torch.as_tensor(inp.pop("assistant_masks"))
        labels = inp["input_ids"].clone()
        labels[(mask == 0) | (inp["attention_mask"] == 0)] = -100
        inp["labels"] = labels
        return dict(inp)

    def loss(self, batch):
        b = {k: (v.to(self.device, torch.float32) if v.is_floating_point() else v.to(self.device)) for k, v in batch.items()}
        return self.model(**b).loss

    def transcribe(self, audios, langs=None, beams=1, bs=8, allowed=None):
        """`allowed` is accepted for symmetry with Whisper; Qwen3-ASR names the language in its output."""
        self.model.eval()
        out = []
        with torch.inference_mode(), torch.autocast(self.device.type, dtype=self.dtype, enabled=self.dtype != torch.float32):
            for b in range(0, len(audios), bs):
                chunk = [np.asarray(a[: 30 * 16000], np.float32) for a in audios[b:b + bs]]
                kw = {}
                if langs and NAMES.get(langs[b]) in self.proc_langs():
                    kw["language"] = [langs[i] for i in range(b, b + len(chunk))]
                inp = self.proc.apply_transcription_request(audio=chunk, **kw).to(self.device)
                inp = {k: (v.to(torch.float32) if v.is_floating_point() else v) for k, v in inp.items()}
                g = self.model.generate(**inp, max_new_tokens=256, num_beams=beams, do_sample=False)
                out += [parse(t) for t in self.proc.batch_decode(g[:, inp["input_ids"].shape[1]:], skip_special_tokens=False)]
        self.train_mode()
        return out

    def proc_langs(self):
        return set(getattr(self.model.config, "support_languages", None) or NAMES.values()) - {"Gujarati", "Tamil"}

    def state(self):
        return {k: v.detach().to("cpu", copy=True) for k, v in self.model.state_dict().items()
                if self.cfg["method"] == "full" or "lora_" in k}

    def load_state(self, sd):
        self.model.load_state_dict(sd, strict=False)

    def save(self, out):
        m = self.model.merge_and_unload() if self.cfg["method"] == "lora" else self.model
        m = m.to("cpu", torch.float16)
        m.config.use_cache = True
        m.save_pretrained(out, safe_serialization=True)
        self.proc.save_pretrained(out)
