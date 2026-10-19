#!/usr/bin/env bash
# First thing a zunos training pod runs (the backend sets it as the container command):
#   curl -fsSL "$ZUNOS_BOOTSTRAP_URL" | bash
# Installs the three Python environments, downloads the models, then hands over to run.py.
# Venvs and the uv cache live on /root: /workspace can be a slow network disk.
set -euo pipefail

ev() {
  [ -n "${ZUNOS_EVENTS_URL:-}" ] || return 0
  curl -fsS -m 20 -X POST "$ZUNOS_EVENTS_URL" -H "Authorization: Bearer $ZUNOS_EVENTS_TOKEN" \
    -H "Content-Type: application/json" -d "$1" >/dev/null || true
}
trap 'ev "{\"type\":\"error\",\"message\":\"pod setup failed at line $LINENO (see /workspace/logs/setup.log)\"}"' ERR

mkdir -p /workspace/code /workspace/logs /workspace/models /workspace/hf /root/envs
exec > >(tee -a /workspace/logs/setup.log) 2>&1
ev '{"type":"stage","stage":"setup","status":"running"}'

export HF_HOME=/workspace/hf UV_CACHE_DIR=/root/uv HF_HUB_ENABLE_HF_TRANSFER=0 DEBIAN_FRONTEND=noninteractive

curl -fsSL "$ZUNOS_CODE_URL" | tar xz -C /workspace/code
CODE=/workspace/code/python

apt-get update -qq && apt-get install -y -qq sox libsndfile1 espeak-ng ffmpeg >/dev/null
pip install -q uv 2>/dev/null || pip install -q --break-system-packages uv

# Model downloads run while the environments install. IndicF5's repo is gated for full snapshots; the two
# files gen_f5.py needs have downloaded without a token before. HF_TOKEN is used when set.
(
  uvx --from "huggingface_hub[hf_xet]" hf download ai4bharat/IndicF5 model.safetensors checkpoints/vocab.txt \
    --local-dir /workspace/models/indicf5 ${HF_TOKEN:+--token "$HF_TOKEN"}
  for r in ResembleAI/chatterbox openai/whisper-large-v3-turbo openai/whisper-large-v3; do
    uvx --from "huggingface_hub[hf_xet]" hf download "$r" >/dev/null
  done
  echo MODELS_DONE
) > /workspace/logs/models.log 2>&1 &
models=$!

uv venv -q --python 3.11 /root/envs/indicf5
VIRTUAL_ENV=/root/envs/indicf5 uv pip install -q git+https://github.com/ai4bharat/IndicF5.git soundfile
uv venv -q --python 3.11 /root/envs/chatter
VIRTUAL_ENV=/root/envs/chatter uv pip install -q chatterbox-tts soundfile
uv venv -q --python 3.11 /root/envs/train
VIRTUAL_ENV=/root/envs/train uv pip install -q torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
VIRTUAL_ENV=/root/envs/train uv pip install -q "transformers>=4.46" accelerate soundfile librosa audiomentations pyroomacoustics numpy scipy -e "$CODE/core"

wait $models
grep -q MODELS_DONE /workspace/logs/models.log
/root/envs/train/bin/python -c "import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))"
ev '{"type":"stage","stage":"setup","status":"done"}'

cd "$CODE/pod"
exec /root/envs/train/bin/python run.py
