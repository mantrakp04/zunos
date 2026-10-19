"""Indic-Transcribe-Flex backend for train.py (bodhan-ai/indic-transcribe-flex: canary-1b-v2 architecture,
FastConformer encoder + Transformer decoder, 1.2B; 27 languages incl. en/hi/gu/ta; native, mixed and
romanized output modes). Gated on Hugging Face (HF_TOKEN with the terms accepted); Indic Open Model License,
attribution required, on-device use allowed.

The repository's Hugging Face port is inference-only (`labels` raise NotImplementedError), so the loss is
computed here from its logits: decoder input = the model's 10-token prompt (language, output mode) + the label
tokens, cross-entropy on the label tokens and <|endoftext|> only. No NeMo needed. Text ids are the aggregate
tokenizer's: multilingual SentencePiece pieces offset by the special-token vocab (1152).

Mode per language (set_modes, from the user's clips): romanized when the user's labels are in English letters
(and the language isn't English), else native. The bake-off: romanized mode beats native + transliteration by
10-19 points, and the model's own language ID calls Hindi Urdu, so the language is always restricted to the
user's languages.

Full fine-tune, decoder-only ("partial": freeze_enc > 0 freezes the encoder), or LoRA (decoder attention and
feed-forward plus encoder attention; targets "enc" / "enc+mlp": encoder attention (and feed-forward) only, so the
decoder's language model stays the base's). The encoder's BatchNorm layers stay in eval mode: batches are small.
With kl.weight > 0 the loss adds weight x KL(base || model) over the label positions, the base being the same
weights with the LoRA adapters off (a frozen copy for a full fine-tune), run in eval mode on the same batch.
Saved as the same HF port (code files copied along) plus zunos.json {family, modes}, which the Mac engine reads.
"""
import contextlib
import copy
import json
import os
import shutil
import sys

import numpy as np
import torch

REPO = "bodhan-ai/indic-transcribe-flex"
LORA_TARGETS = {
    "attn": r".*decoder.*\.(query_net|key_net|value_net|out_projection)$",
    "enc": r".*encoder.*\.(linear_q|linear_k|linear_v|linear_out)$",
    "enc+mlp": r".*encoder.*\.(linear_q|linear_k|linear_v|linear_out|linear1|linear2)$",
    "attn+mlp": r"(.*decoder.*\.(query_net|key_net|value_net|out_projection|dense_in|dense_out)|.*encoder.*\.(linear_q|linear_k|linear_v|linear_out))$",
}
CODE_FILES = ("configuration_indic_canary.py", "feature_extraction_indic_canary.py", "indic_transcribe.py", "lid.py",
              "long_form.py", "modeling_indic_canary.py", "tokenization_indic_canary.py", "inference.py",
              "tokenizer_multilingual.model", "tokenizer_spl_tokens.model", "tokenizer_config.json",
              "feature_extractor.safetensors", "generation_config.json", "indic-open-license.md",
              "Bodhan_AI_Open_Model_License.md", "README.md")


def snapshot(base):
    if os.path.isdir(base):
        return base
    from huggingface_hub import snapshot_download

    return snapshot_download(REPO if base in ("flex", "indic-transcribe-flex") else base,
                             token=os.environ.get("HF_TOKEN") or None)


class FlexBackend:
    family = "indic_canary"

    def __init__(self, cfg, device, dtype):
        self.cfg, self.device, self.dtype = cfg, device, dtype
        self.path = snapshot(cfg["base"])
        if self.path not in sys.path:
            sys.path.append(self.path)  # the model code ships in the snapshot (flat module names, appended last)
        from indic_transcribe import LANGUAGES, IndicTranscribe

        self.supported = set(LANGUAGES)
        self.asr = IndicTranscribe.from_pretrained(self.path, device=device.type, dtype=torch.float32)
        model, self.tok, self.fe = self.asr.model, self.asr.tokenizer, self.asr.fe
        model.config.use_cache = False
        if cfg["freeze_enc"]:
            model.model.encoder.requires_grad_(False)
        if cfg["method"] == "lora":
            from peft import LoraConfig, get_peft_model

            lc = cfg["lora"]
            model = get_peft_model(model, LoraConfig(r=lc["r"], lora_alpha=lc["alpha"], lora_dropout=lc["dropout"],
                                                     target_modules=LORA_TARGETS.get(lc["targets"], lc["targets"]), bias="none"))
        self.model = model
        self.modes = {}
        self.kl = cfg.get("kl") or {"weight": 0.0, "temp": 1.0}
        self.ref = None  # the frozen base for the KL term; LoRA needs none (adapters switched off)
        if self.kl["weight"] > 0 and cfg["method"] != "lora":
            self.ref = copy.deepcopy(model).eval().requires_grad_(False)
        self.last_kl = 0.0

    def base_model(self):
        return self.model.get_base_model() if self.cfg["method"] == "lora" else self.model

    def train_mode(self):
        self.model.train()
        for m in self.model.modules():
            if isinstance(m, torch.nn.BatchNorm1d):
                m.eval()

    def params(self):
        return [p for p in self.model.parameters() if p.requires_grad]

    def set_modes(self, rows):
        """Output mode per language from the user's labels ({lang, text} rows): romanized when most of a
        language's labels are in English letters (and it isn't English), else native. Call it in the main
        process before training or decoding: example() runs in DataLoader worker processes, so a mode first
        learned there never reaches transcribe() or save() (that left the test, and the Mac, on native)."""
        from zunos_core.scoring import is_latin

        for lang in sorted({r["lang"] for r in rows}):
            texts = [r["text"] for r in rows if r["lang"] == lang]
            latin = sum(map(is_latin, texts)) > len(texts) / 2
            self.modes[lang] = "romanized" if latin and lang != "en" else "native"
        return self.modes

    def mode_for(self, lang):
        if lang not in self.modes:
            raise KeyError(f"no output mode for {lang!r}: call set_modes() with the user's clips first")
        return self.modes[lang]

    def text_ids(self, text):
        return [self.tok.spl_size + i for i in self.tok.multi.encode(text.strip())]

    def example(self, audio, text, lang):
        mode = self.mode_for(lang)
        prompt = self.tok.encode_prompt(lang, romanized=mode == "romanized")
        ids = (prompt + self.text_ids(text) + [self.tok.eos_id])[: self.base_model().config.max_target_positions]
        return np.asarray(audio[: 30 * 16000], np.float32), ids, len(prompt)

    def collate(self, batch):
        n = max(16000, max(len(a) for a, _, _ in batch))
        wav = torch.zeros(len(batch), n)
        lens = torch.tensor([max(16000, len(a)) for a, _, _ in batch])
        for i, (a, _, _) in enumerate(batch):
            off = (16000 - len(a)) // 2 if len(a) < 16000 else 0  # short clips centred in 1 s, as in training
            wav[i, off: off + len(a)] = torch.from_numpy(a)
        L = max(len(ids) for _, ids, _ in batch)
        inp = torch.full((len(batch), L - 1), self.tok.pad_id, dtype=torch.long)
        tgt = torch.full((len(batch), L - 1), -100, dtype=torch.long)
        for i, (_, ids, p) in enumerate(batch):
            ids = torch.tensor(ids)
            inp[i, : len(ids) - 1] = ids[:-1]
            tgt[i, p - 1: len(ids) - 1] = ids[p:]  # predict the label tokens and <|endoftext|>, not the prompt
        return {"wav": wav, "lens": lens, "inp": inp, "tgt": tgt}

    def loss(self, batch):
        feats, flen = self.fe(batch["wav"].to(self.device), batch["lens"].to(self.device))
        mask = (torch.arange(feats.size(2), device=self.device)[None] < flen[:, None]).long()
        inp, tgt = batch["inp"].to(self.device), batch["tgt"].to(self.device)
        enc = self.base_model().model.encoder(feats, attention_mask=mask)
        logits = self.model(encoder_outputs=enc, decoder_input_ids=inp, use_cache=False).logits
        ce = torch.nn.functional.cross_entropy(logits.float().transpose(1, 2), tgt, ignore_index=-100)
        w = self.kl["weight"]
        if w <= 0:
            return ce
        with torch.no_grad(), self.reference() as ref:
            enc0 = ref.model.encoder(feats, attention_mask=mask)
            logits0 = ref(encoder_outputs=enc0, decoder_input_ids=inp, use_cache=False).logits
        on, t = tgt != -100, self.kl["temp"]
        lp = torch.log_softmax(logits[on].float() / t, -1)
        lp0 = torch.log_softmax(logits0[on].float() / t, -1)
        kl = (lp0.exp() * (lp0 - lp)).sum(-1).mean() * t * t
        self.last_kl = kl.item()
        return ce + w * kl

    @contextlib.contextmanager
    def reference(self):
        """The base model, in eval mode (no dropout): a frozen copy, or the LoRA model with its adapters off."""
        if self.ref is not None:
            yield self.ref
            return
        self.model.eval()
        try:
            with self.model.disable_adapter():
                yield self.base_model()
        finally:
            self.train_mode()

    def transcribe(self, audios, langs=None, beams=1, bs=1, allowed=None, mode=None):
        """`mode` forces one output mode for every clip (compare.py's probe); default: the language's mode."""
        self.model.eval()  # asr.model is the same object; PEFT injects LoRA layers into it in place
        out = []
        allow = [l for l in (allowed or []) if l in self.supported] or None
        with torch.inference_mode(), torch.autocast(self.device.type, dtype=self.dtype, enabled=self.dtype != torch.float32):
            for i, a in enumerate(audios):
                lang = langs[i] if langs else (self.asr.identify(a, topk=1, allowed_langs=allow)[0][0] if allow else None)
                text = self.asr.transcribe(np.asarray(a[: 40 * 16000], np.float32), lang=lang,
                                           mode=mode or (self.mode_for(lang) if lang else "native"),
                                           num_beams=max(1, beams), do_sample=False)
                out.append(text.strip())
        self.train_mode()
        return out

    def state(self):
        return {k: v.detach().to("cpu", copy=True) for k, v in self.model.state_dict().items()
                if self.cfg["method"] == "full" or "lora_" in k}

    def load_state(self, sd):
        self.model.load_state_dict(sd, strict=False)

    def save(self, out):
        m = self.model.merge_and_unload() if self.cfg["method"] == "lora" else self.model
        m = m.to("cpu")  # fp32: the port runs fp32 on the Mac (MPS); bf16 on CUDA
        m.save_pretrained(out, safe_serialization=True)
        for f in CODE_FILES:
            if os.path.exists(f"{self.path}/{f}"):
                shutil.copy(f"{self.path}/{f}", f"{out}/{f}")
        json.dump({"family": self.family, "modes": self.modes, "base": REPO}, open(f"{out}/zunos.json", "w"), indent=1)
