"""Pitch-preserving tempo change for speech (WSOLA: waveform-similarity overlap-add).

    tempo(x, rate, sr)   rate > 1 is faster (shorter), rate < 1 slower; pitch and formants stay put.

Resampling (scipy resample_poly) changes speed and pitch together, which makes a voice sound like someone
else; WSOLA cuts the signal into overlapping windows and re-spaces them, nudging each window by up to
`tolerance` to the position most similar to the natural continuation, so periods line up and pitch is kept.
"""
import numpy as np


def tempo(x, rate, sr=16000, frame_ms=30.0, tolerance_ms=10.0):
    x = np.asarray(x, dtype=np.float32)
    if abs(rate - 1.0) < 1e-3 or len(x) < sr // 20:
        return x.copy()
    n = int(sr * frame_ms / 1000) // 2 * 2
    hop_out = n // 2
    hop_in = hop_out * rate
    tol = int(sr * tolerance_ms / 1000)
    win = np.hanning(n).astype(np.float32)
    pad = np.concatenate([np.zeros(tol + n, np.float32), x, np.zeros(tol + 2 * n, np.float32)])
    frames = int((len(x) / rate) / hop_out) + 1
    out = np.zeros(frames * hop_out + n, np.float32)
    norm = np.zeros_like(out)
    prev = tol + n  # start of the previously copied input window, in `pad`
    for k in range(frames):
        target = int(round(tol + n + k * hop_in))
        if k == 0:
            best = target
        else:
            # The natural continuation of the last copied window, compared with the candidates around target.
            nat = pad[prev + hop_out: prev + hop_out + n]
            lo, hi = max(0, target - tol), min(len(pad) - n, target + tol)
            if hi <= lo or len(nat) < n:
                best = min(max(target, 0), len(pad) - n)
            else:
                seg = pad[lo: hi + n]
                # Cross-correlation of every candidate window with the natural continuation.
                corr = np.correlate(seg, nat, mode="valid")
                best = lo + int(np.argmax(corr))
        chunk = pad[best: best + n]
        if len(chunk) < n:
            break
        o = k * hop_out
        out[o: o + n] += chunk * win
        norm[o: o + n] += win
        prev = best
    y = out / np.maximum(norm, 1e-3)
    return y[: int(round(len(x) / rate))].astype(np.float32)
