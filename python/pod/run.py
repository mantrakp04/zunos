"""A training run (an experiment of one or more variants) on the GPU pod, start to finish.

  data -> splits -> references, pace, jobs -> generate (cached) -> judge (cached) -> variants -> report -> upload

Pod mode (bootstrap.sh starts it): reads the dataset at ZUNOS_DATASET_URL, the experiment spec from its
manifest's `cfg` (config.py; empty = the production recipe), reports to ZUNOS_EVENTS_URL, keeps synthetic
sets in ZUNOS_CACHE (default /workspace/cache, a network volume if one is mounted) and in the backend
(ZUNOS_CACHE_URL), uploads the exported variant's model to ZUNOS_MODEL_URL. The backend terminates the pod
after the final `done` or `error` event.

Dry run (on the Mac, no GPU, nothing uploaded): the same steps with stand-ins, macOS `say` for the TTS, an
identity voice conversion, whisper-tiny as judge and base, a handful of sentences and steps:

  python run.py --dry-run [--spec spec.json] [--work /tmp/zunos-dry] [--langs en,hi] [--clips-per-lang 6]

It reads the app's own clips (~/Library/Application Support/zunos), test split included, so the report has
the same shape as a pod's.
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import traceback
import urllib.request

import config
from cache import Cache
from data import assign, prompt_lines, read_jsonl, write_jsonl, write_real

CODE = os.path.dirname(os.path.abspath(__file__))
RUN = os.environ.get("ZUNOS_RUN_ID", "local")
JUDGE_VERSION = 2
ARGS = None
WORK = LOGS = None
T_START = time.time()
PRICE = float(os.environ.get("ZUNOS_PRICE_PER_HOUR") or 0)


def event(**body):
    url, token = os.environ.get("ZUNOS_EVENTS_URL"), os.environ.get("ZUNOS_EVENTS_TOKEN")
    print("EVENT", json.dumps(body, ensure_ascii=False)[:300], flush=True)
    if not url or ARGS.dry_run:
        return
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    for attempt in range(5):
        try:
            urllib.request.urlopen(req, timeout=20).read()
            return
        except urllib.error.HTTPError as e:
            if e.code == 409:  # the run was stopped: give up rather than keep billing
                print("run finished on the backend; exiting", flush=True)
                os._exit(3)
            print("event failed", attempt, e, flush=True)
        except Exception as e:  # the backend may be briefly unreachable; never kill the run over it
            print("event failed", attempt, e, flush=True)
        time.sleep(2 ** attempt)


def log(line):
    event(type="log", line=line)


def stage(name, status="running"):
    event(type="stage", stage=name, status=status)


def py(env):
    if ARGS.dry_run:
        return sys.executable
    return f"/root/envs/{env}/bin/python"


def run(cmd, logname, env=None, on_line=None, cwd=None):
    """Run a command, tee its output to LOGS/<logname>.log, optionally parse each line. Raises on failure."""
    with open(f"{LOGS}/{logname}.log", "a") as f:
        p = subprocess.Popen(cmd, cwd=cwd or CODE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             env={**os.environ, **(env or {})})
        for line in p.stdout:
            f.write(line)
            if ARGS.verbose:
                sys.stdout.write(line)
            if on_line:
                on_line(line.rstrip("\n"))
        if p.wait():
            tail = open(f"{LOGS}/{logname}.log").read().splitlines()[-20:]
            raise RuntimeError(f"{logname} failed:\n" + "\n".join(tail))


def spawn(cmd, logname, env=None, cwd=None):
    f = open(f"{LOGS}/{logname}.log", "a")
    return subprocess.Popen(cmd, cwd=cwd or CODE, stdout=f, stderr=subprocess.STDOUT, env={**os.environ, **(env or {})})


def wait_all(procs, what):
    bad = [n for n, p in procs if p.wait() != 0]
    if bad:
        tails = {n: open(f"{LOGS}/{n}.log").read().splitlines()[-8:] for n in bad}
        raise RuntimeError(f"{what} failed: {json.dumps(tails, ensure_ascii=False)[:1500]}")


# ------------------------------------------------------------------ environments

ENV_PROCS = {}


def ensure_env(name):
    """Start installing a Python environment in the background (envs.sh); idempotent."""
    if ARGS.dry_run or name in ENV_PROCS:
        return
    ENV_PROCS[name] = spawn(["bash", f"{CODE}/envs.sh", name], f"env_{name}")


def need_env(name):
    if ARGS.dry_run:
        return
    ensure_env(name)
    if ENV_PROCS[name].wait() != 0:
        raise RuntimeError(f"installing the {name} environment failed:\n" + "\n".join(open(f"{LOGS}/env_{name}.log").read().splitlines()[-15:]))


def judge_env(model):
    return "omniasr" if model == "omniasr" else "judge"


# ------------------------------------------------------------------ data

def fetch_data():
    D = f"{WORK}/data"
    os.makedirs(f"{D}/incoming", exist_ok=True)
    tgz = f"{D}/incoming/dataset.tar.gz"
    urllib.request.urlretrieve(os.environ["ZUNOS_DATASET_URL"], tgz)
    with tarfile.open(tgz) as t:
        t.extractall(f"{D}/incoming", filter="data")
    src = f"{D}/incoming"
    for sub in ("16k", "48k"):
        os.makedirs(f"{D}/real/{sub}", exist_ok=True)
        for f in os.listdir(f"{src}/clips/{sub}") if os.path.isdir(f"{src}/clips/{sub}") else []:
            shutil.move(f"{src}/clips/{sub}/{f}", f"{D}/real/{sub}/{f}")
    os.makedirs(f"{D}/real/recordings", exist_ok=True)  # full takes: room tone for the noise bank
    for f in os.listdir(f"{src}/recordings") if os.path.isdir(f"{src}/recordings") else []:
        shutil.move(f"{src}/recordings/{f}", f"{D}/real/recordings/{f}")
    shutil.move(f"{src}/manifest.json", f"{D}/manifest.json")
    shutil.rmtree(src, ignore_errors=True)
    return json.load(open(f"{D}/manifest.json", encoding="utf-8"))


APP_DIR = os.path.expanduser("~/Library/Application Support/zunos")


def dataset_from_app(langs, per_lang, app_dir):
    """Dry run: the app's clips (and cached reference answers) as if unpacked from a dataset. Read-only.
    `app_dir` may be an archived copy of the data folder: absolute paths into the live folder are remapped."""
    D = f"{WORK}/data"
    for sub in ("16k", "48k", "recordings"):
        os.makedirs(f"{D}/real/{sub}", exist_ok=True)
    db = sqlite3.connect(f"file:{app_dir}/zunos.db?mode=ro", uri=True)
    db.row_factory = sqlite3.Row

    def absp(p):
        if not p:
            return p
        if p.startswith(APP_DIR + "/") and app_dir != APP_DIR:
            p = p[len(APP_DIR) + 1:]
        return p if p.startswith("/") else f"{app_dir}/{p}"
    clips, prompts = [], []
    for lang in langs:
        rows = db.execute("SELECT * FROM clips WHERE lang = ? ORDER BY split DESC, id", (lang,)).fetchall()
        test = [r for r in rows if r["split"] == "test"][: max(2, per_lang // 3)]
        train = [r for r in rows if r["split"] == "train"][:per_lang]
        for r in test + train:
            c = dict(id=r["id"], lang=lang, split=r["split"], text=r["text"], native_text=r["native_text"],
                     seconds=r["seconds"], kind=r["kind"])
            shutil.copy(absp(r["path_16k"]), f"{D}/real/16k/{r['id']}.wav")
            if r["split"] == "train" and r["path_48k"] and os.path.exists(absp(r["path_48k"])):
                shutil.copy(absp(r["path_48k"]), f"{D}/real/48k/{r['id']}.wav")
            clips.append(c)
        for p in db.execute("SELECT * FROM prompts WHERE lang = ? AND kind = 'sentence' LIMIT 20", (lang,)).fetchall():
            native, roman = prompt_lines(p)
            prompts.append(dict(id=p["id"], lang=lang, roman=roman, native=native))
    reference = {}
    try:
        sys.path.insert(0, os.path.join(CODE, "../engine/src"))
        import zunos_engine.reference as zr

        if (zr.Path(app_dir) / "reference").is_dir():
            zr.CACHE_DIR = zr.Path(app_dir) / "reference"
        reference = zr.cached_texts([dict(c, path=f"{D}/real/16k/{c['id']}.wav") for c in clips if c["split"] == "test"])
    except Exception as e:
        print("no reference answers:", e)
    m = dict(langs=langs, cfg={}, clips=clips, prompts=prompts, reference=reference)
    json.dump(m, open(f"{D}/manifest.json", "w"), ensure_ascii=False)
    return m


DRY = {
    "gen": {"engines": {"default": ["say"], "hi": ["say", "vc"]}, "max_lines_per_lang": 6,
            "vc": {"tts": "say", "model": "identity"}, "refs": {"per_lang": 4, "min_s": 1.0, "max_s": 15.0}},
    "judge": {"models": {"en": "whisper", "indic": "whisper", "default": "whisper", "longtail": []},
              "whisper_model": "openai/whisper-tiny", "max_err": 1.0, "abs_floor": 1.0,
              "speaker": {"enabled": True, "min_rel": 0.0}, "pace": {"enabled": True, "slack": 5.0}},
    "dev": {"real_per_lang": 1, "min_train_left": 2},
    "train": {"base": "openai/whisper-tiny", "bs": 4, "accum": 1, "gc": 0, "workers": 0, "eval_every": 3,
              "beams": 2, "stage1": {"epochs": 1, "steps": 6}, "stage2": {"steps": 3}},
}


# ------------------------------------------------------------------ steps

def references_and_jobs(cfg, m):
    D = f"{WORK}/data"
    engines = {e for l in m["langs"] for e in config.engines_for(cfg["gen"], l)}
    if engines & {"omnivoice", "higgs"}:  # these condition on the reference's transcript
        run([py("train"), "ref_text.py", WORK, cfg["judge"]["whisper_model"] if ARGS.dry_run else "openai/whisper-large-v3"], "ref_text")
    run([py("train"), "make_jobs.py", WORK], "make_jobs")
    for lang, s in json.load(open(f"{D}/gen_summary.json")).items():
        log(f"{lang}: {s['sentences']} sentences ({s['script']}), {s['refs']} refs, pace {s.get('pace')}, paths {s['engines']}, "
            f"{s['dropped_for_test_overlap']} dropped for test overlap")
    return json.load(open(f"{D}/shards.json"))


def generate(cfg, shards, cache):
    """Every shard not in the cache: TTS (and VC), then post.py. Returns shards with their directory."""
    gen = cfg["gen"]
    ready, todo = [], []
    for s in shards:
        d = cache.get_dir(f"synth-{s['key']}")
        (ready if d else todo).append(dict(s, dir=d))
    log(f"synthetic shards: {len(ready)} cached, {len(todo)} to generate ({sum(s['n'] for s in todo)} takes)")
    if not todo:
        return ready
    stage("gen")
    base = lambda s: config.base_engine(s["engine"])  # noqa: E731
    tts_of = lambda s: config.vc_tts(gen, s["lang"]) if base(s) == "vc" else base(s)  # noqa: E731
    needed = {tts_of(s) for s in todo}
    for e in needed:
        ensure_env({"omnivoice": "omnivoice", "higgs": "higgs", "say": "train"}[e])
    if any(base(s) == "vc" for s in todo):
        ensure_env({"seed-vc": "seedvc", "chatterbox-vc": "chattervc", "identity": "train"}[gen["vc"]["model"]])
    higgs = None
    if "higgs" in needed:
        need_env("higgs")
        port = gen["higgs"]["port"]
        higgs = spawn(["/root/envs/higgs/bin/sgl-omni", "serve", "--model-path", "bosonai/higgs-tts-3-4b",
                       "--allowed-local-media-path", WORK, "--port", str(port)], "higgs_server")
        for _ in range(240):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5)
                break
            except Exception:
                if higgs.poll() is not None:
                    raise RuntimeError("the Higgs server exited during startup (see higgs_server.log)")
                time.sleep(15)
    t0 = time.time()
    try:
        for i, s in enumerate(todo):
            d = f"{WORK}/shards/{s['key']}"
            os.makedirs(d, exist_ok=True)
            tts = tts_of(s)
            env = {"PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True", "OMP_NUM_THREADS": "2"}
            if tts == "omnivoice":
                need_env("omnivoice")
                n = int(os.environ.get("ZUNOS_TTS_WORKERS", 3))
                wait_all([(f"omnivoice_{s['key']}_{w}", spawn([py("omnivoice"), "gen_omnivoice.py", s["jobs"], d, str(w), str(n)],
                                                              f"omnivoice_{s['key']}_{w}", env)) for w in range(n)], "OmniVoice")
            elif tts == "higgs":
                run([py("train"), "gen_higgs.py", s["jobs"], d, f"http://127.0.0.1:{gen['higgs']['port']}"], f"higgs_{s['key']}")
            elif tts == "say":
                run([sys.executable, "gen_say.py", s["jobs"], d, "0", "1"], f"say_{s['key']}")
            if base(s) == "vc":
                venv = {"seed-vc": "seedvc", "chatterbox-vc": "chattervc", "identity": "train"}[gen["vc"]["model"]]
                need_env(venv)
                n = 1 if ARGS.dry_run else int(os.environ.get("ZUNOS_VC_WORKERS", 2))
                vc_env = dict(env, SEEDVC_DIR=os.environ.get("SEEDVC_DIR", "/root/seed-vc"))
                wait_all([(f"vc_{s['key']}_{w}", spawn([py(venv), f"{CODE}/vc.py", s["jobs"], d, str(w), str(n)],
                                                       f"vc_{s['key']}_{w}", vc_env)) for w in range(n)], "voice conversion")
            run([py("train"), "post.py", s["jobs"], d], f"post_{s['key']}")
            for sub in ("raw", "tts"):
                shutil.rmtree(f"{d}/{sub}", ignore_errors=True)
            kept = sum(1 for _ in open(f"{d}/takes.jsonl"))
            ready.append(dict(s, dir=cache.put_dir(f"synth-{s['key']}", d)))
            log(f"generated {s['lang']}/{s['engine']}: {kept}/{s['n']} takes ({i + 1}/{len(todo)} shards, {time.time() - t0:.0f}s)")
    finally:
        if higgs:
            higgs.terminate()
    stage("gen", "done")
    return ready


def judge(cfg, shards, cache):
    """ASR + speaker embeddings for each shard (cached per shard and judge), real-clip calibration, decisions."""
    from judge import judge_for

    stage("filter")
    D, J = f"{WORK}/data", f"{WORK}/judge"
    os.makedirs(J, exist_ok=True)
    jcfg = cfg["judge"]
    real = [r for r in read_jsonl(f"{D}/real.jsonl") if r["split"] in ("train", "dev")]
    for m in {judge_for(jcfg, s["lang"]) for s in shards} | {judge_for(jcfg, r["lang"]) for r in real}:
        ensure_env(judge_env(m))
    ensure_env("judge")
    whisper_id = jcfg["whisper_model"]

    def asr(model, items, out, tag):
        need_env(judge_env(model))
        write_jsonl(f"{J}/{tag}.list.jsonl", items)
        run([py(judge_env(model)), "judge.py", "asr", model, f"{J}/{tag}.list.jsonl", out, whisper_id], f"judge_{tag}")

    # Calibration on the user's real clips (train + dev, never test): small, recomputed every run.
    for m in sorted({judge_for(jcfg, r["lang"]) for r in real}):
        asr(m, [dict(id=r["id"], lang=r["lang"], path=r["path"]) for r in real if judge_for(jcfg, r["lang"]) == m],
            f"{J}/real-{m}.jsonl", f"real-{m}")
    if jcfg["speaker"]["enabled"]:
        write_jsonl(f"{J}/real-speaker.list.jsonl", [dict(id=r["id"], lang=r["lang"], path=r["path"]) for r in real])
        need_env("judge")
        run([py("judge"), "judge.py", "speaker", f"{J}/real-speaker.list.jsonl", f"{J}/real-speaker.jsonl"], "judge_real_speaker")

    out = []
    for s in shards:
        m = judge_for(jcfg, s["lang"])
        jkey = config.digest(JUDGE_VERSION, s["key"], m, whisper_id if m == "whisper" else None, jcfg["speaker"]["enabled"])
        d = cache.get_dir(f"judged-{jkey}")
        if not d:
            d = f"{WORK}/judged/{jkey}"
            os.makedirs(d, exist_ok=True)
            items = [dict(id=t["id"], lang=t["lang"], path=f"{s['dir']}/{t['file']}") for t in read_jsonl(f"{s['dir']}/takes.jsonl")]
            asr(m, items, f"{d}/asr.jsonl", f"synth-{jkey}")
            if jcfg["speaker"]["enabled"]:
                write_jsonl(f"{d}/speaker.list.jsonl", items)
                run([py("judge"), "judge.py", "speaker", f"{d}/speaker.list.jsonl", f"{d}/speaker.jsonl"], f"judge_spk_{jkey}")
            d = cache.put_dir(f"judged-{jkey}", d)
        out.append(dict(s, judged=d))
    json.dump(out, open(f"{D}/shards_ready.json", "w"), indent=1)
    run([py("judge"), "judge.py", "score", WORK], "judge_score")
    rep = json.load(open(f"{D}/judge_report.json"))
    for k, v in rep["shards"].items():
        log(f"judge {k}: kept {v['kept']}/{v['takes']} (styled {v['styled_kept']}/{v['styled']}; words thr {v['threshold']} "
            f"from clean err {v['clean_err']}, real-clip err {v['real_ceiling']}; voice thr {v['voice_thr']} median "
            f"{v['voice_median']} real {v['real_voice_sim']}; rejected {v['rejected']})")
    stage("filter", "done")
    return rep


STEP_LINE = re.compile(r"STEP (\w+) (\d+)/(\d+) step (\d+) loss ([\d.]+) lr ([\d.e+-]+)")


def train_variant(run_cfg, primary, offset):
    out = f"{WORK}/ckpt/{run_cfg['name']}"
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    vpath = f"{out}/variant.json"
    json.dump(run_cfg, open(vpath, "w"), indent=1)
    last = [time.time()]

    def on_line(line):
        if m := STEP_LINE.search(line):
            if primary:
                event(type="train", step=offset + int(m[4]), total=0, loss=float(m[5]), lr=float(m[6]))
        elif line.startswith("DEV "):
            d = json.loads(line[4:])
            log(f"{run_cfg['name']} dev @{d['step']} ({d['stage']}): {d['dev']}  {json.dumps(d['res'])}")
        elif line.startswith(("data ", "model ", "modes ", "selected ", "HYP ")) or "Error" in line:
            log(f"{run_cfg['name']}: {line[:400]}")
        elif time.time() - last[0] > 600:  # keep the backend's stall timer fed during long stages
            last[0] = time.time()
            log(f"{run_cfg['name']}: {line[:200]}")

    t0 = time.time()
    run([py("train"), "train.py", WORK, vpath, out], f"train_{run_cfg['name']}", env={"OMP_NUM_THREADS": "1"}, on_line=on_line)
    rep = json.load(open(f"{out}/report.json"))
    rep["seconds"]["total"] = round(time.time() - t0)
    rep["cost_usd"] = round(PRICE * (time.time() - t0) / 3600, 3)
    json.dump(rep, open(f"{out}/report.json", "w"), indent=1, ensure_ascii=False)
    return rep


def summary_table(reports, judge_rep, shared_s):
    """Markdown comparison: per-language WER [95% CI] vs the reference recognizer, ratio, 2x verdict."""
    langs = sorted({l for r in reports for l in r["test"]["langs"]})
    lines = ["| variant | " + " | ".join(langs) + " | avg | train min | cost |", "|---" * (len(langs) + 4) + "|"]
    for r in reports:
        cells = []
        for l in langs:
            s = r["test"]["langs"].get(l)
            if not s:
                cells.append("-")
                continue
            c = f"{s['wer']:.1%} [{s['ci'][0]:.0%}-{s['ci'][1]:.0%}]"
            if "ratio" in s:
                c += f" x{s['ratio']:.2f} {s['verdict']}"
            cells.append(c)
        lines.append(f"| {r['variant']} | " + " | ".join(cells) + f" | {r['test']['avg']} | {r['seconds']['train'] / 60:.0f} | ${r.get('cost_usd', 0):.2f} |")
    ref = reports[0]["test"]["langs"] if reports else {}
    lines.append("| reference | " + " | ".join(f"{ref[l]['other']:.1%} [{ref[l]['other_ci'][0]:.0%}-{ref[l]['other_ci'][1]:.0%}]"
                                                if l in ref and "other" in ref[l] else "-" for l in langs) + " | | | |")
    lines.append("")
    lines.append(f"Shared (setup, generation, judging): {shared_s / 60:.0f} min, ${PRICE * shared_s / 3600:.2f}. "
                 "xN = reference WER / ours (paired bootstrap over the same clips); pass = 95% CI lower bound >= 2, "
                 "likely = point estimate >= 2.")
    return "\n".join(lines)


def export_and_upload(name):
    stage("export")
    src = f"{WORK}/ckpt/{name}"
    out = f"{WORK}/export/{RUN}-hf"
    run([py("train"), "export.py", f"{src}/model", out, src], "export")
    tar = f"{WORK}/export/{RUN}.tar"
    with tarfile.open(tar, "w") as t:  # safetensors don't compress; plain tar
        t.add(out, arcname=f"{RUN}-hf")
    stage("export", "done")
    size = os.path.getsize(tar)
    if os.environ.get("ZUNOS_MODEL_URL") and not ARGS.dry_run:
        stage("upload")
        subprocess.run(["curl", "-fsS", "--retry", "5", "-X", "PUT", "-H", "Content-Type: application/x-tar", "-T", tar,
                        os.environ["ZUNOS_MODEL_URL"]], check=True)
        stage("upload", "done")
    return size


def main():
    global ARGS, WORK, LOGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--spec", help="experiment spec JSON (overrides the dataset's cfg)")
    ap.add_argument("--work", default=None)
    ap.add_argument("--langs", default="en,hi")
    ap.add_argument("--clips-per-lang", type=int, default=6)
    ap.add_argument("--app-dir", default=APP_DIR, help="dry run: the app data folder to read (read-only)")
    ap.add_argument("--verbose", action="store_true")
    ARGS = ap.parse_args()
    WORK = ARGS.work or ("/tmp/zunos-dry" if ARGS.dry_run else os.environ.get("ZUNOS_WORK", "/workspace"))
    LOGS = f"{WORK}/logs"
    if ARGS.dry_run:
        shutil.rmtree(f"{WORK}/data", ignore_errors=True)
        shutil.rmtree(f"{WORK}/ckpt", ignore_errors=True)
    os.makedirs(LOGS, exist_ok=True)
    D = f"{WORK}/data"
    try:
        stage("data")
        if ARGS.dry_run:
            m = dataset_from_app(ARGS.langs.split(","), ARGS.clips_per_lang, ARGS.app_dir.rstrip("/"))
        else:
            m = fetch_data()
        spec = json.load(open(ARGS.spec)) if ARGS.spec else (m.get("cfg") or {})
        if ARGS.dry_run:
            spec = config.merge(spec, {k: v for k, v in DRY.items() if k != "train"})
            spec["train"] = config.merge(spec.get("train", {}), DRY["train"])
            spec["variants"] = [config.merge(v, {k: x for k, x in DRY["train"].items() if k in v}) for v in spec.get("variants") or [{"name": "default"}]]
        cfg = config.load(spec)
        # Environments install in the background while the data is prepared.
        for e in ["train", "judge", *sorted(config.tts_engines(cfg["gen"], m["langs"]) & {"omnivoice", "higgs"})]:
            ensure_env(e)
        if any(config.base_engine(e) == "vc" for l in m["langs"] for e in config.engines_for(cfg["gen"], l)):
            ensure_env({"seed-vc": "seedvc", "chatterbox-vc": "chattervc"}.get(cfg["gen"]["vc"]["model"], "train"))
        json.dump({k: v for k, v in cfg.items()}, open(f"{D}/cfg.json", "w"), indent=1, ensure_ascii=False)
        clips = assign(m["clips"], cfg["dev"])
        write_real(WORK, clips)
        json.dump(m.get("reference") or {}, open(f"{D}/reference.json", "w"), ensure_ascii=False)
        n = {s: sum(c["split"] == s for c in clips) for s in ("train", "dev", "test")}
        log(f"dataset: {len(clips)} clips ({n}), langs {m['langs']}, experiment {cfg['name']!r} with "
            f"{len(cfg['runs'])} variant(s): {[r['name'] for r in cfg['runs']]}; reference answers for "
            f"{len(m.get('reference') or {})} test clips")
        stage("data", "done")

        need_env("train")
        cache = Cache(os.environ.get("ZUNOS_CACHE", f"{WORK}/cache"), os.environ.get("ZUNOS_CACHE_URL") if not ARGS.dry_run else None,
                      os.environ.get("ZUNOS_EVENTS_TOKEN"), log)
        shards = references_and_jobs(cfg, m)
        shards = generate(cfg, shards, cache)
        judge_rep = judge(cfg, shards, cache) if shards else {"shards": {}}
        if not shards:
            write_jsonl(f"{D}/synth.jsonl", [])
        shared_s = time.time() - T_START

        stage("train")
        export = cfg.get("export") or cfg["runs"][0]["name"]
        reports, offset = [], 0
        for r in cfg["runs"]:
            rep = train_variant(r, r["name"] == export, offset)
            offset += rep["steps"]
            reports.append(rep)
            t = rep["test"]
            log(f"{r['name']} test: avg {t['avg']} " + "  ".join(
                f"{l}: {s['wer']:.3f} [{s['ci'][0]:.3f}, {s['ci'][1]:.3f}]" + (f" ref {s['other']:.3f} x{s['ratio']} {s['verdict']}" if "ratio" in s else "")
                for l, s in t["langs"].items()))
        stage("train", "done")

        table = summary_table(reports, judge_rep, shared_s)
        summary = dict(experiment=cfg["name"], run=RUN, price_per_hour=PRICE, shared_seconds=round(shared_s),
                       total_seconds=round(time.time() - T_START), judge=judge_rep, variants=reports, table=table,
                       gen=json.load(open(f"{D}/gen_summary.json")))
        os.makedirs(f"{WORK}/reports", exist_ok=True)
        json.dump(summary, open(f"{WORK}/reports/{RUN}.json", "w"), indent=1, ensure_ascii=False)
        open(f"{WORK}/reports/{RUN}.md", "w").write(f"# {cfg['name']} ({RUN})\n\n{table}\n")
        print(table, flush=True)

        size = export_and_upload(export)
        primary = next(r for r in reports if r["variant"] == export)
        # The app reads evals: one, the exported variant's test score (selection never used it).
        event(type="eval", step=primary["steps"], score=primary["test"]["avg"] or 0,
              res={l: s["wer"] for l, s in primary["test"]["langs"].items()})
        event(type="report", report=dict(experiment=cfg["name"], table=table, variants=[
            dict(name=r["variant"], base=r["base"], method=r["method"], test=r["test"], seconds=r["seconds"],
                 cost_usd=r.get("cost_usd"), selected_step=r["selected_step"]) for r in reports],
            judge=judge_rep["shards"], total_seconds=summary["total_seconds"],
            cost_usd=round(PRICE * summary["total_seconds"] / 3600, 3)))
        event(type="done", best_step=primary["steps"], best_score=primary["test"]["avg"] or 0, model_bytes=size)
    except Exception as e:
        traceback.print_exc()
        event(type="error", message=f"{type(e).__name__}: {e}"[-2000:])
        sys.exit(1)


if __name__ == "__main__":
    main()
