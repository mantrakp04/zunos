"use dom";

import "@zunos/ui/globals.css";
import "./zunos.css";

import { useSystemTheme } from "@zunos/ui/hooks/use-system-theme";
import { cn } from "@zunos/ui/lib/utils";
import { AudioLines, FlaskConical, LogOut, Mic, Sparkles, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import type { Actions } from "../services/actions";
import type { LiveState } from "../shared/types";
import { Bean, type BeanMood, Wordmark } from "./Bean";
import Languages from "./screens/Languages";
import Record from "./screens/Record";
import SignIn from "./screens/SignIn";
import Test from "./screens/Test";
import Train from "./screens/Train";
import Use from "./screens/Use";
import { Button, ErrorNote, langName, minutes, pct, useAsync } from "./ui";

export type ScreenProps = { a: Actions; live: LiveState };

type ScreenId = "record" | "train" | "test" | "use";

const NAV: { id: ScreenId; label: string; icon: LucideIcon; Screen: (p: ScreenProps) => React.ReactNode }[] = [
  { id: "record", label: "Record", icon: Mic, Screen: Record },
  { id: "train", label: "Train", icon: AudioLines, Screen: Train },
  { id: "test", label: "Test", icon: FlaskConical, Screen: Test },
  { id: "use", label: "Dictate", icon: Sparkles, Screen: Use },
];

const SCREEN_KEY = "zunos.screen";
const savedScreen = (): ScreenId => {
  const s = typeof localStorage !== "undefined" ? localStorage.getItem(SCREEN_KEY) : null;
  return NAV.some((n) => n.id === s) ? (s as ScreenId) : "record";
};

type Props = Actions & { live: LiveState; dom?: import("expo/dom").DOMProps };

export default function ZunosApp({ live, dom: _dom, ...a }: Props) {
  useSystemTheme();
  const langs = useAsync(() => a.languages(), [live.user?.id]);
  const [screen, setScreenState] = useState<ScreenId>(savedScreen);
  const [editingLangs, setEditingLangs] = useState(false);
  const setScreen = (id: ScreenId) => {
    setScreenState(id);
    localStorage.setItem(SCREEN_KEY, id);
  };

  // ⌘1–⌘4 jump between screens, like tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length && !live.recording) (e.preventDefault(), setScreen(NAV[n - 1]!.id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live.recording]);

  if (!live.authReady || (live.user && !langs.data)) return <Splash error={langs.error} onRetry={langs.reload} />;
  if (!live.user) return <SignIn a={a as Actions} live={live} />;
  if (editingLangs || !langs.data!.some((l) => l.enabled))
    return (
      <Languages
        a={a as Actions}
        live={live}
        initial={langs.data!}
        canCancel={langs.data!.some((l) => l.enabled)}
        onCancel={() => setEditingLangs(false)}
        onDone={async () => {
          await langs.reload();
          setEditingLangs(false);
        }}
      />
    );

  const { Screen } = NAV.find((n) => n.id === screen)!;
  return (
    <div className="flex h-screen overflow-hidden bg-rail text-foreground">
      <Rail
        a={a as Actions}
        live={live}
        screen={screen}
        onScreen={setScreen}
        languages={langs.data!.filter((l) => l.enabled).map((l) => l.code)}
        onEditLanguages={() => setEditingLangs(true)}
      />
      <main className="relative my-2 mr-2 min-w-0 flex-1 overflow-hidden rounded-[14px] bg-background shadow-[0_0_0_1px_var(--rail-line),0_1px_3px_rgb(0_0_0/0.05)]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={screen}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 overflow-y-auto"
          >
            <Screen a={a as Actions} live={live} />
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}

/* ---- the rail: brand, the four steps as one journey, your languages, engine and account ------- */

function Rail({ a, live, screen, onScreen, languages, onEditLanguages }: ScreenProps & {
  screen: ScreenId; onScreen: (id: ScreenId) => void; languages: string[]; onEditLanguages: () => void;
}) {
  // Small facts shown next to each step. Refreshed when the screen changes.
  const stats = useAsync(() => a.stats(), [screen]);
  const runs = useAsync(() => a.runs(), [screen]);
  const models = useAsync(() => a.models(), [screen]);
  const active = models.data?.find((m) => m.active && m.format === "hf");
  const evalRes = useAsync(() => (active ? a.latestEval(active.id) : Promise.resolve(null)), [active?.id, screen]);

  const recorded = (stats.data ?? []).reduce((s, x) => s + x.trainSeconds + x.testSeconds, 0);
  const running = (runs.data ?? []).find((r) => ["uploading", "queued", "running"].includes(r.status));
  const scores = Object.entries(evalRes.data?.scores ?? {}).filter(([k]) => k !== "avg").map(([, v]) => v);
  const avg = evalRes.data?.scores.avg ?? (scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : undefined);
  // Dictation from the global hotkey can start on any screen (or with the window closed).
  const hot = live.dictation?.source === "hotkey" ? live.dictation : null;
  const facts: Record<ScreenId, string | null> = {
    record: recorded > 0 ? minutes(recorded) : null,
    train: running ? "training…" : runs.data?.length ? `${runs.data.length} runs` : null,
    test: avg != null ? pct(avg) : null,
    use: hot ? (hot.phase === "listening" ? "listening" : "writing") : live.engine === "ready" && active ? "ready" : null,
  };
  const done: Record<ScreenId, boolean> = {
    record: recorded > 0, train: !!active, test: avg != null, use: !!active,
  };

  const mood: BeanMood =
    live.recording || hot?.phase === "listening"
      ? "listening"
      : hot?.phase === "thinking" || live.engine === "busy" || live.engine === "loading" || live.engine === "starting" || !!live.transfer
        ? "thinking"
        : live.engine === "error"
          ? "sleepy"
          : "idle";

  return (
    <aside className="flex w-[232px] shrink-0 flex-col px-3 pt-[calc(var(--titlebar)+14px)] pb-3 select-none">
      <div className="mb-6 flex items-center gap-2.5 px-2">
        <Bean mood={mood} level={live.level} size={34} className="-my-1 -ml-1" />
        <Wordmark height={17} className="text-brand-ink dark:text-brand-cream" />
      </div>

      <nav className="relative flex flex-col gap-0.5">
        {NAV.map(({ id, label, icon: Icon }, i) => {
          const on = screen === id;
          return (
            <button
              key={id}
              onClick={() => onScreen(id)}
              disabled={live.recording && !on}
              title={`${label} (⌘${i + 1})`}
              className={cn(
                "group relative flex h-10 items-center gap-3 rounded-[11px] px-2.5 text-left text-[13.5px] transition-colors disabled:opacity-40",
                on ? "text-foreground" : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
              )}
            >
              {on && (
                <motion.span
                  layoutId="rail-active"
                  transition={{ type: "spring", stiffness: 480, damping: 38 }}
                  className="absolute inset-0 rounded-[11px] bg-card shadow-[0_0_0_0.5px_var(--input),0_1px_2px_rgb(64_32_25/0.08),0_4px_14px_-6px_rgb(64_32_25/0.18)]"
                />
              )}
              <span
                className={cn(
                  "relative grid size-6 place-items-center rounded-[8px] transition-colors",
                  on ? "bg-brand text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_2px_6px_-1px_rgb(243_74_45/0.5)]" : "bg-foreground/[0.06]",
                )}
              >
                <Icon className="size-3.5" strokeWidth={2.2} />
              </span>
              <span className="relative font-medium">{label}</span>
              <span className="relative ml-auto flex items-center gap-1.5 text-[11.5px] tabular-nums text-muted-foreground">
                {facts[id]}
                {done[id] && !facts[id] && <span className="size-1.5 rounded-full bg-good" />}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="mt-7 px-2.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10.5px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Your voice</span>
          <button onClick={onEditLanguages} disabled={live.recording} className="text-[11.5px] text-muted-foreground hover:text-brand disabled:opacity-40">
            Edit
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {languages.map((code) => (
            <span key={code} className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11.5px] font-medium">
              {langName(code)}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {hot && <HotkeyDictation key="hot" phase={hot.phase} level={live.level} onOpen={() => onScreen("use")} />}
        </AnimatePresence>
        <EngineCard live={live} model={active?.name ?? null} />
        <div className="flex items-center gap-2 px-2.5 pt-1">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-ink text-[11px] font-semibold text-brand-cream dark:bg-brand-cream dark:text-brand-ink">
            {(live.user?.email ?? "?")[0]!.toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{live.user?.email}</span>
          <button title="Sign out" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground" onClick={() => a.signOut()}>
            <LogOut className="size-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}

/** A dictation from the hotkey, in whatever app is in front: what it's doing, and the voice level. */
function HotkeyDictation({ phase, level, onOpen }: { phase: "listening" | "thinking"; level: number; onOpen: () => void }) {
  const listening = phase === "listening";
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      title="Open Dictate"
      initial={{ opacity: 0, y: 10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.97, transition: { duration: 0.16 } }}
      transition={{ type: "spring", stiffness: 460, damping: 32 }}
      className={cn(
        "relative flex items-center gap-2.5 overflow-hidden rounded-[12px] px-3 py-2.5 text-left transition-colors duration-300",
        listening
          ? "bg-[linear-gradient(135deg,var(--brand),var(--brand-deep))] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_6px_18px_-8px_rgb(243_74_45/0.8)]"
          : "bg-brand-gold/16 text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--brand-gold)_40%,transparent)]",
      )}
    >
      <VoiceBars level={listening ? level : 0} thinking={!listening} />
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] leading-tight font-semibold">{listening ? "Listening" : "Writing it down"}</span>
        <span className={cn("block truncate text-[11px]", listening ? "text-white/75" : "text-muted-foreground")}>
          {listening ? "Esc to cancel" : "Then it's pasted"}
        </span>
      </span>
    </motion.button>
  );
}

/** Five bars that follow the mic level, a little higher in the middle; a slow wave while thinking. */
function VoiceBars({ level, thinking }: { level: number; thinking: boolean }) {
  const shape = [0.45, 0.75, 1, 0.75, 0.45];
  return (
    <span className="flex h-5 w-6 shrink-0 items-center justify-between">
      {shape.map((k, i) => (
        <span
          key={i}
          className={cn("w-[3px] rounded-full", thinking ? "zn-hot-wave bg-[#b56c10] dark:bg-brand-gold" : "bg-white")}
          style={
            thinking
              ? { height: 8, animationDelay: `${i * 0.12}s` }
              : { height: `${Math.round(4 + Math.min(1, level * 1.6) * k * 16)}px`, transition: "height 90ms linear" }
          }
        />
      ))}
      <style>{`
        @keyframes zn-hot-wave { 0%, 100% { transform: scaleY(0.5) } 50% { transform: scaleY(1.6) } }
        .zn-hot-wave { animation: zn-hot-wave 1s ease-in-out infinite }
      `}</style>
    </span>
  );
}

function EngineCard({ live, model }: { live: LiveState; model: string | null }) {
  const label = {
    stopped: "Engine off", starting: "Starting engine", loading: "Loading model", ready: "On-device, ready", busy: "Working", error: "Engine error",
  }[live.engine];
  const tone =
    live.engine === "ready" ? "bg-good" : live.engine === "error" ? "bg-destructive" : live.engine === "stopped" ? "bg-muted-foreground" : "bg-warn";
  const pulsing = live.engine === "starting" || live.engine === "loading" || live.engine === "busy";
  return (
    <div title={live.engineError ?? undefined} className="rounded-[12px] bg-foreground/[0.04] px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--rail-line)]">
      <div className="flex items-center gap-2 text-[12px] font-medium">
        <span className="relative flex size-2">
          {pulsing && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", tone)} />}
          <span className={cn("relative size-2 rounded-full", tone)} />
        </span>
        {label}
      </div>
      <div className="mt-1 truncate pl-4 text-[11.5px] text-muted-foreground">{model ? `Model ${model}` : "No model yet"}</div>
      {live.transfer && (
        <div className="mt-2 pl-4">
          <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
            <div className="h-full bg-brand transition-[width] duration-300" style={{ width: `${Math.round(live.transfer.progress * 100)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

function Splash({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  return (
    <div className="grain flex h-screen flex-col items-center justify-center gap-5 bg-background">
      <Bean mood={error ? "sleepy" : "thinking"} size={96} />
      <Wordmark height={26} draw className="text-brand-ink dark:text-brand-cream" />
      {error && (
        <div className="flex max-w-sm flex-col items-center gap-3">
          <ErrorNote error={error} />
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
