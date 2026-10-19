import type { Env } from "./env";
import { HOUR, keys, presign } from "./r2";

export type RunStatus = "uploading" | "queued" | "running" | "done" | "failed" | "stopped";
export const ACTIVE: RunStatus[] = ["uploading", "queued", "running"];
/** Statuses with a pod that is (or may be) billing. */
export const BILLING: RunStatus[] = ["queued", "running"];

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

export const getRun = (env: Env, id: string) =>
  env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<RunRow>();

export const activeRunFor = (env: Env, userId: string) =>
  env.DB.prepare(`SELECT * FROM runs WHERE user_id = ? AND status IN ('uploading','queued','running') LIMIT 1`)
    .bind(userId)
    .first<RunRow>();

export async function billingRuns(env: Env): Promise<RunRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM runs WHERE status IN ('queued','running')`).all<RunRow>();
  return results;
}

/** Updates the given columns on a run, optionally only while its status is one of `onlyIf`. */
export async function updateRun(env: Env, id: string, fields: Partial<RunRow>, onlyIf?: RunStatus[]): Promise<boolean> {
  const cols = Object.keys(fields) as (keyof RunRow)[];
  if (!cols.length) return true;
  let sql = `UPDATE runs SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`;
  const args: unknown[] = [...cols.map((c) => fields[c] ?? null), id];
  if (onlyIf?.length) {
    sql += ` AND status IN (${onlyIf.map(() => "?").join(",")})`;
    args.push(...onlyIf);
  }
  const res = await env.DB.prepare(sql)
    .bind(...args)
    .run();
  return (res.meta.changes ?? 0) > 0;
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

export async function toRemoteRun(env: Env, row: RunRow, now = Date.now()): Promise<RemoteRun> {
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    costUsd: costUsd(row, now),
    evals: parseJson(row.evals, []),
    steps: parseJson(row.steps, []),
    modelUrl: row.status === "done" ? await presign(env, keys.model(row.id), "GET", 24 * HOUR) : null,
    error: row.error,
  };
}
