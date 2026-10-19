import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { keys } from "./blobs";
import { ACTIVE, type RunRow, type RunStatus, getRun, updateRun } from "./db";
import type { Ctx } from "./env";
import { type Runpod, runpod } from "./runpod";

export const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
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

/** Deletes a blob, logging rather than throwing: the reaper sweeps leftovers. */
export async function deleteBlob(ctx: Ctx, key: string, reason: string): Promise<boolean> {
  try {
    const deleted = await ctx.blobs.delete(key);
    if (deleted) console.log(JSON.stringify({ msg: "deleted blob", key, reason }));
    return deleted;
  } catch (e) {
    console.error(JSON.stringify({ msg: "blob delete failed", key, reason, error: String(e) }));
    return false;
  }
}

/**
 * Moves an active run to a terminal status, terminates its pod and deletes its dataset. Returns the updated
 * row, or the current row unchanged if the run had already finished.
 */
export async function finishRun(
  ctx: Ctx,
  row: RunRow,
  status: Extract<RunStatus, "done" | "failed" | "stopped">,
  opts: { error?: string | null; reason: string; extra?: Partial<RunRow>; now?: number; rp?: Runpod },
): Promise<RunRow> {
  const now = opts.now ?? Date.now();
  const changed = updateRun(ctx, row.id, { status, finished_at: now, error: opts.error ?? null, ...opts.extra }, ACTIVE);
  if (changed) {
    console.log(JSON.stringify({ msg: "run finished", runId: row.id, status, reason: opts.reason }));
    if (row.pod_id) await terminatePod(opts.rp ?? runpod(ctx.env), row.pod_id, `run ${row.id}: ${opts.reason}`);
    await deleteBlob(ctx, keys.dataset(row.id), `run ${status}`);
  }
  return getRun(ctx, row.id) ?? row;
}
