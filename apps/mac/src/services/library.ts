// Reads and writes the user's voice library in the app database.
import { schema } from "@zunos/db";
import type { Lang } from "@zunos/db/schema";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import Native from "../../modules/zunos-native";
import type {
  Baseline, EvalResult, Language, LangStats, ModelItem, PromptItem, RunDetail, RunSummary, SavedRecording,
} from "../shared/types";
import { abs, dataDir, type Db } from "./db";
import * as engine from "./engine";

const { clips, evals, languages, models, prompts, recordings, runs, runSteps, baselines } = schema;

// Share of each language's clips held back for testing. Test clips are never trained on.
const TEST_SHARE = 0.25;

export function createLibrary(db: Db) {
  return {
    async languages(): Promise<Language[]> {
      return db.select().from(languages).orderBy(asc(languages.sort));
    },

    async setLanguageEnabled(code: Lang, enabled: boolean) {
      await db.update(languages).set({ enabled }).where(eq(languages.code, code));
    },

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
        .from(prompts).groupBy(prompts.lang);
      const langs = await this.languages();
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

    /** Paragraphs and twisters first (they give the most speech per take), then dictation sentences. */
    async prompts(lang: Lang): Promise<PromptItem[]> {
      const rows = await db
        .select({
          id: prompts.id, lang: prompts.lang, kind: prompts.kind, title: prompts.title, lines: prompts.lines,
          recorded: sql<number>`exists(select 1 from recordings r where r.prompt_id = "prompts"."id")`,
        })
        .from(prompts)
        .where(eq(prompts.lang, lang))
        .orderBy(sql`case ${prompts.kind} when 'para' then 0 when 'twister' then 1 else 2 end`, asc(prompts.id));
      return rows.map((r) => ({ ...r, recorded: !!r.recorded }));
    },

    newRecordingPath(promptId: string) {
      const id = `${promptId}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
      return { id, rel: `audio/recordings/${id}.wav`, path: `${dataDir}/audio/recordings/${id}.wav` };
    },

    /** Store a finished take, cut it into clips at line boundaries, and assign train/test splits. */
    async saveRecording(promptId: string, rec: { id: string; rel: string }, take: { seconds: number; sampleRate: number; marks: number[] }): Promise<SavedRecording> {
      const [prompt] = await db.select().from(prompts).where(eq(prompts.id, promptId));
      if (!prompt) throw new Error(`Unknown prompt ${promptId}`);
      await db.insert(recordings).values({
        id: rec.id, promptId, lang: prompt.lang, kind: prompt.kind, path: rec.rel, sampleRate: take.sampleRate,
        seconds: take.seconds, marks: take.marks, recordedAt: new Date().toISOString(),
      });
      const { clips: cut } = await engine.call<{ clips: any[] }>("segment", {
        path: abs(rec.rel), marks: take.marks, lines: prompt.lines, out_dir: `${dataDir}/audio/clips`, id_prefix: rec.id,
      });
      const [counts] = await db
        .select({ test: sql<number>`coalesce(sum(${clips.split} = 'test'), 0)`, all: sql<number>`count(*)` })
        .from(clips).where(eq(clips.lang, prompt.lang));
      let test = counts?.test ?? 0, all = counts?.all ?? 0;
      const saved = cut.map((c) => {
        const split = test < (all + 1) * TEST_SHARE ? "test" : "train";
        if (split === "test") test++;
        all++;
        return {
          id: c.id, recordingId: rec.id, lang: prompt.lang, kind: prompt.kind, start: c.start, end: c.end, seconds: c.seconds,
          path16k: c.path_16k.replace(`${dataDir}/`, ""), path48k: c.path_48k.replace(`${dataDir}/`, ""),
          text: c.text, split: split as "train" | "test", unsure: false,
        };
      });
      if (saved.length) await db.insert(clips).values(saved);
      return { recordingId: rec.id, seconds: take.seconds, clips: saved.map(({ id, seconds, split, text }) => ({ id, seconds, split, text })) };
    },

    async deleteRecording(id: string) {
      const cs = await db.select().from(clips).where(eq(clips.recordingId, id));
      const [rec] = await db.select().from(recordings).where(eq(recordings.id, id));
      await db.delete(clips).where(eq(clips.recordingId, id));
      await db.delete(recordings).where(eq(recordings.id, id));
      for (const p of [...cs.flatMap((c) => [c.path16k, c.path48k]), rec?.path]) if (p) await Native.deleteFile(abs(p));
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
      const fuzzy = (s: any, l: string) => (Array.isArray(s?.[l]) ? s[l][1] : s?.[l]);
      return {
        id: r.id, name: r.name, base: r.base, status: r.status, stage: r.stage, bestStep: r.bestStep, bestScore: r.bestScore,
        costUsd: r.costUsd, createdAt: r.createdAt, cfg: r.cfg, steps,
        evals: ev.map((e) => ({ step: e.step, score: e.score, en: fuzzy(e.scores, "en"), hi: fuzzy(e.scores, "hi"), gu: fuzzy(e.scores, "gu") })),
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

    async fastModel(runId: string | null) {
      if (!runId) return null;
      const [m] = await db.select().from(models).where(and(eq(models.runId, runId), eq(models.format, "mlx")));
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

    async baselines(): Promise<Baseline[]> {
      return db.select().from(baselines);
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
          path_16k: abs(c.path16k), path_48k: c.path48k ? abs(c.path48k) : null,
        })),
        prompts: ps.map((p) => ({ id: p.id, lang: p.lang, roman: p.lines[0]!, native: p.nativeLines?.[0] ?? null })),
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
  };
}

export type Library = ReturnType<typeof createLibrary>;
