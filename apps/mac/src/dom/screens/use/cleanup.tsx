import { cn } from "@zunos/ui/lib/utils";
import { AlertCircle, ArrowDownToLine, Loader2, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { Button, Segmented } from "../../ui";

/*
 * Transcript cleanup: a small local LLM (MLX, in the Python engine) that removes filler words,
 * fixes punctuation, applies self-corrections and formats the dictated text.
 *
 * TODO(cleanup): none of this is wired to native yet. When the engine side lands:
 *   - CleanupState comes from `live` (e.g. live.cleanup), mapped with toCleanupState() below.
 *   - download()/retry() call the real action (e.g. a.downloadCleanupModel()).
 *   - settings are saved through an action instead of localStorage.
 *   - stopDictation() returns { raw, clean } (see Transcript.clean) and native copies one of them.
 * Until then the strip is hidden in the app. The preview harness shows it with
 * `?cleanup=absent|downloading|loading|ready|error` and simulates the download.
 */

/** Cleanup styles, data-driven so the engine's real names can drop in. `off` is always first. */
export type CleanupStyle = { id: string; label: string; hint: string };
export const CLEANUP_STYLES: CleanupStyle[] = [
  { id: "off", label: "Off", hint: "Exactly what Whisper heard." },
  { id: "light", label: "Light", hint: "Fillers out, punctuation fixed." },
  { id: "polished", label: "Polished", hint: "Self-corrections applied, tidied up." },
];

/** Local shape of the cleanup model's lifecycle. Map the real `live` field onto this. */
export type CleanupState =
  | { status: "absent"; totalBytes: number }
  | { status: "downloading"; doneBytes: number; totalBytes: number }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

export type CleanupSettings = { style: string };

const SETTINGS_KEY = "zunos.cleanup";
const MODEL_BYTES = 2.4e9; // TODO(cleanup): from the engine's model manifest.

const previewParam = () => (typeof location !== "undefined" ? new URLSearchParams(location.search).get("cleanup") : null);

function previewState(): CleanupState | null {
  switch (previewParam()) {
    case "absent":
      return { status: "absent", totalBytes: MODEL_BYTES };
    case "downloading":
      return { status: "downloading", doneBytes: MODEL_BYTES * 0.46, totalBytes: MODEL_BYTES };
    case "loading":
      return { status: "loading" };
    case "ready":
      return { status: "ready" };
    case "error":
      return { status: "error", message: "The download stopped at 1.1 GB. Check your connection and try again." };
    default:
      return null; // TODO(cleanup): toCleanupState(live.cleanup)
  }
}

export function useCleanup() {
  const [state, setState] = useState<CleanupState | null>(previewState);
  const [settings, setSettingsState] = useState<CleanupSettings>(() => {
    try {
      return { style: "light", ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
    } catch {
      return { style: "light" };
    }
  });
  const setSettings = (s: CleanupSettings) => {
    setSettingsState(s);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); // TODO(cleanup): a.setCleanupSettings(s)
  };

  // Preview-only simulation of the one-time download and load.
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);
  const download = () => {
    // TODO(cleanup): a.downloadCleanupModel(); progress then arrives through `live`.
    if (!previewParam()) return;
    let done = state?.status === "downloading" ? state.doneBytes : 0;
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      done = Math.min(MODEL_BYTES, done + MODEL_BYTES / 150);
      if (done < MODEL_BYTES) return setState({ status: "downloading", doneBytes: done, totalBytes: MODEL_BYTES });
      clearInterval(timer.current!);
      setState({ status: "loading" });
      setTimeout(() => setState({ status: "ready" }), 1400);
    }, 100);
  };

  const active = state?.status === "ready" && settings.style !== "off";
  return { state, settings, setSettings, download, active };
}

export type Cleanup = ReturnType<typeof useCleanup>;

/**
 * Preview stand-in for the model: drops common fillers and tidies capitals. Only used by the
 * harness so the cards' clean/raw/changes views have something to show.
 * TODO(cleanup): delete once stopDictation returns the cleaned text.
 */
export function previewClean(raw: string) {
  const s = raw
    .replace(/\b(um+|uh+|hmm+|you know|i mean|like|so|hey|okay so)\b,?\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return s;
  const out = s[0]!.toUpperCase() + s.slice(1);
  return /[.?!]$/.test(out) ? out : `${out}.`;
}

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

/** The strip along the bottom of the instrument: get the cleanup model, or pick a style. */
export function CleanupStrip({ cleanup, busy }: { cleanup: Cleanup; busy: boolean }) {
  const { state, settings, setSettings, download } = cleanup;
  if (!state) return null;
  const style = CLEANUP_STYLES.find((s) => s.id === settings.style) ?? CLEANUP_STYLES[0]!;
  return (
    <div className="relative border-t border-border/80 bg-foreground/[0.018] px-5 py-3.5">
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
                <div className="truncate text-[11.5px] text-muted-foreground">
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
                <div className="line-clamp-2 text-[11.5px] text-muted-foreground select-text">{state.message}</div>
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
          <span className="truncate text-[12.5px] font-semibold">Downloading cleanup model</span>
          <span className="font-mono text-[11px] font-semibold text-foreground/80 tabular-nums">{Math.floor(p * 100)}%</span>
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
        <div className="mt-1 truncate text-[11px] text-muted-foreground">
          <span className="font-mono tabular-nums">
            {(done / 1e9).toFixed(1)} of {gb(total)}
          </span>
          . Dictation works as usual meanwhile.
        </div>
      </div>
    </>
  );
}

/** A little sparkle tile; doubles as a progress ring while downloading. */
function Glyph({ on, spinning, progress }: { on: boolean; spinning?: boolean; progress?: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <span
      className={cn(
        "relative grid size-8 shrink-0 place-items-center rounded-[10px] transition-colors",
        on ? "bg-brand-gold/18 text-[#b56c10] dark:text-brand-gold" : "bg-foreground/[0.06] text-muted-foreground",
      )}
    >
      {spinning ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
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
