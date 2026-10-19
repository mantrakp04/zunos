import { cn } from "@zunos/ui/lib/utils";
import { Play } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import type { Actions } from "../../../services/actions";
import type { Lang, LiveState, ModelItem, RunDetail, RunSummary } from "../../../shared/types";
import { Button, ErrorNote, useAction, useAsync } from "../../ui";
import { Clips } from "./Clips";
import { Running } from "./Running";
import { RunView } from "./RunView";
import { TestResults } from "./TestResults";
import { baseLabel, isActive, shortDate } from "./Versions";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * One version: what it is and whether it's the one Dictate uses, how it tests against the reference
 * (the 2× goal per language), how it learned, and every test clip. Sections are divided by hairlines.
 */
export function ModelDetail({ a, live, run, runs, model, inUse, best, langs, colorOf, baselines, onModels }: {
  a: Actions;
  live: LiveState;
  run: RunDetail & RunSummary;
  runs: RunSummary[];
  /** The installed (accurate) model this run produced, if it's on this Mac. */
  model: ModelItem | null;
  inUse: boolean;
  best: boolean;
  langs: string[];
  colorOf: (lang: string) => string;
  baselines: Record<string, number>;
  /** Reload the model list after the model in use changes. */
  onModels: () => Promise<unknown>;
}) {
  const result = useAsync(() => (model ? a.latestEval(model.id) : Promise.resolve(null)), [model?.id]);
  const use = useAction(async () => {
    await a.setActiveModel(model!.id);
    await onModels();
  });
  // Tests run on the model in use; testing another one makes it the one in use first, and says so.
  const test = useAction(async () => {
    if (!inUse) {
      await a.setActiveModel(model!.id);
      await onModels();
    }
    result.setData(await a.evaluate());
  });

  const testing = test.busy || (inUse && !!live.evalProgress);
  const base = baseLabel(run.base, runs);
  const state = isActive(run) ? "Training" : run.status === "failed" ? "Failed" : run.status === "cancelled" ? "Stopped" : model ? null : "Not on this Mac";
  const trained = run.evals.filter((e) => e.step != null).find((e) => e.step === run.bestStep) ?? null;
  const reference = (l: string) => baselines[l];

  return (
    <div className="flex flex-col">
      {/* ---- what it is ---- */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-6">
        <div className="min-w-0">
          <h2 title={run.name} className="truncate font-display text-[30px] leading-[1.1] font-bold tracking-[-0.022em]">
            {run.name}
          </h2>
          <p className="mt-1 flex min-w-0 flex-wrap gap-x-1.5 text-[13px] text-muted-foreground">
            <span className="min-w-0 truncate" title={base.text}>
              {base.branch ? `Fine-tuned ${base.text}` : base.text}
            </span>
            <span className="whitespace-nowrap">· {shortDate(run.createdAt)}</span>
            {best && <span className="font-medium whitespace-nowrap text-brand">· Best so far</span>}
            {state && <span className="whitespace-nowrap">· {state}</span>}
          </p>
        </div>
        {model && (
          <div className="flex shrink-0 items-center gap-2">
            {inUse ? (
              <span className="flex items-center gap-1.5 px-2 text-[13px] font-medium text-good">
                <span className="size-1.5 rounded-full bg-good" /> In use
              </span>
            ) : (
              <Button variant="outline" size="sm" loading={use.busy} disabled={testing} onClick={() => use.run()}>
                Use this model
              </Button>
            )}
            <Button
              variant="brand"
              size="sm"
              loading={test.busy}
              disabled={testing || live.engine === "error"}
              title={inUse ? undefined : "Makes it the model in use, then tests it"}
              onClick={() => test.run()}
            >
              {!test.busy && <Play className="size-3 fill-current" />}
              {inUse ? "Run test" : "Use and test"}
            </Button>
          </div>
        )}
      </header>
      <ErrorNote error={use.error ?? test.error ?? result.error} className="mb-4" />

      {/* ---- how it tests ---- */}
      <Section>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={testing ? "running" : result.data ? "tested" : "untested"}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {testing ? (
              <Running done={live.evalProgress?.done ?? 0} total={live.evalProgress?.total ?? 0} ids={result.data?.rows.map((r) => r.id)} />
            ) : result.data ? (
              <TestResults scores={result.data.scores} langs={langs} reference={reference} colorOf={colorOf} source={`Tested on this Mac · ${when(result.data.createdAt)}`} />
            ) : trained ? (
              <TestResults
                scores={{ ...trained.langs, avg: trained.score }}
                langs={langs}
                reference={reference}
                colorOf={colorOf}
                source={model ? `Not tested on this Mac yet · from training, step ${trained.step}` : `From training, step ${trained.step}`}
              />
            ) : (
              <p className="text-[13px] text-muted-foreground">{model ? "Not tested yet." : "No scores for this version."}</p>
            )}
          </motion.div>
        </AnimatePresence>
      </Section>

      {/* ---- how it learned ---- */}
      <Section>
        <RunView run={run} langs={langs} colorOf={colorOf} baselines={baselines} />
      </Section>

      {/* ---- every clip ---- */}
      {result.data && !testing && (
        <Section>
          <Clips rows={result.data.rows} langs={langs.filter((l) => result.data!.rows.some((r) => r.lang === l)) as Lang[]} />
        </Section>
      )}
    </div>
  );
}

function Section({ className, children }: { className?: string; children: React.ReactNode }) {
  return <section className={cn("border-t border-border py-7", className)}>{children}</section>;
}
