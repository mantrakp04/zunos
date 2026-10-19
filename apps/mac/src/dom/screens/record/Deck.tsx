import { Check, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef } from "react";

import { Kbd, minutes } from "../../ui";
import { clock } from "./model";

export type Phase = "ready" | "starting" | "recording" | "saving";
export type KeyName = "space" | "enter" | "esc";

/** The take controls: one big keycap you can't misread, flanked by Discard and Finish. */
export const Deck = memo(function Deck({
  phase,
  line,
  lineCount,
  last,
  again,
  estimate,
  savedNote,
  pressed,
  disabled,
  onPrimary,
  onFinish,
  onDiscard,
}: {
  phase: Phase;
  line: number;
  lineCount: number;
  last: boolean;
  /** The prompt has been read before. */
  again: boolean;
  /** Seconds a calm read takes. */
  estimate: number;
  savedNote: string | null;
  pressed: KeyName | null;
  disabled: boolean;
  onPrimary: () => void;
  onFinish: () => void;
  onDiscard: () => void;
}) {
  const recording = phase === "recording";
  const busy = phase === "starting" || phase === "saving";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-5">
      <div className="min-w-0 justify-self-start">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={recording ? "rec" : phase === "saving" ? "saving" : savedNote ? "saved" : "ready"}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            className="text-[12.5px] leading-snug text-muted-foreground"
          >
            {recording ? (
              <>
                <div className="font-display text-[15px] font-semibold whitespace-nowrap text-foreground tabular-nums">
                  Line {line + 1} <span className="text-muted-foreground">of {lineCount}</span>
                </div>
                <div className="@max-[860px]:hidden">{last ? "Last line. Space or Return to finish." : "Space when you reach the end of the line."}</div>
              </>
            ) : phase === "saving" ? (
              <>
                <div className="font-display text-[15px] font-semibold text-foreground">Saving the take</div>
                <div>Cutting it into one clip per line…</div>
              </>
            ) : savedNote ? (
              <>
                <div className="flex items-center gap-1.5 font-display text-[15px] font-semibold text-good">
                  <Check className="size-4" strokeWidth={2.6} /> Saved
                </div>
                <div className="truncate">{savedNote}</div>
              </>
            ) : (
              <>
                <div className="font-display text-[15px] font-semibold whitespace-nowrap text-foreground tabular-nums">
                  {lineCount} line{lineCount === 1 ? "" : "s"} <span className="text-muted-foreground">· about {minutes(estimate)}</span>
                </div>
                <div className="@max-[860px]:hidden">{again ? "You've read this one. Another take still helps." : "Read it the way you'd normally talk."}</div>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-3">
        <button title="Discard this take (Esc)" aria-label="Discard" className="rk-sub" data-hidden={!recording} data-pressed={pressed === "esc"} tabIndex={recording ? 0 : -1} onClick={onDiscard}>
          <Kbd>esc</Kbd> <span className="@max-[860px]:hidden">Discard</span>
        </button>
        <button
          className="rk-key"
          data-state={recording ? "recording" : busy ? "busy" : "ready"}
          data-pressed={pressed === "space"}
          disabled={disabled || busy}
          onClick={onPrimary}
        >
          {busy ? (
            <Loader2 className="size-[18px] animate-spin" strokeWidth={2.4} />
          ) : (
            <span className={recording ? "rk-rec-dot size-3 rounded-full bg-brand" : "size-3 rounded-full bg-white shadow-[0_0_0_3px_rgb(255_255_255/0.25)]"} />
          )}
          <span className="min-w-[7.5em] text-left">
            {phase === "starting" ? "Starting" : phase === "saving" ? "Saving" : recording ? (last ? "Finish take" : "Next line") : again ? "Record again" : "Start reading"}
          </span>
          {!busy && <span className="rk-legend">space</span>}
        </button>
        <button title="Finish and save (Return)" aria-label="Finish" className="rk-sub" data-hidden={!recording} data-pressed={pressed === "enter"} tabIndex={recording ? 0 : -1} onClick={onFinish}>
          <Kbd>return</Kbd> <span className="@max-[860px]:hidden">Finish</span>
        </button>
      </div>

      <div className="min-w-0 justify-self-end" />
    </div>
  );
});

/** Elapsed take time; ticks on its own so the screen doesn't re-render. */
export function Clock({ since, className }: { since: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = clock((Date.now() - since) / 1000);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [since]);
  return <span ref={ref} className={className} />;
}
