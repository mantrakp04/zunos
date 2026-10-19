for p in $(pgrep -f "serve --model-path"); do kill -9 $p; done
for p in $(pgrep -f "sglang_omni"); do kill -9 $p; done
rm -f /tmp/sglang_omni_gpu_0_startup.lock
sleep 3
export HF_HOME=/root/hf
uvx --from "huggingface_hub[hf_xet]" hf download fishaudio/s2-pro codec.pth 2>&1 | tail -1
ls -laL /root/hf/hub/models--fishaudio--s2-pro/snapshots/*/codec.pth
setsid nohup bash /workspace/code/serve_fish.sh > /workspace/logs/serve.log 2>&1 < /dev/null &
echo restarted
