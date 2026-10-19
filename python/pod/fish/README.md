# Fish Audio Drama 3 (experimental)

Expressive voice cloning (drunk, mumbling, whispering, out-of-breath takes) served by sglang-omni.
Run v3b trained on v3a plus these clips and scored 23.3% vs v3a's 22.4%, so the default pipeline
(run.py) doesn't use it. To try it on a pod: setup_fish3.sh, then serve_fish.sh, make_fish_jobs.py,
gen_fish.py, and move the outputs into /workspace/data/synth before filter.py.

Needs gpu.minCudaVersion "13.0" (torch cu130), nvcc and ninja on PATH, and
SGLANG_OMNI_STARTUP_TIMEOUT=3600 on an A40.
