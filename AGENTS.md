# Personal speech model

A Whisper large-v3 fine-tune on the owner's voice: English, plus Hindi and Gujarati written in
English letters. It must run locally on the owner's Mac (M5 Pro, 48 GB). The goal is to beat
Sarvam (saaras) by 2x word error rate on the held-back clips. Current scores are in README.md.

## Layout

- recorder/: Bun web app for recording reading sessions (`bun server.ts`, port 4747). prompts.ts
  holds the paragraphs; recordings are saved to data2/ (the first session is in data/).
- prep/: segment.ts cuts recordings at pauses, transcribe*.ts call Sarvam (key comes from the
  synapse-md repo's .env), and finalize.ts writes data/final/transcripts.jsonl plus the clips.
- corpus/: 721 dictation-style sentences (en .txt; hi/gu .tsv as romanized TAB native script).
- pod/: everything that runs on the GPU pod. Voice generation: gen_f5.py (IndicF5), gen_cb.py
  (Chatterbox), gen_fish.py (Fish Drama 3 via sglang-omni). Also filter.py (quality filter),
  train.py (fine-tune), augment.py, textnorm.py (scoring), eval_ckpt.py, export.py, status.py.
- mac/: uv project. dictate.py (mic → text), check_hf.py / check.py / check_cpp.py (scoring).
- models/: final-hf (used by dictate.py), final-mlx (--fast), ggml-voice-*.bin (whisper.cpp).
- pod-backup/: all 4,743 generated training clips, scores, jobs and logs from the cloud run.
- dashboard/: training dashboard (`bun server.ts`, port 4848; `--live` polls a running pod).

## Rules

- Test set: 13 clips in data/final, listed as TEST in pod/make_jobs.py. Never train on them and
  never write corpus sentences that copy their text. Score with textnorm.fuzzy WER, and score
  Sarvam on the same key.
- Owner's budget is under $2/hour of cloud GPU in total. Quote the price before creating a pod,
  and stop or terminate pods as soon as they're idle.
- Final decoding on the Mac is HF transformers on MPS with num_beams=4. whisper.cpp scores
  about 5 points worse with the same weights, and mlx_whisper has no beam search.

## Traps already hit

- Never `pkill -f <pattern>` over ssh when the pattern appears in the ssh command itself: it
  kills your own session. Put kill commands in a script file and run that file.
- Runpod /workspace is a network disk and slow for pip/uv installs: put venvs and the uv cache
  on /root. Hosts vary in CUDA driver; sglang-omni (torch cu130) needs gpu.minCudaVersion "13.0".
- Fish Drama 3 int4 on an A40 needs nvcc and ninja on PATH, plus SGLANG_OMNI_STARTUP_TIMEOUT=3600.
- macOS returns pure silence (peak 0) when the terminal lacks microphone permission, and
  Whisper then outputs "you". dictate.py checks for this.
- Whisper's Gujarati output mixes scripts, so filter.py scores hi/gu by transliterating to Latin
  first (textnorm.roman_cer).
