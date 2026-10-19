import { cn } from "@zunos/ui/lib/utils";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { useEffect, useRef, useState } from "react";

const LENGTH = 6;

/**
 * Six big keycap tiles over one invisible input, so typing, pasting and the one-time-code
 * autofill all work like a normal field.
 */
export function CodeTiles({
  value,
  onChange,
  onComplete,
  busy,
  error,
  shakeKey,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete: (v: string) => void;
  busy?: boolean;
  error?: boolean;
  /** Bump to shake the row (a wrong code). */
  shakeKey?: number;
  className?: string;
}) {
  const [focused, setFocused] = useState(false);
  const shake = useAnimationControls();
  const input = useRef<HTMLInputElement>(null);
  // The input is disabled while verifying; take focus back once it's done (e.g. after a wrong code).
  useEffect(() => {
    if (!busy) input.current?.focus();
  }, [busy]);
  useEffect(() => {
    if (shakeKey) shake.start({ x: [0, -11, 10, -7, 5, -2, 0], transition: { duration: 0.46, ease: "easeOut" } });
  }, [shakeKey, shake]);

  return (
    <motion.div animate={shake} className={cn("relative w-fit", className)}>
      <div className="flex items-center gap-2.5" aria-hidden>
        {Array.from({ length: LENGTH }, (_, i) => {
          const digit = value[i];
          const active = focused && !busy && i === Math.min(value.length, LENGTH - 1) && value.length < LENGTH;
          return (
            <div key={i} className="contents">
              {i === 3 && <span className="mx-0.5 h-[3px] w-2.5 rounded-full bg-foreground/15" />}
              <motion.div
                animate={busy ? { y: [0, -5, 0] } : { y: 0 }}
                transition={busy ? { duration: 0.7, repeat: Infinity, delay: i * 0.08, ease: "easeInOut" } : { duration: 0.2 }}
                className={cn(
                  "relative grid h-[66px] w-[52px] place-items-center rounded-[16px] transition-[background-color,box-shadow] duration-200",
                  "bg-card",
                  digit && "bg-[color-mix(in_oklab,var(--brand-cream)_38%,var(--card))] dark:bg-[color-mix(in_oklab,var(--brand)_12%,var(--card))]",
                  busy
                    ? "shadow-[0_0_0_1.5px_var(--brand-gold),0_2px_0_var(--input)]"
                    : error
                      ? "shadow-[0_0_0_1.5px_var(--destructive),0_2px_0_var(--input)]"
                      : active
                        ? "shadow-[0_0_0_1.5px_var(--brand),0_0_0_5px_rgb(243_74_45/0.14),0_2px_0_var(--input)]"
                        : "shadow-[0_0_0_1px_var(--input),0_2px_0_var(--input),inset_0_1px_0_rgb(255_255_255/0.7)] dark:shadow-[0_0_0_1px_var(--input),0_2px_0_rgb(0_0_0/0.5),inset_0_1px_0_rgb(255_240_225/0.05)]",
                )}
              >
                <AnimatePresence initial={false}>
                  {digit && (
                    <motion.span
                      key={digit}
                      initial={{ opacity: 0, y: 10, scale: 0.6 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.7, transition: { duration: 0.1 } }}
                      transition={{ type: "spring", stiffness: 620, damping: 26 }}
                      className="absolute font-display text-[34px] leading-none font-semibold tabular-nums"
                    >
                      {digit}
                    </motion.span>
                  )}
                </AnimatePresence>
                {active && <span className="zn-caret h-7 w-[2px] rounded-full bg-brand" />}
              </motion.div>
            </div>
          );
        })}
      </div>
      <input
        ref={input}
        autoFocus
        aria-label="6-digit code"
        autoComplete="one-time-code"
        inputMode="numeric"
        spellCheck={false}
        disabled={busy}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, LENGTH);
          onChange(v);
          if (v.length === LENGTH) onComplete(v);
        }}
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 outline-none selection:bg-transparent"
      />
    </motion.div>
  );
}
