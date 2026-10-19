import numpy as np


def to_16k(audio, rate):
    """Resample mono float32 audio to 16 kHz (polyphase, good enough for ASR input)."""
    if rate == 16000:
        return audio.astype(np.float32)
    from math import gcd

    from scipy.signal import resample_poly

    g = gcd(16000, rate)
    return resample_poly(audio, 16000 // g, rate // g).astype(np.float32)
