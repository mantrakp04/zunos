import { cn } from "@zunos/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";

import { minutes } from "../../ui";
import type { Take } from "./model";

/** Where saved clips land: one token per clip, newest first, tagged train or test. */
export const TakeTray = memo(function TakeTray({ takes }: { takes: Take[] }) {
  const seconds = takes.reduce((s, t) => s + t.saved.seconds, 0);
  const clips = takes.reduce((s, t) => s + t.saved.clips.length, 0);
  const newest = takes[0]?.at;
  return (
    <div className="flex h-[76px] items-center gap-4">
      {takes.length ? (
        <>
          <div className="w-[118px] shrink-0">
            <div className="text-[10.5px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">This session</div>
            <div className="mt-1 font-display text-[17px] leading-tight font-semibold tabular-nums">{minutes(seconds)}</div>
            <div className="text-[11.5px] text-muted-foreground tabular-nums">
              {takes.length} take{takes.length === 1 ? "" : "s"} · {clips} clip{clips === 1 ? "" : "s"}
            </div>
          </div>
          <div className="rk-fade-x -my-2 flex min-w-0 flex-1 gap-2 overflow-x-auto py-2 pr-12 scrollbar-none">
            <AnimatePresence initial={false}>
              {takes.flatMap((t) =>
                t.saved.clips.map((c, i) => (
                  <motion.div
                    key={c.id + t.at}
                    layout="position"
                    initial={t.at === newest ? { opacity: 0, y: 18, scale: 0.9 } : false}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ type: "spring", stiffness: 420, damping: 30, delay: t.at === newest ? 0.12 + i * 0.07 : 0 }}
                    title={c.text}
                    className={cn(
                      "flex w-[196px] shrink-0 flex-col gap-1 rounded-[14px] bg-card px-3 py-2 shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(64_32_25/0.06)]",
                      t.at === newest && "shadow-[0_0_0_1px_color-mix(in_oklab,var(--brand-gold)_45%,transparent),0_6px_18px_-10px_rgb(246_165_60/0.6)]",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-px text-[10px] font-bold tracking-[0.06em] uppercase",
                          c.split === "test" ? "bg-brand-gold/20 text-[#a3630e] dark:text-brand-gold" : "bg-foreground/[0.07] text-muted-foreground",
                        )}
                        title={c.split === "test" ? "Held back to score the model, never trained on" : "Used for training"}
                      >
                        {c.split}
                      </span>
                      <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">{c.seconds.toFixed(1)} s</span>
                    </div>
                    <span dir="auto" className="truncate text-[12px] leading-snug">{c.text}</span>
                  </motion.div>
                )),
              )}
            </AnimatePresence>
          </div>
        </>
      ) : (
        <p className="max-w-[40rem] text-[12.5px] leading-relaxed text-muted-foreground">
          Every take is cut into one clip per line. About one in four clips is held back to test the model fairly, so it is never trained on.
        </p>
      )}
    </div>
  );
});
