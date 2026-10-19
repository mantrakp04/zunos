import { cn } from "@zunos/ui/lib/utils";
import { ChevronDown, CloudOff, Cpu, Hourglass, Mic, Square } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import type { LangStats, RunSummary, TrainingQuote } from "../../../shared/types";
import { Button, ENOUGH_SECONDS, ErrorNote, Eyebrow, langName, minutes } from "../../ui";

/** "$1,234.56": dollars with cents and thousands separators. */
export const money = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The right side of the hero when nothing is running: the price and the start button. */
export function StartPanel({
  quote,
  quoteError,
  loading,
  blocked,
  short,
  counting,
  onRecord,
  busy,
  error,
  onStart,
}: {
  quote: TrainingQuote | null;
  quoteError: string | null;
  loading: boolean;
  blocked: boolean;
  /** Enabled languages still under ENOUGH_SECONDS; training waits for them. */
  short: { lang: string; need: number }[];
  counting: boolean;
  onRecord?: () => void;
  busy: boolean;
  error: string | null;
  onStart: () => void;
}) {
  if (!quote && loading)
    return (
      <Panel>
        <div className="zt-skel h-3 w-24 rounded-full" />
        <div className="zt-skel mt-3 h-8 w-32 rounded-lg" />
        <div className="zt-skel mt-2 h-3 w-40 rounded-full" />
        <div className="zt-skel mt-5 h-11 w-full rounded-full" />
        <p className="mt-2 text-center text-[11.5px] text-muted-foreground">Checking GPU prices…</p>
      </Panel>
    );

  if (!quote)
    return (
      <Panel className="bg-foreground/[0.03]">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground/[0.06] text-muted-foreground">
            <CloudOff className="size-4" />
          </span>
          <div className="text-[13.5px] leading-snug font-semibold">Cloud training isn't available</div>
        </div>
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
          Your recordings are safe on this Mac. Once training is switched on, you can start a model from here.
        </p>
        {quoteError && <p className="mt-3 rounded-lg bg-foreground/[0.04] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground select-text">{quoteError}</p>}
      </Panel>
    );

  const total = quote.pricePerHour * quote.estimatedHours;
  return (
    <Panel>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 @3xl:block">
        <div className="min-w-0 max-w-full">
          <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground">
            <Cpu className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate" title={quote.gpu}>
              {quote.gpu}
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[12px] text-muted-foreground">about</span>
            <span className="font-display text-[36px] leading-none font-bold tracking-tight whitespace-nowrap tabular-nums">{money(total)}</span>
          </div>
          <div className="mt-1.5 text-[12px] whitespace-nowrap tabular-nums text-muted-foreground">
            {quote.estimatedHours.toFixed(1)} h × {money(quote.pricePerHour)}/h
          </div>
        </div>
        <Button variant="brand" size="lg" className="min-w-[13rem] @3xl:mt-4 @3xl:w-full" disabled={!quote.available || blocked || counting || short.length > 0} loading={busy} onClick={onStart}>
          Start training
        </Button>
      </div>
      {blocked && <p className="mt-2 text-center text-[11.5px] text-muted-foreground">One model at a time. This one's still going.</p>}
      {short.length > 0 && <ShortNote short={short} onRecord={onRecord} />}
      {!quote.available && (
        <p className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-snug text-muted-foreground">
          <Hourglass className="mt-0.5 size-3.5 shrink-0 text-warn" />
          {quote.reason ?? "No GPU is free within the budget right now. Try again in a bit."}
        </p>
      )}
      <ErrorNote error={error} className="mt-3" />
    </Panel>
  );
}

/** The right side of the hero while a run is in flight: money spent so far and the stop button. */
export function LivePanel({ run, local, busy, error, onStop }: { run: RunSummary | null; local: "before" | "after" | null; busy: boolean; error: string | null; onStop: () => void }) {
  const canStop = !!run && ["queued", "running"].includes(run.status);
  return (
    <Panel>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 @3xl:block">
        <div className="min-w-0">
          <Eyebrow>{run?.costUsd == null && local === "after" ? "Cloud GPU" : "Spent so far"}</Eyebrow>
          <div className="mt-2 font-display text-[36px] leading-none font-bold tracking-tight whitespace-nowrap tabular-nums">
            {run?.costUsd != null ? money(run.costUsd) : local === "after" ? "Released" : "$0.00"}
          </div>
          <div className="mt-1.5 text-[12px] text-muted-foreground">
            {run ? `Started ${since(run.createdAt)}` : local === "after" ? "Nothing more is billed" : "No GPU rented yet"}
          </div>
        </div>
        {canStop && (
          <Button variant="outline" className="text-destructive @3xl:mt-4 @3xl:w-full" loading={busy} onClick={onStop}>
            <Square className="size-3 fill-current" />
            Stop and release the GPU
          </Button>
        )}
      </div>
      <ErrorNote error={error} className="mt-3" />
    </Panel>
  );
}

/** Which languages still need recording before training can start, and a way to go record them. */
function ShortNote({ short, onRecord }: { short: { lang: string; need: number }[]; onRecord?: () => void }) {
  const line = (s: { lang: string; need: number }) => `${langName(s.lang)} needs ${minutes(s.need)} more`;
  const all = short.map(line).join("\n");
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 @3xl:block">
      <p title={all} className="flex min-w-0 items-start gap-1.5 text-[12px] leading-snug text-muted-foreground">
        <Mic className="mt-0.5 size-3.5 shrink-0 text-warn" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {short.length > 2 ? `${short.length} languages need more recording.` : `${short.map(line).join(". ")}.`} Each needs {ENOUGH_SECONDS / 60} min; more makes a
          better model.
        </span>
      </p>
      {onRecord && (
        <Button variant="soft" size="sm" className="@3xl:mt-2.5 @3xl:w-full" onClick={onRecord}>
          Record more
        </Button>
      )}
    </div>
  );
}

function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("w-full rounded-[18px] bg-background/70 p-4 shadow-[0_0_0_1px_var(--border)] @3xl:w-[17.5rem]", className)}>{children}</div>;
}

export function since(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = m / 60;
  return h < 24 ? `${h.toFixed(1)} h ago` : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// With many languages the list starts folded to the first few, so the hero stays a hero.
const FOLD_AFTER = 8;
const FOLDED = 5;

/** What goes into the next model: per language, the clips it trains on and the ones it never sees. */
export function DataStory({ stats, colorOf }: { stats: LangStats[]; colorOf: (lang: string) => string }) {
  const [all, setAll] = useState(false);
  const folds = stats.length > FOLD_AFTER;
  const shown = folds && !all ? stats.slice(0, FOLDED) : stats;
  const max = Math.max(1, ...stats.map((s) => s.trainSeconds + s.testSeconds));
  const train = stats.reduce((s, x) => s + x.trainSeconds, 0);
  const clips = stats.reduce((s, x) => s + x.trainClips, 0);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="flex items-baseline gap-2">
          <Eyebrow>What goes into the next model</Eyebrow>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-3.5 rounded-[3px] bg-foreground/60" /> Trains the model
          </span>
          <span className="flex items-center gap-1.5">
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
            <div key={s.lang} className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-4 @max-[36rem]:grid-cols-[6.5rem_1fr_auto] @max-[36rem]:gap-3">
              <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium" title={langName(s.lang)}>
                <span className="size-2 shrink-0 rounded-full" style={{ background: c }} />
                <span className="truncate">{langName(s.lang)}</span>
              </span>
              <div className="flex h-3 items-stretch gap-[2px]">
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
              {/* Narrow: just the minutes, trained + held back; the full breakdown is in the tooltip. */}
              <span
                title={`${minutes(s.trainSeconds)} in ${s.trainClips.toLocaleString("en-US")} clips trains it, ${minutes(s.testSeconds)} is held back to test it`}
                className="text-[12px] whitespace-nowrap tabular-nums text-muted-foreground"
              >
                <span className="font-medium text-foreground">{minutes(s.trainSeconds)}</span>
                <span className="@max-[36rem]:hidden">
                  {" "}· {s.trainClips.toLocaleString("en-US")} clips
                  <span className="mx-1.5 text-foreground/20">|</span>
                  {minutes(s.testSeconds)} held back
                </span>
                <span className="hidden @max-[36rem]:inline"> + {minutes(s.testSeconds)}</span>
              </span>
            </div>
          );
        })}
      </div>
      {folds && (
        <button
          onClick={() => setAll((a) => !a)}
          aria-expanded={all}
          className="mt-2.5 flex h-7 items-center gap-1 rounded-full px-2.5 -ml-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", all && "rotate-180")} />
          {all ? "Show fewer" : `Show all ${stats.length} languages`}
        </button>
      )}
      <p className="mt-3.5 text-[12px] leading-relaxed text-muted-foreground">
        {minutes(train)} of your voice in {clips.toLocaleString("en-US")} clips, plus thousands of new sentences read by your cloned voice. Held-back clips are never trained on, so
        the scores stay honest.
      </p>
    </div>
  );
}
