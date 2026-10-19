import { cn } from "@zunos/ui/lib/utils";
import { ChevronDown, CloudOff, Cpu, Hourglass, Square } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import type { LangStats, RunSummary } from "../../../shared/types";
import { TrainButton } from "../../TrainButton";
import { Button, ENOUGH_SECONDS, ErrorNote, Eyebrow, langName, minutes } from "../../ui";
import type { QuoteInfo } from "./Pipeline";

/** "$1,234.56": dollars with cents and thousands separators. */
export const money = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The next model as one line you can act on: the GPU, about what it costs and for how long, and Start
 * training (which fills as you record and opens once every language has its minimum).
 */
export function StartRow({ quote, quoteError, loading, blocked, counts, onRecord, busy, error, onStart }: {
  quote: QuoteInfo | null;
  quoteError: string | null;
  loading: boolean;
  blocked: boolean;
  /** One entry per enabled language, or null while they're being counted. */
  counts: Pick<LangStats, "lang" | "trainSeconds" | "testSeconds">[] | null;
  onRecord?: () => void;
  busy: boolean;
  error: string | null;
  onStart: () => void;
}) {
  if (!quote && loading)
    return (
      <Row>
        <div className="flex flex-col gap-2">
          <div className="zt-skel h-3 w-28 rounded-full" />
          <div className="zt-skel h-8 w-40 rounded-lg" />
        </div>
        <div className="zt-skel h-12 w-[13rem] rounded-full" />
      </Row>
    );

  if (!quote)
    return (
      <div className="flex items-start gap-2.5 py-1">
        <CloudOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">Cloud training isn't available</div>
          {quoteError && <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted-foreground select-text [overflow-wrap:anywhere]">{quoteError}</p>}
        </div>
      </div>
    );

  const total = quote.pricePerHour * quote.estimatedHours;
  const short = counts ? counts.filter((c) => c.trainSeconds + c.testSeconds < ENOUGH_SECONDS) : [];
  return (
    <div>
      <Row>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
            <Cpu className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate" title={quote.gpu}>
              {quote.gpu}
            </span>
            {quote.base && (
              <span className="min-w-0 truncate" title={quote.base}>
                · {quote.base}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="flex items-baseline gap-1.5">
              <span className="text-[13px] text-muted-foreground">about</span>
              <span className="font-display text-[40px] leading-none font-bold tracking-[-0.03em] whitespace-nowrap tabular-nums">{money(total)}</span>
            </span>
            <span className="text-[13px] whitespace-nowrap tabular-nums text-muted-foreground">
              {quote.estimatedHours.toFixed(1)} h × {money(quote.pricePerHour)}/h
            </span>
          </div>
        </div>
        <TrainButton
          size="lg"
          stats={counts}
          busy={busy}
          blocked={blocked ? "One model at a time. This one's still going." : !quote.available ? (quote.reason ?? "No GPU is free right now.") : null}
          onTrain={onStart}
        />
      </Row>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        {!quote.available && (
          <span className="flex min-w-0 items-center gap-1.5">
            <Hourglass className="size-3.5 shrink-0 text-warn" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{quote.reason ?? "No GPU is free right now. Try again in a bit."}</span>
          </span>
        )}
        {short.length > 0 && onRecord && (
          <button
            type="button"
            onClick={onRecord}
            title={short.map((s) => `${langName(s.lang)}: ${minutes(ENOUGH_SECONDS - s.trainSeconds - s.testSeconds)} to go`).join("\n")}
            className="font-medium text-foreground/75 underline-offset-2 hover:text-brand hover:underline"
          >
            Record more
          </button>
        )}
      </div>
      <ErrorNote error={error} className="mt-2" />
    </div>
  );
}

/** While a run is in flight: what it has cost so far, and the stop button. */
export function LiveRow({ run, local, busy, error, onStop }: { run: RunSummary | null; local: "before" | "after" | null; busy: boolean; error: string | null; onStop: () => void }) {
  const canStop = !!run && ["queued", "running"].includes(run.status);
  return (
    <div>
      <Row>
        <div className="min-w-0">
          <Eyebrow>{run?.costUsd == null && local === "after" ? "Cloud GPU" : "Spent so far"}</Eyebrow>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-display text-[40px] leading-none font-bold tracking-[-0.03em] whitespace-nowrap tabular-nums">
              {run?.costUsd != null ? money(run.costUsd) : local === "after" ? "Released" : "$0.00"}
            </span>
            <span className="text-[13px] text-muted-foreground">{run ? `started ${since(run.createdAt)}` : local === "after" ? "nothing more is billed" : "no GPU rented yet"}</span>
          </div>
        </div>
        {canStop && (
          <Button variant="outline" className="text-destructive" loading={busy} onClick={onStop}>
            <Square className="size-3 fill-current" />
            Stop and release the GPU
          </Button>
        )}
      </Row>
      <ErrorNote error={error} className="mt-2" />
    </div>
  );
}

/** Label and figures on the left, the action on the right; the action drops below when it's narrow. */
function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">{children}</div>;
}

export function since(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = m / 60;
  return h < 24 ? `${h.toFixed(1)} h ago` : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// With many languages the list starts folded to the first few.
const FOLD_AFTER = 8;
const FOLDED = 5;

/** What goes into the next model: per language, the clips it trains on and the ones held back to test it. */
export function DataStory({ stats, colorOf }: { stats: LangStats[]; colorOf: (lang: string) => string }) {
  const [all, setAll] = useState(false);
  const folds = stats.length > FOLD_AFTER;
  const shown = folds && !all ? stats.slice(0, FOLDED) : stats;
  const max = Math.max(1, ...stats.map((s) => s.trainSeconds + s.testSeconds));
  return (
    <div className="@container/data">
      <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5">
        <Eyebrow>What goes into the next model</Eyebrow>
        <div className="flex items-center gap-4 text-[11.5px] text-muted-foreground">
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="h-2 w-3.5 rounded-[3px] bg-foreground/60" /> Trains it
          </span>
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="zt-hatch h-2 w-3.5 rounded-[3px] text-foreground/45 shadow-[inset_0_0_0_1px_currentColor]" /> Held back to test it
          </span>
        </div>
      </div>
      <div className="grid gap-2.5">
        {shown.map((s, i) => {
          const c = colorOf(s.lang);
          // Rows revealed by "show all" come in together instead of one by one down a long list.
          const delay = Math.min(i, 6) * 0.06;
          return (
            <div key={s.lang} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-4 @max-[42rem]/data:gap-3">
              <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium" title={langName(s.lang)}>
                <span className="size-2 shrink-0 rounded-full" style={{ background: c }} />
                <span className="truncate">{langName(s.lang)}</span>
              </span>
              <div className="flex h-2.5 min-w-0 items-stretch gap-[2px]">
                <motion.div
                  className="rounded-l-[4px]"
                  style={{ background: c }}
                  initial={{ width: 0 }}
                  animate={{ width: `${(s.trainSeconds / max) * 100}%` }}
                  transition={{ type: "spring", stiffness: 70, damping: 18, delay: 0.1 + delay }}
                />
                <motion.div
                  className="zt-hatch rounded-r-[4px] opacity-70"
                  style={{ color: c, boxShadow: `inset 0 0 0 1px ${c}` }}
                  initial={{ width: 0 }}
                  animate={{ width: `${(s.testSeconds / max) * 100}%` }}
                  transition={{ type: "spring", stiffness: 70, damping: 18, delay: 0.18 + delay }}
                />
              </div>
              {/* Sized to its text, so it never clips; narrow, just trained + held back. */}
              <span
                title={`${minutes(s.trainSeconds)} in ${s.trainClips.toLocaleString("en-US")} clips trains it; ${minutes(s.testSeconds)} is held back to test it`}
                className="text-right text-[12.5px] whitespace-nowrap tabular-nums text-muted-foreground"
              >
                <span className="font-medium text-foreground">{minutes(s.trainSeconds)}</span>
                <span className="@max-[42rem]/data:hidden">
                  {" "}· {s.trainClips.toLocaleString("en-US")} clips
                  <span className="mx-1.5 text-foreground/20">|</span>
                  {minutes(s.testSeconds)} held back
                </span>
                <span className="hidden @max-[42rem]/data:inline"> + {minutes(s.testSeconds)}</span>
              </span>
            </div>
          );
        })}
      </div>
      {folds && (
        <button
          onClick={() => setAll((a) => !a)}
          aria-expanded={all}
          className="mt-2.5 -ml-2.5 flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", all && "rotate-180")} />
          {all ? "Show fewer" : `Show all ${stats.length} languages`}
        </button>
      )}
    </div>
  );
}
