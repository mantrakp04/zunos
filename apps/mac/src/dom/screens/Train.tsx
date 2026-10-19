import { SparkChart } from "@zunos/ui/components/ruixen/spark-chart";
import { cn } from "@zunos/ui/lib/utils";
import { useState } from "react";

import { useEffect } from "react";

import type { RunDetail } from "../../shared/types";
import { Badge, Button, Card, ErrorNote, LANG_NAMES, minutes, PageHeader, pct, Stat, useAction, useAsync } from "../ui";
import type { ScreenProps } from "../ZunosApp";

const STAGES: Record<string, string> = {
  data: "Preparing your recordings", setup: "Setting up the GPU", gen: "Cloning your voice", filter: "Checking clip quality",
  train: "Fine-tuning Whisper", export: "Packaging the model", upload: "Uploading the model", done: "Done", downloaded: "Installed",
};
const PHASES = { packing: "Packing your recordings…", uploading: "Uploading…", starting: "Starting a GPU…", downloading: "Downloading your model…", installing: "Installing…" };

export default function Train({ a, live }: ScreenProps) {
  const runs = useAsync(() => a.runs());
  const stats = useAsync(() => a.stats());
  const langs = useAsync(() => a.languages());
  const quote = useAsync(() => a.trainingQuote());
  const start = useAction(async () => {
    await a.startTraining((langs.data ?? []).filter((l) => l.enabled).map((l) => l.code));
    await runs.reload();
  });
  const stop = useAction(async (id: string) => {
    await a.stopTraining(id);
    await runs.reload();
  });
  const active = (runs.data ?? []).find((r) => ["uploading", "queued", "running"].includes(r.status));
  // Runs are synced by the native shell every 30 s; refresh this view on the same cadence.
  useEffect(() => {
    const t = setInterval(() => runs.reload(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useAsync(() => (open ? a.run(open) : Promise.resolve(null)), [open]);
  const best = (runs.data ?? []).filter((r) => r.bestScore != null).sort((x, y) => x.bestScore! - y.bestScore!)[0];

  return (
    <div>
      <PageHeader
        title="Train"
        subtitle="Training clones your voice to read thousands of new sentences, then fine-tunes Whisper large-v3 on them plus your real recordings. It runs on a cloud GPU and takes about an hour."
      />

      <div className="mb-6 grid grid-cols-[1fr_20rem] gap-6">
        <Card>
          <h2 className="mb-4 font-medium">Your data</h2>
          <div className="grid grid-cols-3 gap-4">
            {(stats.data ?? []).map((s) => (
              <Stat
                key={s.lang}
                label={LANG_NAMES[s.lang]}
                value={minutes(s.trainSeconds)}
                hint={`${s.trainClips} training clips · ${minutes(s.testSeconds)} held back`}
              />
            ))}
          </div>
        </Card>
        <Card className="flex flex-col gap-3">
          <h2 className="font-medium">New model</h2>
          {quote.data ? (
            <>
              <p className="text-sm text-muted-foreground">
                {quote.data.gpu} · about {quote.data.estimatedHours.toFixed(1)} h at ${quote.data.pricePerHour.toFixed(2)}/h
              </p>
              <Button variant="brand" disabled={!quote.data.available || !!active} loading={start.busy} onClick={() => start.run()}>
                Start training · about ${(quote.data.pricePerHour * quote.data.estimatedHours).toFixed(2)}
              </Button>
              {!quote.data.available && <p className="text-xs text-muted-foreground">{quote.data.reason}</p>}
              {live.transfer && (
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <span>{PHASES[live.transfer.phase]}</span>
                  <div className="h-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-brand transition-all" style={{ width: `${Math.round(live.transfer.progress * 100)}%` }} />
                  </div>
                </div>
              )}
              <ErrorNote error={start.error} />
            </>
          ) : quote.loading ? (
            <p className="text-sm text-muted-foreground">Checking GPU prices…</p>
          ) : (
            <ErrorNote error={quote.error} />
          )}
        </Card>
      </div>

      <h2 className="mb-3 font-medium">Training runs</h2>
      <div className="flex flex-col gap-2">
        {(runs.data ?? []).map((r) => (
          <div key={r.id} className="rounded-xl border">
            <button className="flex w-full items-center gap-4 p-4 text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <span className="w-16 font-medium">{r.name}</span>
              <span className="w-56 truncate text-sm text-muted-foreground">{r.base}</span>
              <Badge tone={r.status === "done" ? "good" : r.status === "failed" ? "warn" : "muted"}>{r.status}</Badge>
              {best?.id === r.id && <Badge tone="brand">best</Badge>}
              {["queued", "running"].includes(r.status) && (
                <span className="text-xs text-muted-foreground">
                  {STAGES[r.stage ?? ""] ?? r.stage} {r.costUsd != null && `· $${r.costUsd.toFixed(2)} so far`}
                </span>
              )}
              <span className="ml-auto text-sm tabular-nums text-muted-foreground">
                best avg WER {pct(r.bestScore)} {r.bestStep != null && `at step ${r.bestStep}`}
              </span>
            </button>
            {open === r.id && ["queued", "running"].includes(r.status) && (
              <div className="flex justify-end border-t px-4 py-2">
                <Button variant="danger" loading={stop.busy} onClick={() => stop.run(r.id)}>
                  Stop and release the GPU
                </Button>
              </div>
            )}
            {open === r.id && detail.data && <RunCharts run={detail.data} />}
          </div>
        ))}
      </div>
      <ErrorNote error={runs.error ?? stop.error} />
    </div>
  );
}

function RunCharts({ run }: { run: RunDetail }) {
  const langs = (["en", "hi", "gu"] as const).filter((l) => run.evals.some((e) => e[l] != null));
  return (
    <div className="grid grid-cols-2 gap-4 border-t p-4">
      <ChartCard title="Average WER on your test clips" data={run.evals.map((e) => e.score)} format={pct} />
      <ChartCard title="Training loss" data={run.steps.map((s) => s.loss ?? 0)} format={(v) => v.toFixed(3)} />
      {langs.map((l) => (
        <ChartCard key={l} title={`${LANG_NAMES[l]} WER`} data={run.evals.map((e) => e[l] ?? 0)} format={pct} />
      ))}
    </div>
  );
}

function ChartCard({ title, data, format }: { title: string; data: number[]; format: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length < 2) return null;
  return (
    <div className={cn("rounded-lg bg-muted/40 p-3")}>
      <div className="mb-2 flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{title}</span>
        <span className="tabular-nums text-foreground">{format(hover ?? data[data.length - 1]!)}</span>
      </div>
      <SparkChart data={data} height={64} color="var(--brand)" formatValue={format} onValueChange={(v) => setHover(v)} onActiveChange={(on) => !on && setHover(null)} />
    </div>
  );
}
