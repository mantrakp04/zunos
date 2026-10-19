import "./train/train.css";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { RunDetail } from "../../shared/types";
import { ErrorNote, Eyebrow, PageHeader, pct, useAction, useAsync } from "../ui";
import type { ScreenProps } from "../ZunosApp";
import { ModelDetail } from "./train/ModelDetail";
import { DataStory, LiveRow, StartRow } from "./train/NextModel";
import { PipelineTrack, type QuoteInfo, stagesOf, stageTitle, trackPos } from "./train/Pipeline";
import { isActive, Versions } from "./train/Versions";

/**
 * Train: the next model (or the one in flight) as one action and its track, what goes into it, then
 * every version. Pick a version to see how it tests against the reference and how it learned. One
 * page, grouped by type, space and hairlines rather than boxes.
 */
export default function Train({ a, live, go }: ScreenProps) {
  const runs = useAsync(() => a.runs());
  const ids = (runs.data ?? []).map((r) => r.id).join(",");
  const details = useAsync(async () => {
    const list = runs.data ?? [];
    const got = await Promise.all(list.map((r) => a.run(r.id)));
    return Object.fromEntries(list.map((r, i) => [r.id, got[i] ?? null])) as Record<string, RunDetail | null>;
  }, [ids]);
  const stats = useAsync(() => a.stats());
  const langs = useAsync(() => a.languages());
  const quote = useAsync(() => a.trainingQuote() as Promise<QuoteInfo>);
  const baselineList = useAsync(() => a.baselines());
  const models = useAsync(() => a.models());

  const start = useAction(async () => {
    await a.startTraining((langs.data ?? []).filter((l) => l.enabled).map((l) => l.code));
    await runs.reload();
  });
  const stop = useAction(async (id: string) => {
    await a.stopTraining(id);
    await runs.reload();
  });

  const list = runs.data ?? [];
  const active = list.find(isActive) ?? null;

  // Runs are synced by the native shell every 30 s; refresh this view on the same cadence.
  const tick = useRef(() => {});
  tick.current = () => {
    runs.reload();
    if (active) details.reload();
  };
  useEffect(() => {
    const t = setInterval(() => tick.current(), 15_000);
    return () => clearInterval(t);
  }, []);

  // Language colors follow the language, in the order you picked them.
  const enabled = useMemo(() => (langs.data ?? []).filter((l) => l.enabled).map((l) => l.code as string), [langs.data]);
  const langOrder = useMemo(() => {
    const extra = [...(stats.data ?? []).map((s) => s.lang as string), ...Object.values(details.data ?? {}).flatMap((d) => d?.evals.flatMap((e) => Object.keys(e.langs)) ?? [])];
    return [...new Set([...enabled, ...extra])];
  }, [enabled, stats.data, details.data]);
  const colorOf = (l: string) => `var(--zl-${(Math.max(0, langOrder.indexOf(l)) % 12) + 1})`;

  // One entry per enabled language (a language with no clips has no stats row), for Start training.
  const counts = useMemo(
    () => (stats.data && langs.data ? enabled.map((lang) => stats.data!.find((s) => s.lang === lang) ?? { lang, trainSeconds: 0, testSeconds: 0 }) : null),
    [stats.data, langs.data, enabled],
  );

  const baselines = useMemo(() => {
    const out: Record<string, number> = {};
    for (const b of baselineList.data ?? []) out[b.lang] = b.wer;
    return out;
  }, [baselineList.data]);
  const referenceAvg = useMemo(() => {
    const v = langOrder.map((l) => baselines[l]).filter((x): x is number => x != null);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  }, [langOrder, baselines]);

  const best = list.filter((r) => r.bestScore != null && !isActive(r)).sort((x, y) => x.bestScore! - y.bestScore!)[0] ?? null;
  const hf = (models.data ?? []).filter((m) => m.format === "hf");
  const installed = useMemo(() => new Set(hf.map((m) => m.runId).filter((x): x is string => !!x)), [models.data]);
  const inUse = hf.find((m) => m.active)?.runId ?? null;

  const [picked, setPicked] = useState<string | null>(null);
  const selectedId = picked && list.some((r) => r.id === picked) ? picked : (inUse ?? active?.id ?? best?.id ?? list[0]?.id ?? null);
  const selected = selectedId ? (details.data?.[selectedId] ?? null) : null;
  const selectedSummary = list.find((r) => r.id === selectedId) ?? null;

  // The top: a run in flight (or a local transfer for one), otherwise the next model.
  const flightRun = live.transfer ? (list.find((r) => r.id === live.transfer!.runId) ?? null) : active;
  const inFlight = !!live.transfer || !!active;
  const stages = stagesOf(flightRun, quote.data);
  const pos = trackPos(stages, flightRun, live.transfer);
  const stage = inFlight ? stages[Math.min(Math.max(pos.index, 0), stages.length - 1)]! : null;
  const flightName = flightRun?.name ?? live.transfer?.runId ?? "";

  return (
    <div className="@container mx-auto max-w-[76rem] px-10 pt-10 pb-16">
      <PageHeader title="Train" />

      {/* ---- the next model, or the one in flight ---- */}
      <section className="pb-9">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={!runs.data && !live.transfer ? "loading" : (stage?.id ?? "idle")}
            initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="min-w-0"
          >
            {stage ? (
              <>
                <Eyebrow className="flex min-w-0 items-center gap-2 text-brand">
                  <span className="relative flex size-2 shrink-0">
                    <span className="absolute inset-0 animate-ping rounded-full bg-brand opacity-60" />
                    <span className="relative size-2 rounded-full bg-brand" />
                  </span>
                  <span className="min-w-0 truncate" title={flightName}>
                    Training {flightName}
                  </span>
                  <span className="-ml-1 shrink-0 whitespace-nowrap">
                    · step {Math.min(pos.index + 1, stages.length)} of {stages.length}
                  </span>
                </Eyebrow>
                <h2 className="mt-2 font-display text-[30px] leading-[1.1] font-bold tracking-[-0.022em]">
                  {stageTitle(stage)}
                  {pos.progress != null && <span className="ml-2 text-brand tabular-nums">{Math.round(pos.progress * 100)}%</span>}
                </h2>
              </>
            ) : (
              <>
                <Eyebrow>Next model</Eyebrow>
                <h2 className="mt-2 font-display text-[30px] leading-[1.1] font-bold tracking-[-0.022em]">Train a new version</h2>
              </>
            )}
          </motion.div>
        </AnimatePresence>

        <div className="mt-5">
          {inFlight ? (
            <LiveRow
              run={flightRun}
              local={stage?.where === "mac" ? (pos.index < stages.findIndex((s) => s.where === "cloud") ? "before" : "after") : null}
              busy={stop.busy}
              error={stop.error}
              onStop={() => flightRun && stop.run(flightRun.id)}
            />
          ) : (
            <StartRow
              quote={quote.data}
              quoteError={quote.error}
              loading={quote.loading}
              blocked={!!active}
              counts={counts}
              onRecord={go && (() => go("record"))}
              busy={start.busy}
              error={start.error}
              onStart={() => start.run()}
            />
          )}
        </div>

        <div className="mt-8">
          <PipelineTrack stages={stages} pos={pos} live={inFlight} />
        </div>
      </section>

      {/* ---- what goes into it ---- */}
      {stats.data && stats.data.length > 0 && (
        <section className="border-t border-border py-8">
          <DataStory stats={stats.data} colorOf={colorOf} />
        </section>
      )}
      <ErrorNote error={stats.error} className="mb-4" />

      {/* ---- versions, and the one you picked ---- */}
      <section className="border-t border-border pt-8">
        <div className="grid gap-x-10 gap-y-8 @min-[60rem]:grid-cols-[19rem_minmax(0,1fr)]">
          {/* Bleeds by the rows' padding so their text lines up with the page. */}
          <div className="-mx-3 min-w-0 @min-[60rem]:sticky @min-[60rem]:top-6 @min-[60rem]:max-h-[calc(100vh-5rem)] @min-[60rem]:self-start @min-[60rem]:overflow-y-auto @min-[60rem]:scrollbar-none">
            <div className="mb-2 flex items-baseline justify-between gap-3 px-3">
              <Eyebrow>Versions</Eyebrow>
              {referenceAvg != null && <span className="text-[11.5px] whitespace-nowrap tabular-nums text-muted-foreground">Reference {pct(referenceAvg)}</span>}
            </div>
            {runs.data && list.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground">No versions yet.</p>
            ) : (
              <Versions
                runs={list}
                details={details.data ?? {}}
                selected={selectedId}
                onSelect={setPicked}
                bestId={best?.id ?? null}
                inUse={inUse}
                installed={installed}
                referenceAvg={referenceAvg}
              />
            )}
            <ErrorNote error={runs.error ?? details.error} className="mt-3" />
          </div>

          <div className="min-w-0">
            <AnimatePresence mode="wait" initial={false}>
              {selected && selectedSummary ? (
                <motion.div
                  key={selected.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
                  <ModelDetail
                    a={a}
                    live={live}
                    run={{ ...selected, ...selectedSummary }}
                    runs={list}
                    model={hf.find((m) => m.runId === selected.id) ?? null}
                    inUse={inUse === selected.id}
                    best={best?.id === selected.id}
                    langs={langOrder}
                    colorOf={colorOf}
                    baselines={baselines}
                    onModels={models.reload}
                  />
                </motion.div>
              ) : details.loading && list.length > 0 ? (
                <div className="zt-skel h-[420px] rounded-[20px]" />
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </section>
    </div>
  );
}
