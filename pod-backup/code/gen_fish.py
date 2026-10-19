import json, os, sys, time, traceback
from concurrent.futures import ThreadPoolExecutor
import requests

W = "/workspace/data"
OUT = f"{W}/synth_fish"
os.makedirs(OUT, exist_ok=True)
URL = "http://127.0.0.1:8000/v1/audio/speech"
limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0
jobs = [json.loads(l) for l in open(f"{W}/fish_jobs.jsonl", encoding="utf-8")]
jobs = [j for j in jobs if not os.path.exists(f"{OUT}/{j['id']}.wav")]
if limit:
    jobs = jobs[:limit]
done, fails, t0 = 0, 0, time.time()

def run(j):
    global done, fails
    cap = int(min(650, 40 + 2.6 * len(j["target"])))
    body = {"input": j["gen_text"], "references": [{"audio_path": j["ref"], "text": j["ref_text"]}], "response_format": "wav", "max_new_tokens": cap}
    for attempt in range(3):
        try:
            r = requests.post(URL, json=body, timeout=180)
            if r.status_code == 200 and len(r.content) > 2000:
                path = f"{OUT}/{j['id']}.wav"
                with open(path + ".tmp", "wb") as f:
                    f.write(r.content)
                os.replace(path + ".tmp", path)
                done += 1
                if done % 25 == 0:
                    print(f"{done}/{len(jobs)} in {time.time() - t0:.0f}s", flush=True)
                return
            print("BAD", j["id"], r.status_code, r.text[:200], flush=True)
        except Exception as e:
            print("ERR", j["id"], repr(e)[:200], flush=True)
        time.sleep(2)
    fails += 1

with ThreadPoolExecutor(int(os.environ.get("CONC", "12"))) as ex:
    list(ex.map(run, jobs))
print(f"FISH DONE {done} ok, {fails} failed, {time.time() - t0:.0f}s", flush=True)
