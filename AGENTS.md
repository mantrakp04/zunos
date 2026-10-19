# zunos

A macOS app that fine-tunes Whisper large-v3 on the user's voice, in any Whisper language
(packages/db/src/languages.ts; languages typed in English letters, like Hindi and Gujarati, are
trained to write Latin script). Flow: sign in (Hexclave) → pick languages → record → train (Runpod GPU,
paid by the owner through apps/api) → test → dictate. Decoding runs locally on the Mac. The original
goal, beating the reference recognizer by 2x word error rate on held-back clips, is tracked in README.md.

## Layout (bun workspaces + a uv workspace)

- apps/mac: the Expo app on react-native-macos (expo-desktop template, Expo SDK 55). App.tsx is
  the native shell; src/dom/ are "use dom" screens built with ruixen components; src/services/ hold
  the database, auth, engine and training clients; modules/zunos-native is the Swift module
  (recorder, engine process, Keychain, transfers). Run: `bun run start` in apps/mac (Hexclave dev
  env + Metro on port 8090), then open macos/build/Build/Products/Debug/zunos.app (build with
  xcodebuild, see README).
- apps/api: Elysia server on Bun (SQLite + blob files on a /data volume, deployed by
  hexclave.deploy.ts to Hexclave's GCP runtime) that verifies Hexclave tokens, launches Runpod pods for allow-listed
  users within the budget, receives pod events, and reaps idle pods.
- packages/db: Drizzle schema and SQL migrations for the app database (embedded so expo-sqlite and
  bun:sqlite run the same migrations). `NAME=<change> bun run generate` after editing schema.ts.
- packages/ui: Tailwind v4 theme and ruixen/shadcn components (`npx shadcn add https://ruixen.com/r/<name>`
  from packages/ui).
- python/core: textnorm (fuzzy WER, roman_cer) and scoring shared by the engine and the pod.
- python/engine: the local engine the app launches (`zunos-engine`, JSON lines over stdio): load,
  transcribe, eval, segment, pack, unpack, and transcript cleanup (cleanup.py: Qwen3.5-4B 4-bit on
  MLX, downloaded on request into models/cleanup; few-shot prompt, raw text kept whenever the output
  looks wrong). Also `zunos-eval`, `zunos-reference` (scores the reference recognizer into `baselines`)
  and `zunos-dictate` CLIs.
- python/pod: GPU pipeline, an experiment platform. bootstrap.sh → run.py (envs.sh installs only the
  envs an experiment uses). An experiment spec (config.py; the dataset's `cfg`, empty = production
  recipe) names shared generation/judging settings and training variants. Steps: data.py (train/dev/test
  splits) → ref_text.py, make_jobs.py (corpus.py: packages/db/corpus, test-overlap guard; pace.py: the
  user's measured letters/s; rotating train-clip references; variability.py: a seeded per-take style plan,
  inpainted rush/drag/pause/mumble via omni_vary.py, respellings, non-lexical fillers, repeats, denoise off;
  labels stay the clean sentence) → gen_omnivoice.py / gen_higgs.py, or TTS+VC (vc.py: Seed-VC /
  ChatterboxVC) → post.py → judge.py (Whisper / IndicConformer / omniASR; words threshold relative to the
  shard's clean takes, deletion check, per-shard voice calibration, pace) → pseudo.py when a variant trains
  on a pseudo-labeled set (spec `pseudo`: the dataset's unlabeled/ audio → silero-vad segments → voice check vs
  the train clips → teacher transcripts kept where a second model agrees, or labels provided with the audio
  (teacher "provided", the reference's transcripts); never test-window audio or test-clip text) → train.py per variant (asr_whisper.py / asr_qwen.py / asr_flex.py, full, partial or LoRA (flex:
  encoder-only targets), optional KL to the base, dev early stopping, two stages, test scored once with
  bootstrap CIs vs the reference) → export.py. Generated and judged sets are cached by content hash
  (cache.py: /workspace/cache plus the backend's per-user cache). `python run.py --dry-run` runs it all on
  the Mac with tiny stand-ins; launch.py starts an experiment from the Mac (see python/pod/experiments).
- packages/db/corpus/<code>.json: the reading corpus per language (passages and sentences, each line in
  native script and, for non-Latin languages, English letters; a starter set read first), written by
  scripts/corpus/generate.ts. `bun run corpus` in packages/db embeds new or changed files (src/corpus.gen.ts);
  the app seeds a language's prompts when it is enabled or its file changes. Each language is read in its own
  script or in English letters (languages.script); a take stores the script read and its clips' text is in it.
  <code>.synth.json files are synthesis-only sentences for the pod (python/pod/corpus.py), never shown to read.
  The owner's pre-app data was imported once (tools/migrate, in history).

User data lives in ~/Library/Application Support/zunos (zunos.db, audio/, models/, runs/).

## Rules

- Test set: clips with split='test' (13 from the first session, then one in four of each
  language's new clips). Scoring lives in python/core/scoring.py (fuzzy WER for English and
  romanized languages, basic WER otherwise); don't reimplement it. Never train on them, never use them as voice references, and never write
  corpus sentences that copy their text. Score with fuzzy WER and score the reference recognizer on the same key
  (`uv run zunos-reference`; it is never named in the repo or the UI, and its key stays in the git-ignored
  .env.local).
- Owner's budget: cloud GPU spend stays under MAX_HOURLY_USD in total (apps/api setting; $5/hour while
  experimenting). Quote the price before creating a pod, and stop or terminate pods as soon as they're
  idle. apps/api enforces this for every run it starts (app or launch.py) and refuses to start when a live
  pod's price is unknown.
- Checkpoints are never chosen on the test clips: a variant keeps its last weights or its best dev score
  (real dev clips or held-out synthetic sentences), and the test clips are decoded once, at the end.
- Cleanup never feeds back into scoring: WER (ours and the reference's) is always computed on the raw decoder
  output. Cleanup prompt examples must not reuse test-clip text either.
- Final decoding on the Mac is HF transformers on MPS with num_beams=4. whisper.cpp scores
  about 5 points worse with the same weights, and mlx_whisper has no beam search.

## Traps already hit

- Never `pkill -f <pattern>` over ssh when the pattern appears in the ssh command itself: it
  kills your own session. Put kill commands in a script file and run that file.
- Runpod /workspace is a network disk and slow for pip/uv installs: venvs and the uv cache go on
  /root. Hosts vary in CUDA driver; sglang-omni (torch cu130) needs gpu.minCudaVersion "13.0".
- Fish Drama 3 int4 on an A40 needs nvcc and ninja on PATH, plus SGLANG_OMNI_STARTUP_TIMEOUT=3600.
- macOS returns pure silence (peak 0) when an app lacks microphone permission, and Whisper then
  outputs "you". The recorder and the engine both check for this.
- Whisper's Gujarati output mixes scripts, so the judge scores romanized targets by transliterating to
  Latin first (textnorm.roman_cer).
- Base Whisper's free language detection calls Hindi Urdu and Gujarati Punjabi: decoders pick the
  language among the user's languages only (engine Model, pod asr_whisper.detect).
- transformers 5.20 breaks greedy Whisper decoding ("'EncoderDecoderCache' object has no attribute
  'layers'"); beam search works. Both decoders fall back to 2 beams.
- Licenses: Higgs TTS 3 is research / non-commercial, Seed-VC is GPL-3.0 (pods only, never shipped in the
  app), Indic-Transcribe-Flex is the Indic Open Model License (attribution; on-device use allowed). The
  owner's model is not a commercial product, so all three are allowed as experiment arms.
- Indic-Transcribe-Flex: always pass the language (its own ID calls Hindi Urdu) and use romanized mode for
  romanized users. Its HF port is inference-only; asr_flex.py computes the loss itself (no NeMo). On the
  Mac it needs torchaudio and sentencepiece in the engine env (torchaudio isn't there yet).
- Qwen3-ASR: use transformers' native Qwen/Qwen3-ASR-1.7B-hf, not the qwen-asr package or its SFT
  script (wrong prompt masking under left padding, no encoder windows off CUDA). It has no Gujarati or
  Tamil and writes Hindi in Devanagari until trained on romanized labels.
- apps/mac/macos is committed (bare workflow): the build depends on edits there. Re-running
  `expo-desktop prebuild` applies config plugins on top; check the diff afterwards.
- Monorepo + react-native-macos: bun must use the hoisted linker (bunfig.toml), the Podfile
  rewrites REACT_NATIVE_PATH to the hoisted react-native, and the app's bundle root is
  `.expo/.virtual-metro-entry` with module name `main`.
- Port 8081 is used by another project on this Mac; zunos's Metro is compiled to 8090
  (RCT_METRO_PORT in the Podfile).
- rnx-kit (expo-desktop's Metro config) rewrites `react-native/*` imports to react-native-web on
  web, which breaks DOM-component bundles; metro.config.js bypasses it for web.
- expo-sqlite parses paths with URL(string:): a path with spaces ("Application Support") becomes a
  literal "Application%20Support" folder. Pass the directory as a file:// URL.
- React Native 0.83 no longer forwards console.log to Metro. Read JS logs over CDP:
  `curl localhost:8090/json/list` gives the WebSocket debugger URL.
- Packaged builds: never let anything write inside the signed .app (it breaks the signature).
  The engine runs with `uv run --frozen --no-editable` and PYTHONPYCACHEPREFIX pointing at the
  data folder. Check with `codesign --verify --deep --strict` after running a build.
- Screenshots: capture only the zunos window (screencapture -l <window id>), never the full screen.
