// Serializable shapes passed between the native shell and the DOM screens.
import type { Lang } from "@zunos/db/schema";

export type { Lang };

export type User = { id: string; email: string | null; name: string | null };

export type Language = { code: Lang; name: string; script: string; enabled: boolean };

export type LangStats = {
  lang: Lang;
  trainSeconds: number;
  testSeconds: number;
  trainClips: number;
  testClips: number;
  promptsRecorded: number;
  promptsTotal: number;
};

export type PromptItem = {
  id: string;
  lang: Lang;
  kind: "para" | "twister" | "sentence";
  title: string | null;
  lines: string[];
  recorded: boolean;
};

export type SavedRecording = {
  recordingId: string;
  seconds: number;
  clips: { id: string; seconds: number; split: "train" | "test"; text: string }[];
  /** How the take sounded and what was cleaned; null only when the engine could not measure it. */
  quality: TakeQuality | null;
};

// ---- recording quality (services/quality.ts builds the issues; the engine measures, python enhance.py)

export type MicTransport =
  | "builtIn" | "usb" | "bluetooth" | "bluetoothLE" | "continuity" | "aggregate" | "virtual" | "hdmi" | "displayPort"
  | "airPlay" | "thunderbolt" | "pci" | "fireWire" | "avb" | "unknown";

/** The default input device. inputVolume is 0-1 when the device exposes one; micMode is macOS's Mic Mode. */
export type MicDeviceInfo = {
  name: string | null;
  transport: MicTransport;
  sampleRate: number | null;
  inputVolume: number | null;
  micMode: "standard" | "voiceIsolation" | "wideSpectrum" | null;
};

export type MicIssueCode =
  | "noInput" | "bluetooth" | "narrowband" | "continuity" | "virtualDevice" | "micMode" | "lowInputVolume" | "processedMic"
  | "noisyRoom" | "lowSnr" | "hum" | "rumble" | "echo" | "roomSpoken" | "tooQuiet" | "tooLoud" | "clipping" | "pops"
  | "longSilence" | "deviceChanged";

/**
 * Something about the microphone, the room or the user's delivery, with what to do about it.
 * info: worth knowing, nothing to fix. warn: the recording works but would be better fixed. bad: fix it and
 * record again. `title` is a short label, `detail` one or two sentences of guidance; both are display-ready.
 */
export type MicIssue = { code: MicIssueCode; severity: "info" | "warn" | "bad"; title: string; detail: string };

/** Live microphone state while a take records or the room check listens (null otherwise). Levels in dBFS. */
export type MicState = {
  phase: "room" | "recording";
  device: MicDeviceInfo | null;
  /** True during the first seconds of a take, while the user should stay quiet (room tone). */
  roomTone: boolean;
  noiseDb: number | null;
  speechDb: number | null;
  snrDb: number | null;
  peakDb: number | null;
  speaking: boolean;
  silenceSec: number;
  /** Current issues, worst first. Recomputed about four times a second; codes are stable keys. */
  issues: MicIssue[];
};

/** What the engine measured on a take (python/engine enhance.py measure). Levels in dBFS, times in seconds. */
export type AudioMeasure = {
  seconds: number;
  lufs: number;
  speechDb: number | null;
  noiseDb: number;
  roomDb: number | null;
  snrDb: number | null;
  peakDb: number;
  clippedPct: number;
  clipEvents: number;
  dc: number;
  /** Share of the background's power below 80 Hz (rumble). */
  lowShare: number | null;
  humHz: 50 | 60 | null;
  humDb: number;
  /** Highest frequency the microphone path carries; null = full band. */
  bandwidthHz: number | null;
  gatedPct: number;
  /** Rough reverberation time; null when the take has too few clean word endings to tell. */
  reverbSec: number | null;
  pops: number;
  speechPct: number;
  leadSilence: number | null;
  longestPause: number;
};

/** A finished take: verdict, issues, and the background-noise cleaning applied to its voice-cloning copy. */
export type TakeQuality = {
  /** good: nothing to fix. ok: usable, see issues. redo: record it again (the clips are kept either way). */
  verdict: "good" | "ok" | "redo";
  issues: MicIssue[];
  device: MicDeviceInfo | null;
  raw: AudioMeasure | null;
  clean: AudioMeasure | null;
  cleaning: {
    /** Most the denoiser may lower the background, in dB; 0 = not denoised (only level and rumble fixes). */
    strength: number;
    /** What the measured SNR asked for; lower `strength` means a guardrail stepped it down. */
    wanted: number;
    reason: "snr" | "clean enough" | "speech level" | "asr check" | "silent" | "failed";
    /** Whisper base's error on the raw take and at each strength tried (lower is better). */
    tried: { strength: number; speechKeptDb: number; asr?: number | null }[];
  } | null;
};

/** The room check: a few seconds of listening with the user quiet. */
export type RoomCheck = {
  noiseDb: number | null;
  humHz: number | null;
  device: MicDeviceInfo | null;
  issues: MicIssue[];
  verdict: "good" | "ok" | "noisy";
};

/** Saving a take: measuring, fetching the cleaning models (first time only), cleaning, checking, cutting. */
export type TakeProcessing = { phase: "measuring" | "downloading" | "cleaning" | "checking" | "cutting"; progress: number };

export type RunSummary = {
  id: string;
  name: string;
  base: string;
  status: string;
  stage: string | null;
  bestStep: number | null;
  bestScore: number | null;
  costUsd: number | null;
  createdAt: string;
};

/** One evaluation during training: average WER and WER per language code. */
export type EvalPoint = { step: number | null; score: number; langs: Record<string, number> };

export type RunDetail = RunSummary & {
  cfg: Record<string, unknown>;
  steps: { step: number; loss: number | null }[];
  evals: EvalPoint[];
};

export type ModelItem = {
  id: string;
  name: string;
  format: "hf" | "mlx";
  active: boolean;
  runId: string | null;
  score: Record<string, unknown> | null;
};

export type EvalResult = {
  modelId: string;
  beams: number;
  scores: Record<string, number>;
  rows: { id: string; lang: Lang; ref: string; hyp: string; wer: number }[];
  createdAt: string;
};

/** A comparison score on the test clips; the only provider is the reference recognizer (label it "Reference"). */
export type Baseline = { provider: "reference"; lang: Lang; wer: number };

export type EngineState = "stopped" | "starting" | "loading" | "ready" | "busy" | "error";

/** Live state pushed from the native shell into the DOM screens as props. */
export type LiveState = {
  user: User | null;
  authReady: boolean;
  engine: EngineState;
  engineError: string | null;
  recording: boolean;
  level: number;
  /** The microphone while a take records or the room check listens; null otherwise. */
  mic: MicState | null;
  /** A finished take being cleaned and cut into clips (finishTake is still pending). */
  takeProcessing: TakeProcessing | null;
  evalProgress: { done: number; total: number } | null;
  /** Local side of a cloud training run: preparing the dataset, uploading it, fetching the model. */
  transfer: { runId: string; phase: "packing" | "uploading" | "starting" | "downloading" | "installing"; progress: number } | null;
  /** The transcript-cleanup model; null until dictation has checked for it. */
  cleanup: CleanupState | null;
  /** A dictation in progress, from the Dictate screen or the global hotkey. */
  dictation: { source: "window" | "hotkey"; phase: "listening" | "thinking" } | null;
  /** System-wide dictation needs Accessibility (the hotkey tap and pasting). */
  access: { trusted: boolean; hotkey: boolean };
  /** Bumped whenever the dictation history changes, so lists know to reload. */
  dictationsVersion: number;
};

export type HotkeyKey = "fn" | "rightOption" | "rightCommand";

/**
 * hybrid: hold the key to talk, or tap it to start and tap again to stop. hold: only while held.
 * toggle: every press starts or stops.
 */
export type DictationSettings = {
  hotkey: HotkeyKey | "off";
  mode: "hybrid" | "hold" | "toggle";
  /** Paste into the app that was in front; otherwise only copy. */
  paste: boolean;
  /** Put the user's clipboard back after pasting. */
  restoreClipboard: boolean;
};

export type DictationItem = {
  id: string;
  createdAt: string;
  seconds: number;
  lang: string | null;
  /** Exactly what the model heard. */
  raw: string;
  /** The cleanup model's version (of `corrected` when there is one). */
  clean: string | null;
  style: CleanupStyle | null;
  /** The user's fix of `raw`: what was really said, word for word. */
  corrected: string | null;
  appName: string | null;
  status: "ok" | "failed";
  error: string | null;
  /** Set once the dictation became a training (or test) clip. */
  clip: { id: string; split: "train" | "test" } | null;
  hasAudio: boolean;
};

/** How dictated text is cleaned up by the local LLM. "off" keeps exactly what Whisper heard. */
export type CleanupStyle = "off" | "light" | "polished";
export type CleanupSettings = { style: CleanupStyle };

export type CleanupState =
  | { status: "absent"; totalBytes: number }
  | { status: "downloading"; doneBytes: number; totalBytes: number }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

/** One dictation: `text` is the raw transcript, `clean` the cleaned version when cleanup ran. */
export type DictationResult = {
  id: string;
  text: string;
  clean: string | null;
  style: CleanupStyle | null;
  lang: string;
  seconds: number;
  elapsed: number;
};

export type TrainingQuote = { gpu: string; pricePerHour: number; estimatedHours: number; available: boolean; reason?: string };
