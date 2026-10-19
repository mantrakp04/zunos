import { cn } from "@zunos/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";

import { Kbd, langName, Segmented } from "../../ui";
import type { CleanupStyle } from "../../../shared/types";
import { CLEANUP_STYLES, wordDiff } from "./cleanup";

/** One dictation result, as kept in this session's history. */
export type Transcript = {
  id: number;
  /** What Whisper heard. */
  text: string;
  /** The cleaned-up text, when cleanup ran and its output passed the checks. */
  clean: string | null;
  /** Cleanup style that produced `clean`. */
  style: CleanupStyle | null;
  lang: string;
  seconds: number;
  elapsed: number;
  at: number;
};

/** The text that's on the clipboard and which card it came from. */
export type Clip = { id: number; text: string } | null;

type View = "clean" | "changes" | "raw";

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export const TranscriptList = memo(function TranscriptList({
  items,
  freshId,
  clip,
  onCopy,
}: {
  items: Transcript[];
  freshId: number | null;
  clip: Clip;
  onCopy: (t: Transcript, text: string) => void;
}) {
  if (!items.length) return <EmptyState />;
  return (
    <div className="flex flex-col gap-3">
      <AnimatePresence initial={false}>
        {items.map((t, i) => (
          <TranscriptCard
            key={t.id}
            item={t}
            latest={i === 0}
            fresh={t.id === freshId}
            clipText={clip?.id === t.id ? clip.text : null}
            onCopy={onCopy}
          />
        ))}
      </AnimatePresence>
    </div>
  );
});

function TranscriptCard({
  item,
  latest,
  fresh,
  clipText,
  onCopy,
}: {
  item: Transcript;
  latest: boolean;
  fresh: boolean;
  clipText: string | null;
  onCopy: (t: Transcript, text: string) => void;
}) {
  const cleaned = !!item.clean && item.clean !== item.text;
  const [view, setView] = useState<View>(cleaned ? "clean" : "raw");
  const shown = view === "raw" || !item.clean ? item.text : item.clean;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  // The first time a result shows up its words fade in one by one; the clipboard chip follows.
  const [revealing, setRevealing] = useState(fresh);
  const words = shown.split(/\s+/).filter(Boolean).length;
  const step = Math.min(0.045, 1.2 / Math.max(1, words));
  const revealEnd = revealing ? 0.15 + words * step + 0.2 : 0;
  const diff = useMemo(() => (view === "changes" && item.clean ? wordDiff(item.text, item.clean) : null), [view, item.text, item.clean]);
  const styleName = CLEANUP_STYLES.find((s) => s.id === item.style)?.label;

  return (
    <motion.article
      layout="position"
      initial={{ opacity: 0, y: -16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      className={cn(
        "group relative rounded-[20px] bg-card px-5 py-4 transition-shadow duration-500",
        latest
          ? "shadow-[0_0_0_1px_rgb(243_74_45/0.28),0_1px_2px_rgb(64_32_25/0.06),0_14px_34px_-18px_rgb(243_74_45/0.55)] dark:shadow-[0_0_0_1px_rgb(255_110_80/0.3),0_14px_36px_-18px_rgb(243_74_45/0.6)]"
          : "shadow-[0_0_0_1px_var(--border),var(--elevate)]",
      )}
    >
      <header className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <span
          className={cn(
            "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold",
            latest ? "bg-brand/12 text-brand dark:bg-brand/20" : "bg-muted text-muted-foreground",
          )}
        >
          {langName(item.lang)}
        </span>
        <span className="whitespace-nowrap tabular-nums">{clock(item.at)}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <AnimatePresence>
            {clipText != null && clipText === shown && (
              <motion.span
                key="clip"
                initial={{ opacity: 0, scale: 0.6, x: 6 }}
                animate={{ opacity: 1, scale: 1, x: 0, transition: { type: "spring", stiffness: 520, damping: 26, delay: revealEnd } }}
                exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.12 } }}
                className="inline-flex h-5 items-center gap-1 rounded-full bg-good/12 px-2 text-[11px] font-semibold text-good dark:bg-good/18"
              >
                <Check className="size-3" strokeWidth={3} />
                On clipboard
              </motion.span>
            )}
          </AnimatePresence>
          {shown && (
            <button
              type="button"
              title={view === "raw" && cleaned ? "Copy original" : "Copy"}
              aria-label="Copy text"
              onClick={() => (onCopy(item, shown), setCopied(true))}
              className="relative grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:scale-95"
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={copied ? "y" : "n"}
                  initial={{ opacity: 0, scale: 0.4, rotate: -30 }}
                  animate={{ opacity: 1, scale: 1, rotate: 0 }}
                  exit={{ opacity: 0, scale: 0.4 }}
                  transition={{ type: "spring", stiffness: 600, damping: 28 }}
                  className="grid place-items-center"
                >
                  {copied ? <Check className="size-3.5 text-good" strokeWidth={2.75} /> : <Copy className="size-3.5" />}
                </motion.span>
              </AnimatePresence>
            </button>
          )}
        </div>
      </header>

      <AnimatePresence mode="popLayout" initial={false}>
        <motion.p
          key={view}
          initial={{ opacity: 0, filter: "blur(3px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, filter: "blur(3px)", transition: { duration: 0.12 } }}
          transition={{ duration: 0.25 }}
          className={cn(
            "mt-2.5 cursor-text text-pretty select-text",
            latest ? "text-[17px] leading-[1.5] tracking-[-0.005em]" : "text-[14.5px] leading-relaxed text-foreground/80",
            view === "raw" && cleaned && "text-foreground/70",
          )}
        >
          {!shown ? (
            <span className="text-muted-foreground italic">Didn't catch anything. Check that the mic is on and try again.</span>
          ) : diff ? (
            <Changes parts={diff} />
          ) : revealing ? (
            <Reveal text={shown} step={step} />
          ) : (
            shown
          )}
        </motion.p>
      </AnimatePresence>

      <footer className={cn("flex items-center gap-3", cleaned ? "mt-3" : "mt-2")}>
        {cleaned && (
          <Segmented<View>
            size="sm"
            value={view}
            onChange={(v) => (setRevealing(false), setView(v))}
            options={[
              { value: "clean", label: <span title={styleName ? `${styleName} cleanup` : undefined}>Cleaned</span> },
              { value: "changes", label: "Changes" },
              { value: "raw", label: "Original" },
            ]}
          />
        )}
        <span
          className="ml-auto truncate text-[11.5px] text-muted-foreground tabular-nums"
          title={`${item.seconds.toFixed(1)} s of speech, transcribed in ${item.elapsed.toFixed(1)} s`}
        >
          <span className="font-medium text-foreground/75">{item.seconds.toFixed(1)} s</span>
          <span className="hidden @min-[460px]/list:inline"> of speech</span> in{" "}
          <span className="font-medium text-foreground/75">{item.elapsed.toFixed(1)} s</span>
        </span>
      </footer>
    </motion.article>
  );
}

/** The raw transcript with what cleanup took out struck through and what it added highlighted. */
function Changes({ parts }: { parts: ReturnType<typeof wordDiff> }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " "}
          <span
            className={cn(
              p.kind === "del" && "text-muted-foreground/70 line-through decoration-destructive/50 decoration-[1.5px]",
              p.kind === "add" && "rounded-[4px] bg-brand-gold/20 px-[2px] text-foreground shadow-[inset_0_-1.5px_0_var(--brand-gold)]",
            )}
          >
            {p.text}
          </span>
        </span>
      ))}
    </>
  );
}

/** Words fade up out of a blur, one after another. Spaces stay real text so selection still works. */
function Reveal({ text, step }: { text: string; step: number }) {
  let n = 0;
  return (
    <>
      {text.split(/(\s+)/).map((part, i) =>
        part.trim() ? (
          <motion.span
            key={i}
            className="inline-block"
            initial={{ opacity: 0, y: 5, filter: "blur(5px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ delay: 0.15 + n++ * step, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >
            {part}
          </motion.span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-[20px] p-5 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <h3 className="font-display text-[19px] font-semibold tracking-[-0.01em]">Your words land here</h3>
      <p className="mt-1 text-[13px] text-muted-foreground">Newest on top. Kept until you leave this screen.</p>
      <ol className="mt-5 flex flex-col gap-5">
        <Step n="01">
          Press <Kbd>Space</Kbd> and talk. Press it again when you're done.
        </Step>
        <Step n="02">
          Mix languages freely, even inside one sentence.
          <div className="mt-2.5 rounded-[14px] bg-card px-3.5 py-3 opacity-90 shadow-[0_0_0_1px_var(--border),var(--elevate)]">
            <div className="flex gap-1.5">
              <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] font-semibold text-muted-foreground">English</span>
              <span className="inline-flex h-5 items-center rounded-full bg-brand-gold/15 px-2 text-[11px] font-semibold text-[#b56c10] dark:text-brand-gold">
                Hindi
              </span>
            </div>
            <p className="mt-2 text-[14px] leading-relaxed">
              Can we move the review to Thursday?{" "}
              <span className="underline decoration-brand-gold decoration-2 underline-offset-[5px]">Priya ko bhi bata dena.</span>
            </p>
          </div>
        </Step>
        <Step n="03">
          It's copied the moment it's ready. Paste anywhere with <Kbd>⌘</Kbd>
          <Kbd>V</Kbd>.
        </Step>
      </ol>
    </motion.div>
  );
}

function Step({ n, children }: { n: string; children: ReactNode }) {
  return (
    <li className="flex gap-3.5">
      <span className="mt-[3px] font-mono text-[11px] font-semibold text-brand tabular-nums">{n}</span>
      <div className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-foreground/85 [&_.zn-kbd]:mx-0.5 [&_.zn-kbd]:align-[1px]">{children}</div>
    </li>
  );
}
