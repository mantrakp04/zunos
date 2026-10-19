"""The user's speaking rate per language, measured on their real train clips, and target paces drawn from it.

Rate is letters per second of speech (spaces and punctuation don't count; leading and trailing silence is
trimmed), so it carries over between scripts of the same language only approximately: measure it on the
label script, and compute target durations from the label too.
"""
import math
import random

import numpy as np
import soundfile as sf
from zunos_core.textnorm import basic


def letters(text):
    return sum(c.isalpha() or c.isdigit() or (0x0900 <= ord(c) <= 0x0DFF) for c in basic(text).replace(" ", ""))


def speech_seconds(audio, sr, top_db=35.0):
    """Seconds between the first and last 20 ms frame within top_db of the loudest frame."""
    frame = max(1, int(0.02 * sr))
    n = len(audio) // frame
    if n < 3:
        return len(audio) / sr
    e = (audio[: n * frame].reshape(n, frame) ** 2).mean(1) + 1e-12
    db = 10 * np.log10(e)
    on = np.where(db > db.max() - top_db)[0]
    return (on[-1] - on[0] + 1) * frame / sr if len(on) else len(audio) / sr


def measure(clips, path_of):
    """{lang: {"cps", "p10", "p90", "n"}} from train clips (never test)."""
    rates = {}
    for c in clips:
        if c["split"] != "train" or not c.get("text"):
            continue
        a, sr = sf.read(path_of(c), dtype="float32", always_2d=True)
        s = speech_seconds(a.mean(1), sr)
        if s > 0.5 and letters(c["text"]) >= 5:
            rates.setdefault(c["lang"], []).append(letters(c["text"]) / s)
    out = {}
    for lang, r in rates.items():
        r = np.array(r)
        out[lang] = {"cps": round(float(np.median(r)), 2), "p10": round(float(np.percentile(r, 10)), 2),
                     "p90": round(float(np.percentile(r, 90)), 2), "n": int(len(r))}
    return out


# Used only when a language has no measurable train clip (letters/second of typical read speech).
FALLBACK_CPS = 13.0


def factor(rng: random.Random, pace, lang=None):
    """A pace multiplier: log-normal around `center`, clipped to [slow, rushed] (per language in by_lang)."""
    p = {**pace, **(pace.get("by_lang") or {}).get(lang, {})}
    f = p["center"] * math.exp(rng.gauss(0.0, p["sigma"]))
    return round(min(p["rushed"], max(p["slow"], f)), 3)


def target_seconds(label, cps, f):
    return round(max(0.8, letters(label) / (cps * f)), 2)
