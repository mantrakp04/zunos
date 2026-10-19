"""Cut a prompt recording into training clips at line boundaries.

The recorder stores `marks`: the second at which the reader moved past each line (the last mark is
the end). Each boundary is snapped to the middle of the nearest pause, then consecutive lines are
grouped into clips of at most MAX_SECONDS so every clip fits Whisper's 30 s window with its exact text.
"""
import os

import numpy as np
import soundfile as sf

from .audio import to_16k

FRAME = 0.05  # seconds per RMS frame
SNAP = 1.5  # look this far either side of a mark for a pause
MIN_GAP = 0.2  # shortest pause worth cutting in
MAX_SECONDS = 25.0
MIN_SECONDS = 2.0


def pauses(audio, rate):
    """Midpoints (seconds) of quiet stretches: frames below the 25th-percentile level + 2 dB."""
    n = int(rate * FRAME)
    frames = len(audio) // n
    if frames == 0:
        return np.array([])
    rms = np.sqrt(np.mean(audio[: frames * n].reshape(frames, n) ** 2, axis=1))
    db = 20 * np.log10(rms + 1e-9)
    quiet = db < np.percentile(db, 25) + 2
    mids, run = [], -1
    for i, q in enumerate(np.append(quiet, False)):
        if q and run < 0:
            run = i
        elif not q and run >= 0:
            if (i - run) * FRAME >= MIN_GAP:
                mids.append((run + i) / 2 * FRAME)
            run = -1
    return np.array(mids)


def snap(t, mids):
    if len(mids) == 0:
        return t
    j = int(np.argmin(np.abs(mids - t)))
    return float(mids[j]) if abs(mids[j] - t) <= SNAP else t


def plan(marks, lines, total, mids):
    """[(start, end, first_line, last_line)] for each clip."""
    if len(marks) != len(lines):
        raise ValueError(f"expected one mark per line ({len(lines)}), got {len(marks)}")
    bounds = [0.0] + [snap(m, mids) for m in marks[:-1]] + [min(marks[-1], total)]
    groups, start, first = [], bounds[0], 0
    for i in range(len(lines)):
        end = bounds[i + 1]
        nxt = bounds[i + 2] if i + 2 < len(bounds) else None
        # Close the clip here if adding the next line would make it too long, or at the last line.
        if nxt is None or nxt - start > MAX_SECONDS:
            groups.append((start, end, first, i))
            start, first = end, i + 1
    # A very short tail is merged into the previous clip when that still fits.
    if len(groups) > 1 and groups[-1][1] - groups[-1][0] < MIN_SECONDS and groups[-1][1] - groups[-2][0] <= MAX_SECONDS + 3:
        (s, _, f, _), (_, e, _, l) = groups[-2], groups[-1]
        groups[-2:] = [(s, e, f, l)]
    return groups


def segment(path, marks, out_dir, id_prefix, lines):
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    total = len(audio) / rate
    clips = []
    for k, (s, e, f, l) in enumerate(plan(marks, lines, total, pauses(audio, rate))):
        cid = f"{id_prefix}-{k:02d}"
        piece = audio[int(s * rate): int(e * rate)]
        p16, p48 = os.path.join(out_dir, "16k", f"{cid}.wav"), os.path.join(out_dir, "48k", f"{cid}.wav")
        os.makedirs(os.path.dirname(p16), exist_ok=True)
        os.makedirs(os.path.dirname(p48), exist_ok=True)
        sf.write(p16, to_16k(piece, rate), 16000, subtype="PCM_16")
        sf.write(p48, piece, rate, subtype="PCM_16")
        clips.append({"id": cid, "start": round(s, 2), "end": round(e, 2), "seconds": round(e - s, 2),
                      "text": " ".join(x.strip() for x in lines[f:l + 1]), "lines": [f, l], "path_16k": p16, "path_48k": p48})
    return clips
