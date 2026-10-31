"""Real clips and their splits, shared by every step.

  test   the app's held-back clips (split='test'). Scored once, at the very end, by each variant's final
         model. Never trained on, never a voice reference, never a checkpoint-selection signal, and no
         synthetic sentence overlaps their text (corpus.TestGuard).
  dev    optional: dev.real_per_lang train clips per language held out to pick checkpoints (select=dev).
         Only taken when the language keeps at least dev.min_train_left train clips. Not voice references.
  train  everything else: training data, voice references, pace measurement, judge calibration.

The dev choice is a stable hash of the clip id, so every variant and every rerun sees the same split.
"""
import hashlib
import json
import os


def _rank(cid):
    return hashlib.sha256(f"dev|{cid}".encode()).hexdigest()


def assign(clips, dev_cfg):
    """clips from the manifest -> same dicts with split in {train, dev, test}."""
    out = [dict(c) for c in clips]
    per = int(dev_cfg.get("real_per_lang") or 0)
    if per <= 0:
        return out
    for lang in sorted({c["lang"] for c in out}):
        train = sorted((c for c in out if c["lang"] == lang and c["split"] == "train"), key=lambda c: _rank(c["id"]))
        if len(train) - per >= int(dev_cfg.get("min_train_left", 12)):
            for c in train[:per]:
                c["split"] = "dev"
    return out


def minutes_subset(clips, minutes):
    """The first clips, in a stable hash order of their ids, until `minutes` of audio: a smaller budget is always a
    subset of a larger one (data ablations)."""
    out, total = [], 0.0
    for c in sorted(clips, key=lambda c: hashlib.sha256(f"minutes|{c['id']}".encode()).hexdigest()):
        if total >= minutes * 60:
            break
        out.append(c)
        total += c["seconds"]
    return out


def speaker_clips(clips, minutes):
    """The train clips that voice references, pace and the judge's voice centroid come from: all of them, or the
    same nested `minutes` subset train.py trains a real_minutes variant on (never dev or test clips)."""
    train = [c for c in clips if c["split"] == "train"]
    return minutes_subset(train, minutes) if minutes else train


def write_real(work, clips):
    rows = [dict(id=c["id"], lang=c["lang"], kind=c.get("kind", "para"), seconds=c["seconds"], text=c["text"],
                 native_text=c.get("native_text"), split=c["split"], path=f"{work}/data/real/16k/{c['id']}.wav")
            for c in clips]
    with open(f"{work}/data/real.jsonl", "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return rows


def read_jsonl(path):
    return [json.loads(l) for l in open(path, encoding="utf-8")] if os.path.exists(path) else []


def write_jsonl(path, rows):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def synth_val_ids(sids, frac):
    """Sentence ids held out as synthetic validation (by sentence, so val sentences are never trained on)."""
    return {s for s in sids if int(hashlib.sha256(f"sval|{s}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF < frac}


def prompt_lines(p):
    """(native, roman) first lines of a prompts row, for both schemas: native/roman columns (current) or
    lines (the user's script) + native_lines (older databases, e.g. the 2026-10-19 archive)."""
    keys = p.keys()
    first = lambda v: (json.loads(v) or [None])[0] if v else None
    if "native" in keys:
        return first(p["native"]), first(p["roman"])
    lines, native = first(p["lines"]), first(p["native_lines"])
    return native or lines, lines
