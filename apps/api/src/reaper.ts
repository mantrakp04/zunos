// Cron (every 5 minutes): stops anything that is costing money and shouldn't be.
import { committedHourly } from "./budget";
import { type RunRow, billingRuns } from "./db";
import { type Env, POD_PREFIX, settings } from "./env";
import { finishRun, terminatePod } from "./lifecycle";
import { type PodSummary, runpod } from "./runpod";

const MIN = 60_000;
export const STALL_MS = { queued: 45 * MIN, running: 30 * MIN };
/** An upload URL lives 1 hour; a run still "uploading" well after that was abandoned. */
export const UPLOAD_ABANDON_MS = 3 * 60 * MIN;

export type ReapReport = { failed: { runId: string; reason: string }[]; orphansTerminated: string[]; podsListed: boolean };

export async function reap(env: Env, now = Date.now()): Promise<ReapReport> {
  const s = settings(env);
  const rp = runpod(env);
  const report: ReapReport = { failed: [], orphansTerminated: [], podsListed: false };
  const kill = async (row: RunRow, reason: string, error: string) => {
    await finishRun(env, row, "failed", { error, reason, now, rp });
    report.failed.push({ runId: row.id, reason });
  };

  // Abandoned uploads (no pod, but they block the user's next run).
  const { results: stale } = await env.DB.prepare(`SELECT * FROM runs WHERE status = 'uploading' AND created_at < ?`)
    .bind(now - UPLOAD_ABANDON_MS)
    .all<RunRow>();
  for (const row of stale) await kill(row, "upload abandoned", "The recordings never finished uploading.");

  // Stalled or overlong runs.
  let active = await billingRuns(env);
  for (const row of active) {
    const last = row.last_event_at ?? row.started_at ?? row.created_at;
    const limit = row.status === "queued" ? STALL_MS.queued : STALL_MS.running;
    if (now - last > limit) {
      const mins = Math.round(limit / MIN);
      await kill(row, `no event for ${mins} min`, `The training machine stopped responding for ${mins} minutes.`);
    } else if (row.started_at && now - row.started_at > s.maxRunHours * 60 * MIN) {
      await kill(row, `over ${s.maxRunHours} h`, `Training hit the ${s.maxRunHours}-hour limit.`);
    }
  }
  active = await billingRuns(env);

  let pods: PodSummary[] = [];
  try {
    pods = await rp.listPods();
    report.podsListed = true;
  } catch (e) {
    console.error(JSON.stringify({ msg: "reaper: listPods failed", error: String(e) }));
  }
  const killed = new Set(report.failed.map((f) => f.runId));
  const killedPods = new Set<string>();
  const live = () => pods.filter((p) => !killedPods.has(p.id) && !killed.has(p.name.slice(POD_PREFIX.length)));

  // Over budget: stop the newest zunos runs until the account total fits. Other pods are never touched.
  let total = committedHourly(live(), active);
  const newestFirst = [...active].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
  for (const row of newestFirst) {
    if (total <= s.maxHourlyUsd + 1e-9) break;
    console.warn(JSON.stringify({ msg: "reaper: over budget", total, max: s.maxHourlyUsd, runId: row.id }));
    await kill(row, "over hourly budget", "Stopped to keep GPU spending within the hourly limit.");
    killed.add(row.id);
    if (row.pod_id) killedPods.add(row.pod_id);
    total = committedHourly(
      live(),
      active.filter((r) => !killed.has(r.id)),
    );
  }

  // Orphans: zunos pods with no active run (crashed start, missed terminate, run finished).
  if (report.podsListed) {
    active = await billingRuns(env);
    const keep = new Set(active.flatMap((r) => [r.id, r.pod_id ?? ""]));
    for (const pod of pods) {
      if (!pod.name.startsWith(POD_PREFIX) || pod.status === "TERMINATED" || killedPods.has(pod.id)) continue;
      if (keep.has(pod.id) || keep.has(pod.name.slice(POD_PREFIX.length))) continue;
      if (await terminatePod(rp, pod.id, `orphan ${pod.name} (no active run)`)) report.orphansTerminated.push(pod.id);
    }
  }

  if (report.failed.length || report.orphansTerminated.length) console.log(JSON.stringify({ msg: "reaper", ...report }));
  return report;
}
