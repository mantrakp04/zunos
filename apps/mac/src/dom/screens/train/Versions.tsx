import { cn } from "@zunos/ui/lib/utils";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import type { RunDetail, RunSummary } from "../../../shared/types";
import { pct } from "../../ui";
import { Sparkline } from "./LineChart";

export const isActive = (r: RunSummary) => ["uploading", "queued", "running"].includes(r.status);

/** "openai/whisper-large-v3-turbo" → "large-v3 turbo"; another run's id → "from v3a". */
export function baseLabel(base: string, runs: RunSummary[]) {
  const parent = runs.find((r) => r.id === base || r.name === base);
  if (parent) return { text: `from ${parent.name}`, branch: true };
  const short = base.replace(/^.*\//, "").replace(/^whisper-/, "").replace(/-turbo$/, " turbo");
  return { text: short, branch: false };
}

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const SHOWN = 8;

/**
 * Every version, newest first: one row each, picked to see how it learned and how it tests. Plain rows
 * on the page; the picked one sits on a soft wash.
 */
export function Versions({ runs, details, selected, onSelect, bestId, inUse, installed, referenceAvg }: {
  runs: RunSummary[];
  details: Record<string, RunDetail | null>;
  selected: string | null;
  onSelect: (id: string) => void;
  bestId: string | null;
  inUse: string | null;
  installed: Set<string>;
  referenceAvg: number | null;
}) {
  const [all, setAll] = useState(false);
  const newest = [...runs].sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
  // Folded, the picked version stays in the list even when it's older than the latest few.
  const shown = all || newest.length <= SHOWN ? newest : newest.filter((r, i) => i < SHOWN || r.id === selected);

  return (
    <div className="@container/versions">
      <div role="listbox" aria-label="Versions" className="flex flex-col gap-0.5">
        {shown.map((r) => {
          const on = r.id === selected;
          const live = isActive(r);
          const base = baseLabel(r.base, runs);
          const curve = (details[r.id]?.evals ?? []).filter((e) => e.step != null).map((e) => ({ x: e.step!, y: e.score }));
          const delta = r.bestScore != null && referenceAvg != null ? r.bestScore - referenceAvg : null;
          const state = live ? "Training" : inUse === r.id ? "In use" : installed.has(r.id) ? "On this Mac" : r.status === "failed" ? "Failed" : r.status === "cancelled" ? "Stopped" : null;
          return (
            <button
              key={r.id}
              role="option"
              aria-selected={on}
              onClick={() => onSelect(r.id)}
              className={cn(
                "group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-[12px] px-3 py-2.5 text-left transition-colors @min-[30rem]/versions:grid-cols-[minmax(0,1fr)_4.5rem_auto]",
                on ? "bg-foreground/[0.055]" : "hover:bg-foreground/[0.03]",
              )}
            >
              <span className="min-w-0">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 -translate-y-px rounded-full",
                      live ? "animate-pulse bg-brand" : inUse === r.id ? "bg-good" : r.status === "failed" ? "bg-warn" : "bg-foreground/25",
                    )}
                  />
                  <span title={r.name} className={cn("min-w-0 truncate font-display text-[16px] leading-tight font-semibold tracking-[-0.01em]", !on && "text-foreground/85")}>
                    {r.name}
                  </span>
                  {bestId === r.id && <span className="shrink-0 text-[11.5px] font-semibold text-brand">Best</span>}
                </span>
                <span className="mt-0.5 flex min-w-0 gap-1.5 pl-3.5 text-[11.5px] text-muted-foreground">
                  <span className="shrink-0 tabular-nums">{shortDate(r.createdAt)}</span>
                  <span className="min-w-0 truncate" title={base.text}>
                    · {base.text}
                  </span>
                  {state && <span className={cn("shrink-0", state === "In use" && "text-good", state === "Training" && "text-brand")}>· {state}</span>}
                </span>
              </span>
              <span className="hidden @min-[30rem]/versions:block">
                {curve.length >= 2 && <Sparkline points={curve} best={r.bestStep} className={on ? "text-foreground/55" : "text-foreground/30"} />}
              </span>
              <span className="text-right whitespace-nowrap tabular-nums">
                <span className="block font-display text-[15px] leading-tight font-semibold">{r.bestScore != null ? pct(r.bestScore) : "—"}</span>
                <span className={cn("block text-[11px]", delta != null && delta <= 0 ? "text-good" : "text-muted-foreground")}>
                  {delta != null ? `${delta <= 0 ? "−" : "+"}${Math.abs(delta * 100).toFixed(1)} vs ref` : r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : ""}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {newest.length > SHOWN && (
        <button
          onClick={() => setAll((a) => !a)}
          aria-expanded={all}
          className="mt-1 flex h-8 items-center gap-1 rounded-full px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", all && "rotate-180")} />
          {all ? "Show the latest" : `Show all ${newest.length}`}
        </button>
      )}
    </div>
  );
}
