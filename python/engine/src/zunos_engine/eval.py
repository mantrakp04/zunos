"""Score a model on held-back clips with fuzzy WER (the project's headline metric).

    uv run zunos-eval <model-dir> <clips-dir> [--beams 4]

<clips-dir> holds transcripts.jsonl and 16k/<id>.wav (the layout of the legacy data/final). Only the
legacy test ids are scored from the command line; the app passes its own test clips to evaluate().
"""
import argparse
import json
import os
import time

import soundfile as sf
from zunos_core.scoring import aggregate, clip_wer
from zunos_core.testset import LEGACY_TEST


def evaluate(model, clips, beams=4, on_clip=None):
    """clips: dicts with id, lang, text, path (16 kHz wav). Returns {"rows": [...], "scores": {...}}."""
    rows = []
    for c in clips:
        audio, rate = sf.read(c["path"], dtype="float32")
        assert rate == 16000, f"{c['path']} is {rate} Hz, expected 16000"
        hyp, lang = model.transcribe(audio, beams=beams)
        e, n = clip_wer(hyp, c["text"])
        row = {"id": c["id"], "lang": c["lang"], "ref": c["text"], "hyp": hyp, "detected": lang, "wer": round(e, 4), "words": n}
        rows.append(row)
        if on_clip:
            on_clip(row)
    return {"rows": rows, "scores": aggregate(rows)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("clips")
    ap.add_argument("--beams", type=int, default=4)
    a = ap.parse_args()
    from .model import Model

    d = os.path.expanduser(a.clips)
    clips = [dict(r, path=f"{d}/16k/{r['id']}.wav") for r in map(json.loads, open(f"{d}/transcripts.jsonl", encoding="utf-8"))
             if r["id"] in LEGACY_TEST]
    model = Model(os.path.expanduser(a.model), beams=a.beams)
    t0 = time.time()
    out = evaluate(model, clips, a.beams, on_clip=lambda r: print(f"{r['id']:18} {r['wer']:6.1%} {r['hyp'][:80]}", flush=True))
    audio = sum(c["seconds"] for c in clips)
    print(out["scores"], f"| {audio:.0f}s audio in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
