import { Play } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";

import type { Lang } from "../../shared/types";
import { Bean } from "../Bean";
import { Button, ErrorNote, PageHeader, useAction, useAsync } from "../ui";
import type { ScreenProps } from "../ZunosApp";
import { Clips } from "./test/Clips";
import { ModelPicker } from "./test/ModelPicker";
import { Running } from "./test/Running";
import { Scoreboard } from "./test/Scoreboard";

const swap = {
  initial: { opacity: 0, y: 8, scale: 0.995 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -6, scale: 0.995 },
  transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
} as const;

export default function Test({ a, live }: ScreenProps) {
  const models = useAsync(() => a.models());
  const baselines = useAsync(() => a.baselines());
  const languages = useAsync(() => a.languages());
  const hfModels = (models.data ?? []).filter((m) => m.format === "hf");
  const active = hfModels.find((m) => m.active);
  const result = useAsync(() => (active ? a.latestEval(active.id) : Promise.resolve(null)), [active?.id]);
  // Bumped after a run finishes so the scoreboard rolls its numbers again and the bean hops.
  const [replay, setReplay] = useState(0);
  const run = useAction(async () => {
    const r = await a.evaluate();
    result.setData(r);
    setReplay((n) => n + 1);
  });
  const choose = useAction(async (id: string) => {
    await a.setActiveModel(id);
    await models.reload();
  });

  // Languages to show: the ones scored in the last test (in the user's order), else the user's languages.
  const mine = (languages.data ?? []).filter((l) => l.enabled).map((l) => l.code);
  const scored = Object.keys(result.data?.scores ?? {}).filter((k) => k !== "avg") as Lang[];
  const rank = (l: Lang) => (mine.includes(l) ? mine.indexOf(l) : mine.length);
  const langs = scored.length ? scored.sort((x, y) => rank(x) - rank(y)) : mine;
  const reference = (l: Lang) => baselines.data?.find((b) => b.lang === l)?.wer;
  const progress = live.evalProgress;
  const running = !!progress || run.busy;
  const canRun = !!active && live.engine !== "error";

  let hero: ReactNode = null;
  let heroKey = "none";
  if (running) {
    heroKey = "running";
    hero = <Running done={progress?.done ?? 0} total={progress?.total ?? 0} ids={result.data?.rows.map((r) => r.id)} />;
  } else if (result.data && active) {
    heroKey = "board";
    hero = <Scoreboard result={result.data} langs={langs} reference={reference} modelName={active.name} replay={replay} />;
  } else if (!models.loading && !result.loading) {
    heroKey = "empty";
    hero = <Empty hasModel={!!active} canRun={canRun} onRun={() => run.run()} />;
  } else {
    heroKey = "loading";
    hero = <div className="zn-surface h-[22rem] animate-pulse opacity-60" />;
  }

  return (
    <div className="mx-auto max-w-[1180px] px-10 pt-10 pb-16">
      <PageHeader
        title="Test"
        subtitle={
          <>
            How often your model gets a word wrong on recordings it never trained on, next to a leading cloud recognizer on the same clips. Lower is better. For
            languages typed in English letters, spelling variants count as right (<i>chhe</i> = <i>che</i>).
          </>
        }
      >
        {active && (
          <ModelPicker
            a={a}
            models={hfModels}
            active={active}
            busy={choose.busy}
            disabled={choose.busy || running}
            onChoose={(id) => choose.run(id)}
          />
        )}
        <Button variant="brand" loading={run.busy} disabled={!canRun || running} onClick={() => run.run()}>
          {!run.busy && <Play className="size-3.5 fill-current" />}
          Run test
        </Button>
      </PageHeader>

      <ErrorNote className="mb-4" error={run.error ?? choose.error ?? live.engineError} />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={heroKey} {...swap}>
          {hero}
        </motion.div>
      </AnimatePresence>

      {result.data && !running && <Clips rows={result.data.rows} langs={langs} />}
    </div>
  );
}

function Empty({ hasModel, canRun, onRun }: { hasModel: boolean; canRun: boolean; onRun: () => void }) {
  return (
    <section className="zn-surface grain relative flex flex-col items-center overflow-hidden px-8 pt-12 pb-12 text-center">
      <div className="zn-ripples" style={{ ["--rx" as string]: "50%", ["--ry" as string]: "92px" }} />
      <Bean mood="sleepy" size={96} className="relative" />
      <h2 className="relative mt-5 font-display text-[22px] font-semibold tracking-[-0.015em]">
        {hasModel ? "No test results for this model yet" : "No model to test yet"}
      </h2>
      <p className="relative mt-1.5 max-w-[30rem] text-[13.5px] text-muted-foreground">
        {hasModel
          ? "Run the test to score it. Your model writes down every held-back clip, and each word is compared with what you read."
          : "Train a model first. Once it's installed on this Mac, you can score it here against the reference."}
      </p>
      {hasModel && (
        <Button variant="brand" size="lg" className="relative mt-6" disabled={!canRun} onClick={onRun}>
          <Play className="size-4 fill-current" /> Run test
        </Button>
      )}
    </section>
  );
}
