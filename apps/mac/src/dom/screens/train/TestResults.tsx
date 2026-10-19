import { cn } from "@zunos/ui/lib/utils";
import { Check, ChevronDown, Minus } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { Eyebrow, langName, pct } from "../../ui";

/** The owner's bar: a language passes when its word error rate is at most half the reference's. */
export const GOAL = 2;

/** How a language does against the reference: the ratio, and whether it meets the 2× goal. */
export function verdict(mine: number, ref: number | undefined) {
  if (ref == null) return { ratio: null, pass: null as boolean | null };
  const ratio = mine > 0 ? ref / mine : Infinity;
  return { ratio, pass: ratio >= GOAL };
}

const FOLD_AFTER = 8;
/** Language, bar, your score, the verdict; the rows and the average line up on these. */
const COLS = "grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_5.5rem] items-center gap-x-4 @min-[34rem]/results:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_4.5rem_10rem]";

/**
 * Per language: your word error rate next to the reference recognizer's on the same clips, against
 * the goal of being at least 2× lower. `scores` are the latest test on this Mac, or the training
 * run's best step when it hasn't been tested here (`source` says which).
 */
export function TestResults({ scores, langs, reference, colorOf, source }: {
  scores: Record<string, number>;
  langs: string[];
  reference: (lang: string) => number | undefined;
  colorOf: (lang: string) => string;
  source: string;
}) {
  const [all, setAll] = useState(false);
  const rows = langs.filter((l) => scores[l] != null).map((l) => ({ lang: l, mine: scores[l]!, ref: reference(l), ...verdict(scores[l]!, reference(l)) }));
  const judged = rows.filter((r) => r.pass != null);
  const passed = judged.filter((r) => r.pass).length;
  const scale = Math.min(1, Math.max(0.05, ...rows.flatMap((r) => [r.mine, r.ref ?? 0])) * 1.08);
  const x = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const shown = rows.length > FOLD_AFTER && !all ? rows.slice(0, FOLD_AFTER - 2) : rows;
  const avg = scores.avg ?? (rows.length ? rows.reduce((s, r) => s + r.mine, 0) / rows.length : null);
  const refs = rows.map((r) => r.ref).filter((v): v is number => v != null);
  const refAvg = refs.length ? refs.reduce((s, v) => s + v, 0) / refs.length : null;

  return (
    <div className="@container/results">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <Eyebrow>{source}</Eyebrow>
          <h3 className="mt-1.5 font-display text-[22px] leading-tight font-semibold tracking-[-0.015em]">
            {!judged.length
              ? "No reference to compare with"
              : passed === judged.length
                ? `${GOAL}× better than the reference${judged.length > 1 ? ` in all ${judged.length} languages` : ""}`
                : `Meets the ${GOAL}× goal in ${passed} of ${judged.length} language${judged.length === 1 ? "" : "s"}`}
          </h3>
        </div>
        <div className="flex items-center gap-4 text-[11.5px] whitespace-nowrap text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-3 border-l-[1.5px] border-dashed border-foreground/55" /> Reference
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 border-l-[1.5px] border-dotted border-good" /> {GOAL}× lower
          </span>
        </div>
      </div>

      <div className={cn(COLS, "mt-4 gap-y-2.5")}>
        {shown.map((r, i) => (
          <Row key={r.lang} {...r} color={colorOf(r.lang)} x={x} delay={Math.min(i, 8) * 0.04} />
        ))}
      </div>
      {avg != null && (
        <div className={cn(COLS, "mt-3 border-t border-border pt-3")}>
          <span className="text-[13px] font-semibold">Average</span>
          <span />
          <span className="text-right font-display text-[17px] leading-none font-bold whitespace-nowrap tabular-nums">{pct(avg)}</span>
          <span className="hidden text-right text-[12px] whitespace-nowrap tabular-nums text-muted-foreground @min-[34rem]/results:block">
            {refAvg != null ? `Reference ${pct(refAvg)}` : ""}
          </span>
        </div>
      )}
      {rows.length > FOLD_AFTER && (
        <button
          onClick={() => setAll((a) => !a)}
          aria-expanded={all}
          className="mt-2 -ml-2.5 flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", all && "rotate-180")} />
          {all ? "Show fewer" : `Show all ${rows.length} languages`}
        </button>
      )}
    </div>
  );
}

function Row({ lang, mine, ref, ratio, pass, color, x, delay }: {
  lang: string; mine: number; ref: number | undefined; ratio: number | null; pass: boolean | null; color: string; x: (v: number) => string; delay: number;
}) {
  const said =
    pass == null
      ? "No reference score for this language"
      : ratio === Infinity
        ? "No errors"
        : mine > ref!
          ? `The reference makes ${(mine / ref!).toFixed(2)}× fewer mistakes`
          : `${ratio!.toFixed(2)}× fewer mistakes than the reference${pass ? "" : `; the goal is ${GOAL}×`}`;
  return (
    <>
      <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium" title={langName(lang)}>
        <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate">{langName(lang)}</span>
      </span>
      <div className="relative h-5 min-w-0" title={said}>
        <span className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-foreground/[0.05]" />
        <motion.span
          className="absolute top-1/2 left-0 h-2 -translate-y-1/2 rounded-full"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: x(mine) }}
          transition={{ type: "spring", stiffness: 80, damping: 20, delay }}
        />
        {ref != null && (
          <>
            <span className="absolute inset-y-0 border-l-[1.5px] border-dashed border-foreground/55" style={{ left: x(ref) }} />
            <span className="absolute inset-y-0.5 border-l-[1.5px] border-dotted border-good" style={{ left: x(ref / GOAL) }} />
          </>
        )}
      </div>
      <span className="text-right text-[13px] whitespace-nowrap tabular-nums">
        <span className="font-semibold">{pct(mine)}</span>
        <span className="ml-1.5 text-muted-foreground @min-[34rem]/results:hidden">{ref != null ? `/ ${pct(ref)}` : ""}</span>
      </span>
      <span title={said} className={cn("hidden items-center justify-end gap-1 text-[12px] font-medium whitespace-nowrap tabular-nums @min-[34rem]/results:flex", pass ? "text-good" : "text-muted-foreground")}>
        {pass == null ? (
          "—"
        ) : (
          <>
            {pass ? <Check className="size-3.5" strokeWidth={3} /> : <Minus className="size-3.5" />}
            {ratio === Infinity ? "no errors" : mine > ref! ? "ref leads" : `${ratio!.toFixed(1)}×`}
            <span className="ml-1 font-normal text-muted-foreground">vs {pct(ref)}</span>
          </>
        )}
      </span>
    </>
  );
}
