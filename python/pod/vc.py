"""Voice conversion: the TTS half of a TTS+VC job (<shard>/tts/<id>.wav, read by the voice that reads the
language best) becomes the user's voice (<shard>/raw/<id>.wav). The words and their timing come from the
source; only the voice changes. The label stays the intended text, and post.py + judge.py check the
converted audio exactly like a direct clone (words, voice similarity, pace).

    python vc.py <jobs.jsonl> <shard dir> <worker> <workers>

Models (gen.vc.model):
  seed-vc        Plachtaa/seed-vc v1, offline whisper-small checkpoint (22.05 kHz, no f0 conditioning):
                 its content features come from Whisper's multilingual encoder. GPL-3.0 code and weights
                 (fine to run on our pods; don't ship it in the app). Needs SEEDVC_DIR (a checkout).
  chatterbox-vc  ResembleAI ChatterboxVC (MIT, S3 speech tokens, 24 kHz, always watermarked).
  identity       copies the source (dry runs).
The target voice is the job's rotating user reference (a train clip, never test).
"""
import argparse
import json
import os
import sys
import time
import traceback

import numpy as np
import soundfile as sf

jobs_path, shard, worker, workers = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
gen = json.load(open(os.path.join(os.path.dirname(os.path.dirname(jobs_path)), "cfg.json")))["gen"]
vcfg = gen["vc"]
jobs = [json.loads(l) for l in open(jobs_path, encoding="utf-8")][worker::workers]
os.makedirs(f"{shard}/raw", exist_ok=True)
todo = [j for j in jobs if os.path.exists(f"{shard}/tts/{j['id']}.wav") and not os.path.exists(f"{shard}/raw/{j['id']}.wav")]
print(f"vc ({vcfg['model']}) worker {worker}/{workers}: {len(todo)} to convert", flush=True)


def save(j, wav, sr):
    p = f"{shard}/raw/{j['id']}.wav"
    sf.write(p + ".tmp.wav", np.asarray(wav, np.float32), sr)
    os.replace(p + ".tmp.wav", p)


def seed_vc():
    """Loads Seed-VC once and returns convert(source_path, ref_path) -> (wave, sr). Mirrors the repo's
    inference.main() without f0 conditioning, with the reference's conditioning cached per reference."""
    import librosa
    import torch
    import torchaudio

    os.chdir(os.environ["SEEDVC_DIR"])  # inference.py keeps its HF cache under ./checkpoints
    sys.path.insert(0, os.environ["SEEDVC_DIR"])
    import inference as sv

    args = argparse.Namespace(f0_condition=False, checkpoint=None, config=None, fp16=True)
    model, semantic_fn, _, vocoder_fn, campplus, to_mel, mel_args = sv.load_models(args)
    sr, hop = mel_args["sampling_rate"], mel_args["hop_size"]
    window, overlap = sr // hop * 30, 16
    dev = sv.device
    refs = {}

    def ref_cond(path):
        if path not in refs:
            ref = torch.tensor(librosa.load(path, sr=sr)[0][: sr * 25]).unsqueeze(0).float().to(dev)
            r16 = torchaudio.functional.resample(ref, sr, 16000)
            mel2 = to_mel(ref)
            feat2 = torchaudio.compliance.kaldi.fbank(r16, num_mel_bins=80, dither=0, sample_frequency=16000)
            style2 = campplus((feat2 - feat2.mean(dim=0, keepdim=True)).unsqueeze(0))
            prompt, *_ = model.length_regulator(semantic_fn(r16), ylens=torch.LongTensor([mel2.size(2)]).to(dev),
                                                n_quantizers=3, f0=None)
            refs[path] = (mel2, style2, prompt)
        return refs[path]

    @torch.no_grad()
    def convert(src_path, ref_path):
        mel2, style2, prompt = ref_cond(ref_path)
        src = torch.tensor(librosa.load(src_path, sr=sr)[0]).unsqueeze(0).float().to(dev)
        s16 = torchaudio.functional.resample(src, sr, 16000)
        mel = to_mel(src)
        cond, *_ = model.length_regulator(semantic_fn(s16), ylens=torch.LongTensor([mel.size(2)]).to(dev),
                                          n_quantizers=3, f0=None)
        max_src = window - mel2.size(2)
        out, done, prev = [], 0, None
        ow = overlap * hop
        while done < cond.size(1):
            chunk = cond[:, done:done + max_src]
            last = done + max_src >= cond.size(1)
            cat = torch.cat([prompt, chunk], dim=1)
            with torch.autocast(device_type=dev.type, dtype=torch.float16):
                tgt = model.cfm.inference(cat, torch.LongTensor([cat.size(1)]).to(dev), mel2, style2, None,
                                          vcfg["diffusion_steps"], inference_cfg_rate=vcfg["cfg_rate"])[:, :, mel2.size(-1):]
            w = vocoder_fn(tgt.float()).squeeze().cpu().numpy()
            if prev is not None:
                w[:ow] = w[:ow] * np.cos(np.linspace(np.pi / 2, 0, ow)) ** 2 + prev * np.cos(np.linspace(0, np.pi / 2, ow)) ** 2
            if last:
                out.append(w)
                break
            out.append(w[:-ow])
            prev = w[-ow:]
            done += tgt.size(2) - overlap
        return np.concatenate(out), sr

    return convert


def chatterbox_vc():
    import torch
    from chatterbox.vc import ChatterboxVC

    model = ChatterboxVC.from_pretrained("cuda")

    def convert(src_path, ref_path):
        with torch.inference_mode():
            wav = model.generate(audio=src_path, target_voice_path=ref_path)
        return wav.squeeze(0).cpu().numpy(), model.sr

    return convert


def identity():
    return lambda src, ref: sf.read(src, dtype="float32")


if todo:
    convert = {"seed-vc": seed_vc, "chatterbox-vc": chatterbox_vc, "identity": identity}[vcfg["model"]]()
    t0 = time.time()
    for i, j in enumerate(todo):
        try:
            wav, sr = convert(f"{shard}/tts/{j['id']}.wav", j["ref"])
            save(j, wav, sr)
        except Exception:
            print("FAIL", j["id"], traceback.format_exc()[-600:], flush=True)
        if (i + 1) % 50 == 0:
            print(f"vc worker {worker}: {i + 1}/{len(todo)} in {time.time() - t0:.0f}s", flush=True)
print(f"vc worker {worker} DONE", flush=True)
