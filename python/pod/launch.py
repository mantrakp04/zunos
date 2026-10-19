"""Launch an experiment on a cloud GPU through the zunos backend, from the owner's Mac.

    cd python
    uv run python pod/launch.py experiments/session1.json --langs en,hi,gu            # quote only
    uv run python pod/launch.py experiments/session1.json --langs en,hi,gu --yes      # pack, upload, start, follow

Reads the app's recordings (or --app-dir, e.g. an archived copy; read-only), packs them exactly as the app
does (zunos_engine.pack, with the reference recognizer's cached answers for the test clips) with the spec as
the manifest's `cfg`, then creates and starts a run. The backend enforces the hourly budget (MAX_HOURLY_USD)
and the run-length cap (MAX_RUN_HOURS) as for app runs. Without --yes it only prints the quote.

Needs ZUNOS_API_URL and ZUNOS_OWNER_TOKEN (the server's OWNER_TOKEN) in the environment or the repo's
git-ignored .env.local. Follows the run until it finishes, printing the pod's log lines, then prints the
report table and saves the full report to <app dir>/runs/<run id>.report.json. --download also installs the
model into <app dir>/models/<run id>-hf (the app's own download does the same for app-started runs).
"""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
APP_DIR = os.path.expanduser("~/Library/Application Support/zunos")
sys.path.insert(0, str(HERE))
import config  # noqa: E402
from data import prompt_lines  # noqa: E402


def settings():
    file = {}
    env_file = ROOT / ".env.local"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            k, sep, v = line.partition("=")
            if sep and not k.lstrip().startswith("#"):
                file[k.strip()] = v.strip().strip("\"'")
    get = lambda k: os.environ.get(k) or file.get(k)
    url, token = get("ZUNOS_API_URL"), get("ZUNOS_OWNER_TOKEN")
    if not url or not token:
        raise SystemExit("set ZUNOS_API_URL and ZUNOS_OWNER_TOKEN (environment or .env.local)")
    return url.rstrip("/"), token


def api(base, token, path, method="GET", body=None):
    req = urllib.request.Request(f"{base}{path}", method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"x-zunos-owner-token": token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path}: HTTP {e.code} {e.read().decode(errors='replace')[:400]}") from None


def dataset(app_dir, langs):
    """The same rows the app's library.trainingDataset() returns."""
    db = sqlite3.connect(f"file:{app_dir}/zunos.db?mode=ro", uri=True)
    db.row_factory = sqlite3.Row

    def absp(p):
        if not p:
            return p
        if p.startswith(APP_DIR + "/") and app_dir != APP_DIR:
            p = p[len(APP_DIR) + 1:]
        return p if p.startswith("/") else f"{app_dir}/{p}"

    q = ",".join("?" * len(langs))
    cs = db.execute(f"SELECT * FROM clips WHERE lang IN ({q})", langs).fetchall()
    ps = db.execute(f"SELECT * FROM prompts WHERE lang IN ({q}) AND kind = 'sentence'", langs).fetchall()
    rec_ids = sorted({c["recording_id"] for c in cs if c["split"] == "train" and c["recording_id"]})
    recs = db.execute(f"SELECT path FROM recordings WHERE id IN ({','.join('?' * len(rec_ids))})", rec_ids).fetchall() if rec_ids else []
    clips = [dict(id=c["id"], lang=c["lang"], split=c["split"], text=c["text"], native_text=c["native_text"], seconds=c["seconds"],
                  kind=c["kind"], path_16k=absp(c["path_16k"]), path_48k=absp(c["path_48k"]) if c["path_48k"] else None) for c in cs]
    prompts = [dict(id=p["id"], lang=p["lang"], native=n, roman=r) for p in ps for n, r in [prompt_lines(p)]]
    return clips, prompts, [absp(r["path"]) for r in recs]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--langs", required=True)
    ap.add_argument("--app-dir", default=APP_DIR)
    ap.add_argument("--yes", action="store_true", help="actually start (bills the owner's Runpod account)")
    ap.add_argument("--download", action="store_true")
    a = ap.parse_args()
    spec = json.load(open(a.spec))
    cfg = config.load(spec)  # validates the spec before anything is uploaded
    langs = a.langs.split(",")
    uses = config.tts_engines(cfg["gen"], langs) | {e for l in langs for e in config.engines_for(cfg["gen"], l)}
    min_cuda = "13.0" if "higgs" in uses else "12.8"
    base, token = settings()
    app_dir = a.app_dir.rstrip("/")

    clips, prompts, recordings = dataset(app_dir, langs)
    by = {}
    for c in clips:
        by.setdefault(f"{c['lang']}/{c['split']}", [0, 0.0])
        by[f"{c['lang']}/{c['split']}"][0] += 1
        by[f"{c['lang']}/{c['split']}"][1] += c["seconds"]
    print(f"experiment {cfg['name']!r}: variants {[r['name'] for r in cfg['runs']]}, paths {sorted(uses)}, host CUDA >= {min_cuda}")
    print("clips:", {k: f"{n} ({s / 60:.1f} min)" for k, (n, s) in sorted(by.items())})
    q = api(base, token, f"/quote?minCuda={min_cuda}")
    print(f"quote: {q['gpu']} at ${q['pricePerHour']:.2f}/h, available={q['available']} {q.get('reason', '')}")
    if not a.yes:
        print("dry: pass --yes to pack, upload and start")
        return
    if not q["available"]:
        raise SystemExit("not available within the budget right now")

    sys.path.insert(0, str(ROOT / "python/engine/src"))
    import zunos_engine.reference as zr
    from zunos_engine.pack import pack

    if (Path(app_dir) / "reference").is_dir():
        zr.CACHE_DIR = Path(app_dir) / "reference"
    run = api(base, token, "/runs", "POST", {"langs": langs, "minCuda": min_cuda})
    with tempfile.TemporaryDirectory() as tmp:
        out = pack(f"{tmp}/dataset.tar.gz", langs, clips, prompts, recordings, spec)
        print(f"packed {out['clips']} clips, {out['bytes'] >> 20} MB; uploading")
        subprocess.run(["curl", "-fsS", "--retry", "3", "-X", "PUT", "-H", "Content-Type: application/gzip", "-T", out["path"],
                        run["uploadUrl"]], check=True, stdout=subprocess.DEVNULL)
    r = api(base, token, f"/runs/{run['id']}/start", "POST")
    print(f"started run {run['id']} ({r['status']}); following (Ctrl-C stops following, not the run)")
    prev = []
    while r["status"] in ("queued", "running"):
        time.sleep(30)
        r = api(base, token, f"/runs/{run['id']}")
        logs = r.get("logs") or []  # the last 200 lines: print what follows the overlap with the previous poll
        k = next((k for k in range(min(len(prev), len(logs)), 0, -1) if prev[-k:] == logs[:k]), 0)
        for line in logs[k:]:
            print("  ", line[:300])
        prev = logs
        print(f"[{r['status']} {r['stage']}] ${r['costUsd']:.2f}", end="\r", flush=True)
    print(f"\nrun {run['id']}: {r['status']}, ${r['costUsd']:.2f} {r.get('error') or ''}")
    if r.get("report"):
        Path(f"{app_dir}/runs").mkdir(parents=True, exist_ok=True)
        Path(f"{app_dir}/runs/{run['id']}.report.json").write_text(json.dumps(r["report"], indent=1, ensure_ascii=False))
        print(r["report"].get("table", ""))
    if a.download and r.get("modelUrl"):
        tar = f"{app_dir}/tmp/{run['id']}.tar"
        Path(tar).parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["curl", "-fsS", "--retry", "3", "-o", tar, r["modelUrl"]], check=True)
        subprocess.run(["tar", "xf", tar, "-C", f"{app_dir}/models"], check=True)
        os.remove(tar)
        print(f"model in {app_dir}/models/{run['id']}-hf  (score it: uv run zunos-eval '{app_dir}/models/{run['id']}-hf')")


if __name__ == "__main__":
    main()
