import "./record/record.css";

import { cn } from "@zunos/ui/lib/utils";
import { ChevronLeft, ChevronRight, Library as LibraryIcon, PenLine } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Lang, PromptItem } from "../../shared/types";
import { Bean, type BeanMood } from "../Bean";
import { Badge, Button, ErrorNote, langName, minutes, useAction, useAsync, usePresent } from "../ui";
import type { ScreenProps } from "../ZunosApp";
import { Compose } from "./record/Compose";
import { Enough } from "./record/Enough";
import { Clock, Deck, type KeyName, type Phase } from "./record/Deck";
import { LanguageDials } from "./record/LanguageDials";
import { Library } from "./record/Library";
import { promptLabel, readingSeconds, type Take } from "./record/model";
import { Prompter } from "./record/Prompter";
import { TakeTray } from "./record/TakeTray";
import { VoiceRibbon } from "./record/VoiceRibbon";

export default function Record({ a, live, go }: ScreenProps) {
  const langs = useAsync(() => a.languages());
  const stats = useAsync(() => a.stats());
  const enabled = useMemo(() => (langs.data ?? []).filter((l) => l.enabled), [langs.data]);
  const [lang, setLang] = useState<Lang | null>(null);
  const current = lang ?? enabled[0]?.code ?? null;
  const prompts = useAsync(() => (current ? a.prompts(current) : Promise.resolve([])), [current]);

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
  const [line, setLine] = useState(-1); // -1: not started
  const [since, setSince] = useState(0);
  const [takes, setTakes] = useState<Take[]>([]);
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
  const finish = useAction(async () => {
    const p = prompt!;
    let saved;
    try {
      saved = await a.finishTake();
    } finally {
      setLine(-1);
    }
    const { kind, title } = promptLabel(p, list);
    setTakes((t) => [{ at: Date.now(), promptId: p.id, label: `${kind} ${title}`, saved }, ...t]);
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

  const phase: Phase = start.busy ? "starting" : finish.busy ? "saving" : line >= 0 ? "recording" : "ready";
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
    a.markLine();
    setLine((l) => l + 1);
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
  const error = start.error ?? finish.error ?? cancel.error ?? prompts.error;
  const done = list.filter((p) => p.recorded).length;
  const single = (prompt?.lines.length ?? 1) === 1;

  return (
    <div className="@container relative flex h-full min-h-[560px] flex-col px-8 pt-9 pb-3">
      {/* A few languages sit next to the title; more get a row of their own that scrolls. */}
      <header className={cn("mb-4 flex gap-x-6 gap-y-3", enabled.length > 3 ? "flex-col" : "items-end justify-between")}>
        <div className="min-w-0 shrink-0">
          <h1 className="font-display text-[30px] leading-none font-bold tracking-[-0.025em]">Record</h1>
          <p className="mt-2 hidden max-w-[22rem] text-[13px] leading-snug text-muted-foreground @[880px]:block">
            Read aloud at your normal pace. Five minutes in each language is enough to train; more makes a better model.
          </p>
        </div>
        <LanguageDials
          languages={enabled}
          stats={stats.data}
          value={current}
          onChange={onLang}
          disabled={locked}
          className={enabled.length > 3 ? "self-stretch" : "shrink"}
        />
      </header>

      <section data-rec={live.recording} className="rk-stage grain flex min-h-[260px] flex-1 flex-col overflow-hidden">
        <div className="relative z-10 flex h-[54px] shrink-0 items-center gap-2.5 pr-3 pl-5">
          {composing ? (
            <>
              <Badge tone="brand">
                <PenLine className="size-3" /> Your own
              </Badge>
              <span className="min-w-0 truncate text-[13.5px] font-medium">Write something to read in {current ? langName(current) : ""}</span>
            </>
          ) : label ? (
            <>
              <Badge tone="brand">{label.kind}</Badge>
              <span title={label.title} className="min-w-0 truncate text-[13.5px] font-medium tabular-nums">{label.title}</span>
              {prompt?.recorded && <Badge tone="good">Read before</Badge>}
            </>
          ) : (
            <span className="text-[13px] text-muted-foreground">{prompts.loading ? "Loading…" : null}</span>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {phase === "saving" ? (
              <span className="flex h-7 items-center rounded-full bg-foreground/[0.06] px-3 text-[12px] font-medium text-muted-foreground">Saving…</span>
            ) : live.recording || line >= 0 ? (
              <span className="flex h-7 items-center gap-2 rounded-full bg-brand/12 pr-3 pl-2.5 text-[12px] font-semibold text-brand dark:bg-brand/20">
                <span className="rk-rec-dot size-2 rounded-full bg-brand" />
                REC
                {since > 0 && <Clock since={since} className="font-mono text-[12px] tabular-nums" />}
              </span>
            ) : (
              <>
                <IconButton title="Previous" disabled={locked || composing || index <= 0} onClick={() => onPick(list[index - 1]!.id)}>
                  <ChevronLeft className="size-4" />
                </IconButton>
                <IconButton title="Next" disabled={locked || composing || index < 0 || index >= list.length - 1} onClick={() => onPick(list[index + 1]!.id)}>
                  <ChevronRight className="size-4" />
                </IconButton>
                <span className="mx-1 h-4 w-px bg-border" />
                {!composing && (
                  <Button size="sm" variant="ghost" disabled={locked || !current} onClick={onWrite}>
                    <PenLine className="size-3.5" /> Write your own
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
          estimate={prompt ? readingSeconds(prompt.lines) : 0}
          savedNote={savedNote}
          pressed={pressed}
          disabled={!prompt || composing}
          onPrimary={onPrimary}
          onFinish={onFinish}
          onDiscard={onDiscard}
        />
      </div>

      {error && <ErrorNote error={error} className="mt-3" />}

      {/* The "enough to train" card sits beside the takes, or under them when there isn't room. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="min-w-[min(100%,20rem)] flex-1">
          <TakeTray takes={takes} />
        </div>
        {!locked && <Enough stats={stats.data} current={current} onLang={onLang} onTrain={go && (() => go("train"))} />}
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
