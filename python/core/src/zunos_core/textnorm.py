import re, unicodedata

def basic(s):
    s = unicodedata.normalize("NFC", s).lower()
    s = s.replace("’", "'")
    s = re.sub(r"[^\w\s']", " ", s)
    s = re.sub(r"(?<!\w)'|'(?!\w)", " ", s)
    return re.sub(r"\s+", " ", s).strip()

RULES = [("chh", "ch"), ("ksh", "x"), ("sh", "s"), ("ph", "f"), ("aa", "a"), ("ee", "i"), ("ii", "i"), ("oo", "u"),
         ("uu", "u"), ("w", "v"), ("z", "j"), ("y", "i"), ("q", "k")]

def fuzzy(s):
    s = basic(s).replace("'", "")
    for a, b in RULES:
        s = s.replace(a, b)
    s = re.sub(r"([a-z])\1+", r"\1", s)
    s = re.sub(r"h\b", "", s)
    s = re.sub(r"(?<=[bcdgjkptd])h", "", s)
    return re.sub(r"\s+", " ", s).strip()

def native_chars(s):
    s = unicodedata.normalize("NFC", s)
    return "".join(ch for ch in s if unicodedata.category(ch)[0] in "LM")

def edit(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, y in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y))
        prev = cur
    return prev[-1]

def wer(hyp, ref):
    r = ref.split()
    return edit(hyp.split(), r) / max(1, len(r))

def cer(hyp, ref):
    return edit(list(hyp), list(ref)) / max(1, len(ref))

_SCRIPTS = None

# Tamil, the way people type it in English letters. sanscript's Tamil scheme reads every stop as voiced and
# aspirated (வணக்கம் → vaNaghgham), so Tamil has its own table.
_TA_CONS = dict(zip("கஙசஞடணதநபமயரலவழளறனஜஷஸஹ", "k ng ch nj t n th n p m y r l v zh l r n j sh s h".split()))
_TA_VOW = dict(zip("அஆஇஈஉஊஎஏஐஒஓஔ", "a aa i ii u uu e ee ai o oo au".split()))
_TA_SIGN = dict(zip("ாிீுூெேைொோௌ", "aa i ii u uu e ee ai o oo au".split()))


def _tamil(w):
    out, i = [], 0
    while i < len(w):
        c = w[i]
        nxt = w[i + 1] if i + 1 < len(w) else ""
        if c in _TA_CONS:
            out.append(_TA_CONS[c])
            if nxt == "\u0bcd":  # pulli: no vowel
                i += 1
            elif nxt in _TA_SIGN:
                out.append(_TA_SIGN[nxt])
                i += 1
            else:
                out.append("a")
        elif c in _TA_VOW:
            out.append(_TA_VOW[c])
        elif c == "\u0b83":  # aytham
            out.append("h")
        elif not (0x0B80 <= ord(c) <= 0x0BFF):
            out.append(c)
        i += 1
    return "".join(out)


def to_roman(s):
    global _SCRIPTS
    from indic_transliteration import sanscript as sc
    if _SCRIPTS is None:
        # (first, last code point, scheme, drops the final inherent vowel). Indo-Aryan scripts write a final
        # consonant without its vowel in speech (कमल is "kamal"); Dravidian ones pronounce it.
        _SCRIPTS = [(0x0900, 0x097F, sc.DEVANAGARI, True), (0x0980, 0x09FF, sc.BENGALI, True),
                    (0x0A00, 0x0A7F, sc.GURMUKHI, True), (0x0A80, 0x0AFF, sc.GUJARATI, True),
                    (0x0B00, 0x0B7F, sc.ORIYA, True), (0x0B80, 0x0BFF, sc.TAMIL, False),
                    (0x0C00, 0x0C7F, sc.TELUGU, False), (0x0C80, 0x0CFF, sc.KANNADA, False),
                    (0x0D00, 0x0D7F, sc.MALAYALAM, False)]
    out = []
    for w in unicodedata.normalize("NFC", s).split():
        script, schwa = next(((sch, d) for lo, hi, sch, d in _SCRIPTS if any(lo <= ord(c) <= hi for c in w)), (None, False))
        if script is None:
            out.append(w)
            continue
        if script == sc.TAMIL:
            out.append(_tamil(w))
            continue
        r = sc.transliterate(w, script, sc.ITRANS)
        last = [c for c in w if unicodedata.category(c)[0] in "LM" and unicodedata.name(c, "").find("NUKTA") < 0]  # nukta keeps the consonant
        core, tail = re.match(r"(.*?)([^\w.~]*)$", r).groups()  # trailing punctuation (पापड़, → pApaD,)
        if schwa and last and unicodedata.category(last[-1]) == "Lo" and core.lower().endswith("a") and not core.lower().endswith("aa"):
            r = core[:-1] + tail
        # ITRANS marks (.D for ड़, ~n for ञ, .h for a virama...) would split words once punctuation is stripped.
        out.append(r.replace("M", "n").replace(".N", "n").replace(".n", "n").replace(".h", "").replace(".", "").replace("~", ""))
    return " ".join(out)

def roman_cer(hyp, target):
    a = fuzzy(to_roman(hyp)).replace(" ", "")
    b = fuzzy(target).replace(" ", "")
    return cer(a, b)
