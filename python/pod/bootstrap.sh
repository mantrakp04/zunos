#!/usr/bin/env bash
# First thing a zunos training pod runs (the backend sets it as the container command):
#   curl -fsSL "$ZUNOS_BOOTSTRAP_URL" | bash
# Fetches the code, installs system tools and uv, then hands over to run.py, which installs the Python
# environments an experiment needs in the background (envs.sh) while it prepares the data.
# Venvs and the uv cache live on /root: /workspace can be a slow network disk.
set -euo pipefail

ev() {
  [ -n "${ZUNOS_EVENTS_URL:-}" ] || return 0
  curl -fsS -m 20 -X POST "$ZUNOS_EVENTS_URL" -H "Authorization: Bearer $ZUNOS_EVENTS_TOKEN" \
    -H "Content-Type: application/json" -d "$1" >/dev/null || true
}
trap 'ev "{\"type\":\"error\",\"message\":\"pod setup failed at line $LINENO (see /workspace/logs/setup.log)\"}"' ERR

mkdir -p /workspace/code /workspace/logs /workspace/hf /workspace/cache /root/envs
exec > >(tee -a /workspace/logs/setup.log) 2>&1
ev '{"type":"stage","stage":"setup","status":"running"}'

# HF_HUB_DISABLE_XET: xet downloads have stalled on small repos; plain HTTP is reliable. The Runpod image
# turns hf_transfer on, but our envs don't install it.
export HF_HOME=/workspace/hf UV_CACHE_DIR=/root/uv HF_HUB_DISABLE_XET=1 HF_HUB_ENABLE_HF_TRANSFER=0 DEBIAN_FRONTEND=noninteractive \
  ZUNOS_CACHE=${ZUNOS_CACHE:-/workspace/cache} FAIRSEQ2_CACHE_DIR=/root/fairseq2

curl -fsSL "$ZUNOS_CODE_URL" | tar xz -C /workspace/code
CODE=/workspace/code/python

apt-get update -qq && apt-get install -y -qq sox libsndfile1 espeak-ng ffmpeg git >/dev/null
pip install -q uv 2>/dev/null || pip install -q --break-system-packages uv
/usr/bin/env python3 -c "import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))" 2>/dev/null \
  || nvidia-smi -L
ev '{"type":"stage","stage":"setup","status":"done"}'

cd "$CODE/pod"
# run.py itself only needs the standard library; the train env is installed by run.py before it is used.
exec python3 run.py
