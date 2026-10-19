"""Decode-only comparison on a GPU pod: several models on the same test clips, scored like train.py's test.

    python compare.py --data <dataset dir> --out <dir> --model NAME=SPEC [--model NAME=SPEC ...] [--probe-train N]

<dataset dir> is an unpacked dataset (manifest.json, clips/16k/<id>.wav). SPEC is a base (whisper-large-v3,
whisper-large-v3-turbo, flex, qwen3-asr-1.7b) or an exported Hugging Face folder (export.py's <RUN>-hf; the
family comes from its zunos.json or config.json). Each model is loaded with train.py's backend and defaults
(config.TRAIN, full weights, no LoRA wrapper) and decodes the test clips the way train.py's final test does:
language detected among the dataset's languages, beams=cfg["beams"].

Scoring is zunos_core.scoring (score_clips, bootstrap). A hypothesis in native script is transliterated first
(scoring.comparable, as train.py does for the reference recognizer), so base models that answer in Gujarati
script get a meaningful number; a trained model's English-letter output is scored exactly as in train.py.

The reference recognizer is not scored: the labels are its own transcript, romanized by an LLM, so its WER on
this data is ~0 by construction. Its raw text is kept in every row.

--probe-train N also decodes the first N train clips with every flex model in both romanized and native mode
(language given), to separate mode handling from training.

Writes <out>/rows.jsonl (one row per test clip, every model), <out>/probe.jsonl, <out>/summary.json and
<out>/summary.md (also printed).
"""
import argparse
import gc
import json
import os
import time
import traceback

import numpy as np
import soundfile as sf
import torch

import config
from data import write_jsonl
from zunos_core.scoring import bootstrap, comparable, is_latin, score_clips

BASES = {"whisper-large-v3": "whisper", "whisper-large-v3-turbo": "whisper", "flex": "flex",
         "indic-transcribe-flex": "flex", "qwen3-asr-1.7b": "qwen", "qwen3-asr-0.6b": "qwen"}

if torch.cuda.is_available():
    DEV, DTYPE = torch.device("cuda"), torch.bfloat16
else:
    DEV, DTYPE = torch.device("cpu"), torch.float32


def load(p):
    a, sr = sf.read(p, dtype="float32", always_2d=True)
    assert sr == 16000, p
    return a.mean(1)


def family(spec):
    if not os.path.isdir(spec):
        if spec.lower() not in BASES:
            raise ValueError(f"{spec}: not a folder and not a known base ({sorted(BASES)})")
        return BASES[spec.lower()], {}
    z = json.load(open(f"{spec}/zunos.json")) if os.path.exists(f"{spec}/zunos.json") else {}
    s = json.load(open(f"{spec}/score.json")) if os.path.exists(f"{spec}/score.json") else {}
    kind = " ".join([z.get("family", ""), s.get("family", ""), json.load(open(f"{spec}/config.json")).get("model_type", "")]).lower()
    for key, fam in (("whisper", "whisper"), ("qwen", "qwen"), ("canary", "flex"), ("flex", "flex")):
        if key in kind:
            return fam, dict(zunos=z, score=s)
    raise ValueError(f"{spec}: unknown model family ({kind!r})")


def backend(spec, fam):
    cfg = config.merge(config.TRAIN, {"base": spec, "method": "full", "gc": 0, "freeze_enc": 0})
    if fam == "whisper":
        from asr_whisper import WhisperBackend as B
    elif fam == "flex":
        from asr_flex import FlexBackend as B
    else:
        from asr_qwen import QwenASRBackend as B
    return B(cfg, DEV, DTYPE), cfg


def summary_md(summary, n_probe):
    out = ["| model | family | WER [95% CI] | words hyp/ref | native-script hyps | decode s |", "|---|---|---|---|---|---|"]
    for name, s in summary["models"].items():
        if "error" in s:
            out.append(f"| {name} | {s.get('family', '?')} | failed: {s['error'][:80]} | | | |")
            continue
        for l, st in s["langs"].items():
            out.append(f"| {name} ({l}) | {s['family']} | {st['wer']:.1%} [{st['ci'][0]:.0%}-{st['ci'][1]:.0%}] | "
                       f"{s['len_ratio']:.2f} | {s['native_hyps']}/{st['n']} | {s['seconds']} |")
    out += ["", "reference recognizer: ~0% by construction (the labels are its own transcript, romanized by an LLM); "
                "not scored. Its raw text is in rows.jsonl.",
            "Native-script hypotheses are transliterated (scoring.comparable) before scoring; English-letter ones as is."]
    if n_probe:
        out += ["", "| probe (train clips) | romanized mode WER | native mode WER (raw) | native mode WER (transliterated) |",
                "|---|---|---|---|"]
        for name, p in summary["probe"].items():
            out.append(f"| {name} | {p['romanized']:.1%} | {p['native_raw']:.1%} | {p['native_translit']:.1%} |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", action="append", required=True, help="NAME=SPEC (or SPEC; NAME defaults to its basename)")
    ap.add_argument("--beams", type=int, default=None, help="default: config.TRAIN beams (as train.py's test)")
    ap.add_argument("--probe-train", type=int, default=0, help="train clips for the flex romanized/native probe")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    m = json.load(open(f"{args.data}/manifest.json", encoding="utf-8"))
    clips = [dict(c, path=f"{args.data}/clips/16k/{c['id']}.wav") for c in m["clips"]]
    test = [c for c in clips if c["split"] == "test"]
    train = sorted((c for c in clips if c["split"] == "train"), key=lambda c: c["id"])[: args.probe_train]
    langs = sorted({c["lang"] for c in clips})
    reference = m.get("reference") or {}
    audio = {c["id"]: load(c["path"]) for c in test + train}
    print(f"{len(test)} test clips, langs {langs}, {len(reference)} reference answers, device {DEV}", flush=True)

    rows = {c["id"]: dict(id=c["id"], lang=c["lang"], seconds=c.get("seconds"), label=c["text"],
                          native_text=c.get("native_text"), reference=reference.get(c["id"]), models={}) for c in test}
    probe_rows, summary = [], dict(data=args.data, n_test=len(test), langs=langs, models={}, probe={},
                                   reference="~0 by construction: the labels are its transcript, romanized by an LLM")
    models = [(s.split("=", 1) if "=" in s else (os.path.basename(s.rstrip("/")), s)) for s in args.model]

    for name, spec in models:
        t0 = time.time()
        try:
            fam, meta = family(spec)
            be, cfg = backend(spec, fam)
            beams = args.beams or cfg["beams"]
            info = dict(spec=spec, family=fam, beams=beams, meta=meta)
            if fam == "flex":
                info["modes"] = be.set_modes(clips)  # from the labels' script, as train.py now does
                if meta.get("zunos", {}).get("modes") not in (None, info["modes"]):
                    print(f"{name}: zunos.json modes {meta['zunos']['modes']} differ from the labels' {info['modes']}", flush=True)
            print(f"{name}: {fam}, loaded in {time.time() - t0:.0f}s, beams {beams}", flush=True)
            t1 = time.time()
            hyps = be.transcribe([audio[c["id"]] for c in test], None, beams=beams, allowed=langs)
            dec_s = round(time.time() - t1)
            scored = [comparable(h, c["text"]) for h, c in zip(hyps, test)]
            scores, srows = score_clips(test, scored)
            for c, h, r in zip(test, hyps, srows):
                rows[c["id"]]["models"][name] = dict(hyp=h, wer=r["wer"], translit=not is_latin(h))
            ref_words = sum(len(c["text"].split()) for c in test)
            summary["models"][name] = dict(info, avg=scores.get("avg"), langs=bootstrap(srows), seconds=dec_s,
                                           len_ratio=round(sum(len(h.split()) for h in scored) / max(1, ref_words), 3),
                                           native_hyps=sum(not is_latin(h) for h in hyps))
            print(f"{name}: WER {scores.get('avg')} in {dec_s}s", flush=True)
            for c, h in list(zip(test, hyps))[:3]:
                print(f"  {c['id']}  ref: {c['text'][:120]}\n  {' ' * len(c['id'])}  hyp: {h[:200]}", flush=True)

            if fam == "flex" and train:
                tr = [audio[c["id"]] for c in train]
                ls = [c["lang"] for c in train]
                rom = be.transcribe(tr, ls, beams=beams, mode="romanized")
                nat = be.transcribe(tr, ls, beams=beams, mode="native")
                _, r_rom = score_clips(train, rom)
                _, r_raw = score_clips(train, nat)
                _, r_tr = score_clips(train, [comparable(h, c["text"]) for h, c in zip(nat, train)])
                for c, a, b, x, y, z in zip(train, rom, nat, r_rom, r_raw, r_tr):
                    probe_rows.append(dict(model=name, id=c["id"], label=c["text"], native_text=c.get("native_text"),
                                           romanized=a, native=b, wer_romanized=x["wer"], wer_native_raw=y["wer"],
                                           wer_native_translit=z["wer"]))
                wsum = lambda rs: round(sum(r["wer"] * r["words"] for r in rs) / max(1, sum(r["words"] for r in rs)), 4)
                summary["probe"][name] = dict(n=len(train), romanized=wsum(r_rom), native_raw=wsum(r_raw), native_translit=wsum(r_tr))
                print(f"{name} probe: {summary['probe'][name]}", flush=True)
            del be
        except Exception as e:
            traceback.print_exc()
            summary["models"][name] = dict(spec=spec, error=f"{type(e).__name__}: {e}")
        gc.collect()
        if DEV.type == "cuda":
            torch.cuda.empty_cache()
        # Written after every model, so a later failure keeps what was decoded.
        write_jsonl(f"{args.out}/rows.jsonl", list(rows.values()))
        write_jsonl(f"{args.out}/probe.jsonl", probe_rows)
        json.dump(summary, open(f"{args.out}/summary.json", "w"), indent=1, ensure_ascii=False)

    md = summary_md(summary, args.probe_train)
    open(f"{args.out}/summary.md", "w").write(md + "\n")
    print("\n" + md, flush=True)


if __name__ == "__main__":
    main()
