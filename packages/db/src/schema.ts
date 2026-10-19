// zunos app database (SQLite, one file in ~/Library/Application Support/zunos/zunos.db).
// Audio and model files live next to it on disk; every *path column is relative to that folder
// unless it is absolute (models registered in place).
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
const createdAt = () => text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

/** A Whisper language code (see languages.ts). */
export type Lang = string;
export type Split = "train" | "test";

export const languages = sqliteTable("languages", {
  code: text("code").$type<Lang>().primaryKey(),
  name: text("name").notNull(),
  // Script Whisper is trained to write: "Latin (romanized)" for languages typed in English letters.
  script: text("script").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  sort: integer("sort").notNull().default(0),
});

/** Text the user reads aloud: a paragraph, a tongue twister, or a single dictation sentence. */
export const prompts = sqliteTable("prompts", {
  id: text("id").primaryKey(),
  lang: text("lang").$type<Lang>().notNull(),
  kind: text("kind").$type<"para" | "twister" | "sentence">().notNull(),
  title: text("title"),
  lines: json<string[]>("lines").notNull(),
  // Same lines in native script (Devanagari / Gujarati), when known. Used as TTS input.
  nativeLines: json<string[]>("native_lines"),
  source: text("source").notNull(), // builtin | user (session-1 | recorder | corpus on the owner's migrated install)
  createdAt: createdAt(),
}, (t) => [index("prompts_lang").on(t.lang, t.kind)]);

/** One continuous take of a prompt, as recorded (48 kHz mono WAV). */
export const recordings = sqliteTable("recordings", {
  id: text("id").primaryKey(),
  promptId: text("prompt_id").references(() => prompts.id),
  lang: text("lang").$type<Lang>().notNull(),
  kind: text("kind").notNull(),
  path: text("path").notNull(),
  sampleRate: integer("sample_rate").notNull(),
  seconds: real("seconds").notNull(),
  // Seconds at which the reader advanced to the next line (plus the end).
  marks: json<number[]>("marks").notNull(),
  recordedAt: text("recorded_at").notNull(),
  // The take with its background noise cleaned (python/engine enhance.py); `path` stays the raw original.
  cleanPath: text("clean_path"),
  // Measurements of the raw and cleaned take, the cleaning strength used and why, the input device, and the
  // issues found while recording (apps/mac/src/shared/types.ts TakeQuality).
  quality: json<Record<string, unknown>>("quality"),
});

/** A training or test example: audio plus the word-for-word text. */
export const clips = sqliteTable("clips", {
  id: text("id").primaryKey(),
  recordingId: text("recording_id").references(() => recordings.id),
  lang: text("lang").$type<Lang>().notNull(),
  kind: text("kind").notNull(),
  start: real("start"),
  end: real("end"),
  seconds: real("seconds").notNull(),
  // Raw audio: training input and the test set (dictation hears the raw microphone).
  path16k: text("path_16k").notNull(),
  path48k: text("path_48k"),
  // Cut from the cleaned take: what voice cloning copies the user's voice from.
  path48kClean: text("path_48k_clean"),
  // {speechDb, snrDb, peakDb, clippedPct} of the raw clip.
  quality: json<Record<string, unknown>>("quality"),
  text: text("text").notNull(),
  nativeText: text("native_text"),
  unsure: integer("unsure", { mode: "boolean" }).notNull().default(false),
  // Test clips are never trained on and never used as voice-cloning references.
  split: text("split").$type<Split>().notNull(),
  createdAt: createdAt(),
}, (t) => [index("clips_lang_split").on(t.lang, t.split)]);

/** Voice-cloned training clip generated on the GPU pod. */
export const synthClips = sqliteTable("synth_clips", {
  id: text("id").primaryKey(),
  lang: text("lang").$type<Lang>().notNull(),
  engine: text("engine").notNull(), // f5 | cb_en | cb_mtl | fish
  promptId: text("prompt_id").references(() => prompts.id),
  target: text("target").notNull(), // training label (English letters)
  genText: text("gen_text").notNull(), // text fed to the TTS model
  style: text("style"),
  refClipId: text("ref_clip_id").references(() => clips.id),
  refPath: text("ref_path"),
  refText: text("ref_text"),
  params: json<Record<string, unknown>>("params"),
  dur: real("dur"),
  // Quality score from the filter: WER for English, roman CER for Hindi/Gujarati. Lower is better.
  score: real("score"),
  scoreNative: real("score_native"),
  cps: real("cps"),
  hyp: text("hyp"),
  path16k: text("path_16k"),
  pathRaw: text("path_raw"),
  runId: text("run_id").references(() => runs.id),
}, (t) => [index("synth_lang_engine").on(t.lang, t.engine)]);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  base: text("base").notNull(),
  cfg: json<Record<string, unknown>>("cfg").notNull(),
  status: text("status").$type<"draft" | "uploading" | "queued" | "running" | "done" | "failed" | "stopped">().notNull(),
  stage: text("stage"),
  gpu: text("gpu"),
  costUsd: real("cost_usd"),
  remoteId: text("remote_id"),
  bestStep: integer("best_step"),
  bestScore: real("best_score"),
  logPath: text("log_path"),
  notes: text("notes"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  createdAt: createdAt(),
});

export const runSteps = sqliteTable("run_steps", {
  runId: text("run_id").notNull().references(() => runs.id),
  step: integer("step").notNull(),
  epoch: real("epoch"),
  loss: real("loss"),
  lr: real("lr"),
}, (t) => [primaryKey({ columns: [t.runId, t.step] })]);

export type EvalRow = { id: string; ref: string; hyp: string };
export const evals = sqliteTable("evals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").references(() => runs.id),
  modelId: text("model_id"),
  step: integer("step"),
  beams: integer("beams").notNull().default(1),
  score: real("score").notNull(),
  // { en: [basicWER, fuzzyWER], hi: [...], gu: [...], synth_val_fuzzy?: number }
  scores: json<Record<string, unknown>>("scores").notNull(),
  rows: json<EvalRow[]>("rows"),
  createdAt: createdAt(),
}, (t) => [index("evals_run").on(t.runId, t.step)]);

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  runId: text("run_id").references(() => runs.id),
  name: text("name").notNull(),
  format: text("format").$type<"hf" | "mlx">().notNull(),
  path: text("path").notNull(),
  score: json<Record<string, unknown>>("score"),
  active: integer("active", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

/** Word error rate of the reference recognizer (provider "reference") per language, on the test clips. */
export const baselines = sqliteTable("baselines", {
  provider: text("provider").notNull(),
  lang: text("lang").$type<Lang>().notNull(),
  wer: real("wer").notNull(),
}, (t) => [primaryKey({ columns: [t.provider, t.lang] })]);

/**
 * One dictation from the Dictate screen or the global hotkey. `raw` is exactly what the model heard;
 * `corrected` is the user's fix of that raw text, which can become a training clip (`clipId`).
 */
export const dictations = sqliteTable("dictations", {
  id: text("id").primaryKey(),
  audio: text("audio"), // WAV at the mic's rate, relative path; null once deleted
  sampleRate: integer("sample_rate").notNull(),
  seconds: real("seconds").notNull(),
  lang: text("lang").$type<Lang>(),
  raw: text("raw").notNull().default(""),
  clean: text("clean"),
  style: text("style"),
  corrected: text("corrected"),
  modelId: text("model_id"),
  // Frontmost app when dictation started (bundle id and name), so pasting and modes know the target.
  app: text("app"),
  appName: text("app_name"),
  status: text("status").$type<"ok" | "failed">().notNull().default("ok"),
  error: text("error"),
  clipId: text("clip_id").references(() => clips.id),
  elapsed: real("elapsed"),
  createdAt: createdAt(),
}, (t) => [index("dictations_created").on(t.createdAt)]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value"),
});
