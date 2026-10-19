import json, random, math, os, time, sys, glob
import numpy as np, soundfile as sf, torch
from torch.utils.data import Dataset, DataLoader
from transformers import WhisperForConditionalGeneration, WhisperProcessor, get_cosine_schedule_with_warmup
from augment import augment, NoiseBank
from zunos_core.textnorm import basic, fuzzy, wer

cfg = dict(run="r1", lr=1e-5, epochs=4, bs=16, accum=2, real_rep=20, concat=0.25, freeze_enc=0, eval_every=150, gc=0, base_eval=1,
           en_max=0.2, hi_max=0.35, gu_max=0.35, warmup=0.08, styled_bonus=0.1, base="openai/whisper-large-v3-turbo")
for a in sys.argv[1:]:
    k, v = a.split("=")
    cfg[k] = type(cfg[k])(v) if k in cfg else v
print(cfg, flush=True)
random.seed(0); np.random.seed(0); torch.manual_seed(0)
W = "/workspace/data"
OUT = f"/workspace/ckpt/{cfg['run']}"
os.makedirs(OUT, exist_ok=True)

limits = {"en": cfg["en_max"], "hi": cfg["hi_max"], "gu": cfg["gu_max"]}
synth = [json.loads(l) for l in open(f"{W}/synth_scored.jsonl", encoding="utf-8")]
synth = {r["id"]: r for r in synth}.values()
synth = [r for r in synth if r["score"] <= limits[r["lang"]] + (cfg["styled_bonus"] if r["id"].endswith("fish-1") else 0) and 5 <= r["cps"] <= 30 and r["dur"] <= 29]
random.shuffle(synth)
nval = max(30, len(synth) // 30)
synth_val, synth_train = synth[:nval], synth[nval:]
real = [json.loads(l) for l in open(f"{W}/real.jsonl", encoding="utf-8")]
for r in real:
    r["path"] = f"{W}/real/final/16k/{r['id']}.wav"
real_train = [dict(r, real=True) for r in real if r["split"] == "train"]
real_test = [r for r in real if r["split"] == "test"]
items = synth_train + real_train * cfg["real_rep"]
by_lang = {l: [r for r in synth_train if r["lang"] == l] for l in ["en", "hi", "gu"]}
print("synth kept", len(synth), {l: len(v) for l, v in by_lang.items()}, "real train", len(real_train), "items", len(items), flush=True)

proc = WhisperProcessor.from_pretrained(cfg["base"])
tok = proc.tokenizer
SOT, EOT = tok.convert_tokens_to_ids("<|startoftranscript|>"), tok.convert_tokens_to_ids("<|endoftext|>")
TR, NOTS = tok.convert_tokens_to_ids("<|transcribe|>"), tok.convert_tokens_to_ids("<|notimestamps|>")
LANG = {l: tok.convert_tokens_to_ids(f"<|{l}|>") for l in ["en", "hi", "gu"]}

def labels_for(text, lang):
    return [LANG[lang], TR, NOTS] + tok.encode(" " + text.strip(), add_special_tokens=False) + [EOT]

def load(p):
    a, sr = sf.read(p, dtype="float32")
    if a.ndim > 1:
        a = a.mean(1)
    assert sr == 16000, p
    return a

class DS(Dataset):
    def __init__(self, items, bank):
        self.items, self.bank = items, bank
    def __len__(self):
        return len(self.items)
    def __getitem__(self, i):
        r = self.items[i]
        real = r.get("real", False)
        a = augment(load(r["path"]), self.bank, real=real)
        text = r["text"]
        if not real and random.random() < cfg["concat"]:
            parts, texts = [a], [text]
            total = len(a) / 16000
            for _ in range(random.randint(1, 3)):
                o = random.choice(by_lang[r["lang"]])
                if total + o["dur"] + 0.8 > 28.5:
                    break
                b = augment(load(o["path"]), self.bank)
                parts += [np.zeros(int(random.uniform(0.1, 0.7) * 16000), np.float32), b * (np.abs(a).max() / (np.abs(b).max() + 1e-6))]
                texts.append(o["text"])
                total += o["dur"] + 0.7
            a, text = np.concatenate(parts), " ".join(texts)
        a = a[: 30 * 16000]
        feats = proc.feature_extractor(a, sampling_rate=16000, return_tensors="np").input_features[0]
        return torch.from_numpy(feats), labels_for(text, r["lang"])

def collate(b):
    feats = torch.stack([x for x, _ in b])
    n = max(len(l) for _, l in b)
    lab = torch.full((len(b), n), -100, dtype=torch.long)
    for i, (_, l) in enumerate(b):
        lab[i, : len(l)] = torch.tensor(l)
    return feats, lab

babble = [r["path"] for r in synth_train if r["lang"] in ("hi", "gu", "en")][:400]
bank = NoiseBank(glob.glob(f"{W}/real/clips/*.wav"), babble)
dl = DataLoader(DS(items, bank), batch_size=cfg["bs"], shuffle=True, num_workers=14, collate_fn=collate,
                drop_last=True, persistent_workers=True, prefetch_factor=4)

model = WhisperForConditionalGeneration.from_pretrained(cfg["base"], torch_dtype=torch.float32).cuda()
model.config.forced_decoder_ids = None
if cfg["gc"]:
    model.config.use_cache = False
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
model.generation_config.forced_decoder_ids = None
if cfg["freeze_enc"]:
    for i, layer in enumerate(model.model.encoder.layers):
        if i < cfg["freeze_enc"]:
            for p in layer.parameters():
                p.requires_grad = False
    for p in list(model.model.encoder.conv1.parameters()) + list(model.model.encoder.conv2.parameters()) + [model.model.encoder.embed_positions.weight]:
        p.requires_grad = False
params = [p for p in model.parameters() if p.requires_grad]
opt = torch.optim.AdamW(params, lr=cfg["lr"], weight_decay=0.01, betas=(0.9, 0.98), eps=1e-6)
steps = cfg["epochs"] * len(dl) // cfg["accum"]
sched = get_cosine_schedule_with_warmup(opt, int(cfg["warmup"] * steps), steps)

def transcribe(paths, lang=None):
    model.eval()
    outs = []
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
        for b in range(0, len(paths), 16):
            auds = [load(p) for p in paths[b:b + 16]]
            f = proc.feature_extractor(auds, sampling_rate=16000, return_tensors="pt").input_features.cuda()
            kw = dict(task="transcribe", max_new_tokens=220, num_beams=1)
            if lang:
                kw["language"] = lang
            g = model.generate(f, use_cache=True, **kw)
            outs += tok.batch_decode(g, skip_special_tokens=True)
    model.train()
    return outs

def evaluate(tag):
    res = {}
    hyps = transcribe([r["path"] for r in real_test])
    rows = []
    for l in ["en", "hi", "gu"]:
        rs = [(r, h) for r, h in zip(real_test, hyps) if r["lang"] == l]
        refw = sum(len(basic(r["text"]).split()) for r, _ in rs)
        e1 = sum(wer(basic(h), basic(r["text"])) * len(basic(r["text"]).split()) for r, h in rs) / refw
        e2 = sum(wer(fuzzy(h), fuzzy(r["text"])) * len(fuzzy(r["text"]).split()) for r, h in rs) / refw
        res[l] = (round(e1, 3), round(e2, 3))
    sv = synth_val[:120]
    sh = transcribe([r["path"] for r in sv])
    res["synth_val_fuzzy"] = round(sum(wer(fuzzy(h), fuzzy(r["text"])) for r, h in zip(sv, sh)) / len(sv), 3)
    score = sum(res[l][1] for l in ["en", "hi", "gu"]) / 3
    rows = [dict(id=r["id"], ref=r["text"], hyp=h) for r, h in zip(real_test, hyps)]
    return score, res, rows

log = open(f"{OUT}/log.jsonl", "a")
best = 9.0
if cfg["base_eval"]:
    score, res, rows = evaluate("base")
    print("BASE", round(score, 3), res, flush=True)
    log.write(json.dumps(dict(step=0, score=score, res=res, rows=rows), ensure_ascii=False) + "\n"); log.flush()

model.train()
step, t0, run_loss = 0, time.time(), 0.0
for ep in range(cfg["epochs"]):
    for i, (feats, lab) in enumerate(dl):
        with torch.autocast("cuda", dtype=torch.bfloat16):
            loss = model(input_features=feats.cuda(non_blocking=True), labels=lab.cuda(non_blocking=True)).loss / cfg["accum"]
        loss.backward()
        run_loss += loss.item()
        if (i + 1) % cfg["accum"]:
            continue
        torch.nn.utils.clip_grad_norm_(params, 1.0)
        opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
        step += 1
        if step % 25 == 0:
            print(f"ep {ep} step {step}/{steps} loss {run_loss/25:.4f} lr {sched.get_last_lr()[0]:.2e} {time.time()-t0:.0f}s", flush=True)
            run_loss = 0.0
        if step % cfg["eval_every"] == 0 or step == steps:
            score, res, rows = evaluate(step)
            print("EVAL", step, round(score, 3), res, flush=True)
            log.write(json.dumps(dict(step=step, score=score, res=res, rows=rows), ensure_ascii=False) + "\n"); log.flush()
            if score < best:
                best = score
                model.save_pretrained(f"{OUT}/best", safe_serialization=True)
                proc.save_pretrained(f"{OUT}/best")
                json.dump(dict(step=step, score=score, res=res, cfg=cfg), open(f"{OUT}/best/score.json", "w"))
                print("SAVED best", step, flush=True)
print("TRAIN DONE best", best, flush=True)
