import json, os, sys, time, traceback, glob
import soundfile as sf, torch
from chatterbox.tts import ChatterboxTTS
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

W = "/workspace/data"
OUT = f"{W}/synth"
os.makedirs(OUT, exist_ok=True)
engine, shard, nshard = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
if engine == "cb_en":
    model = ChatterboxTTS.from_pretrained(device="cuda")
else:
    snap = glob.glob("/workspace/hf/hub/models--ResembleAI--chatterbox/snapshots/*")[0]
    model = ChatterboxMultilingualTTS.from_local(snap, "cuda")

jobs = [json.loads(l) for l in open(f"{W}/jobs.jsonl", encoding="utf-8")]
jobs = [j for j in jobs if j["engine"] == engine][shard::nshard]
done = 0
t0 = time.time()
for j in jobs:
    path = f"{OUT}/{j['id']}.wav"
    if os.path.exists(path):
        continue
    try:
        kw = dict(audio_prompt_path=j["ref"], exaggeration=j["exaggeration"], cfg_weight=j["cfg_weight"], temperature=j["temperature"])
        with torch.inference_mode():
            if engine == "cb_en":
                wav = model.generate(j["gen_text"], **kw)
            else:
                wav = model.generate(j["gen_text"], language_id=j["language_id"], **kw)
        sf.write(path + ".tmp.wav", wav.squeeze(0).cpu().numpy(), model.sr)
        os.replace(path + ".tmp.wav", path)
        done += 1
        if done % 20 == 0:
            print(f"{engine} shard {shard}: {done}/{len(jobs)} in {time.time()-t0:.0f}s", flush=True)
    except Exception:
        print("FAIL", j["id"], traceback.format_exc()[-500:], flush=True)
print(f"{engine} shard {shard} DONE {done}", flush=True)
