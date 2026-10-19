"""Train one variant and score it: one model for all of the user's languages.

    python train.py <work> <variant.json> <out dir>

  stage 1   kept synthetic takes (the variant's engines and share) and pseudo-labeled segments (pseudo.set, from
            pseudo.py) + the user's real train clips, the real ones oversampled to `stage1.real_share` of what is
            seen; cosine schedule.
  stage 2   short real-only polish (`stage2.steps` optimizer steps, lr x `lr_mult`, lighter augmentation).
  select    "last": the weights at the end (a fixed recipe). "dev": the best dev score seen at an eval
            (real dev clips where the language has them, else held-out synthetic sentences), stopping early after
            `patience` evals without improvement. The test clips are never looked at during training.
  test      once, at the end: the selected model decodes the test clips with beam search (as the Mac does,
            language detected), scored with zunos_core.scoring; per-language bootstrap CIs and, when the
            dataset carries the reference recognizer's answers, its WER on the same clips and the paired ratio.
  probe     (probe_train > 0) the first train clips decoded the same way: how far the model memorized them.

Writes <out>/model (merged fp16 Hugging Face checkpoint), <out>/report.json, <out>/test_rows.jsonl.
"""
import glob
import hashlib
import json
import math
import os
import random
import sys
import time

import numpy as np
import soundfile as sf
import torch
from torch.utils.data import DataLoader, Dataset

import variability
from augment import NoiseBank, augment
from data import minutes_subset, read_jsonl, synth_val_ids, write_jsonl
from schedule import stage_schedule
from zunos_core.scoring import bootstrap, comparable, score_clips, verdict

work, variant_path, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
D = f"{work}/data"
cfg = json.load(open(variant_path))
full = json.load(open(f"{D}/cfg.json"))
os.makedirs(OUT, exist_ok=True)
random.seed(cfg["seed"]); np.random.seed(cfg["seed"]); torch.manual_seed(cfg["seed"])
T0 = time.time()

if torch.cuda.is_available():
    DEV, DTYPE = torch.device("cuda"), torch.bfloat16
elif torch.backends.mps.is_available() and os.environ.get("ZUNOS_MPS") == "1":
    DEV, DTYPE = torch.device("mps"), torch.float32
else:
    DEV, DTYPE = torch.device("cpu"), torch.float32

# ------------------------------------------------------------------ data

real = read_jsonl(f"{D}/real.jsonl")
if cfg["label_field"] != "text":  # train, select and score on another label of the same clips (e.g. native script)
    real = [dict(r, text=r.get(cfg["label_field"]) or r["text"]) for r in real]
real_train = [dict(r, real=True) for r in real if r["split"] == "train"]
real_dev = [r for r in real if r["split"] == "dev"]
real_test = [r for r in real if r["split"] == "test"]
if cfg["dev_clips"] == "train":  # this variant doesn't select on dev: the dev clips are training data
    real_train += [dict(r, real=True) for r in real_dev]
    real_dev = []
if cfg["real_minutes"]:  # data ablation
    real_train = minutes_subset(real_train, cfg["real_minutes"])
langs = sorted({r["lang"] for r in real})


def wanted(r):
    eng = cfg["synth"]["engines"]
    if eng is None:
        return True
    allowed = eng.get(r["lang"], eng.get("default")) if isinstance(eng, dict) else eng
    return allowed is None or r["engine"] in allowed


def in_share(r):
    return int(hashlib.sha256(f"share|{r['sid']}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF < cfg["synth"]["share"]


synth = [r for r in read_jsonl(f"{D}/synth.jsonl") if r["keep"] and wanted(r) and in_share(r)]
val_ids = synth_val_ids({r["sid"] for r in synth}, full["dev"]["synth_frac"])
synth_val = [r for r in synth if r["sid"] in val_ids]
synth_train = [r for r in synth if r["sid"] not in val_ids]
synth_val = [r for l in langs for r in [x for x in synth_val if x["lang"] == l][:40]]
by_lang = {l: [r for r in synth_train if r["lang"] == l] for l in langs}

pseudo = []
if cfg["pseudo"]["set"]:
    from pseudo import overlaps_test

    pset = cfg["pseudo"]["set"]
    share = lambda r: int(hashlib.sha256(f"pshare|{r['id']}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF < cfg["pseudo"]["share"]  # noqa: E731
    pseudo = [dict(r, pseudo=True) for r in read_jsonl(f"{D}/pseudo/{pset}/rows.jsonl") if r["keep"] and share(r)]
    assert pseudo, f"pseudo set {pset} has no kept segments"
    bad = [r["id"] for r in pseudo if overlaps_test(r["text"], real_test, r["lang"])]
    assert not bad, f"pseudo-labels matching test clips' text: {bad[:5]}"

s1 = cfg["stage1"]
extra = synth_train + pseudo  # what the real clips are mixed with in stage 1
if extra and real_train:
    reps = max(1, round(s1["real_share"] / (1 - s1["real_share"]) * len(extra) / len(real_train)))
else:
    reps = 1 if extra else max(1, round(400 / max(1, len(real_train))))  # real only: ~400 samples an epoch
items = extra + real_train * reps
counts = {l: dict(synth=len(by_lang[l]), synth_val=sum(r["lang"] == l for r in synth_val),
                  pseudo=sum(r["lang"] == l for r in pseudo),
                  pseudo_min=round(sum(r["dur"] for r in pseudo if r["lang"] == l) / 60, 1),
                  real_train=sum(r["lang"] == l for r in real_train),
                  real_min=round(sum(r["seconds"] for r in real_train if r["lang"] == l) / 60, 1), real_dev=sum(r["lang"] == l for r in real_dev),
                  test=sum(r["lang"] == l for r in real_test)) for l in langs}
print("data", json.dumps(dict(counts=counts, real_reps=reps, items=len(items))), flush=True)
assert not ({r["id"] for r in real_test} & {r["id"] for r in items}), "test clip in training data"

# ------------------------------------------------------------------ model

base_l = cfg["base"].lower()
if "qwen" in base_l:
    from asr_qwen import QwenASRBackend as Backend
elif "flex" in base_l or "indic-transcribe" in base_l:
    from asr_flex import FlexBackend as Backend
else:
    from asr_whisper import WhisperBackend as Backend
be = Backend(cfg, DEV, DTYPE)
assert not cfg["kl"]["weight"] or hasattr(be, "reference"), f"kl.weight needs a backend with a reference model ({cfg['base']})"
if hasattr(be, "set_modes"):  # flex: output mode per language, fixed here, not in the DataLoader workers
    print("modes", json.dumps(be.set_modes(real)), flush=True)
n_train = sum(p.numel() for p in be.params())
print(f"model {cfg['base']} ({cfg['method']}): {n_train / 1e6:.1f}M trainable", flush=True)


def load(p):
    a, sr = sf.read(p, dtype="float32", always_2d=True)
    a = a.mean(1)
    assert sr == 16000, p
    return a


class DS(Dataset):
    def __init__(self, items, bank, strength):
        self.items, self.bank, self.strength = items, bank, strength

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        r = self.items[i]
        is_real = r.get("real", False) or r.get("pseudo", False)  # pseudo-labeled audio is the user's real voice
        a, text = load(r["path"]), r["text"]
        if cfg["augment"]:
            a = augment(a, self.bank, real=is_real, strength=self.strength)
        a = variability.perturb(a, 16000, random, cfg.get("variability") or {})
        if not is_real and random.random() < cfg["concat"] and by_lang[r["lang"]]:  # synthetic takes only
            # Join takes into a longer dictation (same language), as people dictate several sentences at once.
            parts, texts, total = [a], [text], len(a) / 16000
            for _ in range(random.randint(1, 3)):
                o = random.choice(by_lang[r["lang"]])
                if total + o["dur"] + 0.8 > 28.5:
                    break
                b = load(o["path"])
                if cfg["augment"]:
                    b = augment(b, self.bank, strength=self.strength)
                parts += [np.zeros(int(random.uniform(0.1, 0.7) * 16000), np.float32), b * (np.abs(a).max() / (np.abs(b).max() + 1e-6))]
                texts.append(o["text"])
                total += o["dur"] + 0.7
            a, text = np.concatenate(parts), " ".join(texts)
        return be.example(a, text, r["lang"])


bank = NoiseBank(sorted(glob.glob(f"{D}/real/recordings/*.wav")), [r["path"] for r in synth_train][:400])
workers = cfg["workers"] if DEV.type == "cuda" else 0


def loader(items, strength):
    return DataLoader(DS(items, bank, strength), batch_size=cfg["bs"], shuffle=True, num_workers=workers,
                      collate_fn=be.collate, drop_last=len(items) >= cfg["bs"], persistent_workers=workers > 0,
                      prefetch_factor=4 if workers else None)


# ------------------------------------------------------------------ evaluation

def dev_score():
    """Mean over languages of WER on real dev clips (where the language has some) else on held-out synthetic
    sentences. Never the test clips."""
    res = {}
    for l in langs:
        rows = [r for r in real_dev if r["lang"] == l] or [r for r in synth_val if r["lang"] == l]
        if not rows:
            continue
        hyps = be.transcribe([load(r["path"]) for r in rows], [l] * len(rows), beams=cfg["dev_beams"])
        sc, _ = score_clips(rows, hyps)
        res[l] = dict(wer=sc[l], on="real_dev" if real_dev and rows[0] in real_dev else "synth_val", n=len(rows))
    return (float(np.mean([v["wer"] for v in res.values()])) if res else None), res


history, best = [], dict(score=math.inf, state=None, step=None, stale=0, stopped=None)


def evaluate(step, stage, select):
    s, res = dev_score()
    history.append(dict(step=step, stage=stage, dev=s, res=res))
    print("DEV", json.dumps(history[-1]), flush=True)
    if select and s is not None:
        if s < best["score"]:
            best.update(score=s, state=be.state(), step=step, stale=0)
        else:
            best["stale"] += 1
            if cfg["patience"] and best["stale"] >= cfg["patience"]:
                best["stopped"] = step
                print(f"early stop at step {step}: no better dev score in {best['stale']} evals", flush=True)


# ------------------------------------------------------------------ training

params = be.params()
lr = cfg["lora_lr"] if cfg["method"] == "lora" else cfg["lr"]
opt = torch.optim.AdamW(params, lr=lr, weight_decay=cfg["weight_decay"], betas=(0.9, 0.98), eps=1e-6)
select_dev = cfg["select"] == "dev"
step = 0


def run_stage(name, dl, total, peak_lr, warmup):
    global step
    sched = stage_schedule(opt, peak_lr, warmup, total)
    done, run_loss, run_kl, t0, i = 0, 0.0, 0.0, time.time(), 0
    while done < total and not best["stopped"]:
        for batch in dl:
            with torch.autocast(DEV.type, dtype=DTYPE, enabled=DTYPE != torch.float32):
                loss = be.loss(batch) / cfg["accum"]
            loss.backward()
            run_loss += loss.item()
            run_kl += getattr(be, "last_kl", 0.0) / cfg["accum"]
            i += 1
            if i % cfg["accum"]:
                continue
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
            step += 1
            done += 1
            if done % 10 == 0 or done == total:
                kl = f" kl {run_kl / 10:.4f}" if cfg["kl"]["weight"] else ""
                print(f"STEP {name} {done}/{total} step {step} loss {run_loss / 10:.4f} lr {sched.get_last_lr()[0]:.2e} {time.time() - t0:.0f}s{kl}", flush=True)
                run_loss = run_kl = 0.0
            if select_dev and done % cfg["eval_every"] == 0 and done < total:
                evaluate(step, name, True)
            if done >= total or best["stopped"]:
                break
    if not best["stopped"]:
        evaluate(step, name, select_dev)


be.train_mode()
bs_eff = cfg["bs"] * cfg["accum"]
steps1 = s1.get("steps") or max(1, s1["epochs"] * len(items) // bs_eff)
run_stage("stage1", loader(items, 1.0), steps1, lr, int(cfg["warmup"] * steps1))
s2 = cfg["stage2"]
if s2["steps"] > 0 and real_train and not best["stopped"]:
    run_stage("stage2", loader(real_train * max(1, math.ceil(s2["steps"] * bs_eff / len(real_train))), s2["augment"]),
              s2["steps"], lr * s2["lr_mult"], max(1, s2["steps"] // 10))
if select_dev and best["state"] is not None:
    be.load_state(best["state"])
    print(f"selected step {best['step']} (dev {best['score']:.4f})", flush=True)
train_s = time.time() - T0

# ------------------------------------------------------------------ the test, once

t1 = time.time()
hyps = be.transcribe([load(r["path"]) for r in real_test], None, beams=cfg["beams"], allowed=langs)
scores, rows = score_clips(real_test, hyps)
reference = json.load(open(f"{D}/reference.json", encoding="utf-8")) if os.path.exists(f"{D}/reference.json") else {}
ref_clips = [r for r in real_test if r["id"] in reference]
_, ref_rows = score_clips(ref_clips, [comparable(reference[r["id"]], r["text"]) for r in ref_clips])
stats = bootstrap(rows, ref_rows if ref_rows else None)
for l, s in stats.items():
    s["verdict"] = verdict(s)
write_jsonl(f"{OUT}/test_rows.jsonl", [dict(r, reference=reference.get(r["id"])) for r in rows])
for r in rows[:3]:  # what the model actually writes, in the log (a WER over 100% is usually script or loops)
    print("HYP", json.dumps(dict(id=r["id"], wer=r["wer"], ref=r["ref"][:200], hyp=r["hyp"][:300]), ensure_ascii=False), flush=True)
probe = None
if cfg["probe_train"]:  # memorization: the same decode on train clips the model was fitted to
    tr = sorted((r for r in real_train if r["split"] == "train"), key=lambda r: r["id"])[: cfg["probe_train"]]
    psc, prow = score_clips(tr, be.transcribe([load(r["path"]) for r in tr], None, beams=cfg["beams"], allowed=langs))
    probe = dict(avg=psc.get("avg"), n=len(tr), rows=[dict(id=r["id"], wer=r["wer"]) for r in prow])
    print("PROBE", json.dumps(probe), flush=True)
be.save(f"{OUT}/model")
report = dict(variant=cfg["name"], cfg=cfg, base=cfg["base"], method=cfg["method"], counts=counts, real_reps=reps,
              steps=step, select=cfg["select"], selected_step=best["step"] if select_dev else step,
              stopped_early=best["stopped"], dev_history=history, test=dict(avg=scores.get("avg"), langs=stats),
              train_probe=probe,
              seconds=dict(train=round(train_s), test=round(time.time() - t1)), trainable_params=n_train,
              device=torch.cuda.get_device_name(0) if DEV.type == "cuda" else DEV.type)
json.dump(report, open(f"{OUT}/report.json", "w"), indent=1, ensure_ascii=False)
print("TEST", json.dumps(dict(avg=scores.get("avg"), langs=stats)), flush=True)
