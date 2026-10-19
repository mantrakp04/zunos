import { cn } from "@zunos/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { PromptItem } from "../../../shared/types";
import { dirOf, needsNativeFont } from "../../scripts";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * The reading stage. Before a take, a passage reads like a page. Once you start, it becomes a
 * prompter: the line you're reading sits large at the focal point and glows, finished lines drift up
 * and fade, the next ones wait below.
 */
export const Prompter = memo(function Prompter({ prompt, line, reading }: {
  prompt: PromptItem;
  /** The line being read, or -1 before the take. */
  line: number;
  reading: boolean;
}) {
  // Long passages read like a page before you start; short ones go straight to the big type.
  const page = line < 0 && prompt.lines.length > 2 && prompt.lines.join(" ").length > 220;
  // Native-script text gets its own font stack (and right-to-left where the language reads that way).
  const text = { lang: prompt.lang, dir: dirOf(prompt.lang, prompt.script), native: needsNativeFont(prompt.lines.join(" ")) };
  return (
    <div className="absolute inset-0 [container-type:size]">
      <AnimatePresence initial={false}>
        <motion.div
          key={`${prompt.id}:${page ? "page" : "prompter"}`}
          initial={{ opacity: 0, y: page ? 10 : 18, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -14, filter: "blur(6px)", transition: { duration: 0.22 } }}
          transition={{ duration: 0.42, ease: EASE }}
          className="absolute inset-0"
        >
          {page ? <Page lines={prompt.lines} text={text} /> : <Track lines={prompt.lines} focus={Math.max(0, line)} reading={reading} text={text} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
});

/** The whole passage, before you start. */
type TextProps = { lang: string; dir: "rtl" | "ltr" | "auto"; native: boolean };

function Page({ lines, text }: { lines: string[]; text: TextProps }) {
  return (
    <div className="rk-fade-page h-full overflow-y-auto scrollbar-none">
      <div className="mx-auto flex min-h-full max-w-[48rem] flex-col justify-center px-12 py-7">
        <p
          lang={text.lang}
          dir={text.dir}
          className={cn(
            "font-display text-[clamp(15px,min(2.2cqi,4.6cqh),23px)] leading-[1.62] text-pretty [overflow-wrap:anywhere]",
            text.native ? "rk-native leading-[1.8]" : "tracking-[-0.008em]",
          )}
        >
          {lines.map((l, i) => (
            <span key={i} dir={text.dir === "auto" ? "auto" : undefined}>
              <sup className="mr-[0.3em] -top-[0.55em] font-mono text-[0.58em] font-semibold text-brand/70 tabular-nums">{i + 1}</sup>
              {l}
              {i < lines.length - 1 && " "}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}

/** The prompter: one column of lines that glides so the current one sits at the focal point. */
function Track({ lines, focus, reading, text }: { lines: string[]; focus: number; reading: boolean; text: TextProps }) {
  const box = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLParagraphElement | null)[]>([]);
  const [size, setSize] = useState(0);
  const [y, setY] = useState<number | null>(null);
  const [glide, setGlide] = useState(false);
  const single = lines.length === 1;

  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setSize(el.clientWidth * 10000 + el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    const p = refs.current[focus];
    if (!el || !p) return;
    const focal = el.clientHeight * (single ? 0.5 : 0.42);
    setY(Math.round(focal - (p.offsetTop + p.offsetHeight / 2)));
  }, [focus, size, single, lines]);

  // Place the column without animating the first time, then glide.
  useEffect(() => {
    if (y == null || glide) return;
    const id = requestAnimationFrame(() => setGlide(true));
    return () => cancelAnimationFrame(id);
  }, [y, glide]);

  return (
    <div ref={box} className={cn("relative h-full overflow-hidden", !single && "rk-fade-y")}>
      <div
        className={cn("rk-track relative mx-auto flex max-w-[min(92%,46rem)] flex-col gap-[0.6em] px-6", glide && "transition-transform duration-[650ms] ease-[cubic-bezier(0.22,1,0.36,1)]")}
        style={{ transform: `translateY(${y ?? 0}px)`, visibility: y == null ? "hidden" : undefined }}
      >
        {lines.map((l, i) => {
          const d = i - focus;
          const now = d === 0;
          const opacity = !reading ? (now ? 1 : 0.5) : now ? 1 : d < 0 ? Math.max(0.07, 0.3 - 0.1 * (-d - 1)) : Math.max(0.14, 0.42 - 0.12 * (d - 1));
          return (
            <p
              key={i}
              ref={(n) => {
                refs.current[i] = n;
              }}
              data-now={now}
              data-reading={reading}
              lang={text.lang}
              dir={text.dir}
              className={cn(
                // Sized by the stage's width and height, so a long line (or a URL) still fits around the focal point.
                "rk-line text-center font-display font-semibold text-balance [overflow-wrap:anywhere]",
                single ? "text-[clamp(18px,min(4.4cqi,13cqh),40px)]" : "text-[clamp(16px,min(3.6cqi,9cqh),34px)]",
                // Native scripts carry marks above and below the line: more leading, no negative tracking.
                text.native ? "rk-native leading-[1.5]" : cn("tracking-[-0.022em]", single ? "leading-[1.22]" : "leading-[1.24]"),
                !now && "text-foreground/90",
              )}
              style={{
                opacity,
                transform: `scale(${now ? 1 : 0.93})`,
                filter: reading && d < -1 ? "blur(1.2px)" : reading && d < 0 ? "blur(0.4px)" : undefined,
              }}
            >
              {l}
              <span
                aria-hidden
                className="rk-caret mx-auto mt-[0.32em] block h-[3px] rounded-full bg-[linear-gradient(90deg,var(--brand),var(--brand-gold))]"
                style={{ width: now && reading ? 44 : 0, opacity: now && reading ? 1 : 0 }}
              />
            </p>
          );
        })}
      </div>
      {!single && reading && <LineRail count={lines.length} focus={focus} />}
    </div>
  );
}

/** Progress through the lines, a column of beads on the stage's left edge. */
function LineRail({ count, focus }: { count: number; focus: number }) {
  return (
    <div className="absolute top-1/2 left-5 flex -translate-y-1/2 flex-col items-center gap-[5px]">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn(
            "w-[5px] rounded-full transition-all duration-500",
            i === focus ? "h-[18px] bg-brand" : "h-[5px]",
            i < focus && "bg-brand-gold",
            i > focus && "bg-foreground/15",
          )}
        />
      ))}
    </div>
  );
}
