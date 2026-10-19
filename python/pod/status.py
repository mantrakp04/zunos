import json, os, re, glob, subprocess, time, collections

W = "/workspace/data"
out = {"now": time.time()}

jobs = [json.loads(l) for l in open(f"{W}/jobs.jsonl", encoding="utf-8")]
done = {os.path.basename(p)[:-4] for p in glob.glob(f"{W}/synth/*.wav") if not p.endswith(".tmp.wav")}
gen = collections.defaultdict(lambda: [0, 0])
for j in jobs:
    k = f"{j['lang']}|{dict(f5='IndicF5', fish='Fish Drama 3').get(j['engine'], 'Chatterbox')}"
    gen[k][1] += 1
    gen[k][0] += j["id"] in done
out["gen"] = [dict(lang=k.split("|")[0], engine=k.split("|")[1], done=v[0], total=v[1]) for k, v in sorted(gen.items())]
mtimes = sorted(os.path.getmtime(f"{W}/synth/{i}.wav") for i in done)
recent = [t for t in mtimes if t > time.time() - 300]
out["gen_rate_per_min"] = round(len(recent) / 5, 1)
fails = 0
for p in glob.glob("/workspace/logs/f5_*.log") + glob.glob("/workspace/logs/cb*_*.log"):
    fails += sum(1 for l in open(p, errors="ignore") if l.startswith("FAIL"))
out["gen_fails"] = fails
newest = sorted(done, key=lambda i: -os.path.getmtime(f"{W}/synth/{i}.wav"))
picks, seen = [], set()
for i in newest:
    key = i.split("-")[0] + i.split("-")[2]
    if key not in seen:
        seen.add(key)
        picks.append(i)
    if len(picks) >= 6:
        break
jmap = {j["id"]: j for j in jobs}
out["samples"] = [dict(id=i, lang=jmap[i]["lang"], text=jmap[i]["target"]) for i in picks]

limits = {"en": 0.2, "hi": 0.35, "gu": 0.35}
filt = collections.defaultdict(lambda: [0, 0])
if os.path.exists(f"{W}/synth_scored.jsonl"):
    rows = {}
    for l in open(f"{W}/synth_scored.jsonl", encoding="utf-8"):
        r = json.loads(l)
        rows[r["id"]] = r
    for r in rows.values():
        ok = r["score"] <= limits[r["lang"]] and 5 <= r["cps"] <= 30 and r["dur"] <= 29
        filt[r["lang"]][0] += ok
        filt[r["lang"]][1] += 1
    out["kept_hours"] = round(sum(r["dur"] for r in rows.values() if r["score"] <= limits[r["lang"]]) / 3600, 2)
out["filter"] = [dict(lang=k, kept=v[0], scored=v[1]) for k, v in sorted(filt.items())]

runs = []
for d in sorted(glob.glob("/workspace/ckpt/*/")):
    name = os.path.basename(d.rstrip("/"))
    run = dict(name=name, train=[], evals=[], best=None, done=False, total=None, cfg=None)
    logp = f"/workspace/logs/train_{name}.log"
    if os.path.exists(logp):
        for l in open(logp, errors="ignore"):
            m = re.search(r"ep (\d+) step (\d+)/(\d+) loss ([\d.]+) lr ([\de.+-]+) (\d+)s", l)
            if m:
                run["train"].append(dict(step=int(m[2]), loss=float(m[4]), lr=float(m[5]), t=int(m[6])))
                run["total"] = int(m[3])
            if "TRAIN DONE" in l:
                run["done"] = True
            if l.startswith("{") and "'run'" in l:
                run["cfg"] = l.strip()[:300]
    if os.path.exists(f"{d}log.jsonl"):
        for l in open(f"{d}log.jsonl", encoding="utf-8"):
            e = json.loads(l)
            run["evals"].append(dict(step=e["step"], score=e["score"], res=e["res"], rows=e["rows"]))
    if os.path.exists(f"{d}best/score.json"):
        run["best"] = json.load(open(f"{d}best/score.json"))
    runs.append(run)
out["runs"] = runs

procs = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True).stdout
out["running"] = {k: procs.count(k) for k in ["gen_f5.py", "gen_cb.py", "filter.py", "train.py"]}
g = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
                   capture_output=True, text=True).stdout.strip().split(", ")
out["gpu"] = dict(util=int(g[0]), mem=int(g[1]), total=int(g[2])) if len(g) == 3 else None
stages = json.load(open("/workspace/stage.json")) if os.path.exists("/workspace/stage.json") else {}
out["stage"] = stages
print(json.dumps(out, ensure_ascii=False))
