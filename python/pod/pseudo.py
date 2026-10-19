"""Pseudo-labels: the user's unlabeled audio (dataset unlabeled/, later their everyday dictation) turned into
training data. One set per spec entry (config.PSEUDO); run.py runs the steps in the env each needs:

    python pseudo.py segment <work> <set>              (vad env; train env for provided labels) segments
    python pseudo.py voice <work> <set>                (train env) segments in the user's voice -> candidates
    python pseudo.py decode <work> <set> <teacher|agree> (train env) transcripts of the candidates
    python pseudo.py select <work> <set>               (train env) checks -> data/pseudo/<set>/rows.jsonl

  segment  silero-vad speech regions of every unlabeled recording, merged across short gaps into segments
           (pad on both sides). A recording that names its source and span is checked against the labeled clips'
           spans in the same source: they must not overlap (test audio never becomes training data).
           Provided labels (teacher "provided"): every unlabeled entry is already one segment and carries its label
           (`text`, in the script of the user's labels; in the app, the reference's transcript of a dictation, made
           in the background). No VAD; entries of 1-30 s are kept, each checked against the labeled clips' spans.
  voice    WavLM speaker embeddings (judge.py speaker, judge env) of the segments and of the user's labeled
           train clips (never the test clips); a segment is kept when its cosine to the clips' centroid is
           >= max(abs_min, min_rel x the clips' leave-one-out similarity). Drops other voices, music, chanting.
  decode   the teacher (and the agreeing model) transcribe the candidates with the language given, in the
           output mode of the user's labels. Transcripts are cached per model across sets. Provided labels
           skip the teacher.
  select   keep a segment when the teacher's text is non-empty, in the labels' script, at a sane letters/s, not
           looping, and the agreeing model's text is within max_disagree fuzzy WER of it (max_disagree None: the
           agreement is only reported). Any segment whose text
           matches a test clip's text is rejected, and an assertion checks none is left.

Segments, embeddings and transcripts live in <work>/pseudo/<segment key>/ (shared by sets with the same VAD
settings); the set's rows and report in <work>/data/pseudo/<set>/. Module level is standard library only (run.py
imports seg_dir).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from data import read_jsonl, write_jsonl  # noqa: E402

SR = 16000
MARGIN_S = 5.0  # unlabeled audio must stay this far from any labeled clip of the same source


def set_cfg(work, name):
    cfg = json.load(open(f"{work}/data/cfg.json"))
    return cfg, cfg["pseudo"][name]


def provided(p):
    return p["teacher"] == "provided"


def seg_dir(work, p):
    import config

    recs = read_jsonl(f"{work}/data/unlabeled.jsonl")
    key = [p["vad"], p["max_minutes"], [r["id"] for r in recs]] + (["provided"] if provided(p) else [])
    return f"{work}/pseudo/seg-{config.digest(*key)}"


def set_dir(work, name):
    d = f"{work}/data/pseudo/{name}"
    os.makedirs(d, exist_ok=True)
    return d


# ------------------------------------------------------------------ guards

def check_spans(recs, clips, margin=MARGIN_S):
    """Unlabeled recordings with a source and span must not overlap a labeled clip's span in that source."""
    for r in recs:
        if not (r.get("source") and r.get("span")):
            continue
        a, b = r["span"]
        for c in clips:
            if c.get("source") == r["source"] and c.get("span"):
                s, e = c["span"]
                assert b <= s - margin or a >= e + margin, f"unlabeled {r['id']} {r['span']} overlaps clip {c['id']} {c['span']}"


def _ngrams(words, n=4):
    return {tuple(words[i:i + n]) for i in range(len(words) - n + 1)}


def overlaps_test(text, tests, lang):
    """The id of a test clip whose text this text matches (equal, contained, or sharing most of its word
    4-grams, after the scoring's normalization), else None."""
    from zunos_core.scoring import norm

    h = norm(text, lang).split()
    hs, hg = " ".join(h), _ngrams(h)
    for t in tests:
        r = norm(t["text"], t["lang"]).split()
        rs = " ".join(r)
        if not r or not h:
            continue
        if hs == rs or (len(r) >= 4 and rs in hs) or (len(h) >= 4 and hs in rs):
            return t["id"]
        rg = _ngrams(r)
        if rg and len(rg & hg) / len(rg) >= 0.5:
            return t["id"]
    return None


# ------------------------------------------------------------------ segment (vad env)

def merge_regions(regions, min_s, max_s, max_gap, pad, total):
    """[(start, end)] speech regions in samples -> segments [(start, end)] of min_s..max_s seconds."""
    out, cur = [], None
    for s, e in regions:
        if cur and s - cur[1] <= max_gap * SR and e - cur[0] <= max_s * SR:
            cur[1] = e
            continue
        if cur:
            out.append(tuple(cur))
        cur = [s, e]
    if cur:
        out.append(tuple(cur))
    p = int(pad * SR)
    return [(max(0, s - p), min(total, e + p)) for s, e in out if min_s * SR <= e - s <= (max_s + 0.5) * SR]


def segment(work, name):
    import soundfile as sf

    cfg, p = set_cfg(work, name)
    v = p["vad"]
    d = seg_dir(work, p)
    if os.path.exists(f"{d}/segments.jsonl"):
        print("segments cached", d)
        return
    os.makedirs(f"{d}/wav", exist_ok=True)
    recs = read_jsonl(f"{work}/data/unlabeled.jsonl")
    manifest = json.load(open(f"{work}/data/manifest.json", encoding="utf-8"))
    check_spans(recs, manifest["clips"])
    if provided(p):
        rows, dropped = [], []
        for rec in recs:
            assert rec.get("text"), f"{rec['id']}: provided labels need a text"
            a, sr = sf.read(rec["path"], dtype="float32", always_2d=True)
            a = a.mean(1)
            assert sr == SR, f"{rec['path']}: {sr} Hz (unlabeled audio must be 16 kHz)"
            if not 1.0 <= len(a) / SR <= 30.0:
                dropped.append(rec["id"])
                continue
            path = f"{d}/wav/{rec['id']}.wav"
            sf.write(path, a, SR, subtype="PCM_16")
            span = rec.get("span") or [0.0, len(a) / SR]
            rows.append(dict(id=rec["id"], lang=rec["lang"], rec=rec["id"], start=span[0], end=span[1],
                             dur=round(len(a) / SR, 2), path=path, text=rec["text"]))
        write_jsonl(f"{d}/segments.jsonl", rows)
        print(f"provided: {len(rows)} segments, {sum(r['dur'] for r in rows) / 60:.1f} min; {len(dropped)} outside 1-30 s", flush=True)
        return
    import torch
    from silero_vad import get_speech_timestamps, load_silero_vad

    torch.set_num_threads(min(8, os.cpu_count() or 1))
    model = load_silero_vad()
    rows, total_s, cap = [], 0.0, p["max_minutes"] * 60
    for rec in recs:
        a, sr = sf.read(rec["path"], dtype="float32", always_2d=True)
        a = a.mean(1)
        assert sr == SR, f"{rec['path']}: {sr} Hz (unlabeled audio must be 16 kHz)"
        ts = get_speech_timestamps(torch.from_numpy(a), model, sampling_rate=SR, threshold=v["threshold"],
                                   min_speech_duration_ms=250, min_silence_duration_ms=250,
                                   max_speech_duration_s=v["max_s"], speech_pad_ms=0)
        segs = merge_regions([(t["start"], t["end"]) for t in ts], v["min_s"], v["max_s"], v["max_gap"], v["pad"], len(a))
        speech = sum(t["end"] - t["start"] for t in ts) / SR
        for s, e in segs:
            if cap and total_s >= cap:
                break
            sid = f"{rec['id']}-{s / SR:07.1f}"
            path = f"{d}/wav/{sid}.wav"
            sf.write(path, a[s:e], SR, subtype="PCM_16")
            off = rec["span"][0] if rec.get("span") else 0.0
            rows.append(dict(id=sid, lang=rec["lang"], rec=rec["id"], start=round(off + s / SR, 2), end=round(off + e / SR, 2),
                             dur=round((e - s) / SR, 2), path=path))
            total_s += (e - s) / SR
        print(f"{rec['id']}: {len(a) / SR / 60:.1f} min, speech {speech / 60:.1f} min, {len(segs)} segments", flush=True)
    write_jsonl(f"{d}/segments.jsonl", rows)
    print(f"segments: {len(rows)}, {total_s / 60:.1f} min", flush=True)


# ------------------------------------------------------------------ voice (train env; embeddings from judge.py)

def voice(work, name):
    import numpy as np

    from judge import voice_centroid

    cfg, p = set_cfg(work, name)
    d = seg_dir(work, p)
    segs = read_jsonl(f"{d}/segments.jsonl")
    sp = p["speaker"]
    out = set_dir(work, name)
    if not sp["enabled"]:
        write_jsonl(f"{out}/candidates.jsonl", segs)
        return
    real = {r["id"]: r for r in read_jsonl(f"{work}/data/real.jsonl")}
    emb = {r["id"]: np.array(r["emb"]) for r in read_jsonl(f"{d}/real-speaker.jsonl")}
    assert all(real[i]["split"] == "train" for i in emb), "voice references must be train clips (never test)"
    centroid, real_sim = voice_centroid(list(emb.values()))
    thr = max(sp["abs_min"], sp["min_rel"] * real_sim)
    semb = {r["id"]: np.array(r["emb"]) for r in read_jsonl(f"{d}/speaker.jsonl")}
    unit = centroid / np.linalg.norm(centroid)
    cands = []
    for s in segs:
        s["spk"] = round(float(np.dot(semb[s["id"]], unit)), 3)
        if s["spk"] >= thr:
            cands.append(s)
    sims = np.array([s["spk"] for s in segs])
    json.dump(dict(real_sim=round(real_sim, 3), threshold=round(thr, 3), segments=len(segs), kept=len(cands),
                   quantiles={q: round(float(np.quantile(sims, q)), 3) for q in (0.05, 0.25, 0.5, 0.75, 0.95)} if len(sims) else {}),
              open(f"{out}/voice.json", "w"), indent=1)
    write_jsonl(f"{out}/candidates.jsonl", cands)
    print(f"voice: {len(cands)}/{len(segs)} segments >= {thr:.3f} (real-vs-real {real_sim:.3f})", flush=True)


# ------------------------------------------------------------------ decode (train env)

def model_spec(work, cfg, m):
    """A variant of this run -> its saved model folder; anything else is a base or a folder already."""
    names = [r["name"] for r in cfg["runs"]]
    return f"{work}/ckpt/{m}/model" if m in names else m


def decode(work, name, role):
    import soundfile as sf
    import torch

    from compare import backend, family

    cfg, p = set_cfg(work, name)
    m = p[role]
    d = seg_dir(work, p)
    cache = f"{d}/hyps-{m.replace('/', '_')}.jsonl"
    done = {r["id"]: r for r in read_jsonl(cache)}
    cands = read_jsonl(f"{set_dir(work, name)}/candidates.jsonl")
    todo = [c for c in cands if c["id"] not in done]
    print(f"{role} {m}: {len(todo)} to decode ({len(cands) - len(todo)} cached)", flush=True)
    if not todo:
        return
    spec = model_spec(work, cfg, m)
    fam, _ = family(spec)
    be, _ = backend(spec, fam)
    if hasattr(be, "set_modes"):
        be.set_modes(read_jsonl(f"{work}/data/real.jsonl"))
    beams = p["beams"] if role == "teacher" else p["agree_beams"]
    rows = list(done.values())
    for b in range(0, len(todo), 32):
        batch = todo[b:b + 32]
        audio = [sf.read(c["path"], dtype="float32")[0] for c in batch]
        hyps = be.transcribe(audio, [c["lang"] for c in batch], beams=beams)
        rows += [dict(id=c["id"], hyp=h) for c, h in zip(batch, hyps)]
        write_jsonl(cache, rows)
        print(f"{role} {b + len(batch)}/{len(todo)}", flush=True)
    del be
    torch.cuda.empty_cache()


# ------------------------------------------------------------------ select (train env)

def repeat_frac(words, n=3):
    g = [tuple(words[i:i + n]) for i in range(len(words) - n + 1)]
    return 1 - len(set(g)) / len(g) if g else 0.0


def select(work, name):
    import numpy as np

    from pace import letters
    from zunos_core.scoring import clip_wer, comparable, is_latin, norm

    cfg, p = set_cfg(work, name)
    d, out = seg_dir(work, p), set_dir(work, name)
    real = read_jsonl(f"{work}/data/real.jsonl")
    tests = [r for r in real if r["split"] == "test"]
    labeled = [r for r in real if r["split"] in ("train", "dev")]
    cands = read_jsonl(f"{out}/candidates.jsonl")
    segs = read_jsonl(f"{d}/segments.jsonl")
    hyp = lambda m: {r["id"]: r["hyp"] for r in read_jsonl(f"{d}/hyps-{m.replace('/', '_')}.jsonl")} if m else {}  # noqa: E731
    teacher = {s["id"]: s["text"] for s in segs} if provided(p) else hyp(p["teacher"])
    agree = hyp(p["agree"])
    cps = {}
    for lang in sorted({r["lang"] for r in labeled}):
        vals = [letters(r["text"]) / r["seconds"] for r in labeled if r["lang"] == lang and r["seconds"]]
        cps[lang] = float(np.median(vals)) if vals else None
    latin = {lang: sum(is_latin(r["text"]) for r in labeled if r["lang"] == lang) * 2 > sum(r["lang"] == lang for r in labeled)
             for lang in cps}
    rows, why = [], {}
    for c in cands:
        text = (teacher.get(c["id"]) or "").strip()
        fails, lang = [], c["lang"]
        words = norm(text, lang).split()
        if not words:
            fails.append("empty")
        else:
            if latin.get(lang) is not None and is_latin(text) != latin[lang]:
                fails.append("script")
            rate = letters(text) / max(c["dur"], 0.1)
            c["cps"] = round(rate, 1)
            if cps.get(lang) and not p["cps_lo"] * cps[lang] <= rate <= p["cps_hi"] * cps[lang]:
                fails.append("pace")
            if repeat_frac(words) > p["max_repeat"]:
                fails.append("repeat")
            if p["agree"]:
                a = agree.get(c["id"])
                dis = clip_wer(comparable(a, text), text, lang)[0] if a is not None else 1.0
                c["agree_hyp"], c["disagree"] = a, round(dis, 3)
                if p["max_disagree"] is not None and dis > p["max_disagree"]:
                    fails.append("disagree")
            hit = overlaps_test(text, tests, lang)
            if hit:
                c["test_match"] = hit
                fails.append("test_overlap")
        r = dict(c, text=text, keep=not fails, fails=fails)
        for f in fails:
            why[f] = why.get(f, 0) + 1
        rows.append(r)
    kept = [r for r in rows if r["keep"]]
    assert not any(overlaps_test(r["text"], tests, r["lang"]) for r in kept), "a kept pseudo-label matches a test clip"
    assert all(r["path"].startswith(f"{work}/pseudo/") for r in kept)
    write_jsonl(f"{out}/rows.jsonl", rows)
    mins = lambda rs: round(sum(r["dur"] for r in rs) / 60, 1)  # noqa: E731
    dis = np.array([r["disagree"] for r in rows if "disagree" in r])
    voice_rep = json.load(open(f"{out}/voice.json")) if os.path.exists(f"{out}/voice.json") else None
    rep = dict(set=name, teacher=p["teacher"], agree=p["agree"],
               unlabeled_min=round(sum(r.get("seconds", 0) for r in read_jsonl(f"{work}/data/unlabeled.jsonl")) / 60, 1),
               segmented=len(segs), segmented_min=mins(segs), voice_kept=len(cands), voice_min=mins(cands),
               kept=len(kept), kept_min=mins(kept), rejected=why, voice=voice_rep, user_cps=cps,
               disagree_quantiles={q: round(float(np.quantile(dis, q)), 3) for q in (0.1, 0.25, 0.5, 0.75, 0.9)} if len(dis) else {},
               samples=[dict(id=r["id"], dur=r["dur"], text=r["text"][:200], agree=(r.get("agree_hyp") or "")[:200],
                             disagree=r.get("disagree")) for r in kept[:5]])
    json.dump(rep, open(f"{out}/report.json", "w"), indent=1, ensure_ascii=False)
    print("PSEUDO", json.dumps({k: v for k, v in rep.items() if k != "samples"}, ensure_ascii=False), flush=True)


def main():
    cmd, work, name = sys.argv[1], sys.argv[2], sys.argv[3]
    if cmd == "segment":
        segment(work, name)
    elif cmd == "voice":
        voice(work, name)
    elif cmd == "decode":
        decode(work, name, sys.argv[4])
    elif cmd == "select":
        select(work, name)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
