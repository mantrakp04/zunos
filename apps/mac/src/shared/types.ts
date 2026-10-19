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
};

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

export type Baseline = { provider: string; lang: Lang; wer: number };

export type EngineState = "stopped" | "starting" | "loading" | "ready" | "busy" | "error";

/** Live state pushed from the native shell into the DOM screens as props. */
export type LiveState = {
  user: User | null;
  authReady: boolean;
  engine: EngineState;
  engineError: string | null;
  recording: boolean;
  level: number;
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
