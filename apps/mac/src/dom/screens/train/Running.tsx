import { cn } from "@zunos/ui/lib/utils";
import { motion } from "motion/react";

import { Bean } from "../../Bean";
import { Eyebrow, Meter } from "../../ui";

/** The test in progress: the bean listens while each held-back clip turns into a filled tile. */
export function Running({ done, total, ids }: { done: number; total: number; ids?: string[] }) {
  const scoring = total > 0 && done >= total;
  const current = Math.min(done + 1, total);
  return (
    <section className="py-2">
      <div className="relative flex items-center gap-6">
        <Bean mood="thinking" size={56} className="-my-2 shrink-0" />
        <div className="min-w-0 flex-1">
          <Eyebrow>Running the test</Eyebrow>
          <h2 className="mt-1 font-display text-[20px] leading-tight font-semibold tracking-[-0.02em]">
            {total === 0 ? "Getting the model ready…" : scoring ? "Scoring every word…" : `Listening to clip ${current} of ${total}`}
          </h2>
        </div>
        <div className="shrink-0 font-display leading-none font-semibold tracking-[-0.04em] whitespace-nowrap tabular-nums">
          <span className="text-[40px]">{done}</span>
          <span className="text-[20px] text-muted-foreground">/{total}</span>
        </div>
      </div>

      <div className="relative mt-7 flex flex-wrap gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <Tile key={i} state={i < done ? "done" : i === done ? "now" : "todo"} title={ids?.[i]} index={i} />
        ))}
      </div>
      <Meter className="relative mt-6" value={total ? done / total : 0} />
    </section>
  );
}

// Bar heights for each tile's little waveform: stable per index, speech-like.
const bars = (i: number) => Array.from({ length: 5 }, (_, b) => 0.3 + 0.7 * Math.abs(Math.sin(i * 12.9898 + b * 78.233) * 0.5 + Math.sin(i * 3.1 + b * 1.7) * 0.5));

function Tile({ state, title, index }: { state: "done" | "now" | "todo"; title?: string; index: number }) {
  const hs = bars(index);
  return (
    <motion.div
      title={title}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.025, 0.6), duration: 0.3 }}
      className={cn(
        "relative flex h-14 max-w-14 min-w-8 flex-1 items-center justify-center gap-[3px] overflow-hidden rounded-[10px] transition-[background-color,box-shadow] duration-300",
        state === "todo" && "bg-foreground/[0.045] shadow-[inset_0_0_0_1px_var(--border)]",
        state === "now" && "bg-card shadow-[0_0_0_1.5px_var(--brand),0_8px_20px_-8px_rgb(243_74_45/0.7)]",
        state === "done" && "bg-[linear-gradient(180deg,#ff6a4a,var(--brand)_55%,var(--brand-deep))] shadow-[inset_0_1px_0_rgb(255_255_255/0.3)]",
      )}
    >
      {hs.map((h, b) =>
        state === "now" ? (
          <motion.span
            key={b}
            className="block w-[3px] rounded-full bg-brand"
            animate={{ height: [`${h * 30}%`, `${h * 70}%`, `${h * 40}%`, `${h * 60}%`, `${h * 30}%`] }}
            transition={{ duration: 0.8 + b * 0.07, repeat: Infinity, ease: "easeInOut" }}
          />
        ) : (
          <motion.span
            key={b}
            className={cn("block w-[3px] rounded-full", state === "done" ? "bg-white/90" : "bg-foreground/15")}
            initial={false}
            animate={{ height: `${h * (state === "done" ? 55 : 32)}%` }}
            transition={{ type: "spring", stiffness: 380, damping: 18, delay: b * 0.03 }}
          />
        ),
      )}
    </motion.div>
  );
}
