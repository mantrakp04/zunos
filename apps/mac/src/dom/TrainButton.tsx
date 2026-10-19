import { cn } from "@zunos/ui/lib/utils";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import type { LangStats } from "../shared/types";
import { Button, ENOUGH_SECONDS, FULL_SECONDS, langName, shortOf } from "./ui";

type Counts = Pick<LangStats, "lang" | "trainSeconds" | "testSeconds">;

/** How far the recordings are toward training: 0..1 across languages (each capped at a full set). */
export function trainProgress(stats: Counts[] | null) {
  if (!stats?.length) return { p: 0, short: [] as ReturnType<typeof shortOf>, ready: false, full: false };
  const per = stats.map((s) => Math.min(1, (s.trainSeconds + s.testSeconds) / FULL_SECONDS));
  const short = shortOf(stats);
  return { p: per.reduce((x, y) => x + y, 0) / per.length, short, ready: short.length === 0, full: per.every((x) => x >= 1) };
}

// Asked once per session: after "Train now" between the minimum and a full set, don't ask again.
let confirmedEarly = false;

/**
 * Start training, as a progress bar: the fill is how much of a full set (10 min per language) is
 * recorded. Muted and disabled until every language has the 5-minute minimum, ember from there, and
 * marked complete at a full set. Between the two, a click asks first: more recording still helps.
 */
export function TrainButton({ stats, onTrain, busy, blocked, size = "md", className }: {
  /** One entry per enabled language (zeroes for languages with nothing recorded). */
  stats: Counts[] | null;
  onTrain: () => void;
  busy?: boolean;
  /** Another reason it can't start right now (no GPU, a run in flight), shown as the tooltip. */
  blocked?: string | null;
  size?: "md" | "lg";
  className?: string;
}) {
  const { p, short, ready, full } = trainProgress(stats);
  const [asking, setAsking] = useState(false);
  const disabled = !ready || !!blocked || busy || !stats;
  const why =
    blocked ??
    (!stats
      ? "Counting your recordings…"
      : short.length
        ? short.map((s) => `${langName(s.lang)} needs ${(s.need / 60).toFixed(1)} more min`).join("\n")
        : full
          ? "A full set in every language."
          : `Every language has the ${ENOUGH_SECONDS / 60}-minute minimum. More makes a better model.`);
  const go = () => {
    if (disabled) return;
    if (!full && !confirmedEarly) setAsking(true);
    else onTrain();
  };

  const label = (
    <span className="relative flex items-center justify-center gap-2">
      {busy ? <Loader2 className="size-4 animate-spin" /> : full ? <Check className="size-4" strokeWidth={3} /> : null}
      <span className="truncate">Start training</span>
      {!busy && ready && <ArrowRight className="size-4 shrink-0" />}
      {!ready && stats && <span className="font-mono text-[11px] font-semibold tabular-nums opacity-70">{Math.floor(p * 100)}%</span>}
    </span>
  );

  return (
    <>
      <button
        type="button"
        title={why}
        aria-disabled={disabled}
        onClick={go}
        className={cn(
          "group relative isolate overflow-hidden rounded-full font-semibold whitespace-nowrap transition-[transform,box-shadow] duration-200 select-none",
          size === "lg" ? "h-12 min-w-[13rem] px-6 text-[15px]" : "h-9 min-w-[10.5rem] px-4 text-[13px]",
          disabled ? "cursor-default" : "active:translate-y-px",
          ready ? "shadow-[0_8px_22px_-10px_rgb(243_74_45/0.7)]" : "shadow-[inset_0_0_0_1px_var(--border)]",
          className,
        )}
      >
        {/* The track, and the fill across it. */}
        <span className={cn("absolute inset-0 -z-10 transition-colors duration-500", ready ? "bg-brand/25" : "bg-foreground/[0.06]")} />
        <motion.span
          className={cn(
            "absolute inset-y-0 left-0 -z-10 transition-[background] duration-500",
            full
              ? "bg-[linear-gradient(90deg,var(--brand),var(--brand-gold))]"
              : ready
                ? "bg-[linear-gradient(180deg,#ff6a48,var(--brand)_60%,var(--brand-deep))]"
                : "bg-foreground/[0.16]",
          )}
          initial={false}
          animate={{ width: `${p * 100}%` }}
          transition={{ type: "spring", stiffness: 70, damping: 20 }}
        />
        {full && <span className="zn-train-sheen absolute inset-0 -z-10" />}
        {/* The label twice: dark over the track, light over the fill, split at the fill's edge. */}
        <span className={cn(ready ? "text-brand-deep dark:text-brand-cream" : "text-muted-foreground")}>{label}</span>
        <motion.span
          aria-hidden
          className={cn("absolute inset-0 flex items-center justify-center px-[inherit]", ready ? "text-white" : "text-foreground")}
          initial={false}
          animate={{ clipPath: `inset(0 ${100 - p * 100}% 0 0)` }}
          transition={{ type: "spring", stiffness: 70, damping: 20 }}
        >
          {label}
        </motion.span>
      </button>
      {/* Fixed to the window: the screen it's in has no transform at rest. */}
      <AnimatePresence>
        {asking && (
          <ConfirmEarly
            onKeep={() => setAsking(false)}
            onTrain={() => {
              confirmedEarly = true;
              setAsking(false);
              onTrain();
            }}
          />
        )}
      </AnimatePresence>
      <style>{`
        @keyframes zn-train-sheen { from { transform: translateX(-100%) } to { transform: translateX(100%) } }
        .zn-train-sheen { background: linear-gradient(100deg, transparent 35%, rgb(255 255 255 / 0.28) 50%, transparent 65%); animation: zn-train-sheen 2.8s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .zn-train-sheen { animation: none } }
      `}</style>
    </>
  );
}

/** Between the minimum and a full set: train now, or keep recording. */
function ConfirmEarly({ onKeep, onTrain }: { onKeep: () => void; onTrain: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onKeep());
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onKeep]);
  return (
    <motion.div
      className="fixed inset-0 z-50 grid place-items-center bg-[rgb(30_14_10/0.4)] p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onClick={onKeep}
    >
      <motion.div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="zn-train-early"
        initial={{ opacity: 0, y: 10, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[24rem] rounded-[22px] bg-popover p-6 text-popover-foreground shadow-[0_0_0_1px_var(--border),0_24px_60px_-20px_rgb(40_16_10/0.5)]"
      >
        <h2 id="zn-train-early" className="font-display text-[20px] leading-tight font-semibold tracking-[-0.01em]">
          You can train now
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
          Every language has the {ENOUGH_SECONDS / 60}-minute minimum. Recording more, up to {FULL_SECONDS / 60} minutes each, makes a better model.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onKeep}>
            Keep recording
          </Button>
          <Button autoFocus variant="brand" onClick={onTrain}>
            Train now
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
