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
};

export type TrainingQuote = { gpu: string; pricePerHour: number; estimatedHours: number; available: boolean; reason?: string };
