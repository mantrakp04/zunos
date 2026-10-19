// The owner's rule: everything running on the Runpod account together stays under MAX_HOURLY_USD.
import { type RunRow, billingRuns } from "./db";
import { type Env, ESTIMATED_HOURS, type Settings, settings } from "./env";
import type { GpuOffer, PodSummary, Runpod } from "./runpod";

const LIVE_POD = (p: PodSummary) => p.status !== "TERMINATED" && p.status !== "EXITED";

/**
 * USD/hour already committed: every live pod on the account (zunos or not, using Runpod's own `cost`),
 * plus zunos runs whose pod doesn't show up in the listing yet (just created).
 */
export function committedHourly(pods: PodSummary[], runs: RunRow[]): number {
  const live = pods.filter(LIVE_POD);
  const listed = new Set(live.map((p) => p.id));
  const podCost = live.reduce((sum, p) => sum + p.costPerHour, 0);
  const unlisted = runs
    .filter((r) => !r.pod_id || !listed.has(r.pod_id))
    .reduce((sum, r) => sum + (r.price_per_hour ?? 0), 0);
  return podCost + unlisted;
}

export type Choice = {
  /** GPU types to try, in priority order, each in stock and within the remaining budget. */
  candidates: GpuOffer[];
  /** What to show in a quote: the first candidate, else the first configured type we know about. */
  display: GpuOffer | null;
  committed: number;
  remaining: number;
  reason?: string;
  code?: "no_capacity" | "over_budget";
};

export function choose(s: Settings, offers: GpuOffer[], committed: number): Choice {
  const remaining = Math.max(0, s.maxHourlyUsd - committed);
  const configured = s.gpuTypes
    .map((id) => offers.find((o) => o.id === id))
    .filter((o): o is GpuOffer => !!o);
  const inStock = configured.filter((o) => o.inStock);
  const candidates = inStock.filter((o) => o.pricePerHour <= remaining + 1e-9);
  const display = candidates[0] ?? inStock[0] ?? configured[0] ?? null;
  const base = { candidates, display, committed, remaining };
  if (candidates.length) return base;
  if (!inStock.length)
    return { ...base, code: "no_capacity", reason: "No training GPUs are free right now. Try again in a few minutes." };
  return {
    ...base,
    code: "over_budget",
    reason: "Training is at its spending limit right now because other runs are using the GPUs. Try again later.",
  };
}

/** Reads the catalog and the account's pods, then picks GPUs that fit. Throws RunpodError on API failure. */
export async function chooseGpu(env: Env, rp: Runpod): Promise<Choice> {
  const [offers, pods, runs] = await Promise.all([rp.listGpuOffers(), rp.listPods(), billingRuns(env)]);
  return choose(settings(env), offers, committedHourly(pods, runs));
}

export const quoteBody = (choice: Choice, override?: { available: false; reason: string }) => ({
  gpu: choice.display?.id ?? "",
  pricePerHour: choice.display?.pricePerHour ?? 0,
  estimatedHours: ESTIMATED_HOURS,
  available: override ? false : choice.candidates.length > 0,
  ...(override ? { reason: override.reason } : choice.reason ? { reason: choice.reason } : {}),
});
