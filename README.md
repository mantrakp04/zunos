# zunos

A speech model that learns your voice, in any of the 99 languages Whisper knows. zunos fine-tunes
Whisper large-v3 on how you speak (languages people usually type in English letters, like Hindi or
Gujarati, are written that way), then transcribes on your Mac.

1. **Sign in** with an emailed code (Hexclave).
2. **Pick your languages**, as many as you speak.
3. **Record**: read the built-in passages (English, Hindi, Gujarati today) or write your own in any
   language. Each take is cut into clips at line breaks; a quarter of every language is held back
   for testing.
4. **Train**: on a cloud GPU, zunos clones your voice to read thousands of new sentences (IndicF5 for
   Indian languages, Chatterbox for 23 others), then fine-tunes Whisper on them plus your real
   recordings (about an hour). Languages neither voice model reads train on your recordings alone.
5. **Test**: word error rate on the held-back clips, next to Sarvam.
6. **Dictate**: talk, stop, and the text is on your clipboard.

## How good it is

The owner's model (English, Hindi, Gujarati). Word error rate of v3a on 13 recordings it never trained on, decoded on the
Mac with beam search (lower is better; Hindi/Gujarati spelling variants are forgiven):

| | English | Hindi | Gujarati |
|---|---|---|---|
| Sarvam (saaras) | 16.9% | 17.6% | 39.7% |
| **zunos v3a** | **14.4%** | 19.8% | **27.4%** |

Measured with `uv run zunos-eval` and in the app's Test screen (both give the same numbers). An
earlier version of this README listed English at 12.5%; that came from the greedy in-training
evaluation at step 350, not the Mac decoder. The 2x target is not reached. The test set is small (about 100
words per language) and the answer key was partly built from Sarvam's output, which flatters Sarvam.
The biggest lever is more of your real Hindi and Gujarati.

## Development

Requirements: macOS with Xcode, CocoaPods, bun, uv.

```sh
bun install
cd python && uv sync && cd ..

# Native build (once, and after native changes)
cd apps/mac/macos && pod install
xcodebuild -workspace zunos.xcworkspace -scheme zunos-macOS -configuration Debug \
  -derivedDataPath build -destination 'platform=macOS' build
cd ..

# Metro with the Hexclave dev environment, then launch the app
bun run start
open macos/build/Build/Products/Debug/zunos.app
```

The app launches the speech engine from `python/` with `uv run zunos-engine`.

Command-line tools:

```sh
cd python
uv run zunos-eval ~/Library/Application\ Support/zunos/models/v3a-hf   # score a model on the app's test clips
uv run zunos-dictate ~/Library/Application\ Support/zunos/models/v3a-hf              # terminal dictation
```

Cloud training: see apps/api/README.md (Elysia on Bun, deployed with `npx hexclave deploy` from
hexclave.deploy.ts on Hexclave's GCP runtime) and python/pod.

## Repository

| Path | What |
|---|---|
| apps/mac | The Mac app (Expo + react-native-macos, ruixen UI in DOM components, Swift module) |
| apps/api | Training backend (Elysia on Bun, Hexclave deployments) |
| packages/db | App database schema and migrations |
| packages/ui | Theme and ruixen components |
| python/core | Text normalization and scoring |
| python/engine | Local transcription, evaluation, segmentation, dataset packing |
| python/pod | GPU training pipeline |

## How v3a was made

1. 7.6 min of reading, cut into 36 clips and transcribed word for word; 13 held back for testing.
2. 721 sentences written for dictation-style speech in the three languages.
3. Read in the cloned voice by IndicF5 (Hindi/Gujarati) and Chatterbox (English/Hindi); a second
   model dropped the takes with wrong words. A later run added Fish Audio Drama 3 takes (v3b) and
   didn't beat v3a.
4. Training added real room noise, babble, fans, room echo, phone/Bluetooth sound, speed changes
   and slurring, and joined clips into long dictations.

Total cloud cost of the first runs: $6.49 on Runpod.
