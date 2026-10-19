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

/** Up to this many languages get the big side-by-side columns; more switch to a compact table. */
const COLUMNS_MAX = 4;
/** Languages named in the headline before it switches to a count. */
const NAMED = 3;

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
      // Past a few names the sentence turns into a list nobody reads; the board below has the detail.
      headline =
        wins.length <= NAMED
          ? `Better than the reference in ${list(wins.map((r) => langName(r.lang)))}`
          : `Better than the reference in ${wins.length} of ${compared.length} languages`;
      sub =
        losses.length === 1
          ? `The reference still leads in ${langName(losses[0].lang)}, ${pct(losses[0].base)} to your ${pct(losses[0].mine)}.`
          : losses.length <= NAMED
            ? `The reference still leads in ${list(losses.map((r) => langName(r.lang)))}.`
            : `The reference still leads in ${losses.length} languages.`;
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

      {rows.length > COLUMNS_MAX ? (
        <LangTable rows={rows} scale={scale} replay={replay} />
      ) : (
        <div className="@container/board relative border-t border-border">
          <div
            className={cn("grid", rows.length === 4 && "grid-cols-2 @[46rem]/board:grid-cols-4")}
            style={rows.length === 4 ? undefined : { gridTemplateColumns: `repeat(${Math.max(1, rows.length)}, minmax(0, 1fr))` }}
          >
            {rows.map((r, i) => (
              <LangColumn key={r.lang} row={r} scale={scale} index={i} count={rows.length} replay={replay} />
            ))}
          </div>
        </div>
      )}

      <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-7 py-3 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <Clock className="size-3.5" /> Tested {when(result.createdAt)}
        </span>
        <span className="flex max-w-full min-w-0 items-center gap-1.5" title={modelName}>
          <AudioLines className="size-3.5 shrink-0" />
          <span className="truncate">{modelName}, beam search ({result.beams} beams)</span>
        </span>
        <span className="whitespace-nowrap tabular-nums">{result.rows.length} held-back clips</span>
        {compared.length > 0 && <span className="ml-auto">The reference recognizer is scored on the same clips</span>}
      </div>
    </section>
  );
}

/** Borders between columns; four languages fold into a 2×2 grid when the board is narrow. */
function columnEdges(index: number, count: number) {
  if (count < 4) return index > 0 && "border-l border-border";
  return cn("border-border", index % 2 === 1 && "border-l", index === 2 && "@[46rem]/board:border-l", index >= 2 && "border-t @[46rem]/board:border-t-0");
}

function LangColumn({ row, scale, index, count, replay }: { row: Row; scale: number; index: number; count: number; replay: number }) {
  const { lang, mine, base } = row;
  const delay = 0.15 + index * 0.08;
  return (
    <div className={cn("@container flex min-w-0 flex-col px-7 pt-6 pb-6", columnEdges(index, count))}>
      <div className="min-w-0" title={langName(lang)}>
        <Eyebrow className="truncate">{langName(lang)}</Eyebrow>
      </div>
      <div className="mt-3 flex items-baseline font-display leading-[0.82] font-semibold tracking-[-0.045em] whitespace-nowrap tabular-nums">
        {mine != null ? (
          <>
            <span className="text-[clamp(30px,26cqw,78px)]">
              <RollingNumber value={mine * 100} replay={replay} />
            </span>
            <span className="ml-1 text-[clamp(14px,9cqw,28px)] tracking-normal text-muted-foreground">%</span>
          </>
        ) : (
          <span className="text-[44px] text-muted-foreground/50">—</span>
        )}
      </div>
      <div className="mt-2 text-[12px] text-muted-foreground">of words wrong</div>

      {mine != null && base != null ? (
        <>
          <Duel mine={mine} base={base} scale={scale} delay={delay} replay={replay} />
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: delay + 0.9, duration: 0.35, ease: EASE }}
            className="mt-7"
          >
            <Verdict mine={mine} base={base} />
          </motion.div>
        </>
      ) : (
        <p className="mt-6 text-[12px] text-muted-foreground">No reference score for this language.</p>
      )}
    </div>
  );
}

/**
 * The board for many languages: one row each, in the same order, with the same shared-scale bars.
 * Subgrid rows keep every column lined up while each row still gets its own border and hover.
 */
function LangTable({ rows, scale, replay }: { rows: Row[]; scale: number; replay: number }) {
  return (
    <div className="relative grid grid-cols-[minmax(0,max-content)_auto_minmax(4.5rem,1fr)_auto_auto] gap-x-5 border-t border-border">
      <div className="col-span-full grid grid-cols-subgrid items-end px-7 pt-4 pb-2">
        <Eyebrow>Language</Eyebrow>
        <Eyebrow className="text-right">You</Eyebrow>
        <div className="min-w-0" title="Both bars on one scale for every language. The band is the margin, the tick is the 2× goal.">
          <Eyebrow className="truncate">Compared</Eyebrow>
        </div>
        <Eyebrow className="text-right">Reference</Eyebrow>
        <span />
      </div>
      {rows.map((r, i) => (
        <LangRow key={r.lang} row={r} scale={scale} delay={0.1 + Math.min(i, 12) * 0.04} replay={replay} />
      ))}
    </div>
  );
}

function LangRow({ row, scale, delay, replay }: { row: Row; scale: number; delay: number; replay: number }) {
  const { lang, mine, base } = row;
  return (
    <div className="col-span-full grid grid-cols-subgrid items-center border-t border-border px-7 py-2.5 transition-colors hover:bg-foreground/[0.015]">
      <span className="max-w-[11rem] truncate text-[13px] font-medium" title={langName(lang)}>
        {langName(lang)}
      </span>
      <span className="text-right font-display text-[22px] leading-none font-semibold tracking-[-0.03em] whitespace-nowrap tabular-nums">
        {mine != null ? (
          <>
            <RollingNumber value={mine * 100} replay={replay} />
            <span className="ml-0.5 text-[12px] tracking-normal text-muted-foreground">%</span>
          </>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </span>
      {mine != null ? <MiniDuel mine={mine} base={base} scale={scale} delay={delay} replay={replay} /> : <span />}
      <span className="text-right text-[12px] whitespace-nowrap text-muted-foreground tabular-nums">{pct(base)}</span>
      <motion.span className="justify-self-end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: delay + 0.8, duration: 0.3 }}>
        {mine != null && base != null ? (
          <Verdict mine={mine} base={base} short />
        ) : (
          <span className="inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-[12px] font-medium whitespace-nowrap text-muted-foreground">No reference</span>
        )}
      </motion.span>
    </div>
  );
}

const x = (v: number, scale: number) => `${Math.min(100, (v / scale) * 100)}%`;
const MINE_BAR = "bg-[linear-gradient(90deg,var(--brand-gold),var(--brand))] shadow-[0_0_12px_-2px_rgb(243_74_45/0.5)]";
const BASE_BAR = "bg-foreground/35";

function Bar({ value, scale, className, delay, replay, thin }: { value: number; scale: number; className: string; delay: number; replay: number; thin?: boolean }) {
  return (
    <div className={cn("relative rounded-full bg-foreground/[0.06]", thin ? "h-1.5" : "h-2.5")}>
      <motion.div
        key={replay}
        className={cn("absolute inset-y-0 left-0 rounded-full", className)}
        initial={{ width: 0 }}
        animate={{ width: x(value, scale) }}
        transition={{ duration: 0.9, delay, ease: EASE }}
      />
    </div>
  );
}

/** The band between the two bars' ends (the margin) and the dashed tick at the 2× goal. */
function Margin({ mine, base, scale, delay, replay, label }: { mine: number; base: number; scale: number; delay: number; replay: number; label?: boolean }) {
  const win = mine < base;
  const lo = Math.min(mine, base);
  const hi = Math.max(mine, base);
  return (
    <>
      <motion.div
        key={`band-${replay}`}
        className={cn("absolute inset-y-0 rounded-[5px] border-x border-dashed", win ? "border-good/60 bg-good/10" : "border-warn/70 bg-warn/12")}
        style={{ left: x(lo, scale), width: `calc(${x(hi, scale)} - ${x(lo, scale)})` }}
        initial={{ opacity: 0 }}
        animate={{ opacity: hi > lo ? 1 : 0 }}
        transition={{ delay: delay + 0.8, duration: 0.4 }}
      />
      <div
        className="absolute inset-y-0 w-px border-l border-dashed border-foreground/30"
        style={{ left: x(base / 2, scale) }}
        title="The goal: half the reference's word error rate"
      >
        {label && <span className="absolute -bottom-3.5 -translate-x-1/2 text-[9.5px] leading-none font-semibold text-muted-foreground">2×</span>}
      </div>
    </>
  );
}

/** Two bars on a shared scale. The band between their ends is the margin; the tick is the 2× goal. */
function Duel({ mine, base, scale, delay, replay }: { mine: number; base: number; scale: number; delay: number; replay: number }) {
  // Label rows sit above full-width bars; the overlay spans from the top of your bar to the bottom of the reference's.
  return (
    <div className="relative mt-6">
      <div className="pointer-events-none absolute inset-x-0 top-[18px] -bottom-1">
        <Margin mine={mine} base={base} scale={scale} delay={delay} replay={replay} label />
      </div>
      <div className="relative flex h-4 items-center justify-between gap-2 text-[11.5px] font-semibold whitespace-nowrap">
        <span>You</span>
        <span className="tabular-nums">{pct(mine)}</span>
      </div>
      <div className="relative mt-1.5">
        <Bar value={mine} scale={scale} className={MINE_BAR} delay={delay} replay={replay} />
      </div>
      <div className="relative mt-3 flex h-4 items-center justify-between gap-2 text-[11.5px] whitespace-nowrap text-muted-foreground">
        <span>Reference</span>
        <span className="tabular-nums">{pct(base)}</span>
      </div>
      <div className="relative mt-1.5">
        <Bar value={base} scale={scale} className={BASE_BAR} delay={delay + 0.08} replay={replay} />
      </div>
    </div>
  );
}

/** The table's duel: the same two bars on the same scale, thin, stacked and unlabelled. */
function MiniDuel({ mine, base, scale, delay, replay }: { mine: number; base: number | undefined; scale: number; delay: number; replay: number }) {
  return (
    <div className="relative py-1">
      {base != null && (
        <div className="pointer-events-none absolute inset-0">
          <Margin mine={mine} base={base} scale={scale} delay={delay} replay={replay} />
        </div>
      )}
      <div className="relative">
        <Bar value={mine} scale={scale} className={MINE_BAR} delay={delay} replay={replay} thin />
      </div>
      {base != null && (
        <div className="relative mt-1">
          <Bar value={base} scale={scale} className={BASE_BAR} delay={delay + 0.08} replay={replay} thin />
        </div>
      )}
    </div>
  );
}

// The column width (container query) each full sentence needs; narrower columns show the short form.
const ROOM = {
  sm: ["@max-[11.5rem]:hidden", "@min-[11.5rem]:hidden"],
  md: ["@max-[12.5rem]:hidden", "@min-[12.5rem]:hidden"],
  lg: ["@max-[14.5rem]:hidden", "@min-[14.5rem]:hidden"],
} as const;

/**
 * The pill under each language. In a column it shows the full sentence when the column has room
 * and the short form when it doesn't; `short` always uses the short form, with the sentence as its tooltip.
 */
function Verdict({ mine, base, short }: { mine: number; base: number; short?: boolean }) {
  const ratio = mine > 0 ? base / mine : Infinity;
  const pts = Math.abs(base - mine) * 100;
  let tone: string;
  let icon = null;
  let text: string;
  let brief: string;
  let room: keyof typeof ROOM;
  if (mine === base) {
    tone = "bg-muted text-muted-foreground";
    text = "Level with the reference";
    brief = "Level";
    room = "sm";
  } else if (mine > base) {
    tone = "bg-warn/14 text-warn";
    text = `Reference leads by ${pts.toFixed(1)} pts`;
    brief = `${pts.toFixed(1)} pts behind`;
    room = "md";
  } else if (ratio >= 2) {
    tone = "bg-[linear-gradient(90deg,var(--brand-gold),var(--brand))] text-white shadow-[0_4px_14px_-6px_rgb(243_74_45/0.8)]";
    icon = <Trophy className="size-3" strokeWidth={2.5} />;
    text = Number.isFinite(ratio) ? `${ratio.toFixed(2)}× better · 2× goal met` : "No errors · 2× goal met";
    brief = Number.isFinite(ratio) ? `${ratio.toFixed(2)}× better` : "No errors";
    room = Number.isFinite(ratio) ? "md" : "sm";
  } else {
    tone = "bg-good/12 text-good dark:bg-good/16";
    icon = <Flag className="size-3" strokeWidth={2.5} />;
    text = `${ratio.toFixed(2)}× better than the reference`;
    brief = `${ratio.toFixed(2)}× better`;
    room = "lg";
  }
  const pill = (label: string, cls?: string, title?: string) => (
    <span
      title={title}
      className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold whitespace-nowrap tabular-nums", tone, cls)}
    >
      {icon}
      {label}
    </span>
  );
  if (short) return pill(brief, undefined, text);
  return (
    <>
      {pill(text, ROOM[room][0])}
      {pill(brief, ROOM[room][1], text)}
    </>
  );
}
