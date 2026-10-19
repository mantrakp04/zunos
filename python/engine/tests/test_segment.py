"""Line marks → clips (segment.py) on synthetic takes. Runs under pytest, or directly:
uv run --frozen --project engine python engine/tests/test_segment.py
"""
import os
import tempfile

import numpy as np
import soundfile as sf

from zunos_engine.segment import fix_marks, pauses, plan, quiet_frames, segment

RATE = 16000
LINES = [
    "Every morning at a quarter past six, Meera unlocks the small clinic on Station Road.",
    "The first patient is usually Mr. Desai, who is seventy-two and walks with a stick.",
    "It never is, of course, but he likes to argue about it while she wraps the cuff.",
    "By eight o'clock the waiting room is full of people who refuse to stop talking.",
    "Meera keeps a notebook with everyone's names, their medicines, and their visits.",
    "Last Thursday the power went out for almost three hours, and nobody complained.",
    "Around noon the rush slows down, and Meera eats her lunch while reading the paper.",
    "In the afternoon she phones patients who missed their appointments, gently.",
]


def take(lines, lead=1.5, gap=0.7, tail=0.8, per_char=0.06, slow_first=1.0, seed=0):
    """Noise bursts (speech) of a length set by each line's text, with quiet gaps. Returns audio and line ends."""
    rng = np.random.default_rng(seed)
    parts, ends, t = [rng.normal(0, 0.001, int(lead * RATE))], [], lead
    for i, line in enumerate(lines):
        d = len(line) * per_char * (slow_first if i == 0 else 1.0)
        n = int(d * RATE)
        syllables = np.sin(np.pi * 4 * np.arange(n) / RATE) ** 2  # 4 Hz level swings, like speech
        parts.append(rng.normal(0, 0.2, n) * (0.1 + syllables))
        t += d
        ends.append(t)
        g = gap if i < len(lines) - 1 else tail
        parts.append(rng.normal(0, 0.001, int(g * RATE)))
        t += g
    return np.concatenate(parts).astype(np.float32), ends


def run(audio, marks, lines, read=None):
    q = quiet_frames(audio, RATE)
    return plan(marks, lines, len(audio) / RATE, pauses(audio, RATE, q), read, q)


def read_lines(groups):
    return [i for _, _, f, l in groups for i in range(f, l + 1)]


def assert_cuts_in_gaps(groups, ends, gap=0.7):
    """Every clip edge between lines falls in the pause after a line, not inside speech."""
    for s, e, f, l in groups:
        assert ends[l] - 0.05 <= e <= ends[l] + gap + 0.85, (e, ends[l])
        if f > 0:
            assert ends[f - 1] - 0.05 <= s <= ends[f - 1] + gap + 0.05, (s, ends[f - 1])


def presses(ends, early=0.3):
    """The reader presses Space a little before finishing each line (as recorded takes show)."""
    return [e - early for e in ends]


def test_full_take():
    audio, ends = take(LINES)
    marks = presses(ends)[:-1] + [len(audio) / RATE]
    g = run(audio, marks, LINES)
    assert read_lines(g) == list(range(len(LINES)))
    assert_cuts_in_gaps(g, ends)


def test_lost_interior_mark_end_included():
    """The owner's failure: one Space never reached the recorder; marks = lines - 1 (end included)."""
    audio, ends = take(LINES)
    m = presses(ends)[:-1]
    marks = m[:4] + m[5:] + [len(audio) / RATE]
    assert len(marks) == len(LINES) - 1
    for read in (None, len(LINES)):
        g = run(audio, marks, LINES, read)
        assert read_lines(g) == list(range(len(LINES))), read
        assert_cuts_in_gaps(g, ends)


def test_lost_mark_as_null():
    audio, ends = take(LINES)
    m = presses(ends)[:-1]
    g = run(audio, m[:4] + [None] + m[5:] + [len(audio) / RATE], LINES)
    assert read_lines(g) == list(range(len(LINES)))
    assert_cuts_in_gaps(g, ends)


def test_lines_minus_one_marks_without_end():
    """A caller that leaves out the final mark: the end of the audio is the last line's end."""
    audio, ends = take(LINES)
    g = run(audio, presses(ends)[:-1], LINES)
    assert read_lines(g) == list(range(len(LINES)))
    assert g[-1][1] == len(audio) / RATE


def test_partial_take_keeps_read_lines():
    """Stopped after 4 lines with a slow first line and a long wait before reading: no false lost mark."""
    audio, ends = take(LINES[:4], lead=3.0, slow_first=1.6)
    marks = presses(ends)[:-1] + [len(audio) / RATE]
    g = run(audio, marks, LINES)
    assert read_lines(g) == [0, 1, 2, 3]
    assert_cuts_in_gaps(g, ends)


def test_partial_take_short():
    audio, ends = take(LINES[:2])
    g = run(audio, presses(ends)[:-1] + [len(audio) / RATE], LINES)
    assert read_lines(g) == [0, 1]


def test_read_lower_than_marks_drops_unread_lines():
    """5 line ends and a stop, read=5: the stretch after the 5th mark is dropped, not merged into a line."""
    audio, ends = take(LINES[:6])
    marks = presses(ends)[:5] + [len(audio) / RATE]
    g = run(audio, marks, LINES, read=5)
    assert read_lines(g) == [0, 1, 2, 3, 4]
    assert g[-1][1] < ends[5] - 1.0, (g[-1], ends)
    assert_cuts_in_gaps(g, ends)


def test_double_press_and_mark_on_last_line():
    audio, ends = take(LINES)
    m = presses(ends)
    total = len(audio) / RATE
    twice = m[:3] + [m[3], m[3] + 0.1] + m[4:-1] + [total]
    g = run(audio, twice, LINES)
    assert read_lines(g) == list(range(len(LINES)))
    last_too = m + [total]  # Space on the last line, then stop
    g = run(audio, last_too, LINES)
    assert read_lines(g) == list(range(len(LINES)))
    assert_cuts_in_gaps(g, ends)



def test_one_line_then_minutes_of_silence():
    """A one-line take whose recorder kept running: the clip ends at the line, not three minutes later."""
    audio, ends = take(LINES[:1], tail=180.0)
    total = len(audio) / RATE
    g = run(audio, [ends[0] + 0.3, total], LINES[:1])
    assert read_lines(g) == [0] and g[-1][1] < ends[0] + 1.5, g
    g = run(audio, [total], LINES[:1])  # no mark at all: nothing says where the line ended, keep it whole
    assert read_lines(g) == [0]


def test_degenerate_inputs():
    audio, _ = take(LINES[:1])
    assert read_lines(run(audio, [], LINES[:1])) == [0]
    assert read_lines(run(audio, [float("nan"), -1, 1e9], LINES[:1])) == [0]
    try:
        fix_marks([1.0], [], 2.0)
    except ValueError:
        pass
    else:
        raise AssertionError("no lines should fail")


def test_segment_writes_both_rates():
    audio, ends = take(LINES[:3])
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "take.wav")
        sf.write(wav, audio, RATE, subtype="PCM_16")
        clips = segment(wav, presses(ends)[:1] + [len(audio) / RATE], d, "t", LINES[:3], read=3)  # one mark lost
        assert " ".join(c["text"] for c in clips) == " ".join(LINES[:3])
        for c in clips:
            assert os.path.exists(c["path_16k"]) and os.path.exists(c["path_48k"])


if __name__ == "__main__":
    tests = [(k, v) for k, v in dict(globals()).items() if k.startswith("test_")]
    for name, fn in tests:
        fn()
        print("ok", name)
