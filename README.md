# Your personal speech model

Whisper large-v3, fine-tuned on your voice: English, plus Hindi and Gujarati written in
English letters. Runs fully on your Mac. No internet, no API costs.

## Use it

    cd ~/voice-data/mac
    uv run python dictate.py          # accurate: beam search on the Mac GPU, ~4x real time
    uv run python dictate.py --fast   # fast: MLX, ~13x real time, slightly less accurate

Press Enter, talk, press Enter. The text prints and is copied to your clipboard.
The language is detected automatically. Recordings over 28 s are split into chunks.

## How good it is

Word error rate on 13 of your recordings it never trained on (lower is better).
Hindi/Gujarati spelling variants are forgiven (chhe = che, wapas = waapas).

| | English | Hindi | Gujarati |
|---|---|---|---|
| Sarvam (saaras) | 17.5% | 17.6% | 39.7% |
| Whisper large-v3, untrained | ~28% | unusable (Urdu script / translates) | unusable (Hindi script) |
| **Your model, accurate mode** | **12.5%** | 19.8% | **27.4%** |
| Your model, fast mode | 13.3% | 25.3% | 32.9% |

1.4x better than Sarvam on English, 1.45x on Gujarati, slightly worse on Hindi.
The 2x target was not reached. Caveats: the test set is small (about 100 words per
language), and the answer key was partly built from Sarvam's output, which flatters Sarvam.

## Biggest next lever

More of your real Hindi and Gujarati. Training had only ~70 s of your real Hindi. The
recorder has 4 new paragraphs ready (cd ~/voice-data/recorder && bun server.ts, then
http://localhost:4747; saves to ~/voice-data/data2). Retraining with them costs about $2.

## What's here

- models/final-hf: the model (Hugging Face format, fp16), used by accurate mode
- models/final-mlx: the same model for MLX, used by fast mode
- models/ggml-voice-*.bin: whisper.cpp versions (work, but whisper.cpp decodes worse here: 25% avg)
- data/: your recordings, clips and word-for-word transcripts
- pod-backup/: all 4,743 training clips, quality scores, logs, code and sentence lists
- dashboard/: training dashboard (bun dashboard/server.ts, then http://localhost:4848)
- mac/check_hf.py, mac/check.py: re-score a model on your held-back clips
- recorder/: the recording web app (bun recorder/server.ts, then http://localhost:4747)
- prep/, corpus/, pod/: the scripts and sentences used to build the training data and train
- AGENTS.md: notes for future coding sessions in this project

## How it was made

1. 7.6 min of you reading, cut into 36 clips and transcribed word for word; 13 held back for testing.
2. 721 sentences written for dictation-style speech in the three languages.
3. Read in your cloned voice by three open models: IndicF5 (Hindi/Gujarati), Chatterbox
   (English/Hindi) and Fish Audio Drama 3 (all three, incl. drunk, mumbling, whispering,
   out-of-breath takes). 4,743 clips; a second model dropped the ones with wrong words.
4. Training added your real room noise, babble, fans, room echo, phone/Bluetooth sound,
   speed changes and slurring, and joined clips into long dictations.
5. Runs: turbo (r1), large-v3 (v3a, the winner), large-v3 + Drama 3 (v3b). Best checkpoint
   by score on your held-back clips.

Total cloud cost: $6.49 on Runpod.
