"""Score the reference recognizer on the app's test clips and store its WER as baselines (provider "reference").

    uv run zunos-reference [--dry-run]

Needs REFERENCE_ASR_URL, REFERENCE_ASR_MODEL and REFERENCE_ASR_KEY, from the environment or from the
git-ignored .env.local at the repo root. Each clip's 16 kHz audio (the same file our model is scored on)
is sent once with its language; the raw response is cached in <app data>/reference/, so reruns only
pay for new or changed clips. Scoring is the same as ours (zunos_core.scoring.clip_wer, raw output):
when a clip's answer key is in English letters (romanized Hindi, Gujarati...) and the reference answers
in native script, its text is transliterated first (textnorm.to_roman, as in roman_cer).
"""
import argparse
import hashlib
import json
import os
import sqlite3
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from zunos_core.scoring import aggregate, clip_wer, comparable

from .eval import APP_DIR, app_test_clips

PROVIDER = "reference"
CACHE_DIR = Path(APP_DIR) / "reference"
ENV_FILE = Path(__file__).resolve().parents[4] / ".env.local"
# Whisper codes the reference recognizer spells differently (it takes ISO 639-1 or 639-3).
LANG_CODES = {"jw": "jv"}


def _settings():
    file = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            k, sep, v = line.partition("=")
            if sep and not k.lstrip().startswith("#"):
                file[k.strip()] = v.strip().strip("\"'")
    return {k: os.environ.get(k) or file.get(k) for k in ("REFERENCE_ASR_URL", "REFERENCE_ASR_MODEL", "REFERENCE_ASR_KEY")}


def config():
    cfg = _settings()
    missing = [k for k, v in cfg.items() if not v]
    if missing:
        raise SystemExit(f"missing {', '.join(missing)} (environment or {ENV_FILE})")
    return cfg


def multipart(fields, file_name, file_bytes):
    boundary = uuid.uuid4().hex
    out = b""
    for k, v in fields.items():
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    out += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file_name}"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
    out += file_bytes + f"\r\n--{boundary}--\r\n".encode()
    return out, f"multipart/form-data; boundary={boundary}"


def _cache_file(clip, model, audio=None):
    audio = audio if audio is not None else Path(clip["path"]).read_bytes()
    lang = LANG_CODES.get(clip["lang"], clip["lang"])
    key = hashlib.sha256(audio + f"|{lang}|{model}".encode()).hexdigest()[:16]
    return CACHE_DIR / f"{clip['id']}-{key}.json"


def cached_texts(clips):
    """{clip id: raw text} for the clips whose reference answer is already cached for their current audio.

    Never calls the service and needs no key, only REFERENCE_ASR_MODEL. Used to ship the reference's answers
    with a training dataset, so the pod scores both recognizers on the same clips and key.
    """
    model = _settings()["REFERENCE_ASR_MODEL"]
    out = {}
    for c in clips if model else []:
        f = _cache_file(c, model)
        if f.exists():
            out[c["id"]] = json.loads(f.read_text()).get("text", "")
    return out


def transcribe(cfg, clip):
    """The reference's raw response for one clip, from the cache when the audio, language and model match."""
    audio = Path(clip["path"]).read_bytes()
    lang = LANG_CODES.get(clip["lang"], clip["lang"])
    cached = _cache_file(clip, cfg["REFERENCE_ASR_MODEL"], audio)
    if cached.exists():
        return json.loads(cached.read_text()), True
    fields = {"model_id": cfg["REFERENCE_ASR_MODEL"], "language_code": lang, "tag_audio_events": "false", "temperature": "0"}
    body, ctype = multipart(fields, Path(clip["path"]).name, audio)
    req = urllib.request.Request(cfg["REFERENCE_ASR_URL"], data=body, method="POST",
                                 headers={"xi-api-key": cfg["REFERENCE_ASR_KEY"], "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{clip['id']}: HTTP {e.code} {e.read().decode(errors='replace')[:300]}") from None
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(res, ensure_ascii=False))
    return res, False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="score and print, but don't write baselines")
    a = ap.parse_args()
    cfg = config()
    rows, fresh = [], 0
    for c in app_test_clips():
        res, hit = transcribe(cfg, c)
        fresh += not hit
        hyp = comparable(res.get("text", ""), c["text"])
        e, n = clip_wer(hyp, c["text"], c["lang"])
        rows.append({"id": c["id"], "lang": c["lang"], "wer": e, "words": n})
        print(f"{c['id']:34} {e:6.1%} {'cached' if hit else 'new   '} {hyp[:70]}", flush=True)
    scores = aggregate(rows)
    print(f"{fresh} new request(s), {len(rows) - fresh} cached; WER {scores}")
    if a.dry_run:
        return
    db = sqlite3.connect(f"{APP_DIR}/zunos.db", timeout=30)
    with db:
        db.execute("DELETE FROM baselines WHERE provider = ?", (PROVIDER,))
        db.executemany("INSERT INTO baselines (provider, lang, wer) VALUES (?, ?, ?)",
                       [(PROVIDER, l, w) for l, w in scores.items() if l != "avg"])
    print(f"wrote {len(scores) - 1} baseline(s) to {APP_DIR}/zunos.db")


if __name__ == "__main__":
    main()
