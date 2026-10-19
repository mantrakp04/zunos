// Background-noise cleaning of finished takes, off the save path. A take is saved and cut into its raw
// clips at once (library.saveRecording); this queue then cleans one take at a time on an engine background
// thread (python/engine enhance.py: measure, denoise at a strength set by the SNR, guardrails), cuts the
// voice-cloning copies of its clips from the cleaned take, and stores the take's quality verdict.
//
// A take still waiting has recordings.quality = { status: "pending", ... } (the recorder's facts, needed
// for the verdict) or null; both are picked up again at the next launch.
import { schema } from "@zunos/db";
import { asc, eq, sql } from "drizzle-orm";

import type { MicStats } from "../../modules/zunos-native";
import type { AudioMeasure, CleaningState, LiveState, MicDeviceInfo, TakeQuality, TakeQualityItem } from "../shared/types";
import * as corpus from "./corpus";
import { abs, dataDir, type Db } from "./db";
import * as engine from "./engine";
import { deviceChangedIssue, takeVerdict } from "./quality";

const { clips, prompts, recordings } = schema;

const MODELS_DIR = `${dataDir}/models`;

/** What the recorder knew about a take, kept until the take is cleaned. */
export type PendingQuality = {
  status: "pending"; device: MicDeviceInfo | null; deviceChanged: boolean; live: MicStats | null;
  /** Seconds of room tone at the start of the take. */
  room: number;
};

type EnhanceResult = {
  path: string | null; raw: AudioMeasure & { silent?: boolean }; clean: AudioMeasure | null; strength: number; wanted: number;
  reason: NonNullable<TakeQuality["cleaning"]>["reason"]; tried: NonNullable<TakeQuality["cleaning"]>["tried"];
  clips?: { id: string; path: string; quality: Record<string, unknown> | null }[];
};

type SetLive = (patch: Partial<LiveState> | ((s: LiveState) => Partial<LiveState>)) => void;

export const isPending = (q: unknown): boolean => q == null || (q as { status?: string }).status === "pending";

export function createCleaning(db: Db, setLive: SetLive) {
  const queue: string[] = [];
  let running = false;
  let models: Promise<unknown> | null = null;

  const publish = (current: CleaningState["current"], latest?: TakeQualityItem) =>
    setLive((s) => ({
      cleaning: { pending: queue.length + (running ? 1 : 0), current, latest: latest ?? s.cleaning.latest },
      ...(latest ? { qualityVersion: s.qualityVersion + 1 } : {}),
    }));

  /** Fetches the denoiser and the Whisper-base check model (about 160 MB) once, in the background. */
  function prefetch() {
    models ??= engine.call<{ denoiser: boolean; asr: boolean }>("enhance_status", { dir: MODELS_DIR })
      .then((s) => (s.denoiser && s.asr ? s : engine.call("enhance_download", { dir: MODELS_DIR })))
      .catch(() => (models = null)); // offline: cleaning fetches them itself, or skips the check
    return models;
  }

  async function clean(id: string): Promise<TakeQualityItem | null> {
    const [r] = await db.select().from(recordings).where(eq(recordings.id, id));
    if (!r || !isPending(r.quality)) return null;
    const facts = (r.quality ?? { status: "pending", device: null, deviceChanged: false, live: null, room: 0 }) as PendingQuality;
    const [prompt] = r.promptId ? await db.select().from(prompts).where(eq(prompts.id, r.promptId)) : [];
    const { lines } = prompt ? corpus.takeLines(prompt, r.script) : { lines: null };
    const cut = await db.select({ id: clips.id, start: clips.start, end: clips.end }).from(clips).where(eq(clips.recordingId, id));
    await models?.catch(() => {});

    const cleanRel = `audio/recordings-clean/${id}.wav`;
    let enh: EnhanceResult | null = null;
    publish({ recordingId: id, phase: "measuring", progress: 0 });
    try {
      enh = await engine.call<EnhanceResult>("enhance", {
        path: abs(r.path), out: abs(cleanRel), dir: MODELS_DIR, lang: r.lang, lines, marks: r.marks, room: facts.room ? [0, facts.room] : null,
        clips: cut.filter((c) => c.start != null && c.end != null), clip_dir: `${dataDir}/audio/clips/48k-clean`,
      }, (event, data) => {
        if (event === "progress" && data.phase !== "done") publish({ recordingId: id, phase: data.phase, progress: data.progress });
      });
    } catch (e) {
      console.warn(`zunos: cleaning ${id} failed`, e);
    }
    const raw = enh && !enh.raw.silent ? enh.raw : null;
    const verdict = takeVerdict(raw, facts.live ?? undefined, facts.device);
    if (facts.deviceChanged) {
      verdict.issues.unshift(deviceChangedIssue());
      verdict.verdict = "redo";
    }
    const quality: TakeQuality = {
      ...verdict, device: facts.device, raw, clean: enh?.clean ?? null,
      cleaning: enh ? { strength: enh.strength, wanted: enh.wanted, reason: enh.reason, tried: enh.tried ?? [] }
        : { strength: 0, wanted: 0, reason: "failed", tried: [] },
    };
    await db.update(recordings).set({ cleanPath: enh?.path ? cleanRel : null, quality }).where(eq(recordings.id, id));
    for (const c of enh?.clips ?? [])
      await db.update(clips).set({ path48kClean: c.path.replace(`${dataDir}/`, ""), quality: c.quality }).where(eq(clips.id, c.id));
    return { recordingId: id, promptId: r.promptId, lang: r.lang, recordedAt: r.recordedAt, quality };
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const id = queue.shift()!;
        publish({ recordingId: id, phase: "measuring", progress: 0 });
        const done = await clean(id).catch((e) => (console.warn(`zunos: cleaning ${id} failed`, e), null));
        publish(null, done ?? undefined);
      }
    } finally {
      running = false;
      publish(null);
    }
  }

  return {
    prefetch,
    /** Cleans this take after the ones already waiting. Returns at once. */
    enqueue(id: string) {
      if (!queue.includes(id)) queue.push(id);
      publish(null);
      void drain();
    },
    /** At launch: fetch the models and pick up takes a quit or crash left uncleaned. */
    async start() {
      void prefetch();
      const rows = await db.select({ id: recordings.id }).from(recordings)
        .where(sql`${recordings.quality} is null or json_extract(${recordings.quality}, '$.status') = 'pending'`)
        .orderBy(asc(recordings.recordedAt));
      for (const { id } of rows) this.enqueue(id);
    },
    /** Every take's quality, newest first (quality null: still being cleaned). For badges on takes and languages. */
    async qualities(lang?: string): Promise<TakeQualityItem[]> {
      const rows = await db.select({ id: recordings.id, promptId: recordings.promptId, lang: recordings.lang, recordedAt: recordings.recordedAt, quality: recordings.quality })
        .from(recordings).where(lang ? eq(recordings.lang, lang) : undefined).orderBy(sql`${recordings.recordedAt} desc`);
      return rows.map((r) => ({
        recordingId: r.id, promptId: r.promptId, lang: r.lang, recordedAt: r.recordedAt,
        quality: isPending(r.quality) ? null : (r.quality as TakeQuality),
      }));
    },
  };
}

export type Cleaning = ReturnType<typeof createCleaning>;
