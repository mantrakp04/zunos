import { cn } from "@zunos/ui/lib/utils";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useMemo, useState } from "react";

import type { EvalResult, Lang } from "../../../shared/types";
import { langName, Segmented } from "../../ui";
import { type Diff, diffWords, isFuzzyLang, type Op } from "./diff";

type Row = EvalResult["rows"][number] & { diff: Diff };

const tone = (wer: number) => (wer < 0.15 ? "good" : wer < 0.3 ? "warn" : "bad");
const TONE_TEXT = { good: "text-good", warn: "text-warn", bad: "text-brand" } as const;
const TONE_BG = { good: "bg-good", warn: "bg-warn", bad: "bg-brand" } as const;

/** Every test clip: what you read against what the model heard, word by word. */
export function Clips({ rows, langs }: { rows: EvalResult["rows"]; langs: Lang[] }) {
  const [lang, setLang] = useState<"all" | Lang>("all");
  const [sort, setSort] = useState<"worst" | "best">("worst");
  const items: Row[] = useMemo(() => rows.map((r) => ({ ...r, diff: diffWords(r.ref, r.hyp, r.lang) })), [rows]);
  const shown = useMemo(
    () => items.filter((r) => lang === "all" || r.lang === lang).sort((x, y) => (sort === "worst" ? y.wer - x.wer : x.wer - y.wer)),
    [items, lang, sort],
  );
  const count = (l: Lang) => items.filter((r) => r.lang === l).length;
  const forgiving = langs.some(isFuzzyLang);

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h2 className="font-display text-[20px] font-semibold tracking-[-0.015em]">Clip by clip</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">What the model heard, with what you actually read written above each mistake.</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            size="sm"
            value={lang}
            onChange={setLang}
            options={[
              { value: "all", label: <>All <Count n={items.length} /></> },
              ...langs.map((l) => ({ value: l, label: <>{langName(l)} <Count n={count(l)} /></> })),
            ]}
          />
          <Segmented
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: "worst", label: "Worst first" },
              { value: "best", label: "Best first" },
            ]}
          />
        </div>
      </div>

      <Legend forgiving={forgiving} />

      <div className="zn-surface overflow-hidden">
        <AnimatePresence initial={false}>
          {shown.map((r, i) => (
            <motion.div
              key={r.id}
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ type: "spring", stiffness: 420, damping: 40 }}
              className={cn(i > 0 && "border-t border-border")}
            >
              <ClipRow row={r} />
            </motion.div>
          ))}
        </AnimatePresence>
        {!shown.length && <p className="px-6 py-8 text-center text-[13px] text-muted-foreground">No clips in this language were tested.</p>}
      </div>
    </section>
  );
}

const Count = ({ n }: { n: number }) => <span className="ml-0.5 tabular-nums opacity-55">{n}</span>;

function Legend({ forgiving }: { forgiving: boolean }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[11.5px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="rounded-[5px] bg-brand/12 px-1 font-medium text-brand">heard</span> misheard
      </span>
      <span className="flex items-center gap-1.5">
        <span className="rounded-[5px] px-1 text-muted-foreground line-through decoration-brand/70 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--brand)_35%,transparent)]">word</span>
        missed
      </span>
      <span className="flex items-center gap-1.5">
        <span className="rounded-[5px] bg-warn/14 px-1 font-medium text-warn">extra</span> added
      </span>
      {forgiving && (
        <span className="flex items-center gap-1.5">
          <span className="text-foreground underline decoration-muted-foreground/60 decoration-dotted underline-offset-[3px]">che</span>
          spelling variant, counted as right
        </span>
      )}
    </div>
  );
}

const ClipRow = memo(function ClipRow({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const t = tone(row.wer);
  const d = row.diff;
  const facts = [
    d.sub && `${d.sub} misheard`,
    d.del && `${d.del} missed`,
    d.ins && `${d.ins} added`,
  ].filter(Boolean);
  return (
    <div className="group grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-5 px-6 py-5 transition-colors hover:bg-foreground/[0.015]">
      <div className="pt-0.5">
        <div className={cn("font-display text-[24px] leading-none font-semibold tracking-[-0.03em] tabular-nums", TONE_TEXT[t])}>
          {(row.wer * 100).toFixed(1)}
          <span className="text-[13px] tracking-normal opacity-70">%</span>
        </div>
        <Leds value={row.wer} tone={t} />
        <div className="mt-2 text-[11px] text-muted-foreground tabular-nums">{d.words} words</div>
      </div>

      <div className="min-w-0">
        <div className="mb-2.5 flex items-center gap-2 text-[11.5px]">
          <span className="rounded-full bg-foreground/[0.06] px-2 py-px font-semibold">{langName(row.lang)}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{row.id}</span>
          <span className="ml-auto flex shrink-0 items-center gap-3 text-muted-foreground">
            {row.wer === 0 ? <span className="font-semibold text-good">Every word right</span> : <span className="tabular-nums">{facts.join(" · ")}</span>}
            <button
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              {open ? "Hide" : "Both texts"}
              <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
            </button>
          </span>
        </div>

        <DiffText ops={d.ops} />

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <dl className="mt-4 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-[12px] bg-foreground/[0.035] px-4 py-3 text-[13px] leading-relaxed select-text">
                <dt className="pt-px text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">You read</dt>
                <dd>{row.ref}</dd>
                <dt className="pt-px text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">It heard</dt>
                <dd>{row.hyp}</dd>
              </dl>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
});

/** Ten little lights, 5 points each; a clip over 50% lights them all. */
function Leds({ value, tone: t }: { value: number; tone: keyof typeof TONE_BG }) {
  const lit = Math.min(10, Math.ceil(value * 20 - 1e-9));
  return (
    <div className="mt-2.5 flex gap-[2px]" aria-hidden>
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className={cn("h-[5px] w-[5px] rounded-[1.5px]", i < lit ? TONE_BG[t] : "bg-foreground/10")} />
      ))}
    </div>
  );
}

/**
 * The model's transcript, read left to right. Each word sits under a small slot; mistakes put
 * what you actually read in that slot, like a teacher's correction above the line.
 */
function DiffText({ ops }: { ops: Op[] }) {
  return (
    <p className="flex flex-wrap items-end gap-x-[0.28em] gap-y-1 text-[15px] leading-[1.35] select-text">
      {ops.map((o, i) => (
        <Word key={i} op={o} />
      ))}
    </p>
  );
}

/** A word without the punctuation around it, for the small correction above the line. */
const bare = (w: string) => w.replace(/^[^\p{L}\p{N}+−]+|[^\p{L}\p{N}+−]+$/gu, "") || w;

function Word({ op }: { op: Op }) {
  const note = (text: string, cls = "text-muted-foreground") => (
    <span className={cn("block h-[15px] text-[11px] leading-[15px] font-medium whitespace-nowrap", cls)}>{bare(text)}</span>
  );
  const slot = <span className="block h-[15px]" />;
  switch (op.kind) {
    case "same":
      return (
        <span className="inline-flex flex-col">
          {slot}
          <span className="text-foreground/88">{op.hyp}</span>
        </span>
      );
    case "variant":
      return (
        <span className="inline-flex flex-col" title={`Spelling variant, counted as right (you read “${op.ref}”)`}>
          {note(op.ref, "text-muted-foreground/45 italic")}
          <span className="text-foreground/88 underline decoration-muted-foreground/55 decoration-dotted underline-offset-[4px]">{op.hyp}</span>
        </span>
      );
    case "sub":
      return (
        <span className="inline-flex flex-col items-center" title={`Heard “${op.hyp}”, you read “${op.ref}”`}>
          {note(op.ref, "text-foreground/60")}
          <span className="rounded-[6px] bg-brand/11 px-[4px] font-medium text-brand dark:bg-brand/18">{op.hyp}</span>
        </span>
      );
    case "del":
      return (
        <span className="inline-flex flex-col items-center" title={`Missed “${op.ref}”`}>
          {note("−", "text-brand font-bold")}
          <span className="rounded-[6px] px-[4px] text-muted-foreground/75 line-through decoration-brand/70 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--brand)_35%,transparent)]">
            {op.ref}
          </span>
        </span>
      );
    case "ins":
      return (
        <span className="inline-flex flex-col items-center" title={`Added “${op.hyp}”, which you didn't read`}>
          {note("+", "text-warn font-bold")}
          <span className="rounded-[6px] bg-warn/14 px-[4px] font-medium text-warn">{op.hyp}</span>
        </span>
      );
  }
}
