import { cn } from "@zunos/ui/lib/utils";
import { AlertCircle, ArrowDownToLine, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import type { Actions } from "../../../services/actions";
import type { CleanupSettings, CleanupStyle, LiveState } from "../../../shared/types";
import { TidyMark } from "../../marks";
import { Button, message, Segmented, useAsync } from "../../ui";

/*
 * Transcript cleanup: a small local LLM (MLX, in the Python engine) that removes filler words,
 * fixes punctuation, applies self-corrections and formats the dictated text. Its lifecycle comes
 * from `live.cleanup` (null until prepareDictation has checked for the model), settings persist
 * in the app DB, and stopDictation returns the cleaned text next to the raw one.
 */

/** The cleanup styles, `off` first. Ids match CleanupStyle. */
export type StyleOption = { id: CleanupStyle; label: string; hint: string };
export const CLEANUP_STYLES: StyleOption[] = [
  { id: "off", label: "Off", hint: "Exactly what Whisper heard." },
  { id: "light", label: "Light", hint: "Fillers out, punctuation fixed." },
  { id: "polished", label: "Polished", hint: "Self-corrections applied, tidied up." },
];

export function useCleanup(a: Actions, live: LiveState) {
  const saved = useAsync(() => a.cleanupSettings(), []);
  // The choice shows at once; the save (and any model load it starts) happens behind it.
  const [picked, setPicked] = useState<CleanupSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settings: CleanupSettings = picked ?? saved.data ?? { style: "light" };

  const setSettings = (s: CleanupSettings) => {
    setPicked(s);
    setError(null);
    a.setCleanupSettings(s).catch((e) => (setError(message(e)), setPicked(null)));
  };
  /** Downloads the model if it's missing, then loads it. Also the retry after an error. */
  const download = () => {
    setError(null);
    a.downloadCleanupModel().catch((e) => setError(message(e)));
  };

  const state = live.cleanup;
  const active = state?.status === "ready" && settings.style !== "off";
  return { state, settings, setSettings, download, active, error: error ?? saved.error };
}

export type Cleanup = ReturnType<typeof useCleanup>;

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

/** The strip along the bottom of the instrument: get the cleanup model, or pick a style. */
export function CleanupStrip({ cleanup, busy, className }: { cleanup: Cleanup; busy: boolean; className?: string }) {
  const { settings, setSettings, download } = cleanup;
  // An action that failed before native reported anything shows as the error state.
  const state = cleanup.error && cleanup.state?.status !== "error" ? { status: "error" as const, message: cleanup.error } : cleanup.state;
  if (!state) return null;
  const style = CLEANUP_STYLES.find((s) => s.id === settings.style) ?? CLEANUP_STYLES[0]!;
  return (
    <div className={cn("relative border-t border-border/80 bg-foreground/[0.018] px-5 py-3.5", className)}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={state.status}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="flex min-h-9 items-center gap-3"
        >
          {state.status === "ready" && (
            <>
              <Glyph on={style.id !== "off"} />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold">Cleanup</div>
                <div className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{style.hint}</div>
              </div>
              <Segmented
                size="sm"
                value={style.id}
                onChange={(id) => !busy && setSettings({ ...settings, style: id })}
                options={CLEANUP_STYLES.map((s) => ({ value: s.id, label: s.label }))}
                className={cn(busy && "pointer-events-none opacity-60")}
              />
            </>
          )}

          {state.status === "absent" && (
            <>
              <Glyph on={false} />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold">Clean up as you talk</div>
                <div className="truncate text-[11.5px] text-muted-foreground" title={`Drops the ums, fixes punctuation. ${gb(state.totalBytes)}, runs on this Mac.`}>
                  Drops the ums, fixes punctuation. {gb(state.totalBytes)}, runs on this Mac.
                </div>
              </div>
              <Button variant="soft" size="sm" onClick={download}>
                <ArrowDownToLine className="size-3.5" />
                Get it
              </Button>
            </>
          )}

          {state.status === "downloading" && <Downloading done={state.doneBytes} total={state.totalBytes} />}

          {state.status === "loading" && (
            <>
              <Glyph on spinning />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold">Loading cleanup model</div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/8">
                  <div className="zn-cleanup-indeterminate h-full w-1/3 rounded-full bg-[linear-gradient(90deg,transparent,var(--brand-gold),transparent)]" />
                </div>
              </div>
            </>
          )}

          {state.status === "error" && (
            <>
              <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-destructive/10 text-destructive">
                <AlertCircle className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold">Cleanup isn't available</div>
                <div title={state.message} className="line-clamp-2 text-[11.5px] [overflow-wrap:anywhere] text-muted-foreground select-text">
                  {state.message}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={download}>
                Try again
              </Button>
            </>
          )}
        </motion.div>
      </AnimatePresence>
      <style>{`
        @keyframes zn-cleanup-slide { from { transform: translateX(-100%) } to { transform: translateX(300%) } }
        .zn-cleanup-indeterminate { animation: zn-cleanup-slide 1.2s cubic-bezier(.45,0,.55,1) infinite }
      `}</style>
    </div>
  );
}

function Downloading({ done, total }: { done: number; total: number }) {
  const p = total ? done / total : 0;
  return (
    <>
      <Glyph on progress={p} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[12.5px] font-semibold" title="Downloading cleanup model">
            Downloading cleanup model
          </span>
          <span className="shrink-0 font-mono text-[11px] font-semibold text-foreground/80 tabular-nums">{Math.floor(p * 100)}%</span>
        </div>
        <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/8">
          <motion.div
            className="relative h-full overflow-hidden rounded-full bg-[linear-gradient(90deg,var(--brand),var(--brand-gold))]"
            initial={false}
            animate={{ width: `${p * 100}%` }}
            transition={{ type: "spring", stiffness: 140, damping: 26 }}
          >
            <div className="zn-cleanup-indeterminate absolute inset-y-0 w-1/3 bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.55),transparent)]" />
          </motion.div>
        </div>
        <div className="mt-1 truncate text-[11px] text-muted-foreground" title="Dictation works as usual meanwhile.">
          <span className="font-mono tabular-nums">
            {(done / 1e9).toFixed(1)} of {gb(total)}
          </span>
          . Dictation works as usual meanwhile.
        </div>
      </div>
    </>
  );
}

/** The cleanup mark, plain; doubles as a progress ring while downloading. */
function Glyph({ on, spinning, progress }: { on: boolean; spinning?: boolean; progress?: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <span className={cn("relative grid size-8 shrink-0 place-items-center transition-colors", on ? "text-foreground" : "text-muted-foreground")}>
      {spinning ? <Loader2 className="size-[18px] animate-spin" /> : <TidyMark className="size-[18px]" />}
      {progress != null && (
        <svg viewBox="0 0 36 36" className="absolute -inset-0.5 -rotate-90">
          <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={2} />
          <motion.circle
            cx="18"
            cy="18"
            r={r}
            fill="none"
            stroke="var(--brand-gold)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={c}
            initial={false}
            animate={{ strokeDashoffset: c * (1 - progress) }}
          />
        </svg>
      )}
    </span>
  );
}

/* ---- word diff between the raw transcript and the cleaned text ------------------------------- */

export type DiffPart = { text: string; kind: "same" | "add" | "del" };

export function wordDiff(raw: string, clean: string): DiffPart[] {
  const a = raw.split(/\s+/).filter(Boolean);
  const b = clean.split(/\s+/).filter(Boolean);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) out.push({ text: a[i++]!, kind: "same" }), j++;
    else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ text: a[i++]!, kind: "del" });
    else out.push({ text: b[j++]!, kind: "add" });
  }
  return out;
}
