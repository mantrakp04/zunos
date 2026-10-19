import { cn } from "@zunos/ui/lib/utils";
import { AlertCircle, Loader2, RotateCcw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import type { MicIssue, TakeQualityItem } from "../../../shared/types";

const enter = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4, transition: { duration: 0.15 } },
  transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
} as const;

const linkButton =
  "inline-flex shrink-0 items-center gap-1 font-medium text-foreground/80 underline-offset-2 hover:text-brand hover:underline disabled:opacity-60";

/**
 * Takes that were kept but couldn't be cut into clips (and the error from the take that just failed),
 * with a Retry. Nothing is lost while this shows: the audio is saved, only the cutting is pending.
 */
export function UncutTakes({ count, error, busy, onRetry }: { count: number; error: string | null; busy: boolean; onRetry: () => void }) {
  const show = count > 0 || !!error;
  // With nothing waiting to be cut, the error is all there is to say (a slow save, say).
  const text = count > 1 ? `${count} takes couldn't be cut into clips` : count === 1 ? "A take couldn't be cut into clips" : error;
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div key="uncut" {...enter} className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
          <AlertCircle className="size-3.5 shrink-0 text-warn" />
          <span title={error ?? undefined} className="min-w-0 truncate">
            {text}
            {count > 0 && error && <span className="text-muted-foreground/80"> · {error}</span>}
          </span>
          <button type="button" disabled={busy} onClick={onRetry} className={linkButton}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
            {busy ? "Retrying" : "Retry"}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * How the last take sounded, once its background cleaning is done. "redo": the reason and a one-click
 * re-record of that prompt. "ok": a quiet mark with the issues in its tooltip. "good": nothing. While
 * takes are still being cleaned, a faint "cleaning" instead.
 */
export function TakeQualityNote({ item, cleaning, onRedo, onDismiss, busy }: {
  item: TakeQualityItem | null;
  /** Takes still waiting for their cleaning. */
  cleaning: number;
  onRedo: (promptId: string) => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const q = item?.quality ?? null;
  const issues: MicIssue[] = (q?.issues ?? []).filter((i) => i.severity !== "info");
  const tip = issues.map((i) => `${i.title}. ${i.detail}`).join("\n") || undefined;
  const state = q?.verdict === "redo" ? "redo" : q?.verdict === "ok" && issues.length ? "ok" : cleaning > 0 ? "cleaning" : null;
  return (
    <AnimatePresence mode="wait" initial={false}>
      {state === "redo" ? (
        <motion.div key={`redo-${item!.recordingId}`} {...enter} className="flex min-w-0 items-center gap-2 text-[12.5px]">
          <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
          <span title={tip} className="min-w-0 truncate text-foreground/85">
            <span className="font-semibold">Last take should be redone</span>
            {issues[0] && <span className="text-muted-foreground"> · {issues[0].title}</span>}
          </span>
          {item!.promptId && (
            <button type="button" disabled={busy} onClick={() => onRedo(item!.promptId!)} className={linkButton}>
              <RotateCcw className="size-3" />
              Record it again
            </button>
          )}
          <Dismiss onClick={onDismiss} />
        </motion.div>
      ) : state === "ok" ? (
        <motion.div key={`ok-${item!.recordingId}`} {...enter} className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
          <span title={tip} className="min-w-0 truncate">
            Last take ok · {issues[0]!.title}
            {issues.length > 1 && ` +${issues.length - 1}`}
          </span>
          <Dismiss onClick={onDismiss} />
        </motion.div>
      ) : state === "cleaning" ? (
        <motion.div key="cleaning" {...enter} className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground/70">
          <Loader2 className="size-3 animate-spin" />
          Cleaning {cleaning === 1 ? "the last take" : `${cleaning} takes`}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function Dismiss({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Dismiss"
      className={cn("grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground")}
    >
      <X className="size-3" />
    </button>
  );
}
