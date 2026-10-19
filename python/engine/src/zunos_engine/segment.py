"""Cut a prompt recording into training clips at line boundaries.

The recorder stores `marks`: the second at which the reader moved past each line (the last mark is
the end). Each boundary is snapped to the middle of the nearest pause, then consecutive lines are
grouped into clips of at most MAX_SECONDS so every clip fits Whisper's 30 s window with its exact text.
Clips are cut from the raw take (training input and test set) and from its cleaned version (enhance.py,
voice-cloning references), at the same sample positions.
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


def quiet_frames(audio, rate):
    """One flag per FRAME: below the 25th-percentile level + 2 dB."""
    n = int(rate * FRAME)
    frames = len(audio) // n
    if frames == 0:
        return np.zeros(0, bool)
    rms = np.sqrt(np.mean(audio[: frames * n].reshape(frames, n) ** 2, axis=1))
    db = 20 * np.log10(rms + 1e-9)
    return db < np.percentile(db, 25) + 2


def pauses(audio, rate, quiet=None):
    """Midpoints (seconds) of quiet stretches (quiet_frames)."""
    quiet = quiet_frames(audio, rate) if quiet is None else quiet
    if len(quiet) == 0:
        return np.array([])
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


DOUBLE_PRESS = 0.3  # a mark this close after the previous one is the same key press twice
END_SLACK = 0.5  # a last mark this close to the end of the audio is the end
LOST_RATE = 1.85  # a line this many times slower per character than the median hides a lost mark (two lines read ~2x)


def fix_marks(marks, lines, total, read=None, quiet=None):
    """(marks, n): one boundary per line read, the last at the end of the audio, and n, the lines read.

    Recorder slips are repaired rather than failing the take: a missing end (the end of the audio is
    the last line's end), double presses, marks out of order or past the end, a lost mark (null at its
    index, `read` higher than the marks, or, with no `read`, one line far slower per character of speech
    than the rest; placed by text length, snapped to a pause later), and extra marks with no `read` (the
    shortest lines are merged). Lines after the last one read are dropped, never merged: a take stopped
    part-way keeps what was read. `quiet` (quiet_frames) makes speech rates ignore pauses and the lead-in.
    """
    if not lines:
        raise ValueError("the prompt has no lines")
    chars = [max(len(x.strip()), 1) for x in lines]
    ms = []
    for m in marks or []:
        if m is None or not np.isfinite(m):
            ms.append(None)
            continue
        m = min(float(m), total)
        known = [x for x in ms if x is not None]
        if m <= 0 or (known and m - known[-1] < DOUBLE_PRESS):
            continue
        ms.append(m)
    while ms and ms[-1] is None:
        ms.pop()
    if ms and total - ms[-1] <= END_SLACK:
        ms[-1] = total
    else:
        ms.append(total)

    def place(ms):
        """Fill null marks by text length between their known neighbours."""
        for i, m in enumerate(ms):
            if m is not None:
                continue
            p = max((j for j in range(i) if ms[j] is not None), default=-1)
            q = next(j for j in range(i + 1, len(ms)) if ms[j] is not None)
            a, b = ms[p] if p >= 0 else 0.0, ms[q]
            w = [chars[min(k, len(chars) - 1)] for k in range(p + 1, q + 1)]
            ms[i] = a + (b - a) * sum(w[: i - p]) / sum(w)
        return ms

    def split(ms, i):
        """Interval i holds two lines: add the boundary between them by text length."""
        a = ms[i - 1] if i > 0 else 0.0
        ci, cj = chars[min(i, len(chars) - 1)], chars[min(i + 1, len(chars) - 1)]
        return ms[:i] + [a + (ms[i] - a) * ci / (ci + cj)] + ms[i:]

    def spoken(ms):
        """Seconds of speech in each line's interval: quiet frames (pauses, the wait before reading) don't count."""
        starts = [0.0] + ms[:-1]
        if quiet is None:
            return [e - s for s, e in zip(starts, ms)]
        return [float((~quiet[int(s / FRAME):int(e / FRAME)]).sum()) * FRAME for s, e in zip(starts, ms)]

    def rates(ms):
        return [t / chars[min(i, len(chars) - 1)] for i, t in enumerate(spoken(ms))]

    ms = place(ms)
    if read:
        # The screen says how far the reader got: lines past that weren't read, whatever was marked after them.
        n = min(len(lines), max(1, int(read)))
        if len(ms) > n:
            ms = ms[:n]
        while len(ms) < n:  # more lines read than marked: the slowest line holds a lost mark
            ms = split(ms, int(np.argmax(rates(ms))))
        return ms, n
    while len(ms) > len(lines):  # extra marks (e.g. one on the last line, then stop): merge the shortest line, keeping the end
        j = int(np.argmin(np.diff([0.0] + ms)))
        del ms[min(j, len(ms) - 2)]
    # No word on how far the reader got: a line far slower than the rest, with enough extra speech for the next
    # line, is two lines with a lost mark. Otherwise the take stopped part-way and the unread lines are dropped.
    while len(lines) > len(ms) >= 4:
        r, t = rates(ms), spoken(ms)
        # Line 0 is never a candidate: it holds the lead-in and readers start slowly (a lost first mark needs `read`).
        i = max(range(1, len(ms)), key=lambda k: r[k])
        med = float(np.median(r[:i] + r[i + 1:]))
        extra = t[i] - med * chars[i]
        if r[i] <= LOST_RATE * med or extra < 0.9 * med * chars[min(i + 1, len(chars) - 1)]:
            break
        ms = split(ms, i)
    return ms, len(ms)


def plan(marks, lines, total, mids, read=None, quiet=None):
    """[(start, end, first_line, last_line)] for each clip."""
    marks, n = fix_marks(marks, lines, total, read, quiet)
    bounds = [0.0]
    for m in marks[:-1]:
        bounds.append(max(snap(m, mids), bounds[-1] + FRAME))
    end = marks[-1] if marks[-1] >= total - END_SLACK else snap(marks[-1], mids)  # unread lines cut off: end in a pause
    bounds.append(max(end, bounds[-1] + FRAME))
    groups, start, first = [], bounds[0], 0
    for i in range(n):
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


def clip_quality(piece, rate, noise_db):
    """Level, SNR (against the take's noise floor) and clipping of one clip of the raw take."""
    from .enhance import db, frame_power, voiced

    if len(piece) == 0:
        return None
    p = frame_power(piece, rate)
    v = voiced(db(p), noise_db) if noise_db is not None else np.ones(len(p), bool)
    speech = float(db(p[v].mean())) if v.any() else None
    return {
        "speechDb": round(speech, 1) if speech is not None else None,
        "snrDb": round(speech - noise_db, 1) if speech is not None and noise_db is not None else None,
        "peakDb": round(float(db(np.abs(piece).max() ** 2)), 1),
        "clippedPct": round(100 * float((np.abs(piece) >= 0.995).mean()), 3),
    }


def segment(path, marks, out_dir, id_prefix, lines, clean_path=None, noise_db=None, read=None):
    """Cut the raw take (and its cleaned version, when there is one, at the same sample positions)."""
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    clean = None
    if clean_path and os.path.exists(clean_path):
        clean, crate = sf.read(clean_path, dtype="float32", always_2d=True)
        clean = clean.mean(axis=1) if crate == rate and abs(len(clean) - len(audio)) <= 1 else None
    total = len(audio) / rate
    clips = []
    quiet = quiet_frames(audio, rate)
    for k, (s, e, f, l) in enumerate(plan(marks, lines, total, pauses(audio, rate, quiet), read, quiet)):
        cid = f"{id_prefix}-{k:02d}"
        a, b = int(s * rate), int(e * rate)
        piece = audio[a:b]
        p16, p48 = os.path.join(out_dir, "16k", f"{cid}.wav"), os.path.join(out_dir, "48k", f"{cid}.wav")
        os.makedirs(os.path.dirname(p16), exist_ok=True)
        os.makedirs(os.path.dirname(p48), exist_ok=True)
        sf.write(p16, to_16k(piece, rate), 16000, subtype="PCM_16")
        sf.write(p48, piece, rate, subtype="PCM_16")
        pc = None
        if clean is not None:
            pc = os.path.join(out_dir, "48k-clean", f"{cid}.wav")
            os.makedirs(os.path.dirname(pc), exist_ok=True)
            sf.write(pc, clean[a:b], rate, subtype="PCM_16")
        clips.append({"id": cid, "start": round(s, 2), "end": round(e, 2), "seconds": round(e - s, 2),
                      "text": " ".join(x.strip() for x in lines[f:l + 1]), "lines": [f, l], "path_16k": p16, "path_48k": p48,
                      "path_48k_clean": pc, "quality": clip_quality(piece, rate, noise_db)})
    return clips
