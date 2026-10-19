cd /root/sglang-omni
export HF_HOME=/root/hf CUDA_HOME=/usr/local/cuda PATH=/root/envs/fish/bin:/usr/local/cuda/bin:$PATH SGLANG_OMNI_STARTUP_TIMEOUT=3600
exec /root/envs/fish/bin/sgl-omni serve --model-path /root/models/drama-3-int4 --port 8000 --tts_engine.gpu_memory_fraction 0.62 --vocoder.gpu_memory_fraction 0.15 --tts_engine.factory.max_running_requests 24
