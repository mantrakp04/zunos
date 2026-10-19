import "./train/train.css";

import { cn } from "@zunos/ui/lib/utils";
import { Laptop } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { RunDetail } from "../../shared/types";
import { Badge, ErrorNote, Eyebrow, PageHeader, shortOf, useAction, useAsync } from "../ui";
import type { ScreenProps } from "../ZunosApp";
import { DataStory, LivePanel, StartPanel } from "./train/NextModel";
import { PipelineTrack, TRACK, trackPos } from "./train/Pipeline";
import { RunView } from "./train/RunView";
import { baseLabel, isActive, shortDate, Versions } from "./train/Versions";

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
  const quote = useAsync(() => a.trainingQuote());
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
  const langOrder = useMemo(() => {
    const enabled = (langs.data ?? []).filter((l) => l.enabled).map((l) => l.code as string);
    const extra = [...(stats.data ?? []).map((s) => s.lang as string), ...Object.values(details.data ?? {}).flatMap((d) => d?.evals.flatMap((e) => Object.keys(e.langs)) ?? [])];
    return [...new Set([...enabled, ...extra])];
  }, [langs.data, stats.data, details.data]);
  const colorOf = (l: string) => `var(--zl-${(Math.max(0, langOrder.indexOf(l)) % 12) + 1})`;

  // Training waits until every enabled language has enough recorded (a language with no clips has no stats row).
  const short = useMemo(() => {
    if (!stats.data || !langs.data) return null;
    const enabled = langs.data.filter((l) => l.enabled).map((l) => l.code as string);
    return shortOf(enabled.map((lang) => stats.data!.find((s) => s.lang === lang) ?? { lang, trainSeconds: 0, testSeconds: 0 }));
  }, [stats.data, langs.data]);

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
  const installed = useMemo(() => new Set((models.data ?? []).map((m) => m.runId).filter((x): x is string => !!x)), [models.data]);
  const inUse = (models.data ?? []).find((m) => m.active)?.runId ?? null;

  const [picked, setPicked] = useState<string | null>(null);
  const selectedId = picked && list.some((r) => r.id === picked) ? picked : (active?.id ?? best?.id ?? list[0]?.id ?? null);
  const selected = selectedId ? (details.data?.[selectedId] ?? null) : null;
  const selectedSummary = list.find((r) => r.id === selectedId) ?? null;
  const selectedBase = selected
    ? `${baseLabel(selected.base, list).branch ? "fine-tuned" : "on Whisper"} ${baseLabel(selected.base, list).text} · ${shortDate(selected.createdAt)}`
    : "";

  // The hero: a run in flight (or a local transfer for one), otherwise the next model.
  const flightRun = live.transfer ? (list.find((r) => r.id === live.transfer!.runId) ?? null) : active;
  const inFlight = !!live.transfer || !!active;
  const pos = trackPos(flightRun, live.transfer);
  const stage = inFlight ? TRACK[Math.min(Math.max(pos.index, 0), TRACK.length - 1)]! : null;
  const flightName = flightRun?.name ?? live.transfer?.runId ?? "";

  return (
    <div className="@container mx-auto max-w-[76rem] px-10 pt-10 pb-14">
      <PageHeader eyebrow="Train" title="Your models" subtitle="Each training run makes a new version of your voice model. Pick one to see how it learned." />

      {/* ---- hero: the pipeline ---- */}
      <section
        className="zn-surface grain relative overflow-hidden p-6"
        style={{ "--rx": `calc(24px + (100% - 48px) * ${((Math.max(pos.index, 0) + 0.5) / TRACK.length).toFixed(3)})`, "--ry": "62%" } as React.CSSProperties}
      >
        {inFlight && <div className="zn-ripples opacity-90" />}
        <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--brand-gold)_18%,transparent),transparent)]" />

        <div className="@container relative">
          <div className="flex flex-col gap-5 @3xl:flex-row @3xl:items-start @3xl:justify-between">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={!runs.data && !live.transfer ? "loading" : (stage?.id ?? "idle")}
                initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="max-w-[34rem] min-w-0"
              >
                {!runs.data && !live.transfer ? (
                  <>
                    <div className="zt-skel h-3 w-24 rounded-full" />
                    <div className="zt-skel mt-4 h-8 w-72 rounded-lg" />
                    <div className="zt-skel mt-3 h-3.5 w-[28rem] max-w-full rounded-full" />
                    <div className="zt-skel mt-2 h-3.5 w-80 rounded-full" />
                  </>
                ) : stage ? (
                  <>
                    <Eyebrow className="flex items-center gap-2 text-brand">
                      <span className="relative flex size-2 shrink-0">
                        <span className="absolute inset-0 animate-ping rounded-full bg-brand opacity-60" />
                        <span className="relative size-2 rounded-full bg-brand" />
                      </span>
                      <span className="min-w-0 truncate" title={flightName}>
                        Training {flightName}
                      </span>
                      <span className="-ml-1 shrink-0 whitespace-nowrap">
                        · step {Math.min(pos.index + 1, TRACK.length)} of {TRACK.length}
                      </span>
                    </Eyebrow>
                    <h2 className="mt-2.5 font-display text-[30px] leading-[1.08] font-bold tracking-[-0.022em]">
                      {stage.title}
                      {pos.progress != null && <span className="ml-2 text-brand tabular-nums">{Math.round(pos.progress * 100)}%</span>}
                    </h2>
                    <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
                      {stage.desc} {stage.group === 1 ? "You can close zunos; the GPU keeps going and the model comes back on its own." : "Keep zunos open for this part."}
                    </p>
                  </>
                ) : (
                  <>
                    <Eyebrow>Next model</Eyebrow>
                    <h2 className="mt-2.5 font-display text-[30px] leading-[1.08] font-bold tracking-[-0.022em]">Train a new version</h2>
                    <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
                      Your clips go to a cloud GPU. It clones your voice to read thousands of new sentences, fine-tunes Whisper large-v3 on all of it, then
                      sends the model back to this Mac
                      {quote.data ? `, about ${quote.data.estimatedHours.toFixed(1)} h later.` : "."}
                    </p>
                  </>
                )}
              </motion.div>
            </AnimatePresence>

            {inFlight ? (
              <LivePanel
                run={flightRun}
                local={stage?.group === 0 ? "before" : stage?.group === 2 ? "after" : null}
                busy={stop.busy} error={stop.error} onStop={() => flightRun && stop.run(flightRun.id)} />
            ) : (
              <StartPanel
                quote={quote.data}
                quoteError={quote.error}
                loading={quote.loading}
                blocked={!!active}
                // Until the recordings are counted, hold the button (unless counting failed: then the server decides).
                short={short ?? []}
                counting={!short && !stats.error && !langs.error}
                onRecord={go && (() => go("record"))}
                busy={start.busy}
                error={start.error}
                onStart={() => start.run()}
              />
            )}
          </div>

          <div className="mt-7">
            <PipelineTrack pos={pos} live={inFlight} />
          </div>

          {stats.data && stats.data.length > 0 && (
            <div className="mt-6 border-t pt-5">
              <DataStory stats={stats.data} colorOf={colorOf} />
            </div>
          )}
          <ErrorNote error={stats.error} className="mt-4" />
        </div>
      </section>

      {/* ---- versions ---- */}
      <div className="mt-11 mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-[22px] leading-tight font-bold tracking-[-0.015em]">Versions</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">Oldest on the left. Scores are average word error rate on clips the model never trained on.</p>
        </div>
        {referenceAvg != null && (
          <div className="hidden shrink-0 text-right text-[12px] text-muted-foreground @2xl:block">
            Reference averages <span className="font-semibold text-foreground tabular-nums">{(referenceAvg * 100).toFixed(1)}%</span>
          </div>
        )}
      </div>

      {runs.data && list.length === 0 ? (
        <div className="rounded-[18px] p-8 text-center text-[13px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
          No versions yet. Your first model shows up here as soon as you start training.
        </div>
      ) : (
        <Versions
          runs={list}
          details={details.data ?? {}}
          selected={selectedId}
          onSelect={setPicked}
          bestId={best?.id ?? null}
          installed={installed}
          referenceAvg={referenceAvg}
        />
      )}
      <ErrorNote error={runs.error ?? details.error} className="mt-3" />

      {/* ---- the selected version ---- */}
      <AnimatePresence mode="wait" initial={false}>
        {selected && selectedSummary && (
          <motion.section
            key={selected.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="zn-surface mt-3 p-6"
          >
            <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
              <h3 title={selected.name} className="max-w-full min-w-0 truncate font-display text-[26px] leading-[1.15] font-bold tracking-[-0.02em]">
                {selected.name}
              </h3>
              <span className="max-w-full min-w-0 truncate text-[13px] text-muted-foreground" title={selectedBase}>
                {selectedBase}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                {best?.id === selected.id && <Badge tone="brand">Best so far</Badge>}
                {inUse === selected.id ? (
                  <Badge tone="good">
                    <Laptop className="size-3" /> In use
                  </Badge>
                ) : installed.has(selected.id) ? (
                  <Badge tone="muted">On this Mac</Badge>
                ) : null}
                <Badge tone={isActive(selectedSummary) ? "brand" : selectedSummary.status === "failed" ? "warn" : "muted"}>
                  {isActive(selectedSummary) ? "Training" : cap(selectedSummary.status)}
                </Badge>
              </span>
            </div>
            <RunView run={{ ...selected, ...selectedSummary }} langs={langOrder} colorOf={colorOf} baselines={baselines} />
          </motion.section>
        )}
      </AnimatePresence>
      {!selected && details.loading && list.length > 0 && <div className={cn("zt-skel mt-3 h-[420px] rounded-[20px]")} />}
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
