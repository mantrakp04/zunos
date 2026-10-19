import { cn } from "@zunos/ui/lib/utils";
import { useMemo, useState } from "react";

import type { RunDetail } from "../../../shared/types";
import { Eyebrow, langName, pct } from "../../ui";
import { type Line, LineChart, type RefLine } from "./LineChart";
import { isActive } from "./Versions";

/** The selected model's curves: word error rate per language with Sarvam for reference, and loss. */
export function RunView({ run, langs, colorOf, baselines }: { run: RunDetail; langs: string[]; colorOf: (l: string) => string; baselines: Record<string, number> }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showRefs, setShowRefs] = useState(true);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const live = isActive(run);

  const evals = useMemo(() => run.evals.filter((e) => e.step != null).sort((a, b) => a.step! - b.step!), [run.evals]);
  const runLangs = useMemo(() => {
    const present = new Set(evals.flatMap((e) => Object.keys(e.langs)));
    return [...langs.filter((l) => present.has(l)), ...[...present].filter((l) => !langs.includes(l))];
  }, [evals, langs]);
  const steps = useMemo(() => run.steps.filter((s) => s.loss != null), [run.steps]);

  const xDomain: [number, number] = useMemo(() => {
    const xs = [...evals.map((e) => e.step!), ...steps.map((s) => s.step)];
    return xs.length ? [Math.min(0, ...xs), Math.max(...xs)] : [0, 1];
  }, [evals, steps]);

  const werLines: Line[] = [
    ...runLangs
      .filter((l) => !hidden.has(l))
      .map((l) => ({
        key: l,
        label: langName(l),
        color: colorOf(l),
        points: evals.filter((e) => e.langs[l] != null).map((e) => ({ x: e.step!, y: e.langs[l]! })),
        ref: baselines[l],
        live,
      })),
  ];
  if (!hidden.has("avg"))
    werLines.unshift({ key: "avg", label: "Average", color: "var(--foreground)", width: 2.75, area: true, points: evals.map((e) => ({ x: e.step!, y: e.score })), live });
  const refs: RefLine[] = showRefs
    ? runLangs.filter((l) => baselines[l] != null && !hidden.has(l)).map((l) => ({ key: l, label: `Sarvam ${langName(l)}`, color: colorOf(l), y: baselines[l]! }))
    : [];

  // Keep the y range about the useful part: a first eval of a base model can be 200% WER.
  const yMax = useMemo(() => {
    const vals = evals.flatMap((e) => [e.score, ...Object.values(e.langs)]).sort((a, b) => a - b);
    if (!vals.length) return 0.5;
    const q90 = vals[Math.floor(vals.length * 0.9)]!;
    const refMax = Math.max(0, ...Object.values(baselines));
    const top = Math.min(vals[vals.length - 1]!, Math.max(q90 * 1.35, refMax * 1.15));
    return Math.ceil((top * 1.06) / 0.05) * 0.05;
  }, [evals, baselines]);
  const lossMax = useMemo(() => {
    const v = Math.max(0.1, ...steps.map((s) => s.loss!));
    return Math.ceil(v * 1.08 * 10) / 10;
  }, [steps]);

  const best = evals.find((e) => e.step === run.bestStep) ?? null;
  const marker = run.bestStep != null && best ? { x: run.bestStep, label: `Best · step ${run.bestStep}` } : null;
  const titleFor = (x: number) => (x === 0 ? "Step 0 · before training" : `Step ${x}`);
  const recipe = recipeOf(run.cfg);

  const toggle = (k: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <Eyebrow>Word error rate on your held-back clips · lower is better</Eyebrow>
          {recipe && <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">{recipe}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <LegendChip on={!hidden.has("avg")} onClick={() => toggle("avg")} swatch={<span className="h-[3px] w-3.5 rounded-full bg-foreground" />}>
            Average
          </LegendChip>
          {runLangs.map((l) => (
            <LegendChip key={l} on={!hidden.has(l)} onClick={() => toggle(l)} swatch={<span className="h-[3px] w-3.5 rounded-full" style={{ background: colorOf(l) }} />}>
              {langName(l)}
            </LegendChip>
          ))}
          {Object.keys(baselines).length > 0 && (
            <LegendChip
              on={showRefs}
              onClick={() => setShowRefs((s) => !s)}
              swatch={<span className="w-3.5 border-t-[1.5px] border-dashed border-muted-foreground" />}
            >
              Sarvam
            </LegendChip>
          )}
        </div>
      </div>

      {evals.length >= 2 ? (
        <LineChart
          lines={werLines}
          refs={refs}
          height={300}
          xDomain={xDomain}
          yDomain={[0, yMax]}
          yFormat={(v) => `${Math.round(v * 1000) / 10}%`}
          marker={marker}
          hoverX={hoverX}
          onHoverX={setHoverX}
          tooltipTitle={titleFor}
          drawKey={run.id}
        />
      ) : (
        <Waiting live={live} every={Number(run.cfg.eval_every) || null} />
      )}

      <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <BestTable best={best} langs={runLangs} colorOf={colorOf} baselines={baselines} step={run.bestStep} />
        <div className="rounded-[16px] bg-foreground/[0.025] p-3 pb-1 shadow-[inset_0_0_0_1px_var(--border)]">
          <div className="mb-1 flex items-baseline justify-between px-1">
            <Eyebrow>Training loss</Eyebrow>
            <span className="text-[11px] tabular-nums text-muted-foreground">{steps.length ? `${steps[steps.length - 1]!.loss!.toFixed(3)} at step ${steps[steps.length - 1]!.step}` : "—"}</span>
          </div>
          {steps.length >= 2 ? (
            <LineChart
              lines={[{ key: "loss", label: "Loss", color: "var(--brand-gold)", points: steps.map((s) => ({ x: s.step, y: s.loss! })), area: true, width: 1.75, live }]}
              height={132}
              xDomain={xDomain}
              yDomain={[0, lossMax]}
              yFormat={(v) => v.toFixed(lossMax > 1 ? 1 : 2)}
              marker={null}
              hoverX={hoverX}
              onHoverX={setHoverX}
              tooltipTitle={titleFor}
              gutter={false}
              drawKey={run.id}
            />
          ) : (
            <p className="px-1 py-8 text-center text-[12px] text-muted-foreground">No loss logged yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function LegendChip({ on, onClick, swatch, children }: { on: boolean; onClick: () => void; swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-[background-color,color,opacity]",
        on ? "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.09]" : "text-muted-foreground opacity-55 hover:opacity-90",
      )}
    >
      {swatch}
      {children}
    </button>
  );
}

function BestTable({
  best,
  langs,
  colorOf,
  baselines,
  step,
}: {
  best: RunDetail["evals"][number] | null;
  langs: string[];
  colorOf: (l: string) => string;
  baselines: Record<string, number>;
  step: number | null;
}) {
  if (!best) return <div className="grid place-items-center rounded-[16px] p-6 text-[12.5px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">No best step yet.</div>;
  return (
    <div className="rounded-[16px] p-4 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="mb-3 flex items-baseline justify-between">
        <Eyebrow>At its best step{step != null && ` (${step})`}</Eyebrow>
        <span className="text-[11px] text-muted-foreground">vs Sarvam on the same clips</span>
      </div>
      <div className="grid gap-2">
        {langs.map((l) => {
          const v = best.langs[l];
          const ref = baselines[l];
          const d = v != null && ref != null ? (v - ref) * 100 : null;
          const scale = Math.max(v ?? 0, ref ?? 0, 0.01) * 1.1;
          return (
            <div key={l} className="grid grid-cols-[5.5rem_1fr_5.5rem] items-center gap-3">
              <span className="flex items-center gap-2 text-[12.5px] font-medium">
                <span className="size-2 rounded-full" style={{ background: colorOf(l) }} />
                {langName(l)}
              </span>
              <div className="relative h-5">
                <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full" style={{ width: `${((v ?? 0) / scale) * 100}%`, background: colorOf(l) }} />
                {ref != null && (
                  <div className="absolute top-0 bottom-0 border-l-[1.5px] border-dashed border-foreground/50" style={{ left: `${(ref / scale) * 100}%` }} title={`Sarvam ${pct(ref)}`} />
                )}
              </div>
              <span className="text-right text-[12px] tabular-nums">
                <span className="font-semibold">{pct(v)}</span>
                {d != null && (
                  <span className={cn("ml-1.5 text-[11px] font-semibold", d <= 0 ? "text-good" : "text-muted-foreground")}>
                    {d <= 0 ? "−" : "+"}
                    {Math.abs(d).toFixed(1)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
        <div className="mt-1 grid grid-cols-[5.5rem_1fr_5.5rem] items-center gap-3 border-t pt-2.5">
          <span className="text-[12.5px] font-semibold">Average</span>
          <span className="text-[11px] text-muted-foreground">dashed line: Sarvam · points of WER</span>
          <span className="text-right font-display text-[15px] font-bold tabular-nums">{pct(best.score)}</span>
        </div>
      </div>
    </div>
  );
}

function Waiting({ live, every }: { live: boolean; every: number | null }) {
  return (
    <div className="grid h-[220px] place-items-center rounded-[16px] text-center shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="max-w-xs">
        <div className="text-[13.5px] font-semibold">{live ? "The first score is on its way" : "No scores for this run"}</div>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          {live ? `The model is tested on your held-back clips${every ? ` every ${every} steps` : " as it trains"}. Curves show up after two tests.` : "It stopped before it was tested."}
        </p>
      </div>
    </div>
  );
}

function recipeOf(cfg: Record<string, unknown>) {
  const parts: string[] = [];
  if (cfg.lr != null) parts.push(`lr ${Number(cfg.lr).toExponential(0).replace("e-", "e-")}`);
  if (cfg.epochs != null) parts.push(`${cfg.epochs} epochs`);
  if (cfg.bs != null) parts.push(`batch ${cfg.bs}${cfg.accum && Number(cfg.accum) > 1 ? `×${cfg.accum}` : ""}`);
  if (cfg.eval_every != null) parts.push(`tested every ${cfg.eval_every} steps`);
  if (Number(cfg.freeze_enc)) parts.push("encoder frozen");
  return parts.join("  ·  ");
}
