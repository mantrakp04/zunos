import { cn } from "@zunos/ui/lib/utils";
import { AlertTriangle, Check, Copy, GraduationCap, Loader2, PencilLine, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Actions } from "../../../services/actions";
import type { DictationItem } from "../../../shared/types";
import { Badge, Button, ErrorNote, Kbd, langName, useAction } from "../../ui";
import { CLEANUP_STYLES, wordDiff } from "./cleanup";

/*
 * Every dictation, from this window or the hotkey, newest first. Each one shows what was written
 * (cleaned up when cleanup ran) over what the model heard, and can be copied, corrected word for
 * word, turned into a training clip, retried when it failed, or deleted.
 */

/** Where the newest dictation's text went: the clipboard, or pasted into another app. */
export type Landed = { id: string; text: string; pastedInto: string | null } | null;

/** What a dictation reads as: the cleaned text, else the user's fix, else what was heard. */
export const textOf = (d: DictationItem) => d.clean ?? d.corrected ?? d.raw;

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 864e5);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Cards rendered at first; "Show more" adds another page. Keeps a long history quick to lay out. */
const PAGE = 40;

export const DictationHistory = memo(function DictationHistory({
  a,
  items,
  freshId,
  landed,
  onCopy,
  empty,
}: {
  a: Actions;
  items: DictationItem[];
  freshId: string | null;
  landed: Landed;
  onCopy: (d: DictationItem, text: string) => void;
  empty: ReactNode;
}) {
  const [limit, setLimit] = useState(PAGE);
  const days = useMemo(() => {
    const out: { label: string; items: DictationItem[] }[] = [];
    for (const d of items.slice(0, limit)) {
      const label = dayLabel(d.createdAt);
      if (out.at(-1)?.label === label) out.at(-1)!.items.push(d);
      else out.push({ label, items: [d] });
    }
    return out;
  }, [items, limit]);
  const more = items.length - limit;

  if (!items.length) return <>{empty}</>;
  return (
    <div className="flex flex-col">
      {days.map((day) => (
        <section key={day.label} className="mb-2">
          <h4 className="sticky top-0 z-10 -mx-1 mb-2 bg-[linear-gradient(var(--background)_70%,transparent)] px-1 pt-1 pb-1.5 text-[11.5px] font-semibold text-muted-foreground">
            {day.label}
          </h4>
          <div className="flex flex-col gap-2.5">
            <AnimatePresence initial={false}>
              {day.items.map((d) => (
                <DictationCard
                  key={d.id}
                  a={a}
                  item={d}
                  latest={d.id === items[0]!.id}
                  fresh={d.id === freshId}
                  landed={landed?.id === d.id ? landed : null}
                  onCopy={onCopy}
                />
              ))}
            </AnimatePresence>
          </div>
        </section>
      ))}
      {more > 0 && (
        <Button variant="ghost" size="sm" className="mx-auto mt-1" onClick={() => setLimit((l) => l + PAGE * 2)}>
          Show {Math.min(more, PAGE * 2)} more
        </Button>
      )}
    </div>
  );
});

function DictationCard({
  a,
  item,
  latest,
  fresh,
  landed,
  onCopy,
}: {
  a: Actions;
  item: DictationItem;
  latest: boolean;
  fresh: boolean;
  landed: Landed;
  onCopy: (d: DictationItem, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [changes, setChanges] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealing, setRevealing] = useState(fresh);
  useEffect(() => setRevealing((r) => r || fresh), [fresh]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  const correct = useAction((text: string) => a.correctDictation(item.id, text));
  const retry = useAction(() => a.retryDictation(item.id));
  const train = useAction(() => a.trainOnDictation(item.id));
  const remove = useAction(() => a.deleteDictation(item.id));

  const failed = item.status === "failed";
  const base = item.corrected ?? item.raw;
  const shown = textOf(item);
  const cleaned = !!item.clean && item.clean !== base;
  const styleName = CLEANUP_STYLES.find((s) => s.id === item.style)?.label;
  const diff = useMemo(() => (changes && item.clean ? wordDiff(base, item.clean) : null), [changes, base, item.clean]);
  const fix = useMemo(() => (item.corrected ? wordDiff(item.raw, item.corrected) : null), [item.raw, item.corrected]);

  const words = shown.split(/\s+/).filter(Boolean).length;
  const step = Math.min(0.045, 1.2 / Math.max(1, words));
  const revealEnd = revealing ? 0.15 + words * step + 0.2 : 0;

  const save = async (text: string) => {
    await correct.run(text);
    setEditing(false);
  };

  return (
    <motion.article
      layout="position"
      initial={{ opacity: 0, y: -14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, height: 0, marginBottom: -10, transition: { duration: 0.2 } }}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      className={cn(
        "group relative rounded-[18px] bg-card px-4.5 pt-3.5 pb-3 transition-shadow duration-500",
        failed
          ? "shadow-[0_0_0_1px_color-mix(in_oklab,var(--destructive)_30%,transparent),var(--elevate)]"
          : latest && fresh
            ? "shadow-[0_0_0_1px_rgb(243_74_45/0.28),0_1px_2px_rgb(64_32_25/0.06),0_14px_34px_-18px_rgb(243_74_45/0.55)] dark:shadow-[0_0_0_1px_rgb(255_110_80/0.3),0_14px_36px_-18px_rgb(243_74_45/0.6)]"
            : "shadow-[0_0_0_1px_var(--border),var(--elevate)]",
      )}
    >
      {/* ---- what, when, where ---- */}
      <header className="flex h-6 min-w-0 items-center gap-2 text-[11.5px] text-muted-foreground">
        {item.lang && item.lang !== "?" ? (
          <span
            title={langName(item.lang)}
            className={cn(
              "inline-block h-5 max-w-[45%] shrink-0 truncate rounded-full px-2 text-[11px] leading-5 font-semibold",
              latest && fresh ? "bg-brand/12 text-brand dark:bg-brand/20" : "bg-muted text-muted-foreground",
            )}
          >
            {langName(item.lang)}
          </span>
        ) : null}
        <span className="shrink-0 whitespace-nowrap tabular-nums">{clock(item.createdAt)}</span>
        {/* "Pasted in <app>" says it already, and the chip needs the room. */}
        {item.appName && !(landed?.pastedInto && !editing) && (
          <span className="min-w-0 shrink-[100] truncate" title={item.appName}>
            <span className="text-muted-foreground/60">in</span> <span className="font-medium text-foreground/70">{item.appName}</span>
          </span>
        )}

        {/* When it's tight, the app name gives way first, then the chip; the buttons never do. */}
        <span className="flex-1" />
        <AnimatePresence>
          {landed && !editing && (
            <motion.span
              key="landed"
              initial={{ opacity: 0, scale: 0.6, x: 6 }}
              animate={{ opacity: 1, scale: 1, x: 0, transition: { type: "spring", stiffness: 520, damping: 26, delay: revealEnd } }}
              exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.12 } }}
              title={landed.pastedInto ? `Pasted in ${landed.pastedInto}` : undefined}
              className="mr-1 inline-flex h-5 min-w-0 items-center gap-1 rounded-full bg-good/12 px-2 text-[11px] font-semibold whitespace-nowrap text-good dark:bg-good/18"
            >
              <Check className="size-3 shrink-0" strokeWidth={3} />
              <span className="truncate">{landed.pastedInto ? `Pasted in ${landed.pastedInto}` : "On clipboard"}</span>
            </motion.span>
          )}
        </AnimatePresence>
        <div className="flex shrink-0 items-center gap-0.5">
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
            {!failed && !editing && (
              <IconButton title="Fix what it heard" onClick={() => (setRevealing(false), setEditing(true))}>
                <PencilLine className="size-3.5" />
              </IconButton>
            )}
            <DeleteButton busy={remove.busy} onDelete={() => remove.run()} />
          </div>
          {!failed && shown && (
            <IconButton title="Copy" onClick={() => (onCopy(item, shown), setCopied(true))}>
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
            </IconButton>
          )}
        </div>
      </header>

      {/* ---- the text ---- */}
      {failed ? (
        <div className="mt-2 flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">Couldn't write this one down</p>
            {item.error && <p dir="auto" className="mt-0.5 text-[12px] [overflow-wrap:anywhere] text-muted-foreground select-text">{item.error}</p>}
            <div className="mt-2.5 flex items-center gap-2">
              {item.hasAudio ? (
                <Button variant="outline" size="sm" disabled={retry.busy} onClick={() => retry.run()}>
                  {retry.busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                  {retry.busy ? "Transcribing" : "Try again"}
                </Button>
              ) : (
                <span className="text-[12px] text-muted-foreground">The audio wasn't kept, so it can't be retried.</span>
              )}
            </div>
            <ErrorNote error={retry.error} className="mt-2" />
          </div>
        </div>
      ) : editing ? (
        <FixEditor
          initial={base}
          heard={item.raw}
          busy={correct.busy}
          error={correct.error}
          onSave={save}
          onCancel={() => (setEditing(false), correct.setError(null))}
        />
      ) : (
        <>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p
              key={changes ? "changes" : "text"}
              dir="auto"
              initial={{ opacity: 0, filter: "blur(3px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(3px)", transition: { duration: 0.12 } }}
              transition={{ duration: 0.22 }}
              className={cn(
                "mt-2 cursor-text text-pretty [overflow-wrap:anywhere] select-text",
                latest ? "text-[16px] leading-[1.5] tracking-[-0.005em]" : "text-[14px] leading-relaxed text-foreground/85",
              )}
            >
              {!shown ? (
                <span className="text-muted-foreground italic">Didn't catch anything. Check that the mic is on and try again.</span>
              ) : diff ? (
                <Diff parts={diff} />
              ) : revealing ? (
                <Reveal text={shown} step={step} />
              ) : (
                shown
              )}
            </motion.p>
          </AnimatePresence>

          {/* What the model heard, under what was written: struck-through words are the ones you fixed. */}
          {(fix || cleaned) && (
            <button
              type="button"
              onClick={() => (setRevealing(false), setEditing(true))}
              title="Fix what it heard"
              className="mt-2 block w-full rounded-[10px] bg-foreground/[0.03] px-2.5 py-1.5 text-left text-[12px] leading-relaxed [overflow-wrap:anywhere] text-muted-foreground transition-colors hover:bg-foreground/[0.055]"
            >
              <span className="mr-1.5 font-mono text-[9.5px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
                {fix ? "Fixed" : "Heard"}
              </span>
              <span dir="auto">{fix ? <Diff parts={fix} subtle /> : item.raw}</span>
            </button>
          )}
        </>
      )}

      {/* ---- training, cleanup, length ---- */}
      {!failed && !editing && (
        <footer className="mt-2.5 flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-1">
          <TrainControl item={item} busy={train.busy} onTrain={() => train.run()} />
          {cleaned && (
            <button
              type="button"
              onClick={() => (setRevealing(false), setChanges((c) => !c))}
              title={changes ? "Show the cleaned text" : "Show what cleanup changed"}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap transition-colors",
                changes ? "bg-brand-gold/20 text-[#9a5a0c] dark:text-brand-gold" : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
              )}
            >
              <Sparkles className="size-3" />
              {changes ? "Changes" : `${styleName ?? "Cleaned"}`}
            </button>
          )}
          <span className="ml-auto pl-2 text-[11.5px] whitespace-nowrap text-muted-foreground tabular-nums">{item.seconds.toFixed(1)} s</span>
        </footer>
      )}
      <ErrorNote error={train.error ?? remove.error} className="mt-2" />
    </motion.article>
  );
}

/** "Use for training", then which set the clip landed in. */
function TrainControl({ item, busy, onTrain }: { item: DictationItem; busy: boolean; onTrain: () => void }) {
  if (item.clip)
    return (
      <motion.span initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 500, damping: 26 }}>
        <Badge tone={item.clip.split === "train" ? "good" : "brand"} className="h-6 px-2.5 whitespace-nowrap">
          <GraduationCap className="size-3" />
          {item.clip.split === "train" ? "In training set" : "In test set"}
        </Badge>
      </motion.span>
    );
  if (!item.raw.trim() && !item.corrected) return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onTrain}
      title="Add this recording to your voice, so the next model learns from it"
      className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-60"
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <GraduationCap className="size-3" />}
      {busy ? "Adding" : "Use for training"}
    </button>
  );
}

/** Inline correction of what was heard. ⌘↩ saves, Esc cancels. */
function FixEditor({
  initial,
  heard,
  busy,
  error,
  onSave,
  onCancel,
}: {
  initial: string;
  heard: string;
  busy: boolean;
  error: string | null;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const changed = text.trim() !== initial.trim();
  const preview = useMemo(() => wordDiff(heard, text), [heard, text]);
  const edits = preview.filter((p) => p.kind !== "same").length;

  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className="mt-2">
      <label className="mb-1.5 block text-[11.5px] text-muted-foreground">Type what you really said, word for word. zunos remembers the words it got wrong.</label>
      <textarea
        ref={ref}
        value={text}
        disabled={busy}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onCancel());
          if (e.key === "Enter" && e.metaKey) (e.preventDefault(), changed && onSave(text));
        }}
        rows={1}
        dir="auto"
        className="block w-full resize-none [overflow-wrap:anywhere] rounded-[12px] bg-background px-3 py-2 text-[14.5px] leading-relaxed shadow-[inset_0_0_0_1px_var(--input),0_0_0_3px_color-mix(in_oklab,var(--brand)_14%,transparent)] outline-none focus:shadow-[inset_0_0_0_1.5px_var(--brand),0_0_0_4px_color-mix(in_oklab,var(--brand)_16%,transparent)] disabled:opacity-60"
      />
      {edits > 0 && (
        <p className="mt-2 rounded-[10px] bg-foreground/[0.03] px-2.5 py-1.5 text-[12px] leading-relaxed [overflow-wrap:anywhere] text-muted-foreground">
          <span className="mr-1.5 font-mono text-[9.5px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">Heard</span>
          <span dir="auto">
            <Diff parts={preview} subtle />
          </span>
        </p>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy || !changed} onClick={() => onSave(text)}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {busy ? "Saving" : "Save fix"}
          {!busy && (
            <span className="ml-0.5 text-[10.5px] opacity-60">
              ⌘↩
            </span>
          )}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <span className="ml-auto hidden text-[11px] text-muted-foreground @min-[420px]/list:inline">
          <Kbd>esc</Kbd> to cancel
        </span>
      </div>
      <ErrorNote error={error} className="mt-2" />
    </motion.div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="relative grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground active:scale-95"
    >
      {children}
    </button>
  );
}

/** Two clicks to delete: the bin turns into a red "Delete" for a few seconds. */
function DeleteButton({ busy, onDelete }: { busy: boolean; onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {armed || busy ? (
        <motion.button
          key="confirm"
          type="button"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          onClick={onDelete}
          disabled={busy}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-destructive px-2.5 text-[11.5px] font-semibold whitespace-nowrap text-white"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
          Delete
        </motion.button>
      ) : (
        <motion.span key="bin" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <IconButton title="Delete" onClick={() => setArmed(true)}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** A word diff: dropped words struck through, added ones highlighted. */
function Diff({ parts, subtle }: { parts: ReturnType<typeof wordDiff>; subtle?: boolean }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " "}
          <span
            className={cn(
              p.kind === "del" && "text-muted-foreground/70 line-through decoration-destructive/50 decoration-[1.5px]",
              p.kind === "add" &&
                (subtle
                  ? "font-medium text-foreground/85 underline decoration-brand-gold decoration-2 underline-offset-[3px]"
                  : "rounded-[4px] bg-brand-gold/20 px-[2px] text-foreground shadow-[inset_0_-1.5px_0_var(--brand-gold)]"),
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

export function EmptyHistory({ phrase }: { phrase: string | null }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="rounded-[20px] p-5 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <h3 className="font-display text-[19px] font-semibold tracking-[-0.01em]">Your words land here</h3>
      <p className="mt-1 text-[13px] text-muted-foreground">Everything you dictate, here or in other apps, newest on top.</p>
      <ol className="mt-5 flex flex-col gap-5">
        <Step n="01">
          Press <Kbd>Space</Kbd> and talk. Press it again when you're done.
          {phrase && <> Anywhere else, {phrase.toLowerCase()} instead.</>}
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
          Got a word wrong? Fix it here and use the clip for training. The next model hears you better.
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
