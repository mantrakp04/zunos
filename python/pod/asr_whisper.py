"""Whisper backend for train.py: examples, loss, decoding, saving. Full fine-tune or LoRA (PEFT).

One model for every language: each example carries its language token (<|hi|>, <|gu|>...), and decoding at
test time detects the language like the Mac app does (no forced language).
"""
import numpy as np
import torch

BASES = {"whisper-large-v3": "openai/whisper-large-v3", "whisper-large-v3-turbo": "openai/whisper-large-v3-turbo"}
LORA_TARGETS = {"attn": ["q_proj", "k_proj", "v_proj", "out_proj"],
                "attn+mlp": ["q_proj", "k_proj", "v_proj", "out_proj", "fc1", "fc2"]}


class WhisperBackend:
    family = "whisper"

    def __init__(self, cfg, device, dtype):
        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        self.cfg, self.device, self.dtype = cfg, device, dtype
        self.base = BASES.get(cfg["base"], cfg["base"])
        self.proc = WhisperProcessor.from_pretrained(self.base)
        self.tok = self.proc.tokenizer
        model = WhisperForConditionalGeneration.from_pretrained(self.base, torch_dtype=torch.float32)
        model.config.forced_decoder_ids = None
        model.generation_config.forced_decoder_ids = None
        if cfg["gc"]:
            model.config.use_cache = False
            model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        if cfg["freeze_enc"]:
            enc = model.model.encoder
            for i, layer in enumerate(enc.layers):
                if i < cfg["freeze_enc"]:
                    layer.requires_grad_(False)
            for m in (enc.conv1, enc.conv2, enc.embed_positions):
                m.requires_grad_(False)
        if cfg["method"] == "lora":
            from peft import LoraConfig, get_peft_model

            lc = cfg["lora"]
            targets = LORA_TARGETS.get(lc["targets"], lc["targets"])
            if cfg["gc"]:
                model.enable_input_require_grads()
            model = get_peft_model(model, LoraConfig(r=lc["r"], lora_alpha=lc["alpha"], lora_dropout=lc["dropout"],
                                                     target_modules=targets, bias="none"))
        self.model = model.to(device)
        self.eot = self.tok.convert_tokens_to_ids("<|endoftext|>")
        self.task = [self.tok.convert_tokens_to_ids("<|transcribe|>"), self.tok.convert_tokens_to_ids("<|notimestamps|>")]
        self._lang = {}

    def train_mode(self):
        self.model.train()

    def params(self):
        return [p for p in self.model.parameters() if p.requires_grad]

    def lang_token(self, lang):
        if lang not in self._lang:
            self._lang[lang] = self.tok.convert_tokens_to_ids(f"<|{lang}|>")
        return self._lang[lang]

    def example(self, audio, text, lang):
        feats = self.proc.feature_extractor(audio[: 30 * 16000], sampling_rate=16000, return_tensors="np").input_features[0]
        # The model shifts labels right and prepends <|startoftranscript|> (decoder_start_token_id).
        labels = [self.lang_token(lang), *self.task] + self.tok.encode(" " + text.strip(), add_special_tokens=False) + [self.eot]
        return torch.from_numpy(feats), labels[:440]

    @staticmethod
    def collate(batch):
        feats = torch.stack([f for f, _ in batch])
        n = max(len(l) for _, l in batch)
        lab = torch.full((len(batch), n), -100, dtype=torch.long)
        for i, (_, l) in enumerate(batch):
            lab[i, : len(l)] = torch.tensor(l)
        return {"input_features": feats, "labels": lab}

    def loss(self, batch):
        return self.model(input_features=batch["input_features"].to(self.device, non_blocking=True),
                          labels=batch["labels"].to(self.device, non_blocking=True)).loss

    def detect(self, feats, allowed):
        """Language of each clip, argmax of the language-token logits over `allowed` only (base Whisper calls
        Hindi Urdu and Gujarati Punjabi when it may pick any of its 99 languages)."""
        sot = self.tok.convert_tokens_to_ids("<|startoftranscript|>")
        ids = [self.lang_token(l) for l in allowed]
        enc = self.model.get_encoder()(feats)
        dec = torch.full((feats.shape[0], 1), sot, dtype=torch.long, device=feats.device)
        logits = self.model(encoder_outputs=enc, decoder_input_ids=dec).logits[:, -1]
        return [allowed[i] for i in logits[:, ids].argmax(-1).tolist()]

    def transcribe(self, audios, langs=None, beams=1, bs=16, allowed=None):
        """16 kHz arrays -> texts. langs=None detects the language, among `allowed` when given (the user's
        languages, as the Mac decoder does)."""
        self.model.eval()
        out = [None] * len(audios)
        use_cache = self.model.config.use_cache
        self.model.config.use_cache = True
        with torch.inference_mode(), torch.autocast(self.device.type, dtype=self.dtype, enabled=self.dtype != torch.float32):
            for b in range(0, len(audios), bs):
                chunk = [np.asarray(a[: 30 * 16000], np.float32) for a in audios[b:b + bs]]
                f = self.proc.feature_extractor(chunk, sampling_rate=16000, return_tensors="pt").input_features.to(self.device)
                ls = langs[b:b + bs] if langs else (self.detect(f, allowed) if allowed else [None] * len(chunk))
                for lang in dict.fromkeys(ls):
                    idx = [i for i, l in enumerate(ls) if l == lang]
                    kw = dict(task="transcribe", max_new_tokens=220, num_beams=beams)
                    if lang:
                        kw["language"] = lang
                    try:
                        g = self.model.generate(input_features=f[idx], **kw)
                    except AttributeError as e:
                        # transformers 5.20 greedy decoding on Whisper: "'EncoderDecoderCache' object has no
                        # attribute 'layers'". Beam search is unaffected.
                        if "layers" not in str(e) or kw["num_beams"] > 1:
                            raise
                        g = self.model.generate(input_features=f[idx], **dict(kw, num_beams=2))
                    for i, t in zip(idx, self.tok.batch_decode(g, skip_special_tokens=True)):
                        out[b + i] = t.strip()
        self.model.config.use_cache = use_cache
        self.train_mode()
        return out

    def state(self):
        """Trainable weights only (a LoRA adapter, or the full model), copied to CPU: a checkpoint in memory."""
        return {k: v.detach().to("cpu", copy=True) for k, v in self.model.state_dict().items()
                if self.cfg["method"] == "full" or "lora_" in k}

    def load_state(self, sd):
        self.model.load_state_dict(sd, strict=False)

    def save(self, out):
        """Merged fp16 Hugging Face checkpoint the Mac app loads (WhisperForConditionalGeneration)."""
        m = self.model.merge_and_unload() if self.cfg["method"] == "lora" else self.model
        m = m.to("cpu", torch.float16)
        m.config.use_cache = True
        m.generation_config.forced_decoder_ids = None
        m.save_pretrained(out, safe_serialization=True)
        self.proc.save_pretrained(out)
