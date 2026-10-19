import { ArrowRight, AudioLines, Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";

import type { Lang, LangStats } from "../../../shared/types";
import { Button, langName, shortOf } from "../../ui";

/**
 * Once the language you're on has the 5 minutes that are enough to train, says so, and points at
 * what's next: the Train screen when every language is there, else the language that needs the most.
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
  return (
    <AnimatePresence initial={false}>
      {state && (
        <motion.div
          key={state}
          initial={{ opacity: 0, x: 12, scale: 0.97 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 8, transition: { duration: 0.15 } }}
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          className="flex w-[min(100%,27rem)] shrink-0 items-center gap-3 rounded-[16px] bg-good/[0.07] py-2.5 pr-2.5 pl-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--good)_28%,transparent)]"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-good text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3)]">
            <Check className="size-4" strokeWidth={3} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold" title={state === "ready" ? undefined : `${langName(current!)} has enough to train`}>
              {state === "ready" ? "Enough to train" : `${langName(current!)} has enough`}
            </div>
            <div className="text-[11.5px] leading-snug text-muted-foreground">
              {state === "ready"
                ? "More takes make a better model. Tired? Take a break and train now."
                : short!.length === 1
                  ? `${langName(next!.lang)} needs ${Math.ceil(next!.need / 60)} more min before training.`
                  : `${short!.length} languages need more before training.`}
            </div>
          </div>
          {state === "ready" ? (
            <Button variant="brand" size="sm" className="shrink-0" onClick={onTrain} disabled={!onTrain}>
              <AudioLines className="size-3.5" />
              Start training
              <ArrowRight className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="max-w-[9.5rem] min-w-0 shrink"
              title={short!.map((s) => `${langName(s.lang)}: ${Math.ceil(s.need / 60)} min to go`).join("\n")}
              onClick={() => onLang(next!.lang as Lang)}
            >
              <span className="truncate">{langName(next!.lang)}</span>
              <ArrowRight className="size-3.5 shrink-0" />
            </Button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
});
