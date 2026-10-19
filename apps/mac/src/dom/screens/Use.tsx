import { cn } from "@zunos/ui/lib/utils";
import { Check, Loader2, Mic, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BeanMood } from "../Bean";
import { Button, ErrorNote, PageHeader, useAction, useAsync } from "../ui";
import type { ScreenProps } from "../ZunosApp";
import { Instrument, type Phase, Timer } from "./use/Instrument";
import { CleanupStrip, previewClean, useCleanup } from "./use/cleanup";
import { type Clip, type Transcript, TranscriptList } from "./use/Transcripts";

const listOf = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export default function Use({ a, live }: ScreenProps) {
  const actions = useRef(a);
  actions.current = a;

  const [items, setItems] = useState<Transcript[]>([]);
  const [freshId, setFreshId] = useState<number | null>(null);
  const [clip, setClip] = useState<Clip>(null);
  const [toast, setToast] = useState(0);
  const [cheer, setCheer] = useState(0);
  const [spoke, setSpoke] = useState(0);
  const seq = useRef(0);
  const startedAt = useRef(0);

  const models = useAsync(() => a.models(), []);
  const langs = useAsync(() => a.languages(), []);
  const model = models.data?.find((m) => m.active && m.format === "hf")?.name ?? null;
  const langNames = useMemo(() => (langs.data ?? []).filter((l) => l.enabled).map((l) => l.name), [langs.data]);
  const cleanup = useCleanup();

  const prepare = useAction(() => a.prepareDictation());
  const start = useAction(() => a.startDictation());
  const stop = useAction(async () => {
    setSpoke((performance.now() - startedAt.current) / 1000);
    const r = await a.stopDictation();
    // TODO(cleanup): take `clean` from the result once stopDictation returns it; previewClean is
    // a harness stand-in. Native decides which text it copies; we assume the cleaned one.
    const clean = cleanup.active && r.text ? previewClean(r.text) : null;
    const item: Transcript = { ...r, clean, style: clean ? cleanup.settings.style : null, id: ++seq.current, at: Date.now() };
    setItems((h) => [item, ...h].slice(0, 20));
    setFreshId(item.id);
    setCheer(item.id);
    // The native side has already put non-empty text on the clipboard.
    const copied = clean || r.text;
    if (copied) (setClip({ id: item.id, text: copied }), setToast(item.id));
  });

  useEffect(() => {
    prepare.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (live.recording) startedAt.current = performance.now();
  }, [live.recording]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(0), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!cheer) return;
    const t = setTimeout(() => setCheer(0), 1400);
    return () => clearTimeout(t);
  }, [cheer]);

  const loading = prepare.busy || live.engine === "loading" || live.engine === "starting";
  const disabled = loading || stop.busy || start.busy;
  const phase: Phase = stop.busy
    ? "thinking"
    : live.recording
      ? "listening"
      : loading
        ? "loading"
        : live.engine === "error"
          ? "error"
          : "ready";
  const mood: BeanMood =
    phase === "listening" ? "listening" : phase === "thinking" ? "thinking" : phase === "loading" || phase === "error" ? "sleepy" : cheer ? "happy" : "idle";

  const toggle = () => {
    if (disabled) return;
    if (live.recording) stop.run();
    else start.run();
  };
  const keys = useRef(toggle);
  keys.current = toggle;
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || !!t.closest("input, textarea, select, [contenteditable]"));
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      e.preventDefault();
      if (!e.repeat) keys.current();
    };
    // A focused button would also "click" on Space release; Space belongs to dictation here.
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e.target)) e.preventDefault();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  const onCopy = useCallback((t: Transcript, text: string) => {
    actions.current.copyText(text);
    setClip({ id: t.id, text });
  }, []);
  const clear = useCallback(() => (setItems([]), setClip(null), setFreshId(null)), []);

  const error = prepare.error ?? start.error ?? stop.error ?? (live.engine === "error" ? live.engineError : null);

  return (
    <div className="@container h-full">
      <div className="mx-auto flex max-w-[1240px] flex-col px-8 pt-10 pb-7 @min-[720px]:h-full">
        <PageHeader title="Dictate" subtitle="Talk, stop, paste. The text goes straight to your clipboard, and it all runs on this Mac." />

        <div className="grid min-h-0 flex-1 gap-6 @min-[720px]:grid-cols-[minmax(330px,1fr)_minmax(320px,1fr)]">
          {/* ---- the instrument ---- */}
          <section className="relative isolate flex min-h-[470px] flex-col overflow-hidden rounded-[24px] bg-card shadow-[0_0_0_1px_var(--border),var(--elevate)]">
            <div aria-hidden className="grain pointer-events-none absolute inset-0 -z-10 opacity-70 dark:opacity-40" />
            <StatusBar phase={phase} model={model} />

            <Instrument
              phase={phase}
              level={live.level}
              mood={mood}
              disabled={disabled}
              label={live.recording ? "Stop and transcribe" : "Start talking"}
              onToggle={toggle}
            />

            <div className={cn("flex flex-col items-center px-6 text-center", cleanup.state ? "pb-3" : "pb-6")}>
              <Headline phase={phase} hasItems={items.length > 0} />
              <p className="mt-1.5 min-h-[20px] max-w-[30rem] text-[13px] text-muted-foreground">
                {phase === "loading" && (model ? `Loading ${model}. The first load takes a few seconds.` : "Loading your model. The first load takes a few seconds.")}
                {phase === "ready" && (langNames.length > 1 ? `Talk in ${listOf(langNames)}, or mix them in one sentence.` : "Talk the way you normally would.")}
                {phase === "listening" && "Listening. Press Space when you're done."}
                {phase === "thinking" && `${spoke.toFixed(1)} s of speech, ${cleanup.active ? "transcribing and cleaning up" : "transcribing"} on this Mac`}
                {phase === "error" && "The engine stopped before your model was ready."}
              </p>

              <div className="mt-4 flex h-11 items-center gap-2">
                {phase === "listening" ? (
                  <Button variant="primary" size="lg" className="min-w-[156px]" onClick={toggle} disabled={disabled}>
                    <Square className="size-3.5" fill="currentColor" />
                    Stop
                    <KeyCap tone="dark">Space</KeyCap>
                  </Button>
                ) : phase === "thinking" || phase === "loading" ? (
                  <div
                    role="status"
                    className="flex h-11 min-w-[156px] items-center justify-center gap-2 rounded-full bg-card/80 px-6 text-[14.5px] font-medium text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] backdrop-blur-sm"
                  >
                    <Loader2 className="size-4 animate-spin" />
                    {phase === "thinking" ? "Transcribing" : "Loading model"}
                  </div>
                ) : (
                  <>
                    <Button variant="brand" size="lg" className="min-w-[156px]" onClick={toggle} disabled={disabled}>
                      <Mic className="size-4" strokeWidth={2.4} />
                      Talk
                      <KeyCap tone="brand">Space</KeyCap>
                    </Button>
                    {(phase === "error" || prepare.error) && (
                      <Button variant="outline" size="lg" onClick={() => prepare.run()}>
                        Try again
                      </Button>
                    )}
                  </>
                )}
              </div>

              <div className="mt-3 flex h-7 items-center justify-center">
                <AnimatePresence mode="wait">
                  {toast ? (
                    <motion.div
                      key={toast}
                      initial={{ opacity: 0, y: 10, scale: 0.9 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.96, transition: { duration: 0.18 } }}
                      transition={{ type: "spring", stiffness: 520, damping: 30 }}
                      className="flex h-7 items-center gap-2 rounded-full bg-foreground pr-3 pl-1 text-[12.5px] font-medium text-background shadow-[0_6px_18px_-6px_rgb(0_0_0/0.35)]"
                    >
                      <motion.span
                        initial={{ scale: 0, rotate: -45 }}
                        animate={{ scale: 1, rotate: 0 }}
                        transition={{ type: "spring", stiffness: 600, damping: 18, delay: 0.08 }}
                        className="grid size-5 place-items-center rounded-full bg-good text-white"
                      >
                        <Check className="size-3" strokeWidth={3.2} />
                      </motion.span>
                      {clip?.id === toast && items[0]?.clean ? "Cleaned and copied. Paste with ⌘V" : "Copied. Paste with ⌘V"}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
              <ErrorNote error={error} className="mt-1 max-w-md text-left" />
            </div>
            <CleanupStrip cleanup={cleanup} busy={phase === "listening" || phase === "thinking"} />
          </section>

          {/* ---- this session ---- */}
          <section className="@container/list flex min-h-0 flex-col">
            <div className="mb-3 flex h-7 items-center gap-2 px-1">
              <span className="text-[10.5px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">This session</span>
              {items.length > 0 && <span className="text-[11.5px] text-muted-foreground tabular-nums">{items.length}</span>}
              {items.length > 0 && (
                <Button variant="ghost" size="sm" className="ml-auto" onClick={clear}>
                  Clear
                </Button>
              )}
            </div>
            <div className="-mx-2 min-h-0 flex-1 px-2 pt-0.5 pb-4 @min-[720px]:overflow-y-auto @min-[720px]:[mask-image:linear-gradient(to_bottom,transparent,#000_10px,#000_calc(100%-24px),transparent)]">
              <TranscriptList items={items} freshId={freshId} clip={clip} onCopy={onCopy} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Headline({ phase, hasItems }: { phase: Phase; hasItems: boolean }) {
  const cls = "font-display text-[25px] leading-none font-semibold tracking-[-0.02em] whitespace-nowrap @min-[960px]:text-[30px]";
  return (
    <div className="relative flex h-9 items-center justify-center">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={phase}
          initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className={cls}
        >
          {phase === "listening" ? (
            <Timer running className="tabular-nums" />
          ) : phase === "thinking" ? (
            "Writing it down"
          ) : phase === "loading" ? (
            "Waking up your model"
          ) : phase === "error" ? (
            "Something went wrong"
          ) : hasItems ? (
            "Ready for another"
          ) : (
            "Ready when you are"
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** A device-style label strip: a status light, what the instrument is doing, and the model in use. */
function StatusBar({ phase, model }: { phase: Phase; model: string | null }) {
  const label: Record<Phase, string> = {
    loading: "Loading",
    ready: "Ready",
    listening: "Rec",
    thinking: "Transcribing",
    error: "Offline",
  };
  const light: Record<Phase, string> = {
    loading: "bg-warn",
    ready: "bg-good",
    listening: "bg-brand",
    thinking: "bg-brand-gold",
    error: "bg-destructive",
  };
  return (
    <div className="flex items-center justify-between px-5 pt-4 font-mono text-[10.5px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
      <span className="flex items-center gap-2">
        <span className="relative flex size-2">
          {phase !== "ready" && phase !== "error" && (
            <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", light[phase])} />
          )}
          <span className={cn("relative size-2 rounded-full shadow-[0_0_8px_currentColor]", light[phase])} />
        </span>
        {label[phase]}
      </span>
      <span className="truncate pl-4 tracking-[0.06em] normal-case">{model ? `On-device · ${model}` : "On-device"}</span>
    </div>
  );
}

function KeyCap({ tone, children }: { tone: "brand" | "dark"; children: ReactNode }) {
  return (
    <kbd
      className={cn(
        "ml-1 inline-flex h-[20px] items-center rounded-[6px] px-1.5 font-sans text-[10.5px] font-semibold tracking-wide",
        tone === "brand" && "bg-white/20 text-white shadow-[inset_0_-1px_0_rgb(0_0_0/0.15),inset_0_0_0_0.5px_rgb(255_255_255/0.3)]",
        tone === "dark" && "bg-primary-foreground/15 text-primary-foreground/85 shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.15)]",
      )}
    >
      {children}
    </kbd>
  );
}
