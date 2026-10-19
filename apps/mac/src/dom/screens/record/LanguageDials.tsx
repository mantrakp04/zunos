import { cn } from "@zunos/ui/lib/utils";
import { Check } from "lucide-react";
import { motion } from "motion/react";
import { memo } from "react";

import type { Lang, LangStats, Language } from "../../../shared/types";
import { Ring, ScrollStrip } from "../../ui";
import { GOAL_SECONDS, PLENTY_SECONDS } from "./model";

/**
 * One dial per language: how far along the 5 minutes that are enough to train. Past that the ring
 * stays full and a dotted orbit fills as more is recorded, since more still makes a better model.
 * Also the language switch. With more languages than fit, the tray scrolls sideways and keeps the
 * selected one in view.
 */
export const LanguageDials = memo(function LanguageDials({ languages, stats, value, onChange, disabled, className }: {
  languages: Language[];
  stats: LangStats[] | null;
  value: Lang | null;
  onChange: (l: Lang) => void;
  disabled: boolean;
  className?: string;
}) {
  return (
    <div className={cn("relative flex min-w-0 rounded-[20px] bg-foreground/[0.045] p-1 shadow-[inset_0_0_0_1px_var(--border)]", className)}>
      <ScrollStrip active={value} fade={20} className="-m-1 rounded-[20px] p-1" innerClassName="gap-1">
        {languages.map((l) => {
          const s = stats?.find((x) => x.lang === l.code);
          const total = (s?.trainSeconds ?? 0) + (s?.testSeconds ?? 0);
          const v = total / GOAL_SECONDS;
          const done = v >= 1;
          const more = done ? Math.min(1, (total - GOAL_SECONDS) / (PLENTY_SECONDS - GOAL_SECONDS)) : 0;
          const mins = (total / 60).toFixed(1);
          const on = value === l.code;
          return (
            <button
              key={l.code}
              data-strip-key={l.code}
              disabled={disabled && !on}
              onClick={() => onChange(l.code)}
              title={`${l.name}${s ? `: ${mins} min, ${s.trainClips} training clips, ${s.testClips} held back for testing.${done ? " Enough to train; more makes a better model." : ` ${GOAL_SECONDS / 60} min is enough to train.`}` : ""}`}
              className={cn(
                "relative flex h-[50px] max-w-[13rem] shrink-0 snap-start items-center gap-2.5 rounded-[16px] pr-4 pl-2 text-left whitespace-nowrap transition-[color,opacity] disabled:opacity-40",
                on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {on && (
                <motion.span
                  layoutId="rk-lang"
                  transition={{ type: "spring", stiffness: 480, damping: 38 }}
                  className="absolute inset-0 rounded-[16px] bg-card shadow-[0_0_0_0.5px_var(--input),0_1px_2px_rgb(64_32_25/0.08),0_6px_16px_-8px_rgb(64_32_25/0.25)]"
                />
              )}
              <span className="relative shrink-0">
                <Ring value={v} size={36} stroke={3.5} color={done ? "var(--good)" : on ? "url(#rk-ring)" : "var(--brand)"} className={cn("relative", on ? "text-foreground" : "text-muted-foreground")}>
                  {done ? (
                    <Check className="size-3.5 text-good" strokeWidth={3} />
                  ) : (
                    <span className="font-display text-[10.5px] font-bold tabular-nums">{Math.round(Math.min(1, v) * 100)}</span>
                  )}
                </Ring>
                {done && <MoreOrbit value={more} />}
              </span>
              <span className="relative flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[13px] leading-none font-semibold">{l.name}</span>
                <span className="text-[11.5px] leading-none text-muted-foreground tabular-nums">
                  {!s ? "…" : done ? `${mins} min · enough` : `${mins} of ${GOAL_SECONDS / 60} min`}
                </span>
              </span>
            </button>
          );
        })}
      </ScrollStrip>
      {/* The ember→gold stroke for the selected ring. */}
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="rk-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: "var(--brand)" }} />
            <stop offset="1" style={{ stopColor: "var(--brand-gold)" }} />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
});

/** A dotted orbit around a full ring: open-ended, it fills in gold as you keep recording. */
function MoreOrbit({ value }: { value: number }) {
  const r = 21;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 46 46" className="pointer-events-none absolute -inset-[5px] -rotate-90">
      <circle cx="23" cy="23" r={r} fill="none" stroke="var(--good)" strokeOpacity={0.35} strokeWidth={1.5} strokeDasharray="0.5 3.5" strokeLinecap="round" />
      <motion.circle
        cx="23"
        cy="23"
        r={r}
        fill="none"
        stroke="var(--brand-gold)"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeDasharray={c}
        initial={false}
        animate={{ strokeDashoffset: c * (1 - value) }}
        transition={{ type: "spring", stiffness: 80, damping: 20 }}
      />
    </svg>
  );
}
