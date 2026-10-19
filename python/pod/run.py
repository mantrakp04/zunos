"""Training run on the GPU pod, start to finish. Started by bootstrap.sh after the environments exist.

  data → refs/jobs → voice generation → quality filter → fine-tune → export → upload

Reports progress to the zunos backend (ZUNOS_EVENTS_URL) and uploads the model to ZUNOS_MODEL_URL.
The backend terminates the pod after the final `done` or `error` event.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import traceback
import urllib.request

W = "/workspace/data"
LOGS = "/workspace/logs"
ENVS = "/root/envs"
CODE = os.path.dirname(os.path.abspath(__file__))
RUN = os.environ.get("ZUNOS_RUN_ID", "local")
os.makedirs(LOGS, exist_ok=True)


def event(**body):
    url, token = os.environ.get("ZUNOS_EVENTS_URL"), os.environ.get("ZUNOS_EVENTS_TOKEN")
    print("EVENT", json.dumps(body)[:300], flush=True)
    if not url:
        return
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    for attempt in range(5):
        try:
            urllib.request.urlopen(req, timeout=20).read()
            return
        except Exception as e:  # the backend may be briefly unreachable; never kill the run over it
            print("event failed", attempt, e, flush=True)
            time.sleep(2 ** attempt)


def stage(name, status="running"):
    event(type="stage", stage=name, status=status)


def run(cmd, log, env=None, on_line=None):
    """Run a command, tee its output to LOGS/<log>.log, optionally parse each line. Raises on failure."""
    with open(f"{LOGS}/{log}.log", "a") as f:
        p = subprocess.Popen(cmd, cwd=CODE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             env={**os.environ, **(env or {})})
        for line in p.stdout:
            f.write(line)
            if on_line:
                on_line(line.rstrip("\n"))
        if p.wait():
            tail = open(f"{LOGS}/{log}.log").read().splitlines()[-15:]
            raise RuntimeError(f"{os.path.basename(cmd[1])} failed:\n" + "\n".join(tail))


def py(env):
    return f"{ENVS}/{env}/bin/python"


# ------------------------------------------------------------------ steps

def fetch_data():
    stage("data")
    os.makedirs(f"{W}/incoming", exist_ok=True)
    tgz = f"{W}/incoming/dataset.tar.gz"
    urllib.request.urlretrieve(os.environ["ZUNOS_DATASET_URL"], tgz)
    with tarfile.open(tgz) as t:
        t.extractall(f"{W}/incoming", filter="data")
    src = f"{W}/incoming"
    for sub in ("16k", "48k"):
        os.makedirs(f"{W}/real/final/{sub}", exist_ok=True)
        for f in os.listdir(f"{src}/clips/{sub}"):
            shutil.move(f"{src}/clips/{sub}/{f}", f"{W}/real/final/{sub}/{f}")
    os.makedirs(f"{W}/real/clips", exist_ok=True)  # full takes: room tone for the noise bank
    for f in os.listdir(f"{src}/recordings") if os.path.isdir(f"{src}/recordings") else []:
        shutil.move(f"{src}/recordings/{f}", f"{W}/real/clips/{f}")
    shutil.move(f"{src}/manifest.json", f"{W}/manifest.json")
    m = json.load(open(f"{W}/manifest.json"))
    event(type="log", line=f"dataset: {len(m['clips'])} clips, {len(m['prompts'])} sentences, langs {m['langs']}")
    stage("data", "done")
    return m


def make_jobs():
    run([py("train"), "ref_text.py"], "ref_text")
    run([py("train"), "make_jobs.py"], "make_jobs")
    return [json.loads(l) for l in open(f"{W}/jobs.jsonl", encoding="utf-8")]


def generate(jobs):
    """Chatterbox and IndicF5 workers share the GPU; when Chatterbox finishes, IndicF5 gets more workers."""
    stage("gen")
    by_engine = {e: sum(j["engine"] == e for j in jobs) for e in ("f5", "cb_en", "cb_mtl")}
    env = {"OMP_NUM_THREADS": "2", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
    procs = []

    def spawn(env_name, args, log):
        f = open(f"{LOGS}/{log}.log", "a")
        procs.append((log, subprocess.Popen([py(env_name), *args], cwd=CODE, stdout=f, stderr=subprocess.STDOUT, env={**os.environ, **env})))

    if by_engine["cb_en"]:
        for s in range(3):
            spawn("chatter", ["gen_cb.py", "cb_en", str(s), "3"], f"cben_{s}")
    if by_engine["cb_mtl"]:
        for s in range(2):
            spawn("chatter", ["gen_cb.py", "cb_mtl", str(s), "2"], f"cbmtl_{s}")
    f5_workers = 3 if procs else 6
    for s in range(f5_workers if by_engine["f5"] else 0):
        spawn("indicf5", ["gen_f5.py", str(s), str(f5_workers)], f"f5_{s}")

    total, rebalanced, last = len(jobs), False, 0
    while any(p.poll() is None for _, p in procs):
        time.sleep(30)
        done = len([f for f in os.listdir(f"{W}/synth") if f.endswith(".wav") and not f.endswith(".tmp.wav")]) if os.path.isdir(f"{W}/synth") else 0
        if time.time() - last > 120:
            event(type="log", line=f"generated {done}/{total} voice clips")
            last = time.time()
        cb_running = any(p.poll() is None for log, p in procs if log.startswith("cb"))
        if by_engine["f5"] and not rebalanced and not cb_running and f5_workers == 3:
            # Chatterbox is done: restart IndicF5 with 6 shards (finished clips are skipped).
            for log, p in procs:
                if log.startswith("f5") and p.poll() is None:
                    p.terminate()
            time.sleep(5)
            procs[:] = [(l, p) for l, p in procs if not l.startswith("f5")]
            for s in range(6):
                spawn("indicf5", ["gen_f5.py", str(s), "6"], f"f5_r{s}")
            rebalanced = True
    failed = [log for log, p in procs if p.returncode not in (0, None, -15)]
    if failed:
        event(type="log", line=f"generator workers exited with errors: {failed}")
    stage("gen", "done")


def filter_clips():
    stage("filter")
    run([py("train"), "filter.py"], "filter", env={"OMP_NUM_THREADS": "4"})
    stage("filter", "done")


TRAIN_LINE = re.compile(r"ep (\d+) step (\d+)/(\d+) loss ([\d.]+) lr ([\d.e+-]+)")


def train(cfg):
    stage("train")
    args = {"run": RUN, "base": "openai/whisper-large-v3", "epochs": 4, "bs": 16, "accum": 2, "gc": 1,
            "eval_every": 50, "base_eval": 0, **{k: v for k, v in cfg.get("train", {}).items()}}
    log_path = f"/workspace/ckpt/{RUN}/log.jsonl"
    sent = 0

    def on_line(line):
        nonlocal sent
        if m := TRAIN_LINE.search(line):
            event(type="train", step=int(m[2]), total=int(m[3]), loss=float(m[4]), lr=float(m[5]))
        if line.startswith("EVAL") and os.path.exists(log_path):
            rows = open(log_path).read().splitlines()
            for r in rows[sent:]:
                e = json.loads(r)
                event(type="eval", step=e["step"], score=e["score"], res=e["res"])
            sent = len(rows)

    run([py("train"), "train.py", *[f"{k}={v}" for k, v in args.items()]], f"train_{RUN}", env={"OMP_NUM_THREADS": "1"}, on_line=on_line)
    stage("train", "done")
    return json.load(open(f"/workspace/ckpt/{RUN}/best/score.json"))


def export_and_upload(score):
    stage("export")
    out = f"/workspace/export/{RUN}-hf"
    run([py("train"), "export.py", f"/workspace/ckpt/{RUN}/best", out], "export")
    tar = f"/workspace/export/{RUN}.tar"
    with tarfile.open(tar, "w") as t:  # safetensors don't compress; plain tar
        t.add(out, arcname=f"{RUN}-hf")
    stage("export", "done")
    stage("upload")
    size = os.path.getsize(tar)
    subprocess.run(["curl", "-fsS", "--retry", "5", "-X", "PUT", "-H", "Content-Type: application/x-tar", "-T", tar,
                    os.environ["ZUNOS_MODEL_URL"]], check=True)
    stage("upload", "done")
    return size


def main():
    try:
        m = fetch_data()
        jobs = make_jobs()
        generate(jobs)
        filter_clips()
        score = train(m.get("cfg", {}))
        size = export_and_upload(score)
        event(type="done", best_step=score["step"], best_score=score["score"], model_bytes=size)
    except Exception as e:
        traceback.print_exc()
        event(type="error", message=f"{type(e).__name__}: {e}"[-2000:])
        sys.exit(1)


if __name__ == "__main__":
    main()
