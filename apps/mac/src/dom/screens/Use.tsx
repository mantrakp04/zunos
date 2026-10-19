import { cn } from "@zunos/ui/lib/utils";
import { Check, Loader2, Mic, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DictationItem, LiveState } from "../../shared/types";
import type { BeanMood } from "../Bean";
import { Button, ErrorNote, PageHeader, Segmented, useAction, useAsync, usePresent } from "../ui";
import type { ScreenProps } from "../ZunosApp";
import { Instrument, type Phase, Timer } from "./use/Instrument";
import { CleanupStrip, useCleanup } from "./use/cleanup";
import { DictationHistory, EmptyHistory, type Landed, textOf } from "./use/History";
import { AccessCard, type DictationPrefs, DictationSettingsPanel, hotkeyPhrase, KEYS, useDictationSettings } from "./use/settings";

const listOf = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
/** Named one by one up to three; past that the line would run to a paragraph, so just the count. */
const talkIn = (names: string[]) => (names.length <= 3 ? `Talk in ${listOf(names)}` : `Talk in any of your ${names.length} languages`);

type Tab = "history" | "settings";
const TAB_KEY = "zunos.dictate.tab";
const savedTab = (): Tab => (typeof localStorage !== "undefined" && localStorage.getItem(TAB_KEY) === "settings" ? "settings" : "history");

export default function Use({ a, live }: ScreenProps) {
  const actions = useRef(a);
  actions.current = a;

  const [tab, setTabState] = useState<Tab>(savedTab);
  const setTab = (t: Tab) => (setTabState(t), localStorage.setItem(TAB_KEY, t));
  const [freshId, setFreshId] = useState<string | null>(null);
  const [landed, setLanded] = useState<Landed>(null);
  const [toast, setToast] = useState<{ id: string; cleaned: boolean } | null>(null);
  const [cheer, setCheer] = useState(0);
  const [spoke, setSpoke] = useState(0);
  const startedAt = useRef(0);

  const models = useAsync(() => a.models(), []);
  const langs = useAsync(() => a.languages(), []);
  const history = useAsync(() => a.dictations(100), [live.dictationsVersion]);
  const model = models.data?.find((m) => m.active && m.format === "hf")?.name ?? null;
  const langNames = useMemo(() => (langs.data ?? []).filter((l) => l.enabled).map((l) => l.name), [langs.data]);
  const cleanup = useCleanup(a, live);
  const prefs = useDictationSettings(a);
  const phrase = hotkeyPhrase(prefs.settings);

  const prepare = useAction(() => a.prepareDictation());
  const start = useAction(() => a.startDictation());
  const stop = useAction(async () => {
    setSpoke((performance.now() - startedAt.current) / 1000);
    const r = await a.stopDictation();
    setCheer(Date.now());
    // Native has already copied `clean ?? text` (when there was any text).
    if (r.clean ?? r.text) setToast({ id: r.id, cleaned: !!r.clean });
  });
  const cancel = useAction(() => a.cancelDictation());

  // A dictation that shows up at the top of the history while this screen is open (from the Talk
  // button or the hotkey) gets the word-by-word reveal and a chip saying where its text went.
  const known = useRef<Set<string> | null>(null);
  const source = useRef<"window" | "hotkey">("window");
  if (live.dictation) source.current = live.dictation.source;
  useEffect(() => {
    const list = history.data;
    if (!list) return;
    const top = list[0];
    if (known.current && top && !known.current.has(top.id)) {
      setFreshId(top.id);
      const text = textOf(top);
      if (top.status === "ok" && text) {
        const pasted = source.current === "hotkey" && prefs.settings.paste && !!top.appName;
        setLanded({ id: top.id, text, pastedInto: pasted ? top.appName : null });
      }
    }
    known.current = new Set(list.map((d) => d.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.data]);

  useEffect(() => {
    prepare.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (live.recording) startedAt.current = performance.now();
  }, [live.recording]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!cheer) return;
    const t = setTimeout(() => setCheer(0), 1400);
    return () => clearTimeout(t);
  }, [cheer]);

  const dict = live.dictation;
  const viaHotkey = dict?.source === "hotkey";
  const loading = prepare.busy || live.engine === "loading" || live.engine === "starting";
  const disabled = loading || stop.busy || start.busy || viaHotkey;
  const phase: Phase =
    stop.busy || dict?.phase === "thinking"
      ? "thinking"
      : live.recording || dict?.phase === "listening"
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
  const keys = useRef({ toggle, escape: () => {} });
  keys.current = {
    toggle,
    // Esc throws away a dictation started here, like it does for the hotkey.
    escape: () => live.recording && !viaHotkey && !stop.busy && cancel.run(),
  };
  const present = usePresent();
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || !!t.closest("input, textarea, select, [contenteditable]"));
    const onDown = (e: KeyboardEvent) => {
      if (!present.current) return;
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.code === "Escape") return void keys.current.escape();
      if (e.code !== "Space") return;
      e.preventDefault();
      if (!e.repeat) keys.current.toggle();
    };
    // A focused button would also "click" on Space release; Space belongs to dictation here.
    const onUp = (e: KeyboardEvent) => {
      if (present.current && e.code === "Space" && !typing(e.target)) e.preventDefault();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  const onCopy = useCallback((d: DictationItem, text: string) => {
    actions.current.copyText(text);
    setLanded({ id: d.id, text, pastedInto: null });
  }, []);

  const error = prepare.error ?? start.error ?? stop.error ?? cancel.error ?? (live.engine === "error" ? live.engineError : null);
  const items = history.data ?? [];
  const showAccess = !live.access.trusted && (tab === "settings" || prefs.settings.hotkey !== "off");

  return (
    <div className="@container/page h-full">
      {/* Side by side, the columns fill the window; a short window scrolls rather than squash the instrument. */}
      <div className="mx-auto flex max-w-[1240px] flex-col px-8 pt-10 pb-7 @min-[720px]:h-full @min-[720px]:min-h-[660px]">
        <PageHeader
          title="Dictate"
          subtitle={
            phrase
              ? `Talk here with Space, or ${phrase.toLowerCase()} in any app and it's pasted where you're typing. It all runs on this Mac.`
              : "Talk, stop, paste. The text goes straight to your clipboard, and it all runs on this Mac."
          }
        >
          <HotkeyChip prefs={prefs} live={live} onClick={() => setTab("settings")} />
        </PageHeader>

        <div className="grid min-h-0 flex-1 gap-6 @min-[720px]:grid-cols-[minmax(330px,1fr)_minmax(320px,1fr)]">
          {/* ---- the instrument ---- */}
          <section className="relative isolate flex min-h-[470px] flex-col overflow-hidden rounded-[24px] bg-card shadow-[0_0_0_1px_var(--border),var(--elevate)]">
            <div aria-hidden className="grain pointer-events-none absolute inset-0 -z-10 opacity-70 dark:opacity-40" />
            <StatusBar phase={phase} model={model} viaHotkey={viaHotkey} />

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
                {phase === "ready" && (langNames.length > 1 ? `${talkIn(langNames)}, or mix them in one sentence.` : "Talk the way you normally would.")}
                {phase === "listening" &&
                  (viaHotkey
                    ? `Listening from the hotkey. ${prefs.settings.mode === "toggle" ? "Tap" : "Let go of"} ${prefs.settings.hotkey === "off" ? "it" : KEYS[prefs.settings.hotkey].short} when you're done.`
                    : "Listening. Press Space when you're done, Esc to throw it away.")}
                {phase === "thinking" &&
                  (viaHotkey
                    ? `${cleanup.active ? "Transcribing and cleaning up" : "Transcribing"}, then it's ${prefs.settings.paste ? "pasted" : "copied"}`
                    : `${spoke.toFixed(1)} s of speech, ${cleanup.active ? "transcribing and cleaning up" : "transcribing"} on this Mac`)}
                {phase === "error" && "The engine stopped before your model was ready."}
              </p>

              <div className="mt-4 flex h-11 items-center gap-2">
                {phase === "listening" && !viaHotkey ? (
                  <Button variant="primary" size="lg" className="min-w-[156px]" onClick={toggle} disabled={disabled}>
                    <Square className="size-3.5" fill="currentColor" />
                    Stop
                    <KeyCap tone="dark">Space</KeyCap>
                  </Button>
                ) : phase === "thinking" || phase === "loading" || viaHotkey ? (
                  <div
                    role="status"
                    className="flex h-11 min-w-[156px] items-center justify-center gap-2 rounded-full bg-card/80 px-6 text-[14.5px] font-medium text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] backdrop-blur-sm"
                  >
                    {phase === "listening" ? <span className="size-2 animate-pulse rounded-full bg-brand" /> : <Loader2 className="size-4 animate-spin" />}
                    {phase === "listening" ? "Hotkey" : phase === "thinking" ? "Transcribing" : "Loading model"}
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
                      key={toast.id}
                      initial={{ opacity: 0, y: 10, scale: 0.9 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.96, transition: { duration: 0.18 } }}
                      transition={{ type: "spring", stiffness: 520, damping: 30 }}
                      className="flex h-7 items-center gap-2 rounded-full bg-foreground pr-3 pl-1 text-[12.5px] font-medium whitespace-nowrap text-background shadow-[0_6px_18px_-6px_rgb(0_0_0/0.35)]"
                    >
                      <motion.span
                        initial={{ scale: 0, rotate: -45 }}
                        animate={{ scale: 1, rotate: 0 }}
                        transition={{ type: "spring", stiffness: 600, damping: 18, delay: 0.08 }}
                        className="grid size-5 place-items-center rounded-full bg-good text-white"
                      >
                        <Check className="size-3" strokeWidth={3.2} />
                      </motion.span>
                      {toast.cleaned ? "Cleaned and copied. Paste with ⌘V" : "Copied. Paste with ⌘V"}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
              <ErrorNote error={error} className="mt-1 max-w-md text-left" />
            </div>
            <CleanupStrip cleanup={cleanup} busy={phase === "listening" || phase === "thinking"} />
          </section>

          {/* ---- history and settings ---- */}
          <section className="@container/list flex min-h-0 flex-col">
            <div className="mb-3 flex h-7 items-center gap-2 px-1">
              <Segmented<Tab>
                size="sm"
                value={tab}
                onChange={setTab}
                options={[
                  {
                    value: "history",
                    label: (
                      <>
                        History
                        {items.length > 0 && <span className="ml-1.5 text-muted-foreground tabular-nums">{items.length}</span>}
                      </>
                    ),
                  },
                  { value: "settings", label: "Settings" },
                ]}
              />
            </div>
            <div className="-mx-2 min-h-0 flex-1 px-2 pt-0.5 pb-4 @min-[720px]/page:overflow-y-auto @min-[720px]/page:[mask-image:linear-gradient(to_bottom,#000_calc(100%-24px),transparent)]">
              <AnimatePresence initial={false}>
                {showAccess && (
                  <div key="access" className="mb-3">
                    <AccessCard a={a} />
                  </div>
                )}
              </AnimatePresence>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={tab}
                  initial={{ opacity: 0, x: tab === "settings" ? 10 : -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: tab === "settings" ? 10 : -10, transition: { duration: 0.12 } }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                >
                  {tab === "history" ? (
                    <>
                      <ErrorNote error={history.error} className="mb-3" />
                      <DictationHistory
                        a={a}
                        items={items}
                        freshId={freshId}
                        landed={landed}
                        onCopy={onCopy}
                        empty={history.data ? <EmptyHistory phrase={phrase} /> : null}
                      />
                    </>
                  ) : (
                    <DictationSettingsPanel a={a} live={live} prefs={prefs} cleanup={cleanup} busy={phase === "listening" || phase === "thinking"} />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** The hotkey as a little keycap in the header; opens the settings. Presses down while it's held. */
function HotkeyChip({ prefs, live, onClick }: { prefs: DictationPrefs; live: LiveState; onClick: () => void }) {
  const { settings } = prefs;
  const phrase = hotkeyPhrase(settings);
  const held = live.dictation?.source === "hotkey" && live.dictation.phase === "listening";
  const needsAccess = settings.hotkey !== "off" && !live.access.trusted;
  if (!prefs.loaded) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Hotkey settings"
      className="group flex h-10 shrink-0 items-center gap-2.5 rounded-full whitespace-nowrap bg-card pr-4 pl-1.5 shadow-[0_0_0_1px_var(--border),var(--elevate)] transition-shadow hover:shadow-[0_0_0_1px_var(--input),var(--elevate)]"
    >
      <motion.span
        animate={{ y: held ? 1.5 : 0 }}
        transition={{ type: "spring", stiffness: 700, damping: 30 }}
        className={cn(
          "grid h-7 min-w-8 place-items-center rounded-[8px] px-1.5 text-[13px] font-semibold transition-[background,box-shadow,color]",
          settings.hotkey === "off"
            ? "bg-muted text-muted-foreground"
            : held
              ? "bg-brand text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_0_0_#a8261b,0_0_14px_rgb(243_74_45/0.6)]"
              : "bg-[linear-gradient(180deg,var(--card),color-mix(in_oklab,var(--foreground)_6%,var(--card)))] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.6),0_0_0_0.5px_var(--input),0_1.5px_0_var(--input)] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_0_0_0.5px_var(--input),0_1.5px_0_rgb(0_0_0/0.5)]",
        )}
      >
        {settings.hotkey === "off" ? "off" : KEYS[settings.hotkey].glyph}
      </motion.span>
      <span className="text-left leading-tight">
        <span className="block text-[12.5px] font-semibold">{phrase ? `${phrase} anywhere` : "Hotkey off"}</span>
        <span className={cn("flex items-center gap-1 text-[11px]", needsAccess ? "text-warn" : "text-muted-foreground")}>
          {needsAccess ? (
            <>
              <span className="size-1.5 rounded-full bg-warn" />
              Needs access
            </>
          ) : held ? (
            "Listening"
          ) : phrase ? (
            prefs.settings.paste ? "Pastes where you type" : "Copies to the clipboard"
          ) : (
            "Set one up"
          )}
        </span>
      </span>
    </button>
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
function StatusBar({ phase, model, viaHotkey }: { phase: Phase; model: string | null; viaHotkey: boolean }) {
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
    <div className="flex min-w-0 items-center justify-between px-5 pt-4 font-mono text-[10.5px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
      <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <span className="relative flex size-2">
          {phase !== "ready" && phase !== "error" && (
            <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", light[phase])} />
          )}
          <span className={cn("relative size-2 rounded-full shadow-[0_0_8px_currentColor]", light[phase])} />
        </span>
        {label[phase]}
        {viaHotkey && <span className="text-muted-foreground/70">· hotkey</span>}
      </span>
      <span className="min-w-0 truncate pl-4 tracking-[0.06em] normal-case" title={model ?? undefined}>
        {model ? `On-device · ${model}` : "On-device"}
      </span>
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
