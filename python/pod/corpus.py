"""Sentences for synthetic speech, per language, in this order (deduplicated):

  packages/db/corpus/<lang>.synth.json   sentences written only for synthesis (the user never reads them)
  packages/db/corpus/<lang>.json         the reading corpus (passages and sentences the user records)
  the dataset's built-in prompts         (gen.include_prompts)

A corpus file is {lang, items: [{id, kind, title?, native: [lines], roman: [lines] | null}], ...} (a bare
list of items is accepted too). Every line is one sentence to synthesize. The label (what the model learns to write) is in the script the user reads and
writes for that language: romanized when their real clips are in English letters and the item has roman
lines, else native. The TTS always reads the native line (cloning models read native script best).

Test safety: the user reads this same corpus when recording, so some lines are test clips. A line is dropped
when it shares a word 3-gram with any test clip (both normalized), and a line shorter than 3 words is dropped
when it equals a test clip's text. Nothing a test clip says is ever synthesized or trained on. Words are split
on whitespace and punctuation only: textnorm.basic also drops Indic vowel signs and viramas, which cut native
words into consonant fragments and made the guard reject most Gujarati lines over fragments such as ત ય ર.
"""
import json
import os
import re
import unicodedata

from zunos_core.scoring import is_latin, norm

DIGITS = re.compile(r"\d")  # any script's digits

CODE = os.path.dirname(os.path.abspath(__file__))
# The pod archive carries the corpus at <root>/packages/db/corpus (podcode.ts); locally it is the repo's.
CORPUS_DIRS = [os.environ.get("ZUNOS_CORPUS_DIR", ""), os.path.join(CODE, "../../packages/db/corpus")]


def corpus_files(lang):
    for d in CORPUS_DIRS:
        if d and os.path.exists(f"{d}/{lang}.json") or d and os.path.exists(f"{d}/{lang}.synth.json"):
            return [f for f in (f"{d}/{lang}.synth.json", f"{d}/{lang}.json") if os.path.exists(f)]
    return []


def items_of(path):
    d = json.load(open(path, encoding="utf-8"))
    return d["items"] if isinstance(d, dict) else d


def words(text, lang):
    """Normalized words: norm() for text in English letters; native scripts keep their combining marks."""
    if is_latin(text):
        return norm(text, lang).split()
    t = unicodedata.normalize("NFC", text).lower().replace("\u200c", "").replace("\u200d", "")
    return "".join(c if c.isalnum() or c.isspace() or unicodedata.category(c)[0] == "M" else " " for c in t).split()


def grams(text, lang, n=3):
    w = words(text, lang)
    return {tuple(w[i:i + n]) for i in range(len(w) - n + 1)}


class TestGuard:
    """Rejects any text that overlaps a test clip of the same language."""

    def __init__(self, clips):
        self.grams, self.short = {}, {}
        for c in clips:
            if c["split"] != "test":
                continue
            for t in filter(None, (c.get("text"), c.get("native_text"))):
                self.grams.setdefault(c["lang"], set()).update(grams(t, c["lang"]))
                self.short.setdefault(c["lang"], set()).add(" ".join(words(t, c["lang"])))

    def ok(self, text, lang):
        if not text:
            return True
        if " ".join(words(text, lang)) in self.short.get(lang, ()):
            return False
        return not (grams(text, lang) & self.grams.get(lang, set()))


def target_script(lang, clips, override=None):
    """"roman" when the user's real clips of the language are in English letters (and it isn't English)."""
    if override:
        return override
    texts = [c["text"] for c in clips if c["lang"] == lang and c.get("text")]
    latin = sum(is_latin(t) for t in texts)
    return "roman" if lang != "en" and texts and latin * 2 > len(texts) else "native"


def sentences(lang, manifest, gen, guard, script=None):
    """[(sid, label, tts_text)] for a language, deduplicated, test-safe, corpus first. `script` forces the label
    script (config.label_script); else the manifest cfg's `scripts`, else the script of the user's clips."""
    script = target_script(lang, manifest["clips"], script or (manifest.get("cfg") or {}).get("scripts", {}).get(lang))
    out, seen, dropped, digits = [], set(), 0, 0

    def add(sid, native, roman):
        nonlocal dropped, digits
        label = (roman if script == "roman" and roman else native) or roman
        tts = native or roman
        if not label or not tts:
            return
        if gen.get("drop_digits") and (DIGITS.search(label) or DIGITS.search(tts)):
            digits += 1
            return
        if not (guard.ok(label, lang) and guard.ok(tts, lang)):
            dropped += 1
            return
        key = " ".join(words(label, lang))
        if key in seen:
            return
        seen.add(key)
        out.append((sid, label.strip(), tts.strip()))

    paths = corpus_files(lang)
    for path in paths:
        for item in items_of(path):
            roman = item.get("roman") or [None] * len(item["native"])
            for i, (n, r) in enumerate(zip(item["native"], roman)):
                add(f"{item['id']}-{i:02d}", n, r)
    if gen.get("include_prompts", True):
        for p in manifest.get("prompts", []):
            if p["lang"] == lang:
                # Built-in prompts store the user's script in `roman` and native script in `native`.
                roman = p.get("roman")
                native = p.get("native") or (roman if not is_latin(roman or "") or lang == "en" else None)
                add(f"p-{p['id']}", native or roman, roman if is_latin(roman or "") else None)
    limit = int(gen.get("max_lines_per_lang") or 0)
    return (out[:limit] if limit else out), {"script": script, "dropped_for_test_overlap": dropped, "dropped_digits": digits,
                                             "corpus": [os.path.basename(p) for p in paths]}
