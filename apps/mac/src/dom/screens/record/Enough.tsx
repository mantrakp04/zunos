import { ArrowRight, Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";

import type { Lang, LangStats } from "../../../shared/types";
import { Button, langName, shortOf } from "../../ui";

/**
 * Once the language you're on has the 5 minutes that are enough to train, says so in the take row's
 * right-hand column and offers what's next: Train when every language is there, else the language
 * that needs the most.
 */
export const Enough = memo(function Enough({ stats, current, onTrain, onLang }: {
  stats: LangStats[] | null;
  current: Lang | null;
  onTrain?: () => void;
  onLang: (l: Lang) => void;
}) {
  const short = stats ? shortOf(stats) : null;
  const here = !!short && !!current && !!stats?.some((s) => s.lang === current) && !short.some((s) => s.lang === current);
  const next = short?.slice().sort((x, y) => y.need - x.need)[0];
  const state = !here ? null : short!.length ? "others" : "ready";
  const needs = short?.map((s) => `${langName(s.lang)}: ${Math.ceil(s.need / 60)} min to go`).join("\n");
  return (
    <AnimatePresence initial={false}>
      {state && (
        <motion.div
          key={state}
          initial={{ opacity: 0, x: 10 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 6, transition: { duration: 0.15 } }}
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          className="flex min-w-0 flex-col items-end gap-1.5"
        >
          <span
            title={state === "ready" ? "More takes make a better model." : needs}
            className="flex max-w-full items-center gap-1 text-[12px] font-semibold text-good"
          >
            <Check className="size-3.5 shrink-0" strokeWidth={3} />
            <span className="truncate">{state === "ready" ? "Enough to train" : `${langName(current!)} has enough`}</span>
          </span>
          {state === "ready" ? (
            <Button variant="brand" size="sm" className="max-w-full" onClick={onTrain} disabled={!onTrain}>
              <span className="truncate">Start training</span>
              <ArrowRight className="size-3.5 shrink-0" />
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="max-w-full" title={needs} onClick={() => onLang(next!.lang as Lang)}>
              <span className="truncate">{langName(next!.lang)} next</span>
              <ArrowRight className="size-3.5 shrink-0" />
            </Button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
});
