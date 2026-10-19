import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HOUR, keys, presign } from "./blobs";
import type { Ctx } from "./env";
import { migrate } from "./migrations";

export type RunStatus = "uploading" | "queued" | "running" | "done" | "failed" | "stopped";
export const ACTIVE: RunStatus[] = ["uploading", "queued", "running"];
/** Statuses with a pod that is (or may be) billing. */
export const BILLING: RunStatus[] = ["queued", "running"];
export const FINISHED: RunStatus[] = ["done", "failed", "stopped"];

export type RunRow = {
  id: string;
  user_id: string;
  email: string;
  langs: string;
  status: RunStatus;
  stage: string | null;
  pod_id: string | null;
  gpu: string | null;
  price_per_hour: number | null;
  events_token_hash: string | null;
  evals: string;
  steps: string;
  logs: string;
  error: string | null;
  best_step: number | null;
  best_score: number | null;
  model_bytes: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  last_event_at: number | null;
};

export type RemoteRun = {
  id: string;
  status: RunStatus;
  stage: string | null;
  costUsd: number;
  evals: { step: number; score: number; res: Record<string, unknown> }[];
  steps: { step: number; loss: number }[];
  modelUrl: string | null;
  error: string | null;
};

/** Opens (creating if needed) the database file, or ":memory:", and brings its schema up to date. */
export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

export const getRun = (ctx: Ctx, id: string) =>
  ctx.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);

export const activeRunFor = (ctx: Ctx, userId: string) =>
  ctx.db
    .query<RunRow, [string]>(`SELECT * FROM runs WHERE user_id = ? AND status IN ('uploading','queued','running') LIMIT 1`)
    .get(userId);

export const runsWithStatus = (ctx: Ctx, statuses: RunStatus[]) =>
  ctx.db.query<RunRow, RunStatus[]>(`SELECT * FROM runs WHERE status IN (${placeholders(statuses.length)})`).all(...statuses);

export const billingRuns = (ctx: Ctx) => runsWithStatus(ctx, BILLING);

export function insertRun(ctx: Ctx, run: Pick<RunRow, "id" | "user_id" | "email" | "langs" | "created_at">) {
  ctx.db
    .query("INSERT INTO runs (id, user_id, email, langs, status, created_at) VALUES (?, ?, ?, ?, 'uploading', ?)")
    .run(run.id, run.user_id, run.email, run.langs, run.created_at);
}

type SqlValue = string | number | null;

/** Updates the given columns on a run, optionally only while its status is one of `onlyIf`. */
export function updateRun(ctx: Ctx, id: string, fields: Partial<RunRow>, onlyIf?: RunStatus[]): boolean {
  const cols = Object.keys(fields) as (keyof RunRow)[];
  if (!cols.length) return true;
  let sql = `UPDATE runs SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`;
  const args: SqlValue[] = [...cols.map((c) => (fields[c] ?? null) as SqlValue), id];
  if (onlyIf?.length) {
    sql += ` AND status IN (${placeholders(onlyIf.length)})`;
    args.push(...onlyIf);
  }
  return ctx.db.query(sql).run(...args).changes > 0;
}

/** price × hours between the pod starting and the run finishing (or now). */
export function costUsd(row: Pick<RunRow, "price_per_hour" | "started_at" | "finished_at">, now = Date.now()): number {
  if (!row.price_per_hour || row.started_at == null) return 0;
  const hours = Math.max(0, (row.finished_at ?? now) - row.started_at) / 3_600_000;
  return Math.round(row.price_per_hour * hours * 10_000) / 10_000;
}

export const parseJson = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export async function toRemoteRun(ctx: Ctx, row: RunRow, now = Date.now()): Promise<RemoteRun> {
  // The model is deleted 7 days after the run finishes; from then on there is nothing to download.
  const hasModel =
    row.status === "done" && !!ctx.env.BLOB_SIGNING_SECRET && !!(await ctx.blobs.head(keys.model(row.id)));
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    costUsd: costUsd(row, now),
    evals: parseJson(row.evals, []),
    steps: parseJson(row.steps, []),
    modelUrl: hasModel ? presign(ctx.env, keys.model(row.id), "GET", 24 * HOUR, now) : null,
    error: row.error,
  };
}
