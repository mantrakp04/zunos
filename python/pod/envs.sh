#!/usr/bin/env bash
# Installs one Python environment for the pod, on demand (run.py starts these in the background, so only
# what an experiment uses gets installed, while earlier steps run):
#   bash envs.sh <train|judge|omnivoice|higgs|seedvc|chattervc|omniasr>
# Venvs live in /root/envs and the uv cache in /root/uv (/workspace may be a slow network disk). A finished
# env leaves /root/envs/<name>/.ok, so a second call returns at once. Weights download on first use into
# HF_HOME (bootstrap.sh points it at /workspace/hf).
set -euo pipefail
name=$1
CODE=$(cd "$(dirname "$0")/.." && pwd)   # python/
E=/root/envs/$name
[ -f "$E/.ok" ] && exit 0
export UV_CACHE_DIR=${UV_CACHE_DIR:-/root/uv} UV_HTTP_TIMEOUT=300
TORCH=(torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128)
venv() { rm -rf "$E"; uv venv -q --python "${1:-3.11}" "$E"; }
pip() { VIRTUAL_ENV=$E uv pip install -q "$@"; }

case "$name" in
  train)
    # Whisper, Qwen3-ASR (native in transformers >= 5.13: Qwen/Qwen3-ASR-1.7B-hf) and Indic-Transcribe-Flex
    # (its HF port ships in the gated repo; sentencepiece) fine-tuning, LoRA, post.py.
    venv; pip "${TORCH[@]}"
    pip "transformers>=5.13,<6" "peft>=0.17" accelerate safetensors sentencepiece soundfile librosa scipy numpy -e "$CODE/core"
    ;;
  judge)
    # Whisper large-v3 judge, ai4bharat IndicConformer (ONNX, trust_remote_code; written for transformers 4.x),
    # WavLM speaker embeddings, phonemizer (espeak-ng from apt). Only onnxruntime-gpu: with the CPU package
    # beside it, CUDA silently goes unused. The card's onnxruntime-gpu==1.20.1 doesn't exist on PyPI.
    venv; pip "${TORCH[@]}"
    pip "transformers>=4.46,<4.58" accelerate soundfile librosa scipy numpy "onnx==1.20.1" "onnxruntime-gpu==1.20.2" \
      phonemizer -e "$CODE/core"
    ;;
  omnivoice)
    # k2-fsa/OmniVoice 0.2.1 (torch 2.8 cu128, transformers >= 5.3).
    venv; pip "${TORCH[@]}"
    pip "omnivoice==0.2.1" soundfile numpy
    ;;
  higgs)
    # Higgs TTS 3 through SGLang-Omni: CUDA-13-only wheels (torch 2.13), so the pod must be on a CUDA >= 13.0
    # host (create the run with minCuda "13.0"). Python < 3.13.
    venv 3.12
    pip --prerelease=allow "sglang-omni==0.1.8"
    ;;
  seedvc)
    # Plachtaa/seed-vc v1 (archived repo, GPL-3.0; runs on our pods only). Its own pins, except torch 2.8:
    # checkpoints hold only tensors, so torch >= 2.6's weights-only load is fine.
    venv; pip "${TORCH[@]}"
    rm -rf /root/seed-vc && git clone -q --depth 1 https://github.com/Plachtaa/seed-vc /root/seed-vc
    pip transformers==4.46.3 librosa==0.10.2 munch==4.0.0 einops==0.8.0 numpy==1.26.4 scipy soundfile pyyaml \
      huggingface-hub descript-audio-codec==1.0.0 hydra-core==1.3.2
    ;;
  chattervc)
    # ResembleAI ChatterboxVC (MIT). chatterbox-tts pins torch 2.6; install it without deps on torch 2.8.
    venv; pip "${TORCH[@]}"
    pip --no-deps "chatterbox-tts==0.1.7"
    pip s3tokenizer "librosa==0.11.0" "conformer==0.3.2" "diffusers==0.29.0" safetensors omegaconf "numpy<2" soundfile \
      "transformers==5.2.0" "resemble-perth @ git+https://github.com/resemble-ai/Perth.git@master"
    ;;
  omniasr)
    # Meta Omnilingual ASR (long-tail judge). fairseq2 must match torch exactly; numpy < 2.
    venv; pip "${TORCH[@]}"
    pip "omnilingual-asr==0.2.0" --extra-index-url https://fair.pkg.atmeta.com/fairseq2/whl/pt2.8.0/cu128
    pip -e "$CODE/core" soundfile librosa
    ;;
  *)
    echo "unknown environment $name" >&2; exit 2 ;;
esac
"$E/bin/python" -c "import sys; print(sys.version)"
touch "$E/.ok"
