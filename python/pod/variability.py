"""Speaking-style variability for synthetic takes: what each take does differently, drawn per take.

    plan(rng, lang, tts_text, cfg) -> {"tts_text", "effects", "denoise", "edits"}

make_jobs.py draws a plan per job (rng seeded by the job), gen_omnivoice.py carries it out. The label (what
the recognizer learns to write) is ALWAYS the clean intended sentence; only what the TTS reads changes, and
the job's target duration is scaled by letters(edited tts) / letters(original tts) so the pace stays the
user's. Settings (gen.variability; the 2026-10-19 OmniVoice study's adopted values):

  inpainting, at most `max_inpaint` (2) per take, done in OmniVoice's tokens (omni_vary.py):
    rush    p 0.25   2-4 words at 0.5-0.7x frames
    drag    p 0.15   1 word at 1.4-1.8x
    pause   p 0.15   0.3-0.8 s at a word boundary
    mumble  p 0.10   1-2 words at guidance 0-0.5, temperature 1-2
  text:
    reduce  p 0.20   respelled casual forms (English: CMU phonemes in [..], which OmniVoice reads; Hindi and
                     Gujarati: dropped ह/હ and common contractions)
    filler  p 0.10   a non-lexical filled pause (um, uh, अं...); never a word
    repeat  p 0.05   a repeated word or a false start (b- bank)
  denoise=False p 0.3 (OmniVoice copies more of the reference's room and noise)

Dropped by the study (worse words or voice for no gain): global temperature/guidance changes, formant and
pitch shifts, resampling slur, post-hoc WSOLA for pace (the model's own duration is used instead).
Engines other than OmniVoice get the text edits only.
"""
import re
import unicodedata

DEFAULTS = {
    "enabled": True, "max_inpaint": 2,
    "rush": {"p": 0.25, "words": [2, 4], "factor": [0.5, 0.7]},
    "drag": {"p": 0.15, "words": [1, 1], "factor": [1.4, 1.8]},
    "pause": {"p": 0.15, "seconds": [0.3, 0.8]},
    "mumble": {"p": 0.10, "words": [1, 2], "guid": [0.0, 0.5], "temp": [1.0, 2.0]},
    "reduce": {"p": 0.20, "share": 0.5},
    "filler": {"p": 0.10},
    "repeat": {"p": 0.05},
    "no_denoise": {"p": 0.30},
}

# English casual forms as CMU phonemes in brackets (OmniVoice reads [..] as ARPAbet). Phrases first.
EN_REDUCE = [("going to", "[G AH1 N AH0]"), ("want to", "[W AA1 N AH0]"), ("got to", "[G AA1 D AH0]"),
             ("let me", "[L EH1 M IY0]"), ("give me", "[G IH1 M IY0]"), ("don't know", "[D AH0 N OW1]"),
             ("kind of", "[K AY1 N AH0]"), ("sort of", "[S AO1 R D AH0]"), ("do you", "[D Y AH0]"),
             ("because", "[K AH0 Z]"), ("probably", "[P R AA1 L IY0]"), ("something", "[S AH1 M TH IH0 N]"),
             ("nothing", "[N AH1 TH IH0 N]"), ("just", "[JH AH0 S]"), ("next", "[N EH1 K S]"),
             ("them", "[AH0 M]"), ("and", "[AH0 N]"), ("about", "[B AW1 T]")]
HI_REDUCE = {"रहा": "रा", "रही": "री", "रहे": "रे", "बहुत": "बोत", "वहाँ": "वाँ", "यहाँ": "याँ", "कहाँ": "काँ",
             "इसलिए": "सलिए", "नहीं": "नईं", "सुबह": "सुबा", "तुम्हें": "तुमे", "चाहिए": "चइये", "टाइम": "टैम",
             "कहा": "का", "पहले": "पेले", "रहना": "रैना", "मुझे": "मुजे", "हैं": "एं"}
GU_REDUCE = {"બહુ": "બઉ", "હતી": "તી", "હતો": "તો", "હતું": "તું", "હતા": "તા", "એટલે": "ટલે", "વહેલા": "વેલા",
             "છે": "સે", "છો": "સો", "આવી": "આઈ", "સાંજે": "હાંજે", "પાસે": "પાહે", "સવારે": "હવારે",
             "અત્યારે": "અતારે", "નથી": "નથ", "કરીએ": "કરિયે", "રહ્યો": "રયો", "રહ્યું": "રયું", "કહે": "કે"}
REDUCE = {"hi": HI_REDUCE, "gu": GU_REDUCE}
FILLERS = {"en": ["um", "uh", "hmm"], "hi": ["अं", "हम्म"], "gu": ["અં", "હમ્મ"], "mr": ["अं"], "ne": ["अं"]}


def _u(rng, lo_hi):
    lo, hi = lo_hi
    return round(rng.uniform(lo, hi), 3)


def _ri(rng, lo_hi):
    return rng.randint(int(lo_hi[0]), int(lo_hi[1]))


def _strip(w):
    return re.sub(r"^\W+|\W+$", "", w)


def reduce_text(rng, lang, text, share):
    """Respell a random share of the eligible words (phrases for English)."""
    if lang == "en":
        out = text
        for phrase, cmu in EN_REDUCE:
            pat = re.compile(rf"\b{re.escape(phrase)}\b", re.I)
            out = pat.sub(lambda m: cmu if rng.random() < share else m.group(0), out)
        return out
    table = REDUCE.get(lang)
    if not table:
        return text
    words = text.split()
    for i, w in enumerate(words):
        core = _strip(w)
        if core in table and rng.random() < share:
            words[i] = w.replace(core, table[core])
    return " ".join(words)


def _first_syllable(w):
    """b- for Latin words, the first akshara for Indic scripts (base letter plus its marks)."""
    if all("LATIN" in unicodedata.name(c, "") for c in w if c.isalpha()):
        return w[: max(1, min(3, len(w) // 2))]
    out = ""
    for c in w:
        if out and unicodedata.category(c) not in ("Mn", "Mc"):
            break
        out += c
    return out


def plan(rng, lang, tts_text, cfg):
    c = {**DEFAULTS, **(cfg or {})}
    res = {"tts_text": tts_text, "effects": [], "denoise": True, "edits": []}
    if not c.get("enabled"):
        return res
    text = tts_text
    if rng.random() < c["reduce"]["p"]:
        new = reduce_text(rng, lang, text, c["reduce"]["share"])
        if new != text:
            text = new
            res["edits"].append("reduce")
    words = text.split()
    if len(words) >= 3 and lang in FILLERS and rng.random() < c["filler"]["p"]:
        i = rng.randint(1, len(words) - 1)
        words.insert(i, f"{rng.choice(FILLERS[lang])},")
        if not words[i - 1].endswith((",", ".", "?", "!", "।")):
            words[i - 1] += ","
        res["edits"].append("filler")
    if len(words) >= 3 and rng.random() < c["repeat"]["p"]:
        i = rng.randint(1, len(words) - 2)
        w = _strip(words[i])
        if w:
            words.insert(i, (w + ",") if rng.random() < 0.5 else (_first_syllable(w) + "-"))
            res["edits"].append("repeat")
    res["tts_text"] = " ".join(words)

    kinds = ["rush", "drag", "pause", "mumble"]
    rng.shuffle(kinds)
    for k in kinds:
        if len(res["effects"]) >= c["max_inpaint"]:
            break
        e = c[k]
        if rng.random() >= e["p"]:
            continue
        at = round(rng.uniform(0.15, 0.85), 3)  # fraction of the way through the words (never the edges)
        if k == "pause":
            res["effects"].append({"kind": k, "at": at, "seconds": _u(rng, e["seconds"])})
        elif k == "mumble":
            res["effects"].append({"kind": k, "at": at, "n_words": _ri(rng, e["words"]), "guid": _u(rng, e["guid"]),
                                   "temp": _u(rng, e["temp"])})
        else:
            res["effects"].append({"kind": k, "at": at, "n_words": _ri(rng, e["words"]), "factor": _u(rng, e["factor"])})
    res["denoise"] = rng.random() >= c["no_denoise"]["p"]
    return res


def disfluent(take):
    """True when the TTS read something other than the clean sentence (fillers, repeats, respellings)."""
    return bool(take.get("edits"))


# A post-hoc audio hook (perturb) is kept for training-time experiments; off by default. Implementations must
# keep pitch (tempo.tempo, never resampling) and every word.
def perturb(audio, sr, rng, cfg):
    return audio
