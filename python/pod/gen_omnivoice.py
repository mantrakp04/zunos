"""OmniVoice (k2-fsa/OmniVoice) worker: zero-shot cloning, or the TTS half of a TTS+VC job.

    python gen_omnivoice.py <jobs.jsonl> <shard dir> <worker> <workers>

Direct jobs (engine "omnivoice") read the sentence in the user's voice: ref_audio = a rotating user reference
with its native-script transcript, duration = the job's target seconds (pace calibrated to the user), and the
language code. Output: <shard dir>/raw/<id>.wav (24 kHz).
TTS+VC jobs (engine "vc") read it in the job's tts_voice instead (a native speaker reference {audio, text},
a voice description {instruct}, or nothing: the model's own voice), into <shard dir>/tts/<id>.wav; vc.py
converts those to the user's voice.
Finished files are skipped, so a restarted worker resumes. One take per job; the seed is the job's. Each job
carries its variability plan (variability.py): text edits are already in tts_text, `denoise` picks the
<|denoise|> token, and jobs with inpainting `effects` go through omni_vary.py instead of generate().
"""
import json
import os
import sys
import time
import traceback

import numpy as np
import soundfile as sf
import torch

jobs_path, out, worker, workers = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
spec = json.load(open(os.path.join(os.path.dirname(os.path.dirname(jobs_path)), "cfg.json")))["gen"]
params = spec["omnivoice"]
jobs = [json.loads(l) for l in open(jobs_path, encoding="utf-8")][worker::workers]


def dest(j):
    return f"{out}/{'tts' if j['engine'].split('@')[0] == 'vc' else 'raw'}/{j['id']}.wav"


todo = [j for j in jobs if not os.path.exists(dest(j))]
os.makedirs(f"{out}/raw", exist_ok=True)
os.makedirs(f"{out}/tts", exist_ok=True)
print(f"omnivoice worker {worker}/{workers}: {len(todo)} to do of {len(jobs)}", flush=True)
if not todo:
    sys.exit(0)

from omnivoice import OmniVoice  # noqa: E402

try:
    from omnivoice import OmniVoiceGenerationConfig
except ImportError:
    from omnivoice.models.omnivoice import OmniVoiceGenerationConfig

model = OmniVoice.from_pretrained(os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice"), device_map="cuda:0", dtype=torch.float16)
prompts = {}


def voice(j):
    """(kind, value): ("prompt", VoiceClonePrompt) | ("instruct", text) | ("none", None)."""
    if j["engine"].split("@")[0] == "vc":
        v = j.get("tts_voice") or {}
        if v.get("audio"):
            src, text = v["audio"], v.get("text")
        elif v.get("instruct"):
            return "instruct", v["instruct"]
        else:
            return "none", None
    else:
        src, text = j["ref"], j.get("ref_text") or None
    if src not in prompts:
        prompts[src] = model.create_voice_clone_prompt(ref_audio=src, ref_text=text)
    return "prompt", prompts[src]


groups = {}
for j in todo:
    kind, v = voice(j)
    if kind == "prompt" and j.get("effects"):
        groups.setdefault(("inpaint", j.get("denoise", True)), []).append((j, v))
    else:
        groups.setdefault((kind, j.get("denoise", True)), []).append((j, v))


def save(j, wav):
    p = dest(j)
    sf.write(p + ".tmp.wav", np.asarray(wav, np.float32), model.sampling_rate)
    os.replace(p + ".tmp.wav", p)


aligner = None
done, t0 = 0, time.time()
for (kind, denoise), items in groups.items():
    if kind == "inpaint":
        # Takes with local effects: decode the whole take with our own sampler (same settings as generate),
        # find its words, then re-decode only the spans (omni_vary.py).
        import omni_vary

        if aligner is None:
            aligner = omni_vary.Aligner()
        for j, prompt in items:
            torch.manual_seed(j["seed"])
            try:
                T = max(10, int(j["target_s"] * omni_vary.FPS))
                base = omni_vary.decode(model, j["tts_text"], j["lang"], prompt, T, guid=params["guidance_scale"],
                                        num_step=params["num_step"], denoise=denoise)
                words = aligner(omni_vary.raw_audio(model, base), model.sampling_rate, j["lang"], j["tts_text"])
                tokens, applied = omni_vary.apply_effects(model, base, words, j["effects"], j["tts_text"], j["lang"], prompt,
                                                          params.get("inpaint_steps", 16), params["guidance_scale"], denoise)
                save(j, omni_vary.to_audio(model, tokens, prompt))
                with open(f"{out}/effects.jsonl", "a", encoding="utf-8") as f:
                    f.write(json.dumps({"id": j["id"], "applied": applied}) + "\n")
                done += 1
            except Exception:
                print("FAIL", j["id"], traceback.format_exc()[-800:], flush=True)
            torch.cuda.empty_cache()
        continue
    gcfg = OmniVoiceGenerationConfig(num_step=params["num_step"], guidance_scale=params["guidance_scale"], denoise=denoise)
    for b in range(0, len(items), params["batch"]):
        batch = items[b:b + params["batch"]]
        kw = dict(text=[j["tts_text"] for j, _ in batch], language=[j["lang"] for j, _ in batch],
                  duration=[j["target_s"] for j, _ in batch], generation_config=gcfg)
        if kind == "prompt":
            kw["voice_clone_prompt"] = [v for _, v in batch]
        elif kind == "instruct":
            kw["instruct"] = [v for _, v in batch]
        torch.manual_seed(batch[0][0]["seed"])
        try:
            wavs = model.generate(**kw)
        except Exception:
            print("FAIL batch", [j["id"] for j, _ in batch], traceback.format_exc()[-800:], flush=True)
            torch.cuda.empty_cache()
            continue
        for (j, _), w in zip(batch, wavs):
            save(j, w)
            done += 1
        torch.cuda.empty_cache()  # OmniVoice issue #199: memory creeps across generate() calls otherwise
        if done and done % (params["batch"] * 10) < params["batch"]:
            print(f"omnivoice worker {worker}: {done}/{len(todo)} in {time.time() - t0:.0f}s", flush=True)
print(f"omnivoice worker {worker} DONE {done}", flush=True)
