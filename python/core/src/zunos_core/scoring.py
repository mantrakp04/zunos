import random
import unicodedata

from .textnorm import basic, cer, fuzzy, roman_cer, to_roman, wer

# Languages people usually type in English letters (plus English itself): spelling variants are
# forgiven (chhe = che, wapas = waapas). Every other language is compared after basic normalization.
FUZZY_LANGS = {"en", "hi", "gu", "mr", "pa", "bn", "ta", "te", "kn", "ml", "ur", "ne"}


def norm(text, lang):
    return fuzzy(text) if lang in FUZZY_LANGS else basic(text)


def clip_wer(hyp, ref, lang, plain=False):
    """WER of one clip under the language's normalization (basic only if `plain`), and the reference word count."""
    n = basic if plain else (lambda t: norm(t, lang))
    r = n(ref)
    return wer(n(hyp), r), len(r.split())


def is_latin(text):
    letters = [c for c in text if c.isalpha()]
    return not letters or all("LATIN" in unicodedata.name(c, "") for c in letters)


def synth_score(hyp, target, lang):
    """Quality score of a voice-cloned clip against the text it should say (lower is better).

    English: WER. Targets in English letters (romanized Hindi, Gujarati...): Whisper may answer in
    native script, so both are transliterated to Latin and compared by character (roman_cer).
    Native-script targets (Japanese, Russian, Hindi in Devanagari...): CER after basic normalization.
    """
    if lang == "en":
        return wer(basic(hyp), basic(target))
    if is_latin(target):
        return roman_cer(hyp, target)
    return cer(basic(hyp).replace(" ", ""), basic(target).replace(" ", ""))


def aggregate(rows):
    """Word-weighted WER per language plus their mean.

    rows: dicts with lang, wer, words. Returns e.g. {"en": .., "hi": .., "avg": ..}; the mean is over
    the languages present.
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


def score_clips(clips, hyps, plain=False):
    """Aggregate scores and per-clip rows for clips ({id, lang, text}) and their transcripts."""
    rows = []
    for c, h in zip(clips, hyps):
        e, n = clip_wer(h, c["text"], c["lang"], plain)
        rows.append({"id": c["id"], "lang": c["lang"], "ref": c["text"], "hyp": h, "wer": round(e, 4), "words": n})
    return aggregate(rows), rows


def comparable(text, key_text):
    """Another recognizer's text in the answer key's script, so it is scored exactly like our model's output.

    When the key is in English letters (romanized Hindi, Gujarati...) and the text is in native script, the
    text is transliterated first (textnorm.to_roman, as in roman_cer).
    """
    return to_roman(text) if is_latin(key_text) and not is_latin(text) else text


def _wer_of(rows):
    words = sum(r["words"] for r in rows)
    return sum(r["wer"] * r["words"] for r in rows) / words if words else 0.0


def bootstrap(rows, other=None, n=2000, seed=0, level=0.95):
    """Per-language word-weighted WER with a percentile bootstrap confidence interval over clips.

    rows: per-clip dicts {id, lang, wer, words} (score_clips' rows). other: the same clips scored for another
    recognizer (matched by id); when given, each language also gets that recognizer's WER and the paired
    ratio other/ours (how many times lower our WER is), resampling the same clips for both.
    Returns {lang: {"n", "words", "wer", "ci": [lo, hi], "other"?, "other_ci"?, "ratio"?, "ratio_ci"?}}.
    """
    rng = random.Random(seed)
    lo_q, hi_q = (1 - level) / 2, 1 - (1 - level) / 2
    ci = lambda xs: [round(xs[int(lo_q * (len(xs) - 1))], 4), round(xs[int(hi_q * (len(xs) - 1))], 4)]
    theirs = {r["id"]: r for r in other or []}
    out = {}
    for lang in sorted({r["lang"] for r in rows}):
        ours = [r for r in rows if r["lang"] == lang]
        pairs = [(r, theirs.get(r["id"])) for r in ours]
        paired = [p for p in pairs if p[1] is not None] if other is not None else []
        res = {"n": len(ours), "words": sum(r["words"] for r in ours), "wer": round(_wer_of(ours), 4)}
        samples = sorted(_wer_of([rng.choice(ours) for _ in ours]) for _ in range(n))
        res["ci"] = ci(samples)
        if paired:
            a, b = [p[0] for p in paired], [p[1] for p in paired]
            res["paired_n"] = len(paired)
            res["other"] = round(_wer_of(b), 4)
            ratio = lambda x, y: (y / x) if x > 0 else (float("inf") if y > 0 else 1.0)
            res["ratio"] = round(ratio(_wer_of(a), _wer_of(b)), 3)
            ows, rs = [], []
            for _ in range(n):
                idx = [rng.randrange(len(paired)) for _ in paired]
                x, y = _wer_of([a[i] for i in idx]), _wer_of([b[i] for i in idx])
                ows.append(y)
                rs.append(ratio(x, y))
            res["other_ci"], res["ratio_ci"] = ci(sorted(ows)), ci(sorted(rs))
        out[lang] = res
    return out


TARGET_RATIO = 2.0


def verdict(stats, target=TARGET_RATIO):
    """The 2x goal per language: "pass" when the CI's lower bound clears the target, "likely" when only the
    point estimate does, "fail" otherwise, "n/a" without a reference on the same clips."""
    if "ratio" not in stats:
        return "n/a"
    if stats["ratio_ci"][0] >= target:
        return "pass"
    return "likely" if stats["ratio"] >= target else "fail"
