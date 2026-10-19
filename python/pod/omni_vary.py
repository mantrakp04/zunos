"""OmniVoice inpainting: local tempo, pauses and mumbled words inside one take, in the model's own tokens.

Ported from the 2026-10-19 variability study (OmniVoice 0.2.1; pins its private API: _prepare_inference_inputs,
_decode_and_post_process, audio_tokenizer, VoiceClonePrompt.ref_text/ref_audio_tokens/ref_rms). Audio is 25
frames/s x 8 codebooks. A take is decoded once in full (`decode`), its words are located (`word_spans`), then
each effect replaces a span with MASK frames of a new length (`splice`) and re-decodes only those frames, with
per-frame guidance and temperature:

  rush    2-4 words at 0.5-0.7x their frames        drag    1 word at 1.4-1.8x
  pause   0.3-0.8 s of new frames at a word boundary mumble  1-2 words at guidance 0-0.5, temperature 1-2

Everything outside the spans stays the same audio, so the words keep their order and the label stays the
intended sentence. Effects are applied from the last span to the first, so earlier spans keep their frames.
"""
import math

import numpy as np
import torch
import torch.nn.functional as F

FPS = 25


def _gumbel(logits, temp):
    u = torch.rand_like(logits)
    return logits / temp + (-torch.log(-torch.log(u + 1e-10) + 1e-10))


def _topk_filter(lp, ratio=0.1):
    k = math.ceil(ratio * lp.shape[-1])
    v, i = lp.topk(k, dim=-1)
    return torch.full_like(lp, float("-inf")).scatter_(-1, i, v)


@torch.inference_mode()
def decode(model, text, lang, prompt, target_len, init=None, guid=2.0, temp=0.0, num_step=32, t_shift=0.1,
           pos_temp=5.0, layer_pen=5.0, denoise=True):
    """Iterative unmasking over the MASK positions of `init` (C, T) (everything when None). guid / temp: a float
    or a per-frame array of length T."""
    C, mask_id, dev = model.config.num_audio_codebook, model.config.audio_mask_id, model.device
    inp = model._prepare_inference_inputs(text, target_len, prompt.ref_text, prompt.ref_audio_tokens, lang, None, denoise)
    cond_ids, cond_mask = inp["input_ids"], inp["audio_mask"]
    T, L = target_len, cond_ids.shape[2]
    tokens = torch.full((1, C, T), mask_id, dtype=torch.long, device=dev) if init is None else init.clone().to(dev).view(1, C, T)
    ids = torch.full((2, C, L), mask_id, dtype=torch.long, device=dev)
    amask = torch.zeros((2, L), dtype=torch.bool, device=dev)
    att = torch.zeros((2, 1, L, L), dtype=torch.bool, device=dev)
    ids[0], amask[0], att[0] = cond_ids[0], cond_mask[0], True
    ids[1, :, :T], amask[1, :T], att[1, :, :T, :T] = cond_ids[0, :, -T:], True, True
    if L > T:
        d = torch.arange(T, L, device=dev)
        att[1, :, d, d] = True
    ids[0, :, L - T:], ids[1, :, :T] = tokens[0], tokens[0]
    g = torch.as_tensor(np.broadcast_to(np.asarray(guid, np.float32), (T,)).copy(), device=dev).view(1, 1, T, 1)
    tt = torch.as_tensor(np.broadcast_to(np.asarray(temp, np.float32), (T,)).copy(), device=dev).view(1, 1, T, 1)
    sample_any = bool((tt > 0).any())
    n_mask = int((tokens == mask_id).sum())
    ts = torch.linspace(0, 1, num_step + 1)
    ts = (t_shift * ts / (1 + (t_shift - 1) * ts)).tolist()
    sched, rem = [], n_mask
    for s in range(num_step):
        k = rem if s == num_step - 1 else min(math.ceil(n_mask * (ts[s + 1] - ts[s])), rem)
        sched.append(k)
        rem -= k
    layer_ids = torch.arange(C, device=dev).view(1, -1, 1)
    for k in sched:
        if k <= 0:
            continue
        logits = model(input_ids=ids, audio_mask=amask, attention_mask=att).logits.to(torch.float32)
        c = F.log_softmax(logits[0:1, :, L - T:L], -1)
        u = F.log_softmax(logits[1:2, :, :T], -1)
        lp = torch.log_softmax(c + g * (c - u), -1)
        lp[..., mask_id] = float("-inf")
        pred = lp.argmax(-1)
        if sample_any:
            samp = _gumbel(_topk_filter(lp), tt.clamp(min=1e-3)).argmax(-1)
            pred = torch.where(tt[..., 0] > 0, samp, pred)
        score = lp.max(-1)[0] - layer_ids * layer_pen
        if pos_temp > 0:
            score = _gumbel(score, pos_temp)
        score = score.masked_fill(tokens != mask_id, float("-inf"))
        idx = torch.topk(score.flatten(), k).indices
        flat = tokens.flatten()
        flat[idx] = pred.flatten()[idx]
        tokens = flat.view(1, C, T)
        ids[0, :, L - T:], ids[1, :, :T] = tokens[0], tokens[0]
    return tokens[0]


def splice(tokens, start, end, new_len, mask_id):
    """Frames [start, end) replaced by new_len MASK frames -> (init, span start, span end)."""
    mid = torch.full((tokens.shape[0], new_len), mask_id, dtype=tokens.dtype, device=tokens.device)
    return torch.cat([tokens[:, :start], mid, tokens[:, end:]], 1), start, start + new_len


def to_audio(model, tokens, prompt):
    from omnivoice.models.omnivoice import OmniVoiceGenerationConfig

    with torch.inference_mode():
        return model._decode_and_post_process(tokens.to(model.audio_tokenizer.device), prompt.ref_rms, OmniVoiceGenerationConfig())


def raw_audio(model, tokens):
    """Decoded audio without post-processing: sample i <-> frame i * sr / FPS."""
    with torch.inference_mode():
        return model.audio_tokenizer.decode(tokens.to(model.audio_tokenizer.device).unsqueeze(0)).audio_values[0, 0].cpu().numpy()


class Aligner:
    """Word timings of a decoded take: Whisper word timestamps (forced language), else letter-proportional
    spans between the first and last loud frame."""

    def __init__(self, model_id="openai/whisper-large-v3-turbo", device="cuda"):
        self.pipe = None
        try:
            from transformers import pipeline

            self.pipe = pipeline("automatic-speech-recognition", model=model_id, device=device,
                                 torch_dtype=torch.float16 if device == "cuda" else torch.float32)
        except Exception as e:  # alignment is best effort; the proportional spans still work
            print("aligner: whisper unavailable,", e, flush=True)

    def __call__(self, audio, sr, lang, text):
        import librosa

        a16 = librosa.resample(np.asarray(audio, np.float32), orig_sr=sr, target_sr=16000)
        if self.pipe is not None:
            try:
                out = self.pipe({"raw": a16, "sampling_rate": 16000}, return_timestamps="word",
                                generate_kwargs={"language": lang, "task": "transcribe", "num_beams": 1})
                w = [(c["timestamp"][0], c["timestamp"][1]) for c in out["chunks"]
                     if c["timestamp"][0] is not None and c["timestamp"][1] is not None and c["timestamp"][1] > c["timestamp"][0]]
                if len(w) >= 2:
                    return w
            except Exception as e:
                print("aligner: whisper failed,", e, flush=True)
        from pace import speech_seconds

        words = text.split() or [text]
        frame = 320
        e = np.array([np.mean(a16[i:i + frame] ** 2) for i in range(0, max(1, len(a16) - frame), frame)]) + 1e-12
        db = 10 * np.log10(e)
        on = np.where(db > db.max() - 35)[0]
        t0, t1 = (on[0] * frame / 16000, (on[-1] + 1) * frame / 16000) if len(on) else (0.0, speech_seconds(a16, 16000))
        weights = np.array([max(1, len(w)) for w in words], float)
        edges = t0 + (t1 - t0) * np.concatenate([[0], np.cumsum(weights) / weights.sum()])
        return [(edges[i], edges[i + 1]) for i in range(len(words))]


def apply_effects(model, base, words, effects, text, lang, prompt, num_step, guidance, denoise):
    """Applies inpainting effects to base tokens (C, T). words: [(start s, end s)]; effects from
    variability.plan (fractional positions). Returns (tokens, applied effects with their frames)."""
    mask_id = model.config.audio_mask_id
    n = len(words)
    if n < 2:
        return base, []
    T = base.shape[1]
    fr = lambda t: int(round(t * FPS))  # noqa: E731
    spans = []
    for e in effects:
        i = min(n - 1, max(0, int(e["at"] * n)))
        if e["kind"] == "pause":
            i = min(n - 2, i)
            b = fr((words[i][1] + words[i + 1][0]) / 2)
            spans.append((b, b, max(2, fr(e["seconds"])), e))
        else:
            j = min(n - 1, i + e.get("n_words", 1) - 1)
            f0, f1 = max(0, fr(words[i][0]) - 1), min(T, fr(words[j][1]) + 1)
            if f1 - f0 < 2:
                continue
            new = max(2, int(round((f1 - f0) * e.get("factor", 1.0))))
            spans.append((f0, f1, new, e))
    tokens, applied = base, []
    for f0, f1, new, e in sorted(spans, key=lambda s: -s[0]):  # last first: earlier frames don't move
        init, a, z = splice(tokens, f0, f1, new, mask_id)
        Tn = init.shape[1]
        g = np.full(Tn, guidance, np.float32)
        tt = np.zeros(Tn, np.float32)
        if e["kind"] == "mumble":
            g[a:z], tt[a:z] = e["guid"], e["temp"]
        tokens = decode(model, text, lang, prompt, Tn, init=init, guid=g, temp=tt, num_step=num_step, denoise=denoise)
        applied.append(dict(e, frames=[f0, f1, new]))
    return tokens, applied
