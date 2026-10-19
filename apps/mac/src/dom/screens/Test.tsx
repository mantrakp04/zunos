import { MagneticTabs } from "@zunos/ui/components/ruixen/magnetic-tabs";
import { ProgressiveFluxLoader } from "@zunos/ui/components/ruixen/progressive-flux-loader";
import { useState } from "react";

import type { EvalResult, Lang } from "../../shared/types";
import { Badge, Button, Card, ErrorNote, langName, PageHeader, pct, Stat, useAction, useAsync } from "../ui";
import type { ScreenProps } from "../ZunosApp";

export default function Test({ a, live }: ScreenProps) {
  const models = useAsync(() => a.models());
  const baselines = useAsync(() => a.baselines());
  const active = models.data?.find((m) => m.active && m.format === "hf");
  const result = useAsync(() => (active ? a.latestEval(active.id) : Promise.resolve(null)), [active?.id]);
  const run = useAction(async () => result.setData(await a.evaluate()));
  const choose = useAction(async (id: string) => {
    await a.setActiveModel(id);
    await models.reload();
  });
  const hfModels = (models.data ?? []).filter((m) => m.format === "hf");
  const languages = useAsync(() => a.languages());
  const [filter, setFilter] = useState<"all" | Lang>("all");
  // Languages to show: the ones scored in the last test, else the user's languages.
  const scored = Object.keys(result.data?.scores ?? {}).filter((k) => k !== "avg");
  const langs = scored.length ? scored : (languages.data ?? []).filter((l) => l.enabled).map((l) => l.code);
  const sarvam = (l: Lang) => baselines.data?.find((b) => b.lang === l)?.wer;

  return (
    <div>
      <PageHeader
        title="Test"
        subtitle="Scores your model on recordings it never trained on. Word error rate: lower is better. For languages typed in English letters, spelling variants are forgiven (chhe = che)."
      >
        <Button variant="brand" loading={run.busy} disabled={!active || live.engine === "error"} onClick={() => run.run()}>
          Run test
        </Button>
      </PageHeader>

      {live.evalProgress && (
        <Card className="mb-6">
          <ProgressiveFluxLoader
            value={(live.evalProgress.done / Math.max(1, live.evalProgress.total)) * 100}
            phases={[{ at: 0, label: "Transcribing your test clips" }, { at: 99, label: "Scoring" }]}
            gradient="linear-gradient(90deg, var(--brand), var(--brand-gold))"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {live.evalProgress.done} of {live.evalProgress.total} clips
          </p>
        </Card>
      )}
      <ErrorNote error={run.error ?? live.engineError} />

      <div className="mb-6 grid grid-cols-3 gap-3">
        {langs.map((l) => {
          const mine = result.data?.scores[l];
          const base = sarvam(l);
          return (
            <Card key={l}>
              <Stat
                label={langName(l)}
                value={pct(mine)}
                hint={base != null && <>Sarvam: {pct(base)}{mine != null && base > 0 && <> · {(base / mine).toFixed(2)}× better</>}</>}
              />
            </Card>
          );
        })}
      </div>

      {active && (
        <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <span>Model</span>
          <select
            className="rounded-md border bg-background px-2 py-1 text-foreground"
            value={active.id}
            disabled={choose.busy || run.busy}
            onChange={(e) => choose.run(e.target.value)}
          >
            {hfModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {result.data && <span>· tested {new Date(result.data.createdAt).toLocaleString()} with beam search</span>}
        </div>
      )}

      {result.data && (
        <>
          <MagneticTabs
            items={[{ value: "all", label: "All" }, ...langs.map((l) => ({ value: l, label: langName(l) }))]}
            defaultValue="all"
            onChange={(v) => setFilter(v as typeof filter)}
            sound={false}
          />
          <ClipTable rows={result.data.rows.filter((r) => filter === "all" || r.lang === filter)} />
        </>
      )}
      {!result.data && !result.loading && active && <Card>No test results for this model yet. Run the test to score it.</Card>}
    </div>
  );
}

function ClipTable({ rows }: { rows: EvalResult["rows"] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-xl border">
      {rows.map((r) => (
        <div key={r.id} className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1 border-b p-3 text-sm last:border-0">
          <div className="row-span-2 flex flex-col gap-1">
            <Badge tone={r.wer < 0.15 ? "good" : r.wer < 0.3 ? "muted" : "warn"}>{pct(r.wer)}</Badge>
            <span className="text-xs text-muted-foreground">{r.id}</span>
          </div>
          <p className="text-muted-foreground">{r.ref}</p>
          <p>{r.hyp}</p>
        </div>
      ))}
    </div>
  );
}
