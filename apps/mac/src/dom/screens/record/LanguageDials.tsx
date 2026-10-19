import { cn } from "@zunos/ui/lib/utils";
import { Check } from "lucide-react";
import { motion } from "motion/react";
import { memo } from "react";

import type { Lang, LangStats, Language } from "../../../shared/types";
import { Ring } from "../../ui";
import { GOAL_SECONDS } from "./model";

/** One dial per language: how far along the ~10 minutes it is. Also the language switch. */
export const LanguageDials = memo(function LanguageDials({ languages, stats, value, onChange, disabled }: {
  languages: Language[];
  stats: LangStats[] | null;
  value: Lang | null;
  onChange: (l: Lang) => void;
  disabled: boolean;
}) {
  return (
    <div className="inline-flex gap-1 rounded-[20px] bg-foreground/[0.045] p-1 shadow-[inset_0_0_0_1px_var(--border)]">
      {languages.map((l) => {
        const s = stats?.find((x) => x.lang === l.code);
        const total = (s?.trainSeconds ?? 0) + (s?.testSeconds ?? 0);
        const v = total / GOAL_SECONDS;
        const done = v >= 1;
        const on = value === l.code;
        return (
          <button
            key={l.code}
            disabled={disabled && !on}
            onClick={() => onChange(l.code)}
            title={s ? `${s.trainClips} training clips, ${s.testClips} held back for testing` : undefined}
            className={cn(
              "relative flex h-[50px] items-center gap-2.5 rounded-[16px] pr-4 pl-2 text-left transition-[color,opacity] disabled:opacity-40",
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
            <Ring value={v} size={36} stroke={3.5} color={done ? "var(--good)" : on ? "url(#rk-ring)" : "var(--brand)"} className={cn("relative", on ? "text-foreground" : "text-muted-foreground")}>
              {done ? (
                <Check className="size-3.5 text-good" strokeWidth={3} />
              ) : (
                <span className="font-display text-[10.5px] font-bold tabular-nums">{Math.round(Math.min(1, v) * 100)}</span>
              )}
            </Ring>
            <span className="relative flex flex-col gap-0.5">
              <span className="text-[13px] leading-none font-semibold">{l.name}</span>
              <span className="text-[11.5px] leading-none text-muted-foreground tabular-nums">
                {!s ? "…" : done ? `${(total / 60).toFixed(1)} min, goal met` : `${(total / 60).toFixed(1)} of ${GOAL_SECONDS / 60} min`}
              </span>
            </span>
          </button>
        );
      })}
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
