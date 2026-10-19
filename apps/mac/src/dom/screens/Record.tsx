import "./record/record.css";

import { cn } from "@zunos/ui/lib/utils";
import { ChevronLeft, ChevronRight, Library as LibraryIcon, PenLine } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Lang, PromptItem, Script } from "../../shared/types";
import { Bean, type BeanMood } from "../Bean";
import { TrainButton } from "../TrainButton";
import { Badge, Button, ErrorNote, langName, minutes, useAction, useAsync, usePresent } from "../ui";
import type { ScreenProps } from "../ZunosApp";
import { Compose } from "./record/Compose";
import { Clock, Deck, type KeyName, type Phase } from "./record/Deck";
import { LanguageDials } from "./record/LanguageDials";
import { Library } from "./record/Library";
import { promptLabel } from "./record/model";
import { Prompter } from "./record/Prompter";
import { ScriptToggle } from "./record/ScriptToggle";
import { LiveMicIssue, MicLine } from "./record/MicNotes";
import { TakeQualityNote, UncutTakes } from "./record/TakeNotes";
import { VoiceRibbon } from "./record/VoiceRibbon";

export default function Record({ a, live, go }: ScreenProps) {
  const langs = useAsync(() => a.languages());
  const stats = useAsync(() => a.stats());
  const enabled = useMemo(() => (langs.data ?? []).filter((l) => l.enabled), [langs.data]);
  const [lang, setLang] = useState<Lang | null>(null);
  const current = lang ?? enabled[0]?.code ?? null;
  const prompts = useAsync(() => (current ? a.prompts(current) : Promise.resolve([])), [current]);

  // What you read in, per language: native script or English letters. Shown at once; the prompts
  // come back in the new script after the save.
  const currentLang = enabled.find((l) => l.code === current) ?? null;
  const [scriptPick, setScriptPick] = useState<Partial<Record<Lang, Script>>>({});
  const script: Script = (current && scriptPick[current]) || currentLang?.script || "native";
  const switchScript = useAction(async (lang: Lang, s: Script) => {
    setScriptPick((p) => ({ ...p, [lang]: s }));
    try {
      await a.setLanguageScript(lang, s);
      await Promise.all([langs.reload(), prompts.reload()]);
    } finally {
      setScriptPick(({ [lang]: _, ...rest }) => rest as Partial<Record<Lang, Script>>);
    }
  });

  // Prompts written this session, in case the list hasn't caught up with them yet.
  const [created, setCreated] = useState<PromptItem[]>([]);
  const list = useMemo(() => {
    const base = (prompts.data ?? []).filter((p) => p.lang === current);
    const extra = created.filter((c) => c.lang === current && !base.some((b) => b.id === c.id));
    return extra.length ? [...base, ...extra] : base;
  }, [prompts.data, created, current]);

  const [selected, setSelected] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const prompt = list.find((p) => p.id === selected) ?? list.find((p) => !p.recorded) ?? list[0] ?? null;
  const index = prompt ? list.indexOf(prompt) : -1;

  // ---- the take
  const [line, setLineState] = useState(-1); // -1: not started
  // The line being read, kept in a ref too: markLine and finishTake send it, and a quick key press
  // must not read a stale value from the last render.
  const lineRef = useRef(-1);
  const setLine = (l: number) => ((lineRef.current = l), setLineState(l));
  const finishing = useRef(false);
  const [since, setSince] = useState(0);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [cheer, setCheer] = useState(false);
  const levelRef = useRef(0);
  levelRef.current = live.level;

  const start = useAction(async () => {
    if (!prompt) return;
    setSavedNote(null);
    await a.startTake(prompt.id);
    setLine(0);
    setSince(Date.now());
  });
  // Takes that were saved but couldn't be cut into clips; each can be retried.
  const uncut = useAsync(() => a.unsegmentedRecordings(), []);
  const finish = useAction(async () => {
    if (finishing.current) return; // Space and Return both finish; the save is already on its way
    finishing.current = true;
    const p = prompt!;
    // The line you're on counts as read, and lines after it don't: exact even if a mark went missing.
    const at = lineRef.current;
    let saved;
    try {
      saved = await a.finishTake(at >= 0 ? at : undefined);
    } catch (e) {
      uncut.reload();
      throw e;
    } finally {
      finishing.current = false;
      setLine(-1);
    }
    setSavedNote(`${minutes(saved.seconds)} as ${saved.clips.length} clip${saved.clips.length === 1 ? "" : "s"}`);
    setCheer(true);
    // On to the next one you haven't read yet, so a run of sentences is just Space, Space, Space.
    const i = list.findIndex((x) => x.id === p.id);
    const next = [...list.slice(i + 1), ...list.slice(0, Math.max(0, i))].find((x) => !x.recorded && x.id !== p.id);
    setSelected(next?.id ?? p.id);
    prompts.reload();
    stats.reload();
  });
  const cancel = useAction(async () => {
    await a.cancelTake();
    setLine(-1);
  });
  const retry = useAction(async () => {
    const list = (await a.unsegmentedRecordings()) ?? [];
    for (const r of list) await a.resegmentRecording(r.id);
    finish.setError(null);
    await Promise.all([uncut.reload(), prompts.reload(), stats.reload()]);
  });

  // How the last take in this language sounded, once it's cleaned in the background (reloaded when
  // qualityVersion moves). Only takes from this visit, and only until dismissed; nothing waits on it.
  const shownSince = useRef(Date.now());
  const qualities = useAsync(() => (current ? a.takeQualities(current) : Promise.resolve([])), [current, live.qualityVersion]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const latest = qualities.data?.[0] ?? null;
  const quality = latest && latest.recordingId !== dismissed && new Date(latest.recordedAt).getTime() >= shownSince.current ? latest : null;
  // "Record it again": pick that prompt, then start as soon as it's the one on the stage.
  const redoNext = useRef<string | null>(null);
  const redo = (promptId: string) => {
    if (locked) return;
    setDismissed(latest?.recordingId ?? null);
    setWriting(false);
    setSelected(promptId);
    redoNext.current = promptId;
  };

  const phase: Phase = start.busy ? "starting" : finish.busy ? "saving" : line >= 0 ? "recording" : "ready";

  // The mic you're about to record with, and what's wrong with it. Checked again after each take and
  // every few seconds while idle, so plugging in (or switching to) AirPods shows up before the next take.
  const idle = phase === "ready" && !live.recording;
  const mic = useAsync(() => a.micInfo(), [idle]);
  useEffect(() => {
    if (!idle) return;
    const t = setInterval(() => mic.reload(), 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idle]);
  useEffect(() => {
    if (redoNext.current && prompt?.id === redoNext.current && idle) {
      redoNext.current = null;
      start.run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id, idle]);
  const recording = phase === "recording";
  const locked = live.recording || line >= 0 || start.busy || finish.busy || cancel.busy;
  const last = !!prompt && line === prompt.lines.length - 1;

  // A recording already running when the screen mounts (the preview's ?rec=1): read along with it.
  useEffect(() => {
    if (live.recording && line < 0 && !start.busy && !finish.busy && !cancel.busy && prompt) {
      setLine(0);
      setSince(Date.now());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.recording, !!prompt]);

  useEffect(() => {
    if (!cheer) return;
    const id = setTimeout(() => setCheer(false), 2600);
    return () => clearTimeout(id);
  }, [cheer]);

  const next = () => {
    if (!prompt || writing || start.busy || finish.busy || cancel.busy) return;
    if (!recording) return void start.run();
    if (last) return void finish.run();
    // Mark the line being left by its index, so a lost call can't shift the lines after it.
    const l = lineRef.current;
    a.markLine(l);
    setLine(l + 1);
  };

  // ---- keyboard: Space starts / next line, Return finishes, Esc discards. Ignored while typing.
  const [pressed, setPressed] = useState<KeyName | null>(null);
  const flash = (k: KeyName) => {
    setPressed(k);
    setTimeout(() => setPressed((p) => (p === k ? null : p)), 140);
  };
  const keys = useRef({ next, finish: () => {}, cancel: () => {}, drawer, recording, flash });
  keys.current = {
    next,
    finish: () => void finish.run(),
    cancel: () => void cancel.run(),
    drawer,
    recording,
    flash,
  };
  const present = usePresent();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!present.current) return;
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = keys.current;
      if (e.code === "Space") {
        e.preventDefault();
        if (e.repeat || k.drawer) return;
        k.flash("space");
        k.next();
      } else if (e.code === "Enter" || e.code === "NumpadEnter") {
        if (!k.recording) return;
        e.preventDefault();
        k.flash("enter");
        k.finish();
      } else if (e.code === "Escape") {
        if (k.recording) (e.preventDefault(), k.flash("esc"), k.cancel());
        else if (k.drawer) (e.preventDefault(), setDrawer(false));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Stable handlers for the memoized parts, so the 16 Hz level updates don't re-render them.
  const h = useRef({ next, finish: keys.current.finish, cancel: keys.current.cancel });
  h.current = { next, finish: keys.current.finish, cancel: keys.current.cancel };
  const onPrimary = useCallback(() => h.current.next(), []);
  const onFinish = useCallback(() => h.current.finish(), []);
  const onDiscard = useCallback(() => h.current.cancel(), []);
  const onLang = useCallback((l: Lang) => (setLang(l), setSelected(null), setWriting(false), setDrawer(false), setSavedNote(null)), []);
  const onPick = useCallback((id: string) => (setSelected(id), setWriting(false), setDrawer(false), setSavedNote(null)), []);
  const onWrite = useCallback(() => (setWriting(true), setDrawer(false)), []);
  const onClose = useCallback(() => setDrawer(false), []);

  // The warm light behind the line follows the voice; written straight to the element.
  const spot = useRef<HTMLDivElement>(null);
  const onFrame = useCallback((v: number) => {
    const el = spot.current;
    if (!el) return;
    el.style.opacity = (v * 0.95).toFixed(3);
    el.style.scale = (0.85 + v * 0.3).toFixed(3);
  }, []);

  const mood: BeanMood = live.recording ? "listening" : finish.busy ? "thinking" : cheer ? "happy" : "idle";
  const label = prompt ? promptLabel(prompt, list) : null;
  const composing = !!current && (writing || (!prompts.loading && !prompt));
  const error = start.error ?? cancel.error ?? prompts.error ?? switchScript.error;
  // The starter set comes first in the queue; while you're in it, a quiet count of how far along.
  const starters = list.filter((p) => p.starter);
  const startersDone = starters.filter((p) => p.recorded).length;
  const done = list.filter((p) => p.recorded).length;
  const single = (prompt?.lines.length ?? 1) === 1;
  // Start training fills as you record. Memoised so the Deck (memo) doesn't re-render with every mic level update.
  const counts = useMemo(
    () => enabled.map(({ code }) => stats.data?.find((s) => s.lang === code) ?? { lang: code, trainSeconds: 0, testSeconds: 0 }),
    [enabled, stats.data],
  );
  const trainButton = useMemo(
    () => (locked ? null : <TrainButton stats={stats.data ? counts : null} onTrain={() => go?.("train")} />),
    [locked, counts, stats.data, go],
  );

  return (
    <div className="@container relative flex h-full min-h-[560px] flex-col px-8 pt-9 pb-3">
      {/* A few languages sit next to the title; more get a row of their own that scrolls. */}
      <header className={cn("mb-4 flex gap-x-6 gap-y-3", enabled.length > 3 ? "flex-col" : "items-center justify-between")}>
        <h1 className="shrink-0 font-display text-[30px] leading-none font-bold tracking-[-0.025em]">Record</h1>
        <LanguageDials
          languages={enabled}
          stats={stats.data}
          value={current}
          onChange={onLang}
          disabled={locked}
          className={enabled.length > 3 ? "self-stretch" : "shrink"}
        />
      </header>

      <section data-rec={live.recording} className="rk-stage grain flex min-h-[260px] flex-1 flex-col overflow-clip">
        <div className="relative z-10 flex h-[54px] shrink-0 items-center gap-2.5 pr-3 pl-5">
          {/* The label side gives way first: the title truncates, the starter count drops on a narrow card. */}
          <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
            {composing ? (
              <>
                <Badge tone="brand">
                  <PenLine className="size-3" /> Your own
                </Badge>
                <span className="min-w-0 truncate text-[13.5px] font-medium">Write something to read in {current ? langName(current) : ""}</span>
              </>
            ) : label ? (
              <>
                <Badge tone="brand" className="shrink-0">{label.kind}</Badge>
                <span title={label.title} className="min-w-0 truncate text-[13.5px] font-medium tabular-nums">{label.title}</span>
                {prompt?.recorded && <Badge tone="good" className="shrink-0 @max-[820px]:hidden">Read before</Badge>}
                {prompt?.starter && (
                  <span title="Starter set" className="shrink-0 text-[11.5px] whitespace-nowrap text-muted-foreground tabular-nums @max-[820px]:hidden">
                    starter {startersDone}/{starters.length}
                  </span>
                )}
              </>
            ) : (
              <span className="text-[13px] text-muted-foreground">{prompts.loading ? "Loading…" : null}</span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {phase === "saving" ? (
              <span className="flex h-7 items-center rounded-full bg-foreground/[0.06] px-3 text-[12px] font-medium text-muted-foreground">Saving…</span>
            ) : live.recording || line >= 0 ? (
              <>
                {/* "Stay quiet" while the room tone is measured, then the worst live issue. */}
                {live.mic && <LiveMicIssue roomTone={live.mic.roomTone} issues={live.mic.issues} />}
                <span className="flex h-7 shrink-0 items-center gap-2 rounded-full bg-brand/12 pr-3 pl-2.5 text-[12px] font-semibold text-brand dark:bg-brand/20">
                  <span className="rk-rec-dot size-2 rounded-full bg-brand" />
                  REC
                  {since > 0 && <Clock since={since} className="font-mono text-[12px] tabular-nums" />}
                </span>
              </>
            ) : (
              <>
                {currentLang && !composing && (
                  <>
                    <ScriptToggle
                      lang={currentLang}
                      script={script}
                      disabled={locked || switchScript.busy}
                      onChange={(s) => switchScript.run(currentLang.code, s)}
                      className="mr-1"
                    />
                    {currentLang.hasRoman && <span className="mx-1 h-4 w-px bg-border" />}
                  </>
                )}
                <IconButton title="Previous" disabled={locked || composing || index <= 0} onClick={() => onPick(list[index - 1]!.id)}>
                  <ChevronLeft className="size-4" />
                </IconButton>
                <IconButton title="Next" disabled={locked || composing || index < 0 || index >= list.length - 1} onClick={() => onPick(list[index + 1]!.id)}>
                  <ChevronRight className="size-4" />
                </IconButton>
                <span className="mx-1 h-4 w-px bg-border" />
                {!composing && (
                  <Button size="sm" variant="ghost" disabled={locked || !current} onClick={onWrite} title="Write your own">
                    <PenLine className="size-3.5" /> <span className="@max-[860px]:hidden">Write your own</span>
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={locked || !current} onClick={() => setDrawer(true)}>
                  <LibraryIcon className="size-3.5" /> Library
                  <span className="text-[11.5px] text-muted-foreground tabular-nums">
                    {done}/{list.length}
                  </span>
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          <div
            className={cn(
              "rk-spot-base pointer-events-none absolute left-1/2 h-[min(260px,80%)] w-[80%] -translate-x-1/2 -translate-y-1/2",
              single ? "top-1/2" : "top-[42%]",
            )}
            style={{ opacity: recording && !composing ? 1 : 0 }}
          />
          <div
            ref={spot}
            className={cn("rk-spot pointer-events-none absolute left-1/2 h-[min(220px,70%)] w-[70%] -translate-x-1/2 -translate-y-1/2", single ? "top-1/2" : "top-[42%]")}
          />
          {composing && current ? (
            <Compose
              lang={current}
              a={a}
              onCancel={prompt ? () => setWriting(false) : undefined}
              onCreated={async (p) => {
                setCreated((c) => [...c, p]);
                await prompts.reload();
                setSelected(p.id);
                setWriting(false);
                setSavedNote(null);
              }}
            />
          ) : prompt ? (
            <Prompter prompt={prompt} line={line} reading={recording} />
          ) : null}
        </div>

        <div className="relative flex h-[78px] shrink-0 items-center pr-6 pl-5">
          <Bean mood={mood} level={live.level} size={46} className="relative z-10 shrink-0" />
          <VoiceRibbon levelRef={levelRef} active={live.recording} onFrame={onFrame} className="-ml-0.5 h-[72px] min-w-0 flex-1" />
        </div>
      </section>

      <div className="pt-5 pb-1">
        <Deck
          phase={phase}
          line={Math.max(0, line)}
          lineCount={prompt?.lines.length ?? 0}
          last={last}
          again={!!prompt?.recorded}
          savedNote={savedNote}
          pressed={pressed}
          disabled={!prompt || composing}
          onPrimary={onPrimary}
          onFinish={onFinish}
          onDiscard={onDiscard}
          aside={trainButton}
        />
      </div>

      {error && <ErrorNote error={error} className="mt-3" />}
      <div className="mt-1.5 flex min-h-5 flex-col gap-1">
        <UncutTakes count={uncut.data?.length ?? 0} error={finish.error ?? retry.error} busy={retry.busy} onRetry={() => retry.run()} />
        <TakeQualityNote
          item={quality}
          cleaning={live.cleaning?.pending ?? 0}
          busy={locked}
          onRedo={redo}
          onDismiss={() => latest && setDismissed(latest.recordingId)}
        />
        {idle && mic.data && <MicLine device={mic.data.device} issues={mic.data.issues} />}
      </div>

      <AnimatePresence>
        {drawer && current && (
          <Library lang={current} prompts={list} selected={prompt?.id ?? null} onSelect={onPick} onWrite={onWrite} onClose={onClose} />
        )}
      </AnimatePresence>
    </div>
  );
}

function IconButton({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}
