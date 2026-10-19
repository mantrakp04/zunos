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

def to_roman(s):
    global _SCRIPTS
    from indic_transliteration import sanscript as sc
    if _SCRIPTS is None:
        _SCRIPTS = [(0x0900, 0x097F, sc.DEVANAGARI), (0x0A80, 0x0AFF, sc.GUJARATI)]
    out = []
    for w in unicodedata.normalize("NFC", s).split():
        script = next((sch for lo, hi, sch in _SCRIPTS if any(lo <= ord(c) <= hi for c in w)), None)
        if script is None:
            out.append(w)
            continue
        r = sc.transliterate(w, script, sc.ITRANS)
        last = [c for c in w if unicodedata.category(c)[0] in "LM"]
        if last and unicodedata.category(last[-1]) == "Lo" and r.lower().endswith("a") and not r.lower().endswith("aa"):
            r = r[:-1]
        out.append(r.replace("M", "n").replace(".N", "n"))
    return " ".join(out)

def roman_cer(hyp, target):
    a = fuzzy(to_roman(hyp)).replace(" ", "")
    b = fuzzy(target).replace(" ", "")
    return cer(a, b)
