set -x
export UV_CACHE_DIR=/root/uv HF_HOME=/root/hf
pip install -q uv 2>/dev/null || pip install -q --break-system-packages uv
mkdir -p /root/models /workspace/logs /workspace/data/synth_fish
(uvx --from "huggingface_hub[hf_xet]" hf download fishaudio/drama-3-int4 --local-dir /root/models/drama-3-int4 > /workspace/logs/dl.log 2>&1; echo DL_DONE >> /workspace/logs/dl.log) &
cd /root && git clone -q https://github.com/sgl-project/sglang-omni.git && cd sglang-omni && git checkout -q 3a0655b84
uv venv -q --python 3.12 /root/envs/fish
VIRTUAL_ENV=/root/envs/fish uv pip install --prerelease=allow -e ".[fishaudio]" requests 2>&1 | tail -5
/root/envs/fish/bin/python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
wait
echo SETUP_DONE
