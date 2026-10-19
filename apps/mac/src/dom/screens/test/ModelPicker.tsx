import { cn } from "@zunos/ui/lib/utils";
import { AudioLines, ChevronsUpDown, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import type { Actions } from "../../../services/actions";
import type { ModelItem } from "../../../shared/types";
import { Eyebrow, pct, useAsync } from "../../ui";

/** "openai/whisper-large-v3" -> "Whisper large-v3"; paths and unknown bases give null. */
function baseName(m: ModelItem) {
  const cfg = (m.score as { cfg?: { base?: unknown } } | null)?.cfg;
  const base = typeof cfg?.base === "string" ? cfg.base : null;
  if (!base || base.startsWith("/")) return null;
  const tail = base.split("/").pop()!;
  return tail.startsWith("whisper-") ? `Whisper ${tail.slice(8)}` : tail;
}

const trainingScore = (m: ModelItem) => {
  const s = (m.score as { score?: unknown } | null)?.score;
  return typeof s === "number" ? s : undefined;
};

/** Chooser for the accurate (HF) models: name, where it came from, and its test average when known. */
export function ModelPicker({
  a,
  models,
  active,
  busy,
  disabled,
  onChoose,
}: {
  a: Actions;
  models: ModelItem[];
  active: ModelItem;
  busy: boolean;
  disabled: boolean;
  onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const ids = models.map((m) => m.id).join(",");
  const tested = useAsync(
    () =>
      open
        ? Promise.all(models.map((m) => a.latestEval(m.id).then((e) => [m.id, e?.scores.avg] as const, () => [m.id, undefined] as const))).then(
            (xs) => new Map(xs),
          )
        : Promise.resolve(null),
    [open, ids],
  );

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 items-center gap-2.5 rounded-full bg-card pr-3 pl-1.5 text-left text-[13px] shadow-[0_0_0_1px_var(--input),0_1px_2px_rgb(64_32_25/0.06)] transition-[background-color,transform] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] disabled:opacity-45",
          open && "bg-accent",
        )}
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-ink text-brand-cream dark:bg-brand-cream dark:text-brand-ink">
          {busy ? <Loader2 className="size-3 animate-spin" /> : <AudioLines className="size-3" strokeWidth={2.5} />}
        </span>
        <span className="max-w-[12rem] min-w-0 truncate font-medium @max-[46rem]/test:max-w-[7rem]" title={active.name}>
          {active.name}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.12 } }}
            transition={{ type: "spring", stiffness: 520, damping: 34 }}
            style={{ transformOrigin: "top right" }}
            className="absolute top-full right-0 z-30 mt-2 flex max-h-[min(28rem,calc(100vh-11rem))] w-[19rem] flex-col rounded-[18px] bg-popover p-1.5 text-popover-foreground shadow-[0_0_0_1px_var(--border),0_18px_48px_-16px_rgb(40_16_10/0.4),0_2px_6px_rgb(40_16_10/0.08)]"
          >
            <Eyebrow className="shrink-0 px-2.5 pt-1.5 pb-2">Models on this Mac</Eyebrow>
            {/* Scrolls on its own when there are more models than fit under the header. */}
            <div className="min-h-0 overflow-y-auto overscroll-contain">
              {models.map((m) => {
                const on = m.id === active.id;
                const avg = tested.data?.get(m.id);
                const train = trainingScore(m);
                const sub = [m.runId && `Run ${m.runId}`, baseName(m)].filter(Boolean).join(" · ");
                return (
                  <button
                    key={m.id}
                    onClick={() => {
                      setOpen(false);
                      if (!on) onChoose(m.id);
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-[12px] px-2.5 py-2 text-left transition-colors hover:bg-accent",
                      on && "bg-accent/70",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-full transition-colors",
                        on ? "bg-brand shadow-[inset_0_1px_0_rgb(255_255_255/0.3)]" : "shadow-[inset_0_0_0_1.5px_var(--input)]",
                      )}
                    >
                      {on && <span className="size-1.5 rounded-full bg-white" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium" title={m.name}>
                        {m.name}
                      </span>
                      {sub && (
                        <span className="block truncate text-[11.5px] text-muted-foreground" title={sub}>
                          {sub}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-right whitespace-nowrap">
                      {avg != null ? (
                        <>
                          <span className="block font-display text-[15px] leading-tight font-semibold tabular-nums">{pct(avg)}</span>
                          <span className="block text-[10.5px] text-muted-foreground">test average</span>
                        </>
                      ) : train != null ? (
                        <>
                          <span className="block font-display text-[15px] leading-tight font-semibold text-muted-foreground tabular-nums">{pct(train)}</span>
                          <span className="block text-[10.5px] text-muted-foreground">during training</span>
                        </>
                      ) : tested.loading ? (
                        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                      ) : (
                        <span className="text-[11px] text-muted-foreground">Not tested</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="shrink-0 px-2.5 pt-2 pb-1.5 text-[11px] leading-snug text-muted-foreground">
              Tests use the accurate version of each model, with beam search.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
