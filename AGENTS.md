# zunos

A macOS app that fine-tunes Whisper large-v3 on the user's voice: English, plus Hindi and Gujarati
written in English letters. Flow: sign in (Hexclave) → pick languages → record → train (Runpod GPU,
paid by the owner through apps/api) → test → dictate. Decoding runs locally on the Mac. The original
goal, beating Sarvam (saaras) by 2x word error rate on held-back clips, is tracked in README.md.

## Layout (bun workspaces + a uv workspace)

- apps/mac: the Expo app on react-native-macos (expo-desktop template, Expo SDK 55). App.tsx is
  the native shell; src/dom/ are "use dom" screens built with ruixen components; src/services/ hold
  the database, auth, engine and training clients; modules/zunos-native is the Swift module
  (recorder, engine process, Keychain, transfers). Run: `bun run start` in apps/mac (Hexclave dev
  env + Metro on port 8090), then open macos/build/Build/Products/Debug/zunos.app (build with
  xcodebuild, see README).
- apps/api: Cloudflare Worker that verifies Hexclave tokens, launches Runpod pods for allow-listed
  users within the budget, receives pod events, and reaps idle pods.
- packages/db: Drizzle schema and SQL migrations for the app database (embedded so expo-sqlite and
  bun:sqlite run the same migrations). `NAME=<change> bun run generate` after editing schema.ts.
- packages/ui: Tailwind v4 theme and ruixen/shadcn components (`npx shadcn add https://ruixen.com/r/<name>`
  from packages/ui).
- python/core: textnorm (fuzzy WER, roman_cer) and scoring shared by the engine and the pod.
- python/engine: the local engine the app launches (`zunos-engine`, JSON lines over stdio): load,
  transcribe, eval, segment, pack, unpack. Also `zunos-eval` and `zunos-dictate` CLIs.
- python/pod: GPU pipeline. bootstrap.sh → run.py: ref_text.py, make_jobs.py, gen_f5.py (IndicF5),
  gen_cb.py (Chatterbox), filter.py, train.py, export.py. fish/ is the Fish Drama 3 experiment.
- tools/migrate: one-shot import of the pre-app data into the app database.

User data lives in ~/Library/Application Support/zunos (zunos.db, audio/, models/, runs/).

## Rules

- Test set: clips with split='test' (13 from the first session, then one in four of each
  language's new clips). Never train on them, never use them as voice references, and never write
  corpus sentences that copy their text. Score with fuzzy WER and score Sarvam on the same key.
- Owner's budget is under $2/hour of cloud GPU in total. Quote the price before creating a pod,
  and stop or terminate pods as soon as they're idle. apps/api enforces this for app-started runs.
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
- Whisper's Gujarati output mixes scripts, so filter.py scores hi/gu by transliterating to Latin
  first (textnorm.roman_cer).
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
- Screenshots: capture only the zunos window (screencapture -l <window id>), never the full screen.
