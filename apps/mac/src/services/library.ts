// Reads and writes the user's voice library in the app database.
import { schema } from "@zunos/db";
import type { Lang, Script } from "@zunos/db/schema";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { MicStats } from "../../modules/zunos-native";
import type {
  Baseline, CleanupStyle, MicDeviceInfo, TakeProcessing, TakeQuality, DictationItem, EvalResult, Language, LangStats, ModelItem, PromptItem, RunDetail, RunSummary, SavedRecording,
} from "../shared/types";
import Native from "../../modules/zunos-native";
import { abs, dataDir, type Db } from "./db";
import * as engine from "./engine";
import type { PendingQuality } from "./cleaning";
import * as corpus from "./corpus";

const { clips, dictations, evals, languages, models, prompts, recordings, runs, runSteps, baselines, settings } = schema;

// Share of each language's clips held back for testing. Test clips are never trained on.
const TEST_SHARE = 0.25;

export function createLibrary(db: Db) {
  /** Splits for `n` new clips of `lang`: about one in four goes to the test set. */
  async function nextSplits(lang: Lang, n: number) {
    const [counts] = await db
      .select({ test: sql<number>`coalesce(sum(${clips.split} = 'test'), 0)`, all: sql<number>`count(*)` })
      .from(clips).where(eq(clips.lang, lang));
    let test = counts?.test ?? 0, all = counts?.all ?? 0;
    return Array.from({ length: n }, () => {
      const split: "train" | "test" = test < (all + 1) * TEST_SHARE ? "test" : "train";
      if (split === "test") test++;
      all++;
      return split;
    });
  }

  // Takes being cut right now (a fresh one or a retry): not "unsegmented", and not cut twice at once.
  const cutting = new Set<string>();

  /**
   * Cuts a stored take into clips at its line marks (engine `segment`; `read` = lines the reader got
   * through, when known) and saves them with train/test splits. On failure the take and its row stay,
   * no clips are written, and the error says the take is safe.
   */
  async function cutTake(
    rec: { id: string; rel: string },
    prompt: { lang: Lang; kind: string; lines: string[]; native?: string[] | null },
    take: { marks: (number | null)[]; read?: number; cleanPath?: string | null; noiseDb?: number | null },
  ) {
    let cut: any[];
    try {
      ({ clips: cut } = await engine.call<{ clips: any[] }>("segment", {
        path: abs(rec.rel), marks: take.marks, read: take.read ?? null, lines: prompt.lines, out_dir: `${dataDir}/audio/clips`,
        id_prefix: rec.id, clean_path: take.cleanPath ?? null, noise_db: take.noiseDb ?? null,
      }));
      if (!cut.length) throw new Error("no clips came out");
    } catch (e) {
      console.warn(`zunos: cutting ${rec.id} failed`, e);
      throw new Error(`Your take is saved, but cutting it into clips failed (${e instanceof Error ? e.message : String(e)}). Nothing is lost: try again.`);
    }
    const splits = await nextSplits(prompt.lang, cut.length);
    const saved = cut.map((c, i) => ({
      id: c.id, recordingId: rec.id, lang: prompt.lang, kind: prompt.kind, start: c.start, end: c.end, seconds: c.seconds,
      path16k: c.path_16k.replace(`${dataDir}/`, ""), path48k: c.path_48k.replace(`${dataDir}/`, ""),
      path48kClean: c.path_48k_clean ? (c.path_48k_clean as string).replace(`${dataDir}/`, "") : null, quality: c.quality ?? null,
      text: c.text, nativeText: corpus.nativeTextOf(prompt.native, c.lines), split: splits[i]!, unsure: false,
    }));
    await db.insert(clips).values(saved);
    return saved;
  }

  return {
    /** All languages, the user's own first. */
    async languages(): Promise<Language[]> {
      return (await db.select().from(languages).orderBy(desc(languages.enabled), asc(languages.sort))).map(corpus.withRoman);
    },

    async setLanguageEnabled(code: Lang, enabled: boolean) {
      await db.update(languages).set({ enabled }).where(eq(languages.code, code));
      if (enabled) await corpus.seedLanguages(db, [code]);
    },

    setLanguageScript: (code: Lang, script: Script) => corpus.setLanguageScript(db, code, script),
    /** The script a take of this prompt is read in (the language's choice, when the prompt has those lines). */
    takeScript: (promptId: string) => corpus.takeScript(db, promptId),

    async stats(): Promise<LangStats[]> {
      const rows = await db
        .select({
          lang: clips.lang, split: clips.split,
          seconds: sql<number>`coalesce(sum(${clips.seconds}), 0)`, n: sql<number>`count(*)`,
        })
        .from(clips).groupBy(clips.lang, clips.split);
      const promptRows = await db
        .select({
          lang: prompts.lang, total: sql<number>`count(*)`,
          // Fully qualified: drizzle renders ${prompts.id} as a bare "id", which would bind to r.id.
          recorded: sql<number>`sum(exists(select 1 from recordings r where r.prompt_id = "prompts"."id"))`,
        })
        .from(prompts).where(corpus.listed).groupBy(prompts.lang);
      const langs = (await this.languages()).filter((l) => l.enabled);
      return langs.map(({ code }) => {
        const get = (split: string) => rows.find((r) => r.lang === code && r.split === split);
        const p = promptRows.find((r) => r.lang === code);
        return {
          lang: code,
          trainSeconds: get("train")?.seconds ?? 0, testSeconds: get("test")?.seconds ?? 0,
          trainClips: get("train")?.n ?? 0, testClips: get("test")?.n ?? 0,
          promptsRecorded: p?.recorded ?? 0, promptsTotal: p?.total ?? 0,
        };
      });
    },

    /** The starter set first, then passages (the most speech per take), then dictation sentences. */
    prompts: (lang: Lang): Promise<PromptItem[]> => corpus.promptItems(db, lang),

    /** A passage the user wrote or pasted, split into lines at sentence ends. */
    async createPrompt(lang: Lang, text: string): Promise<PromptItem> {
      const lines = text.split(/(?<=[.!?।॥。！？])\s+|\n+/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) throw new Error("Write at least one sentence.");
      return corpus.createUserPrompt(db, lang, lines);
    },

    newRecordingPath(promptId: string) {
      const id = `${promptId}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
      return { id, rel: `audio/recordings/${id}.wav`, path: `${dataDir}/audio/recordings/${id}.wav` };
    },

    /**
     * Store a finished take, measure it, clean its background noise into a separate file, cut both into clips
     * at line boundaries, and assign train/test splits.
     *
     * Which audio feeds what: the raw take's 16 kHz clips are the training input and the test set (dictation
     * hears the raw microphone, and the pod adds its own noise); the cleaned take's 48 kHz clips are the
     * voice-cloning references (a TTS model copies whatever is in its reference, room noise included). The raw
     * take is never modified.
     */
    async saveRecording(
      promptId: string,
      rec: { id: string; rel: string },
      take: {
        seconds: number; sampleRate: number; marks: (number | null)[];
        /** Lines the reader got through (finishTake's line + 1), when the screen says. */
        read?: number;
        /** The prompt's script the take was read in (startTake's corpus.takeScript). */
        script?: Script;
        /** Seconds of room tone at the start; the device and live statistics from the recorder. */
        room?: number; device?: MicDeviceInfo | null; deviceChanged?: boolean; stats?: MicStats;
      },
      onProgress?: (p: TakeProcessing) => void,
    ): Promise<SavedRecording> {
      const [prompt] = await db.select().from(prompts).where(eq(prompts.id, promptId));
      if (!prompt) throw new Error(`Unknown prompt ${promptId}`);
      const script = take.script ?? await corpus.takeScript(db, promptId);
      const { lines, native } = corpus.takeLines(prompt, script);
      // Raw clips now (training input and the test set); the cleaned copies for voice cloning and the take's
      // quality come afterwards from the background cleaning queue (cleaning.ts), which this marks pending.
      const pending: PendingQuality = {
        status: "pending", device: take.device ?? null, deviceChanged: !!take.deviceChanged, live: take.stats ?? null, room: take.room ?? 0,
      };
      await db.insert(recordings).values({
        id: rec.id, promptId, lang: prompt.lang, kind: prompt.kind, path: rec.rel, sampleRate: take.sampleRate,
        seconds: take.seconds, marks: take.marks as number[], recordedAt: new Date().toISOString(), script, quality: pending,
      });
      cutting.add(rec.id);
      try {
        onProgress?.({ phase: "cutting", progress: 0 });
        const saved = await cutTake(rec, { ...prompt, lines, native }, { marks: take.marks, read: take.read });
        return {
          recordingId: rec.id, seconds: take.seconds, quality: null,
          clips: saved.map(({ id, seconds, split, text }) => ({ id, seconds, split, text })),
        };
      } finally {
        cutting.delete(rec.id);
      }
    },

    /** Kept prompt takes without clips (cutting them failed), newest first. */
    async unsegmentedRecordings() {
      const rows = await db
        .select({ id: recordings.id, promptId: recordings.promptId, lang: recordings.lang, seconds: recordings.seconds, recordedAt: recordings.recordedAt })
        .from(recordings)
        .where(sql`${recordings.promptId} is not null and not exists (select 1 from clips c where c.recording_id = "recordings"."id")`)
        .orderBy(desc(recordings.recordedAt));
      return rows.filter((r) => !cutting.has(r.id));
    },

    /** Cuts a kept take into clips again from its stored marks; a take that already has clips is returned as is. */
    async resegmentRecording(id: string): Promise<SavedRecording> {
      const [r] = await db.select().from(recordings).where(eq(recordings.id, id));
      if (!r?.promptId) throw new Error("That take is gone.");
      const done = await db.select({ id: clips.id, seconds: clips.seconds, split: clips.split, text: clips.text }).from(clips).where(eq(clips.recordingId, id));
      const q = r.quality as (TakeQuality & { status?: string }) | null;
      const quality = q && q.status !== "pending" ? (q as TakeQuality) : null;
      if (done.length) return { recordingId: id, seconds: r.seconds, quality, clips: done };
      if (cutting.has(id)) throw new Error("That take is being cut into clips already.");
      const [prompt] = await db.select().from(prompts).where(eq(prompts.id, r.promptId));
      if (!prompt) throw new Error(`Unknown prompt ${r.promptId}`);
      cutting.add(id);
      try {
        const saved = await cutTake({ id, rel: r.path }, { ...prompt, ...corpus.takeLines(prompt, r.script) }, {
          marks: r.marks, cleanPath: r.cleanPath ? abs(r.cleanPath) : null, noiseDb: quality?.raw?.noiseDb ?? null,
        });
        return { recordingId: id, seconds: r.seconds, quality, clips: saved.map(({ id, seconds, split, text }) => ({ id, seconds, split, text })) };
      } finally {
        cutting.delete(id);
      }
    },

    async testClips() {
      const rows = await db.select().from(clips).where(eq(clips.split, "test")).orderBy(asc(clips.lang), asc(clips.id));
      return rows.map((c) => ({ id: c.id, lang: c.lang, text: c.text, path: abs(c.path16k) }));
    },

    async runs(): Promise<RunSummary[]> {
      return db.select({
        id: runs.id, name: runs.name, base: runs.base, status: runs.status, stage: runs.stage, bestStep: runs.bestStep,
        bestScore: runs.bestScore, costUsd: runs.costUsd, createdAt: runs.createdAt,
      }).from(runs).orderBy(desc(runs.createdAt), desc(runs.id));
    },

    async run(id: string): Promise<RunDetail | null> {
      const [r] = await db.select().from(runs).where(eq(runs.id, id));
      if (!r) return null;
      const steps = await db.select({ step: runSteps.step, loss: runSteps.loss }).from(runSteps).where(eq(runSteps.runId, id)).orderBy(asc(runSteps.step));
      const ev = await db.select().from(evals).where(and(eq(evals.runId, id), sql`${evals.modelId} is null`)).orderBy(asc(evals.step));
      // scores: {lang: [basicWER, normalizedWER] | WER, synth_val_fuzzy, avg}
      const perLang = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s)
        .filter(([k]) => k !== "avg" && !k.startsWith("synth"))
        .map(([k, v]) => [k, Array.isArray(v) ? (v[1] as number) : (v as number)]));
      return {
        id: r.id, name: r.name, base: r.base, status: r.status, stage: r.stage, bestStep: r.bestStep, bestScore: r.bestScore,
        costUsd: r.costUsd, createdAt: r.createdAt, cfg: r.cfg, steps,
        evals: ev.map((e) => ({ step: e.step, score: e.score, langs: perLang(e.scores) })),
      };
    },

    async models(): Promise<ModelItem[]> {
      return db.select({ id: models.id, name: models.name, format: models.format, active: models.active, runId: models.runId, score: models.score })
        .from(models).orderBy(desc(models.active), asc(models.id));
    },

    async activeModel() {
      const [m] = await db.select().from(models).where(and(eq(models.active, true), eq(models.format, "hf")));
      return m ? { ...m, path: abs(m.path) } : null;
    },

    async setActiveModel(id: string) {
      await db.update(models).set({ active: false }).where(eq(models.format, "hf"));
      await db.update(models).set({ active: true }).where(eq(models.id, id));
    },

    async saveEval(modelId: string, beams: number, out: { scores: any; rows: any[] }) {
      await db.insert(evals).values({ runId: null, modelId, step: null, beams, score: out.scores.avg ?? 0, scores: out.scores, rows: out.rows });
    },

    async latestEval(modelId: string): Promise<EvalResult | null> {
      const [e] = await db.select().from(evals).where(eq(evals.modelId, modelId)).orderBy(desc(evals.id)).limit(1);
      if (!e) return null;
      return { modelId, beams: e.beams, scores: e.scores as EvalResult["scores"], rows: (e.rows ?? []) as EvalResult["rows"], createdAt: e.createdAt };
    },

    /** The reference recognizer's word error rate per language, on the same test clips (written by `uv run zunos-reference`). */
    async baselines(): Promise<Baseline[]> {
      const rows = await db.select().from(baselines).where(eq(baselines.provider, "reference"));
      return rows.map((r) => ({ provider: "reference", lang: r.lang, wer: r.wer }));
    },

    /** Everything a training pod needs for these languages (see python/engine/src/zunos_engine/pack.py). */
    async trainingDataset(langs: Lang[]) {
      const cs = await db.select().from(clips).where(inArray(clips.lang, langs));
      const ps = await db.select().from(prompts).where(and(inArray(prompts.lang, langs), eq(prompts.kind, "sentence")));
      const trainRecordings = [...new Set(cs.filter((c) => c.split === "train" && c.recordingId).map((c) => c.recordingId!))];
      const recs = trainRecordings.length ? await db.select().from(recordings).where(inArray(recordings.id, trainRecordings)) : [];
      return {
        clips: cs.map((c) => ({
          id: c.id, lang: c.lang, split: c.split, text: c.text, native_text: c.nativeText, seconds: c.seconds, kind: c.kind,
          // 48 kHz clips are only voice-cloning references on the pod: send the cleaned cut when there is one.
          path_16k: abs(c.path16k), path_48k: c.path48kClean ? abs(c.path48kClean) : c.path48k ? abs(c.path48k) : null,
        })),
        prompts: ps.map((p) => ({ id: p.id, lang: p.lang, roman: p.roman?.[0] ?? null, native: p.native?.[0] ?? null })),
        recordings: recs.map((r) => abs(r.path)),
      };
    },

    async createRun(id: string, langs: Lang[], gpu: string | null) {
      await db.insert(runs).values({
        id, name: id, base: "openai/whisper-large-v3", cfg: { langs }, status: "uploading", stage: "data", gpu, remoteId: id,
        startedAt: new Date().toISOString(),
      });
    },

    /** Cloud runs still in flight, or finished but whose model hasn't been downloaded yet. */
    async activeRuns() {
      return db.select().from(runs).where(and(
        sql`${runs.remoteId} is not null`,
        sql`(${runs.status} in ('uploading','queued','running') or (${runs.status} = 'done' and coalesce(${runs.stage}, '') != 'downloaded'))`,
      ));
    },

    /** Mirror the backend's view of a run: status, cost, training curve and evals. */
    async updateRun(id: string, remote: { status: string; stage: string | null; costUsd: number; steps: { step: number; loss: number }[]; evals: { step: number; score: number; res: Record<string, unknown> }[]; error: string | null }) {
      const best = [...remote.evals].sort((a, b) => a.score - b.score)[0];
      await db.update(runs).set({
        status: remote.status as any, stage: remote.stage, costUsd: remote.costUsd, notes: remote.error,
        bestStep: best?.step ?? null, bestScore: best?.score ?? null,
        finishedAt: ["done", "failed", "stopped"].includes(remote.status) ? new Date().toISOString() : null,
      }).where(eq(runs.id, id));
      await db.delete(runSteps).where(eq(runSteps.runId, id));
      if (remote.steps.length) await db.insert(runSteps).values(remote.steps.map((s) => ({ runId: id, step: s.step, loss: s.loss })));
      await db.delete(evals).where(and(eq(evals.runId, id), sql`${evals.modelId} is null`));
      if (remote.evals.length)
        await db.insert(evals).values(remote.evals.map((e) => ({ runId: id, step: e.step, beams: 1, score: e.score, scores: e.res })));
    },

    async hasModelForRun(runId: string) {
      return (await db.select({ id: models.id }).from(models).where(eq(models.runId, runId))).length > 0;
    },

    async addModel(runId: string, rel: string, score: Record<string, unknown> | null) {
      await db.insert(models).values({ id: `${runId}-hf`, runId, name: runId, format: "hf", path: rel, score, active: false })
        .onConflictDoNothing();
      await db.update(runs).set({ status: "done", stage: "downloaded" }).where(eq(runs.id, runId));
    },

    // ---- dictation history
    newDictation() {
      const id = `d-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}`;
      return { id, rel: `audio/dictations/${id}.wav`, path: `${dataDir}/audio/dictations/${id}.wav` };
    },

    async addDictation(row: typeof dictations.$inferInsert) {
      await db.insert(dictations).values(row);
    },

    async updateDictation(id: string, patch: Partial<typeof dictations.$inferInsert>) {
      await db.update(dictations).set(patch).where(eq(dictations.id, id));
    },

    async dictation(id: string) {
      const [d] = await db.select().from(dictations).where(eq(dictations.id, id));
      return d ?? null;
    },

    async dictations(limit = 100): Promise<DictationItem[]> {
      const rows = await db.select({ d: dictations, split: clips.split }).from(dictations)
        .leftJoin(clips, eq(clips.id, dictations.clipId)).orderBy(desc(dictations.createdAt)).limit(limit);
      return rows.map(({ d, split }) => ({
        id: d.id, createdAt: d.createdAt, seconds: d.seconds, lang: d.lang, raw: d.raw, clean: d.clean,
        style: d.style as CleanupStyle | null, corrected: d.corrected, appName: d.appName, status: d.status, error: d.error,
        clip: d.clipId && split ? { id: d.clipId, split } : null, hasAudio: !!d.audio,
      }));
    },

    async deleteDictation(id: string) {
      const d = await this.dictation(id);
      if (d?.audio) await Native.deleteFile(abs(d.audio));
      await db.delete(dictations).where(eq(dictations.id, id));
    },

    /**
     * Turns a dictation into a clip with the user-confirmed text (the audio is copied, so deleting
     * the dictation later keeps the clip). Splits follow the same one-in-four rule as recordings.
     */
    async clipFromDictation(id: string, text: string, lang: Lang) {
      const d = await this.dictation(id);
      if (!d?.audio) throw new Error("This dictation's audio is gone.");
      const recId = `dict-${d.id}`;
      await db.insert(recordings).values({
        id: recId, promptId: null, lang, kind: "dictation", path: d.audio, sampleRate: d.sampleRate, seconds: d.seconds,
        marks: [d.seconds], recordedAt: d.createdAt,
      }).onConflictDoNothing();
      const { clips: cut } = await engine.call<{ clips: any[] }>("segment", {
        path: abs(d.audio), marks: [d.seconds], lines: [text], out_dir: `${dataDir}/audio/clips`, id_prefix: recId,
      });
      const c = cut[0];
      const [split] = await nextSplits(lang, 1);
      await db.insert(clips).values({
        id: c.id, recordingId: recId, lang, kind: "dictation", start: c.start, end: c.end, seconds: c.seconds,
        path16k: c.path_16k.replace(`${dataDir}/`, ""), path48k: c.path_48k.replace(`${dataDir}/`, ""), text, split: split!, unsure: false,
      });
      await db.update(dictations).set({ clipId: c.id }).where(eq(dictations.id, id));
      return { id: c.id as string, split: split! };
    },

    /** Replaces a clip's word-for-word text (a corrected dictation that already became a clip). */
    async setClipText(id: string, text: string) {
      await db.update(clips).set({ text }).where(eq(clips.id, id));
    },

    // ---- app settings (key → JSON value)
    async setting<T>(key: string): Promise<T | null> {
      const [row] = await db.select().from(settings).where(eq(settings.key, key));
      return (row?.value as T | undefined) ?? null;
    },

    async setSetting(key: string, value: unknown) {
      await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    },
  };
}

export type Library = ReturnType<typeof createLibrary>;
