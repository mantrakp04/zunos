from .textnorm import fuzzy, wer

LANGS = ("en", "hi", "gu")


def clip_wer(hyp, ref):
    """Fuzzy WER of one clip and its reference word count."""
    return wer(fuzzy(hyp), fuzzy(ref)), len(fuzzy(ref).split())


def aggregate(rows):
    """Word-weighted fuzzy WER per language plus their mean.

    rows: dicts with lang, wer, words. Returns {"en": .., "hi": .., "gu": .., "avg": ..}; the mean is
    over the languages present, which matches the 3-language average when all are scored.
    """
    tot = {}
    for r in rows:
        t = tot.setdefault(r["lang"], [0.0, 0])
        t[0] += r["wer"] * r["words"]
        t[1] += r["words"]
    res = {k: round(v[0] / v[1], 3) for k, v in tot.items() if v[1]}
    if res:
        res["avg"] = round(sum(res.values()) / len(res), 3)
    return res
