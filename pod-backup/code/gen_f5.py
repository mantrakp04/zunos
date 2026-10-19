import json, os, sys, time, traceback
import numpy as np, soundfile as sf, torch
from safetensors.torch import load_file
from f5_tts.infer.utils_infer import infer_process, load_model, load_vocoder, preprocess_ref_audio_text
from f5_tts.model import DiT
import torchaudio

def _sf_load(p, *a, **k):
    x, sr = sf.read(p, dtype="float32", always_2d=True)
    return torch.from_numpy(x.T.copy()), sr

torchaudio.load = _sf_load

W = "/workspace/data"
OUT = f"{W}/synth"
os.makedirs(OUT, exist_ok=True)
shard, nshard = int(sys.argv[1]), int(sys.argv[2])
dev = "cuda"

vocoder = load_vocoder(vocoder_name="vocos", is_local=False, device=dev)
model = load_model(DiT, dict(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512, conv_layers=4),
                   mel_spec_type="vocos", vocab_file="/workspace/models/indicf5/checkpoints/vocab.txt", device=dev)
sd = load_file("/workspace/models/indicf5/model.safetensors")
ema = {k.split("ema_model.", 1)[1].replace("_orig_mod.", ""): v for k, v in sd.items() if k.startswith("ema_model.")}
voc = {k.split("vocoder.", 1)[1].replace("_orig_mod.", ""): v for k, v in sd.items() if k.startswith("vocoder.")}
m, u = model.load_state_dict(ema, strict=False)
print("ema missing", len(m), m[:5], "unexpected", len(u), u[:5], flush=True)
if voc:
    m2, u2 = vocoder.load_state_dict(voc, strict=False)
    print("vocoder missing", len(m2), "unexpected", len(u2), flush=True)
model.eval()

refs = {}
jobs = [json.loads(l) for l in open(f"{W}/jobs.jsonl", encoding="utf-8")]
jobs = [j for j in jobs if j["engine"] == "f5"][shard::nshard]
done = 0
t0 = time.time()
for j in jobs:
    path = f"{OUT}/{j['id']}.wav"
    if os.path.exists(path):
        continue
    try:
        if j["ref"] not in refs:
            refs[j["ref"]] = preprocess_ref_audio_text(j["ref"], j["ref_text"], show_info=lambda *a: None)
        ra, rt = refs[j["ref"]]
        with torch.inference_mode():
            wav, sr, _ = infer_process(ra, rt, j["gen_text"], model, vocoder, mel_spec_type="vocos",
                                       speed=j["speed"], show_info=lambda *a: None, progress=None, device=dev)
        wav = np.asarray(wav)
        wav = wav.astype(np.float32) / 32768 if wav.dtype == np.int16 else wav.astype(np.float32)
        sf.write(path + ".tmp.wav", wav, sr)
        os.replace(path + ".tmp.wav", path)
        done += 1
        if done % 20 == 0:
            print(f"shard {shard}: {done}/{len(jobs)} in {time.time()-t0:.0f}s", flush=True)
    except Exception:
        print("FAIL", j["id"], traceback.format_exc()[-500:], flush=True)
print(f"shard {shard} DONE {done}", flush=True)
