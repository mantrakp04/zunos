import { ACTIVE, type RunRow, type RunStatus, getRun, updateRun } from "./db";
import type { Env } from "./env";
import { type Runpod, runpod } from "./runpod";

export function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Terminates a pod, logging the reason. Failures are logged, not thrown: the reaper retries orphans. */
export async function terminatePod(rp: Runpod, podId: string, reason: string): Promise<boolean> {
  try {
    await rp.terminatePod(podId);
    console.log(JSON.stringify({ msg: "terminated pod", podId, reason }));
    return true;
  } catch (e) {
    console.error(JSON.stringify({ msg: "terminate failed", podId, reason, error: String(e) }));
    return false;
  }
}

/**
 * Moves an active run to a terminal status and terminates its pod. Returns the updated row, or the
 * current row unchanged if the run had already finished.
 */
export async function finishRun(
  env: Env,
  row: RunRow,
  status: Extract<RunStatus, "done" | "failed" | "stopped">,
  opts: { error?: string | null; reason: string; extra?: Partial<RunRow>; now?: number; rp?: Runpod },
): Promise<RunRow> {
  const now = opts.now ?? Date.now();
  const changed = await updateRun(
    env,
    row.id,
    { status, finished_at: now, error: opts.error ?? null, ...opts.extra },
    ACTIVE,
  );
  if (changed) {
    console.log(JSON.stringify({ msg: "run finished", runId: row.id, status, reason: opts.reason }));
    if (row.pod_id) await terminatePod(opts.rp ?? runpod(env), row.pod_id, `run ${row.id}: ${opts.reason}`);
  }
  return (await getRun(env, row.id)) ?? row;
}
