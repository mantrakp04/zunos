"""Judge synthetic takes; keep only the ones that say the words, in the user's voice, at the asked pace.

    python judge.py asr <model> <list.jsonl> <out.jsonl> [whisper id]   transcripts {id, hyp}
    python judge.py speaker <list.jsonl> <out.jsonl>                    speaker embeddings {id, emb}
    python judge.py score <work>                                        decisions -> data/synth.jsonl

A list row is {id, lang, path}. run.py runs `asr` in the env each model needs (whisper and indicconformer in
the judge env, omniasr in its own) over every new take AND over the user's real train/dev clips, which
calibrate the thresholds (the test clips are never judged).

Checks per take (all must pass):
  words    error = zunos_core.scoring.synth_score(hyp, label) (WER for English; romanized labels: character
           error after transliterating both to Latin; native scripts: character error); for takes with text
           edits (fillers, repeats, respellings) the lower of that and the error against what the TTS read.
           Threshold: max(abs_floor, median error of the shard's clean takes x ceiling_mult + max_err).
           The judge's error on the user's real clips is reported but not used (0.25-0.33: too loose).
  deletion no label word missing from the hypothesis (word merges forgiven).
  voice    cosine of the take's speaker embedding (microsoft/wavlm-base-plus-sv) to the centroid of the user's
           real clips >= max(abs_min, min(min_rel x real-vs-real, shard median - mad_k x MAD)).
  pace     letters per second of speech within +-pace.slack of what the job asked for.
  phonemes (judge.phoneme) phone error rate of the hypothesis vs the TTS text, espeak-ng, same rule as words.
"""
import json
import os
import sys

import numpy as np

JUDGE_VERSION = 2


def rows_of(path):
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def write(path, rows):
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    os.replace(path + ".tmp", path)


def load16(path):
    import librosa
    import soundfile as sf

    a, sr = sf.read(path, dtype="float32", always_2d=True)
    a = a.mean(1)
    return librosa.resample(a, orig_sr=sr, target_sr=16000) if sr != 16000 else a


def device():
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


# ------------------------------------------------------------------ recognizers

def asr_whisper(items, model_id):
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    dev = device()
    dtype = torch.float16 if dev == "cuda" else torch.float32
    proc = WhisperProcessor.from_pretrained(model_id)
    model = WhisperForConditionalGeneration.from_pretrained(model_id, torch_dtype=dtype).to(dev).eval()
    out = []
    for lang in sorted({r["lang"] for r in items}):
        sub = [r for r in items if r["lang"] == lang]
        for b in range(0, len(sub), 32):
            batch = sub[b:b + 32]
            f = proc.feature_extractor([load16(r["path"])[: 30 * 16000] for r in batch], sampling_rate=16000,
                                       return_tensors="pt").input_features.to(dev, dtype)
            with torch.inference_mode():
                g = model.generate(f, language=lang, task="transcribe", max_new_tokens=220)
            out += [dict(id=r["id"], hyp=h.strip()) for r, h in zip(batch, proc.batch_decode(g, skip_special_tokens=True))]
            print(f"whisper {lang} {b + len(batch)}/{len(sub)}", flush=True)
    return out


def asr_indicconformer(items):
    """ai4bharat/indic-conformer-600m-multilingual (gated: needs HF_TOKEN with the terms accepted). One clip
    per call: its CTC decoder has no batching."""
    import torch
    from transformers import AutoModel

    model = AutoModel.from_pretrained("ai4bharat/indic-conformer-600m-multilingual", trust_remote_code=True,
                                      token=os.environ.get("HF_TOKEN") or None)
    out = []
    for i, r in enumerate(items):
        wav = torch.from_numpy(load16(r["path"])).unsqueeze(0)
        with torch.inference_mode():
            out.append(dict(id=r["id"], hyp=str(model(wav, r["lang"], "ctc")).strip()))
        if i % 200 == 0:
            print(f"indicconformer {i}/{len(items)}", flush=True)
    return out


OMNI_LANG = {"en": "eng_Latn", "hi": "hin_Deva", "gu": "guj_Gujr", "ta": "tam_Taml", "mr": "mar_Deva", "bn": "ben_Beng",
             "te": "tel_Telu", "kn": "kan_Knda", "ml": "mal_Mlym", "pa": "pan_Guru", "or": "ory_Orya", "as": "asm_Beng",
             "ur": "urd_Arab", "ne": "nep_Deva"}


def asr_omniasr(items):
    """Meta Omnilingual ASR (omniASR_LLM_7B_v2) for long-tail languages; runs in its own env (fairseq2)."""
    from omnilingual_asr.models.inference.pipeline import ASRInferencePipeline

    pipe = ASRInferencePipeline(model_card=os.environ.get("OMNIASR_CARD", "omniASR_LLM_7B_v2"))
    hyps = pipe.transcribe([r["path"] for r in items], lang=[OMNI_LANG.get(r["lang"]) for r in items], batch_size=8)
    return [dict(id=r["id"], hyp=str(h).strip()) for r, h in zip(items, hyps)]


def speaker(items):
    import torch
    from transformers import AutoFeatureExtractor, WavLMForXVector

    dev = device()
    fe = AutoFeatureExtractor.from_pretrained("microsoft/wavlm-base-plus-sv")
    model = WavLMForXVector.from_pretrained("microsoft/wavlm-base-plus-sv").to(dev).eval()
    out = []
    for b in range(0, len(items), 16):
        batch = items[b:b + 16]
        x = fe([load16(r["path"])[: 20 * 16000] for r in batch], sampling_rate=16000, padding=True, return_tensors="pt")
        with torch.inference_mode():
            e = model(**{k: v.to(dev) for k, v in x.items()}).embeddings
        e = torch.nn.functional.normalize(e, dim=-1).cpu().numpy()
        out += [dict(id=r["id"], emb=[round(float(v), 5) for v in vec]) for r, vec in zip(batch, e)]
    return out


# ------------------------------------------------------------------ decisions

def judge_for(jcfg, lang):
    """The recognizer that judges a language (one of whisper | indicconformer | omniasr)."""
    m = jcfg["models"]
    if lang in m.get("longtail", []):
        return "omniasr"
    if lang in m:
        return m[lang]
    if lang in jcfg["indic_langs"]:
        return m["indic"]
    return m["default"]


def deleted_words(hyp, label, lang):
    """Label words the hypothesis lost (not substituted: missing), after the scoring's normalization. Romanized
    labels compare against the transliterated hypothesis. A word that only merged with a neighbour
    ("ghare thi" heard as "gharethi") is not a deletion. Languages written without spaces are skipped."""
    from zunos_core.scoring import is_latin, norm
    from zunos_core.textnorm import cer, to_roman

    if lang in ("ja", "zh", "th", "yue", "lo", "my", "km"):
        return []
    if is_latin(label) and not is_latin(hyp):
        hyp = to_roman(hyp)
    r, h = norm(label, lang).split(), norm(hyp, lang).split()
    n, k = len(r), len(h)
    D = [[0] * (k + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        D[i][0] = i
    for j in range(k + 1):
        D[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, k + 1):
            D[i][j] = min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (r[i - 1] != h[j - 1]))
    i, j, align, gone = n, k, {}, []
    while i > 0 or j > 0:
        if i > 0 and j > 0 and D[i][j] == D[i - 1][j - 1] + (r[i - 1] != h[j - 1]):
            align[i - 1] = j - 1
            i, j = i - 1, j - 1
        elif i > 0 and D[i][j] == D[i - 1][j] + 1:
            gone.append(i - 1)
            i -= 1
        else:
            j -= 1
    out = []
    for g in sorted(gone):
        merged = False
        for nb, pair in ((g - 1, lambda: r[g - 1] + r[g]), (g + 1, lambda: r[g] + r[g + 1])):
            if nb in align and cer(h[align[nb]], pair()) <= 0.25:
                merged = True
        if not merged:
            out.append(r[g])
    return out


def phones(text, lang):
    from phonemizer.backend import EspeakBackend
    from phonemizer.separator import Separator

    key = {"en": "en-us"}.get(lang, lang)
    be = phones.cache.get(key) or phones.cache.setdefault(key, EspeakBackend(key, language_switch="remove-flags"))
    return be.phonemize([text], separator=Separator(phone=" ", word=" | "), strip=True)[0].split()


phones.cache = {}


def score(work):
    from zunos_core.scoring import synth_score
    from zunos_core.textnorm import edit

    from pace import letters

    D = f"{work}/data"
    cfg = json.load(open(f"{D}/cfg.json"))
    jcfg = cfg["judge"]
    real = [r for r in rows_of(f"{D}/real.jsonl") if r["split"] in ("train", "dev")]
    jdir = f"{work}/judge"
    shards = json.load(open(f"{D}/shards_ready.json"))
    report, out = {}, []

    # Calibration on the user's real clips: each judge's ceiling per language, and real-vs-real voice similarity.
    real_hyp = {}
    for m in {judge_for(jcfg, r["lang"]) for r in real}:
        p = f"{jdir}/real-{m}.jsonl"
        if os.path.exists(p):
            real_hyp[m] = {r["id"]: r["hyp"] for r in rows_of(p)}
    emb = {r["id"]: np.array(r["emb"]) for r in rows_of(f"{jdir}/real-speaker.jsonl")} if os.path.exists(f"{jdir}/real-speaker.jsonl") else {}
    train_emb = [emb[r["id"]] for r in real if r["id"] in emb and r["split"] == "train"]
    centroid = np.mean(train_emb, 0) if train_emb else None
    real_sim = None
    if centroid is not None and len(train_emb) >= 3:
        s = len(train_emb) * centroid
        loo = [float(np.dot(e, (s - e) / np.linalg.norm(s - e))) for e in train_emb]
        real_sim = float(np.median(loo))

    def thr(errs):
        ceiling = float(np.median(errs)) if errs else None
        return ceiling, max(jcfg["abs_floor"], (ceiling or 0) * jcfg["ceiling_mult"] + jcfg["max_err"])

    ceilings = {}
    for lang in sorted({r["lang"] for r in real} | {s["lang"] for s in shards}):
        m = judge_for(jcfg, lang)
        hyps = real_hyp.get(m, {})
        errs = [synth_score(hyps[r["id"]], r["text"], lang) for r in real if r["lang"] == lang and r["id"] in hyps]
        perrs = []
        if jcfg["phoneme"]:
            for r in real:
                ref = r.get("native_text") or r["text"]
                if r["lang"] == lang and r["id"] in hyps and hyps[r["id"]]:
                    p_ref = phones(ref, lang)
                    perrs.append(edit(phones(hyps[r["id"]], lang), p_ref) / max(1, len(p_ref)))
        ceilings[lang] = dict(judge=m, n_real=len(errs), words=thr(errs), phonemes=thr(perrs) if jcfg["phoneme"] else None)

    for s in shards:
        lang, d = s["lang"], s["dir"]
        m, real_ceiling = ceilings[lang]["judge"], ceilings[lang]["words"][0]
        hyps = {r["id"]: r["hyp"] for r in rows_of(f"{s['judged']}/asr.jsonl")}
        semb = {r["id"]: np.array(r["emb"]) for r in rows_of(f"{s['judged']}/speaker.jsonl")} if jcfg["speaker"]["enabled"] else {}
        takes = rows_of(f"{d}/takes.jsonl")
        rows = []
        for take in takes:
            hyp = hyps.get(take["id"], "")
            err = synth_score(hyp, take["text"], lang)
            if take.get("edits") and take.get("tts_text"):
                # Disfluent or respelled takes: the TTS read something else on purpose; keep the better match.
                err = min(err, synth_score(hyp, take["tts_text"], lang))
            r = dict(take, path=f"{d}/{take['file']}", judge=m, hyp=hyp, err=round(err, 3))
            if jcfg.get("deletions", True):
                r["deleted"] = deleted_words(hyp, take["text"], lang)
            if centroid is not None and take["id"] in semb:
                r["spk"] = round(float(np.dot(semb[take["id"]], centroid / np.linalg.norm(centroid))), 3)
            rows.append(r)
        # Words threshold from the shard's clean takes (no edits, no effects): the judge's floor on this TTS.
        clean = [r["err"] for r in rows if not r.get("edits") and not r.get("effects")]
        clean_med = float(np.median(clean)) if clean else 0.0
        t = max(jcfg["abs_floor"], clean_med * jcfg["ceiling_mult"] + jcfg["max_err"])
        # Voice threshold: the real-vs-real bar, relaxed to the shard's own spread (outliers only), with a floor.
        sp = jcfg["speaker"]
        sims = np.array([r["spk"] for r in rows if "spk" in r])
        spk_thr = None
        if sp["enabled"] and len(sims) and real_sim:
            med = float(np.median(sims))
            mad = float(np.median(np.abs(sims - med))) or 0.02
            spk_thr = max(sp["abs_min"], min(sp["min_rel"] * real_sim, med - sp["mad_k"] * mad))
        kept, why = 0, {}
        for r in rows:
            r["thr"] = round(t, 3)
            fails = []
            if r["err"] > t:
                fails.append("words")
            if r.get("deleted"):
                fails.append("deletion")
            if spk_thr is not None and "spk" in r and r["spk"] < spk_thr:
                fails.append("voice")
            if jcfg["pace"]["enabled"] and r.get("speech_s"):
                asked = letters(r["text"]) / r["target_s"]
                got = letters(r["text"]) / max(r["speech_s"], 0.1)
                r["cps"] = round(got, 1)
                if not (1 - jcfg["pace"]["slack"]) * asked <= got <= (1 + jcfg["pace"]["slack"]) * asked:
                    fails.append("pace")
            if jcfg["phoneme"] and r["hyp"]:
                pc, pt = ceilings[lang]["phonemes"]
                p_ref = phones(r.get("tts_text") or r["text"], lang)
                r["per"] = round(edit(phones(r["hyp"], lang), p_ref) / max(1, len(p_ref)), 3)
                if r["per"] > pt:
                    fails.append("phonemes")
            r["keep"] = not fails
            r["fails"] = fails
            kept += r["keep"]
            for f_ in fails:
                why[f_] = why.get(f_, 0) + 1
            out.append(r)
        n = len(rows)
        styled = [r for r in rows if r.get("edits") or r.get("effects")]
        report[f"{lang}/{s['engine']}"] = dict(
            takes=n, kept=kept, kept_frac=round(kept / max(1, n), 3), judge=m, threshold=round(t, 3),
            clean_err=round(clean_med, 3), real_ceiling=None if real_ceiling is None else round(real_ceiling, 3),
            rejected=why, voice_thr=None if spk_thr is None else round(spk_thr, 3),
            voice_median=round(float(np.median(sims)), 3) if len(sims) else None,
            real_voice_sim=None if real_sim is None else round(real_sim, 3),
            styled=len(styled), styled_kept=sum(r["keep"] for r in styled))
    write(f"{D}/synth.jsonl", out)
    json.dump(dict(shards=report, ceilings=ceilings), open(f"{D}/judge_report.json", "w"), indent=1)
    for k, v in report.items():
        print("judge", k, json.dumps(v), flush=True)


def main():
    cmd = sys.argv[1]
    if cmd == "asr":
        model, src, dst = sys.argv[2], sys.argv[3], sys.argv[4]
        items = rows_of(src)
        if not items:
            write(dst, [])
            return
        if model == "whisper":
            res = asr_whisper(items, sys.argv[5] if len(sys.argv) > 5 else "openai/whisper-large-v3")
        elif model == "indicconformer":
            res = asr_indicconformer(items)
        elif model == "omniasr":
            res = asr_omniasr(items)
        else:
            raise SystemExit(f"unknown judge {model}")
        write(dst, res)
    elif cmd == "speaker":
        write(sys.argv[3], speaker(rows_of(sys.argv[2])))
    elif cmd == "score":
        score(sys.argv[2])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
