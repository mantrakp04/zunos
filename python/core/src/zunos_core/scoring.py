import unicodedata

from .textnorm import basic, cer, fuzzy, roman_cer, wer

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
