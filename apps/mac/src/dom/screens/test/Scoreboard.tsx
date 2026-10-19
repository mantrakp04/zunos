import { cn } from "@zunos/ui/lib/utils";
import { AudioLines, Clock, Flag, Trophy } from "lucide-react";
import { animate, motion } from "motion/react";
import { useEffect, useRef } from "react";

import type { EvalResult, Lang } from "../../../shared/types";
import { Bean } from "../../Bean";
import { Eyebrow, langName, pct } from "../../ui";

const EASE = [0.22, 1, 0.36, 1] as const;

/** A number that rolls to its value whenever the value (or `replay`) changes. */
export function RollingNumber({ value, decimals = 1, replay }: { value: number; decimals?: number; replay?: unknown }) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      el.textContent = value.toFixed(decimals);
      from.current = value;
      return;
    }
    const c = animate(from.current, value, {
      duration: 1.1,
      ease: EASE,
      onUpdate: (v) => (el.textContent = v.toFixed(decimals)),
    });
    from.current = value;
    return () => c.stop();
  }, [value, decimals, replay]);
  return <span ref={ref}>{(0).toFixed(decimals)}</span>;
}

type Row = { lang: Lang; mine: number | undefined; base: number | undefined };

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function when(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

/** The hero: one column per language, your word error rate against the reference's on the same clips. */
export function Scoreboard({
  result,
  langs,
  reference,
  modelName,
  replay,
}: {
  result: EvalResult;
  langs: Lang[];
  reference: (l: Lang) => number | undefined;
  modelName: string;
  /** Changes after a fresh run: numbers roll again and the bean hops. */
  replay: number;
}) {
  const rows: Row[] = langs.map((l) => ({ lang: l, mine: result.scores[l], base: reference(l) }));
  const compared = rows.filter((r) => r.mine != null && r.base != null);
  const wins = compared.filter((r) => r.mine! < r.base!);
  const losses = compared.filter((r) => r.mine! > r.base!);
  const all = rows.flatMap((r) => [r.mine ?? 0, r.base ?? 0]);
  // One scale for every language so the bars compare across columns too; rounded up to a 10% step.
  const scale = Math.max(0.2, Math.ceil((Math.max(...all) * 1.08) / 0.1) * 0.1);

  const mineAvg = result.scores.avg;
  const baseAvg = compared.length === rows.length && rows.length ? rows.reduce((s, r) => s + r.base!, 0) / rows.length : undefined;

  let headline = "Your scores on clips it never trained on";
  let sub: string | null = null;
  if (compared.length) {
    if (!losses.length && wins.length === compared.length) {
      headline = compared.length === 1 ? `Better than the reference in ${langName(wins[0].lang)}` : "Better than the reference in every language";
      sub = mineAvg != null && baseAvg != null ? `${(baseAvg / Math.max(mineAvg, 1e-6)).toFixed(2)}× better on average. The goal is 2×.` : null;
    } else if (wins.length) {
      headline = `Better than the reference in ${list(wins.map((r) => langName(r.lang)))}`;
      sub =
        losses.length === 1
          ? `The reference still leads in ${langName(losses[0].lang)}, ${pct(losses[0].base)} to your ${pct(losses[0].mine)}.`
          : `The reference still leads in ${list(losses.map((r) => langName(r.lang)))}.`;
    } else if (losses.length) {
      headline = "The reference leads for now";
      sub = "More recordings and another training run are the surest way to close the gap.";
    } else {
      headline = "Level with the reference";
    }
  }
  const happy = wins.length > losses.length;

  return (
    <section className="zn-surface grain relative overflow-hidden">
      <div className="zn-ripples opacity-70" style={{ ["--rx" as string]: "70px", ["--ry" as string]: "58px" }} />

      <div className="relative flex items-center gap-5 px-7 pt-6 pb-5">
        <Bean key={replay} mood={happy ? "happy" : "idle"} size={68} className="-my-2 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[22px] leading-tight font-semibold tracking-[-0.015em] text-balance">{headline}</h2>
          {sub && <p className="mt-1 text-[13.5px] text-muted-foreground">{sub}</p>}
        </div>
        {mineAvg != null && (
          <div className="shrink-0 text-right">
            <Eyebrow>Average</Eyebrow>
            <div className="mt-1 font-display text-[26px] leading-none font-semibold tracking-tight tabular-nums">
              <RollingNumber value={mineAvg * 100} replay={replay} />
              <span className="text-[15px] text-muted-foreground">%</span>
            </div>
            {baseAvg != null && <div className="mt-1 text-[11.5px] text-muted-foreground tabular-nums">Reference {pct(baseAvg)}</div>}
          </div>
        )}
      </div>

      <div
        className="relative grid border-t border-border"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, rows.length)}, minmax(0, 1fr))` }}
      >
        {rows.map((r, i) => (
          <LangColumn key={r.lang} row={r} scale={scale} index={i} replay={replay} />
        ))}
      </div>

      <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-7 py-3 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Clock className="size-3.5" /> Tested {when(result.createdAt)}
        </span>
        <span className="flex items-center gap-1.5">
          <AudioLines className="size-3.5" /> {modelName}, beam search ({result.beams} beams)
        </span>
        <span className="tabular-nums">{result.rows.length} held-back clips</span>
        {compared.length > 0 && <span className="ml-auto">The reference recognizer is scored on the same clips</span>}
      </div>
    </section>
  );
}

function LangColumn({ row, scale, index, replay }: { row: Row; scale: number; index: number; replay: number }) {
  const { lang, mine, base } = row;
  const delay = 0.15 + index * 0.08;
  return (
    <div className={cn("@container flex min-w-0 flex-col px-7 pt-6 pb-6", index > 0 && "border-l border-border")}>
      <Eyebrow>{langName(lang)}</Eyebrow>
      <div className="mt-3 flex items-baseline font-display leading-[0.82] font-semibold tracking-[-0.045em] tabular-nums">
        {mine != null ? (
          <>
            <span className="text-[clamp(44px,26cqw,78px)]">
              <RollingNumber value={mine * 100} replay={replay} />
            </span>
            <span className="ml-1 text-[clamp(18px,9cqw,28px)] tracking-normal text-muted-foreground">%</span>
          </>
        ) : (
          <span className="text-[44px] text-muted-foreground/50">—</span>
        )}
      </div>
      <div className="mt-2 text-[12px] text-muted-foreground">of words wrong</div>

      {mine != null && base != null ? (
        <>
          <Duel mine={mine} base={base} scale={scale} delay={delay} replay={replay} />
          <Verdict mine={mine} base={base} delay={delay} />
        </>
      ) : (
        <p className="mt-6 text-[12px] text-muted-foreground">No reference score for this language.</p>
      )}
    </div>
  );
}

/** Two bars on a shared scale. The band between their ends is the margin; the tick is the 2× goal. */
function Duel({ mine, base, scale, delay, replay }: { mine: number; base: number; scale: number; delay: number; replay: number }) {
  const x = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const win = mine < base;
  const lo = Math.min(mine, base);
  const hi = Math.max(mine, base);
  const goal = base / 2;
  const bar = (v: number, cls: string, d: number) => (
    <div className="relative h-2.5 rounded-full bg-foreground/[0.06]">
      <motion.div
        key={replay}
        className={cn("absolute inset-y-0 left-0 rounded-full", cls)}
        initial={{ width: 0 }}
        animate={{ width: x(v) }}
        transition={{ duration: 0.9, delay: d, ease: EASE }}
      />
    </div>
  );
  // Label rows sit above full-width bars; the overlay spans from the top of your bar to the bottom of the reference's.
  return (
    <div className="relative mt-6">
      <div className="pointer-events-none absolute inset-x-0 top-[18px] -bottom-1">
        <motion.div
          key={`band-${replay}`}
          className={cn(
            "absolute inset-y-0 rounded-[5px] border-x border-dashed",
            win ? "border-good/60 bg-good/10" : "border-warn/70 bg-warn/12",
          )}
          style={{ left: x(lo), width: `calc(${x(hi)} - ${x(lo)})` }}
          initial={{ opacity: 0 }}
          animate={{ opacity: hi > lo ? 1 : 0 }}
          transition={{ delay: delay + 0.8, duration: 0.4 }}
        />
        <div className="absolute inset-y-0 w-px border-l border-dashed border-foreground/30" style={{ left: x(goal) }} title="The goal: half the reference's word error rate">
          <span className="absolute -bottom-3.5 -translate-x-1/2 text-[9.5px] leading-none font-semibold text-muted-foreground">2×</span>
        </div>
      </div>
      <div className="relative flex h-4 items-center justify-between text-[11.5px] font-semibold">
        <span>You</span>
        <span className="tabular-nums">{pct(mine)}</span>
      </div>
      <div className="relative mt-1.5">
        {bar(mine, "bg-[linear-gradient(90deg,var(--brand-gold),var(--brand))] shadow-[0_0_12px_-2px_rgb(243_74_45/0.5)]", delay)}
      </div>
      <div className="relative mt-3 flex h-4 items-center justify-between text-[11.5px] text-muted-foreground">
        <span>Reference</span>
        <span className="tabular-nums">{pct(base)}</span>
      </div>
      <div className="relative mt-1.5">{bar(base, "bg-foreground/35", delay + 0.08)}</div>
    </div>
  );
}

function Verdict({ mine, base, delay }: { mine: number; base: number; delay: number }) {
  const ratio = mine > 0 ? base / mine : Infinity;
  const pts = Math.abs(base - mine) * 100;
  let tone: string;
  let icon = null;
  let text: string;
  if (mine === base) {
    tone = "bg-muted text-muted-foreground";
    text = "Level with the reference";
  } else if (mine > base) {
    tone = "bg-warn/14 text-warn";
    text = `Reference leads by ${pts.toFixed(1)} pts`;
  } else if (ratio >= 2) {
    tone = "bg-[linear-gradient(90deg,var(--brand-gold),var(--brand))] text-white shadow-[0_4px_14px_-6px_rgb(243_74_45/0.8)]";
    icon = <Trophy className="size-3" strokeWidth={2.5} />;
    text = Number.isFinite(ratio) ? `${ratio.toFixed(2)}× better · 2× goal met` : "No errors · 2× goal met";
  } else {
    tone = "bg-good/12 text-good dark:bg-good/16";
    icon = <Flag className="size-3" strokeWidth={2.5} />;
    text = `${ratio.toFixed(2)}× better than the reference`;
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: delay + 0.9, duration: 0.35, ease: EASE }}
      className="mt-7"
    >
      <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold whitespace-nowrap tabular-nums", tone)}>
        {icon}
        {text}
      </span>
    </motion.div>
  );
}
