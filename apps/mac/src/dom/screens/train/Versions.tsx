import { cn } from "@zunos/ui/lib/utils";
import { ArrowDownRight, ArrowUpRight, Crown, GitBranch, Laptop } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef } from "react";

import type { RunDetail, RunSummary } from "../../../shared/types";
import { pct } from "../../ui";
import { Sparkline } from "./LineChart";
import { TRACK } from "./Pipeline";

export const isActive = (r: RunSummary) => ["uploading", "queued", "running"].includes(r.status);

/** "openai/whisper-large-v3-turbo" → "large-v3 turbo"; another run's id → "from v3a". */
export function baseLabel(base: string, runs: RunSummary[]) {
  const parent = runs.find((r) => r.id === base || r.name === base);
  if (parent) return { text: `from ${parent.name}`, branch: true };
  const short = base.replace(/^.*\//, "").replace(/^whisper-/, "").replace(/-turbo$/, " turbo");
  return { text: short, branch: false };
}

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Your models as releases on a line, oldest on the left. Pick one to see its curves. */
export function Versions({
  runs,
  details,
  selected,
  onSelect,
  bestId,
  installed,
  referenceAvg,
}: {
  runs: RunSummary[];
  details: Record<string, RunDetail | null>;
  selected: string | null;
  onSelect: (id: string) => void;
  bestId: string | null;
  installed: Set<string>;
  referenceAvg: number | null;
}) {
  // Newest is on the right: start scrolled there when the row overflows.
  const scroller = useRef<HTMLDivElement>(null);
  const count = runs.length;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [count]);
  // Keep the picked card fully in view.
  useEffect(() => {
    const el = scroller.current;
    const card = el?.querySelector<HTMLElement>("[data-on]");
    if (!el || !card) return;
    // offsetLeft is inside the padded row; the 40px padding doubles as the edge fade.
    const l = card.offsetLeft;
    const r = card.offsetLeft + card.offsetWidth + 80 - el.clientWidth;
    if (el.scrollLeft > l) el.scrollTo({ left: l, behavior: "smooth" });
    else if (el.scrollLeft < r) el.scrollTo({ left: r, behavior: "smooth" });
  }, [selected]);
  const ordered = [...runs].reverse().sort((x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime());
  return (
    <div
      ref={scroller}
      className="scrollbar-none -mx-10 overflow-x-auto px-10 pt-1 pb-3 [mask-image:linear-gradient(90deg,transparent,#000_2.5rem,#000_calc(100%-2.5rem),transparent)]"
    >
      {/* 11rem per card, or the full width when they fit: cards share it instead of sizing to their content. */}
      <div className="relative flex gap-3" style={{ width: `max(100%, ${ordered.length * 11 + (ordered.length - 1) * 0.75}rem)` }}>
        {/* the timeline */}
        <div className="pointer-events-none absolute top-[22px] right-2 left-2 h-px bg-[linear-gradient(90deg,transparent,var(--border)_6%,var(--border)_94%,transparent)]" />
        {ordered.map((r, i) => {
          const on = r.id === selected;
          const live = isActive(r);
          const base = baseLabel(r.base, runs);
          const d = details[r.id];
          const curve = (d?.evals ?? []).filter((e) => e.step != null).map((e) => ({ x: e.step!, y: e.score }));
          const delta = r.bestScore != null && referenceAvg != null ? r.bestScore - referenceAvg : null;
          return (
            <motion.button
              key={r.id}
              onClick={() => onSelect(r.id)}
              data-on={on || undefined}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05, type: "spring", stiffness: 260, damping: 26 }}
              className={cn(
                "group relative flex min-w-0 flex-1 basis-0 flex-col rounded-[18px] p-4 pt-3 text-left transition-[background-color,box-shadow,transform] duration-200",
                on
                  ? "bg-card shadow-[0_0_0_1.5px_var(--brand),var(--elevate)]"
                  : "bg-card/60 shadow-[0_0_0_1px_var(--border)] hover:-translate-y-0.5 hover:bg-card hover:shadow-[0_0_0_1px_var(--input),var(--elevate)]",
              )}
            >
              <div className="mb-3 flex items-center gap-2">
                <span className="relative flex size-[15px] items-center justify-center">
                  {live && <span className="absolute inset-0 animate-ping rounded-full bg-brand/40" />}
                  <span
                    className={cn(
                      "relative size-[11px] rounded-full ring-[3px] ring-card",
                      live ? "bg-brand" : r.status === "failed" ? "bg-foreground/25" : on ? "bg-brand" : "bg-foreground/35",
                    )}
                  />
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground">{shortDate(r.createdAt)}</span>
                <span className="ml-auto flex items-center gap-1">
                  {bestId === r.id && (
                    <span className="flex h-5 items-center gap-1 rounded-full bg-[linear-gradient(180deg,var(--brand-gold),#e98f22)] px-2 text-[10.5px] font-bold text-brand-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.4)]">
                      <Crown className="size-3" strokeWidth={2.4} /> Best
                    </span>
                  )}
                  {installed.has(r.id) && (
                    <span title="Installed on this Mac" className="grid size-5 place-items-center rounded-full bg-good/14 text-good">
                      <Laptop className="size-3" />
                    </span>
                  )}
                </span>
              </div>

              <div className="flex items-baseline gap-2">
                <span className="font-display text-[26px] leading-none font-bold tracking-[-0.02em]">{r.name}</span>
                <span className="flex min-w-0 items-center gap-1 truncate text-[11.5px] text-muted-foreground">
                  {base.branch && <GitBranch className="size-3 shrink-0" />}
                  {base.text}
                </span>
              </div>

              {live ? (
                <div className="mt-3 flex flex-col gap-1">
                  <span className="text-[13px] font-semibold text-brand">{TRACK.find((t) => t.id === r.stage)?.title ?? "Starting"}</span>
                  <span className="text-[11.5px] tabular-nums text-muted-foreground">{r.costUsd != null ? `$${r.costUsd.toFixed(2)} so far` : "Getting a GPU"}</span>
                </div>
              ) : r.status === "failed" ? (
                <div className="mt-3 text-[12.5px] text-muted-foreground">Didn't finish</div>
              ) : (
                <div className="mt-3 flex flex-wrap items-end justify-between gap-x-2 gap-y-1.5">
                  <div>
                    <div className="font-display text-[22px] leading-none font-semibold tracking-tight tabular-nums">{pct(r.bestScore)}</div>
                    <div className="mt-1 text-[10.5px] whitespace-nowrap text-muted-foreground">avg WER{r.bestStep != null && ` · step ${r.bestStep}`}</div>
                  </div>
                  {delta != null && (
                    <span
                      title={`Reference averages ${pct(referenceAvg)} on the same clips. Fewer points is better.`}
                      className={cn(
                        "mb-0.5 flex shrink-0 flex-col items-end text-[11px] font-semibold tabular-nums",
                        delta <= 0 ? "text-good" : "text-muted-foreground",
                      )}
                    >
                      <span className="flex items-center gap-0.5">
                        {delta <= 0 ? <ArrowDownRight className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
                        {delta <= 0 ? "−" : "+"}
                        {Math.abs(delta * 100).toFixed(1)} pts
                      </span>
                      <span className="text-[10px] font-medium text-muted-foreground">vs reference</span>
                    </span>
                  )}
                </div>
              )}

              <Sparkline points={curve} best={r.bestStep} className={cn("mt-3", on ? "text-foreground/55" : "text-foreground/30")} />

              <div className="mt-2 flex items-center justify-between text-[10.5px] tabular-nums text-muted-foreground">
                <span>{r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : "cost not recorded"}</span>
                <span className="capitalize">{live ? "training" : r.status}</span>
              </div>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
