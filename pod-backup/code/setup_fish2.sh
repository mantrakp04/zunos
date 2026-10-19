set -x
export UV_CACHE_DIR=/root/uv
mkdir -p /root/models
(time cp -r /workspace/models/drama-3-int4 /root/models/) > /workspace/logs/cp_model.log 2>&1 &
cd /workspace/sglang-omni
uv venv -q --python 3.12 /root/envs/fish
VIRTUAL_ENV=/root/envs/fish uv pip install --prerelease=allow -e ".[fishaudio]" 2>&1 | tail -15
/root/envs/fish/bin/python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
ls /root/envs/fish/bin | grep -i omni && echo FISH_INSTALL_OK
wait
echo SETUP_DONE
