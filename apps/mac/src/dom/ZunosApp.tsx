"use dom";

import "@zunos/ui/globals.css";
import "./zunos.css";

import { useSystemTheme } from "@zunos/ui/hooks/use-system-theme";
import { cn } from "@zunos/ui/lib/utils";
import { AudioLines, FlaskConical, LogOut, Mic } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Actions } from "../services/actions";
import type { LiveState } from "../shared/types";
import { Bean, type BeanMood, Wordmark } from "./Bean";
import { DictateMark } from "./marks";
import Languages from "./screens/Languages";
import Record from "./screens/Record";
import SignIn from "./screens/SignIn";
import Test from "./screens/Test";
import Train from "./screens/Train";
import Use from "./screens/Use";
import { Button, ErrorNote, langName, minutes, pct, shortOf, useAction, useAsync } from "./ui";

export type ScreenProps = { a: Actions; live: LiveState; /** Switch to another screen. */ go?: (id: ScreenId) => void };

export type ScreenId = "record" | "train" | "test" | "use";

const NAV: { id: ScreenId; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; Screen: (p: ScreenProps) => React.ReactNode }[] = [
  { id: "record", label: "Record", icon: Mic, Screen: Record },
  { id: "train", label: "Train", icon: AudioLines, Screen: Train },
  { id: "test", label: "Test", icon: FlaskConical, Screen: Test },
  { id: "use", label: "Dictate", icon: DictateMark, Screen: Use },
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
  const setScreen = useCallback((id: ScreenId) => {
    setScreenState(id);
    localStorage.setItem(SCREEN_KEY, id);
  }, []);

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
            className="absolute inset-0 overflow-x-hidden overflow-y-auto"
          >
            <Screen a={a as Actions} live={live} go={setScreen} />
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}

/* ---- the mascot as status light ---------------------------------------------------------------- */

/** The mascot's states; the same names the 3D mascot takes. */
export type MascotState = "sleeping" | "waking" | "awake" | "listening" | "thinking" | "working" | "error";

/** What the app is doing, as one mascot state, most urgent first. */
export function mascotStatus(live: LiveState, cloudRun: boolean): { state: MascotState; label: string } {
  if (live.engine === "error") return { state: "error", label: "Engine stopped" };
  if (live.recording || live.dictation?.phase === "listening") return { state: "listening", label: "Listening" };
  if (live.engine === "busy" || live.dictation?.phase === "thinking") return { state: "thinking", label: "Working on it" };
  if (live.transfer || cloudRun) return { state: "working", label: live.transfer ? "Moving your model" : "Training in the cloud" };
  if (live.engine === "starting" || live.engine === "loading") return { state: "waking", label: live.engine === "loading" ? "Loading your model" : "Waking up" };
  if (live.engine === "stopped") return { state: "sleeping", label: "Asleep" };
  return { state: "awake", label: "Ready" };
}

const BEAN_MOOD: Record<MascotState, BeanMood> = {
  sleeping: "asleep", waking: "waking", awake: "awake", listening: "listening", thinking: "thinking", working: "thinking", error: "error",
};

/* ---- the rail: the mascot as status light, the steps as one journey, your languages, account -- */

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
    // Every language has the 5 minutes that are enough to train.
    record: !!stats.data?.length && shortOf(stats.data).length === 0,
    train: !!active, test: avg != null, use: !!active,
  };

  const status = mascotStatus(live, !!running);
  const wake = useAction(() => a.prepareDictation());

  return (
    <aside className="flex w-[232px] shrink-0 flex-col px-3 pt-[calc(var(--titlebar)+14px)] pb-3 select-none">
      <div className="mb-6 flex items-center gap-2.5 px-2">
        {/* The mascot is the engine's status light: asleep, waking, awake, listening, thinking, working. */}
        <button
          type="button"
          aria-label={`zunos: ${status.label}`}
          title={status.state === "error" ? `${status.label}: ${live.engineError ?? "the engine stopped"}. Click to try again.` : `${status.label}${active ? ` · Model ${active.name}` : ""}`}
          onClick={() => status.state === "error" && !wake.busy && wake.run()}
          className={cn("-my-1 -ml-1 shrink-0 rounded-full", status.state === "error" ? "cursor-pointer" : "cursor-default")}
        >
          <Bean mood={BEAN_MOOD[status.state]} level={status.state === "listening" ? live.level : 0} size={34} />
        </button>
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
                "group relative flex h-10 items-center gap-3 rounded-[16px] px-2 text-left text-[13.5px] transition-colors disabled:opacity-40",
                on ? "text-foreground" : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
              )}
            >
              {on && (
                <motion.span
                  layoutId="rail-active"
                  transition={{ type: "spring", stiffness: 480, damping: 38 }}
                  className="absolute inset-0 rounded-[16px] bg-card shadow-[0_0_0_0.5px_var(--input),0_1px_2px_rgb(64_32_25/0.08),0_4px_14px_-6px_rgb(64_32_25/0.18)]"
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
                {done[id] && (!facts[id] || id === "record") && <span title={id === "record" ? "Enough to train in every language" : undefined} className="size-1.5 rounded-full bg-good" />}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="mt-7 min-h-0 overflow-hidden px-2.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10.5px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Your voice</span>
          <button onClick={onEditLanguages} disabled={live.recording} className="text-[11.5px] text-muted-foreground hover:text-brand disabled:opacity-40">
            Edit
          </button>
        </div>
        <LanguageChips codes={languages} onMore={live.recording ? undefined : onEditLanguages} />
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {hot && <HotkeyDictation key="hot" phase={hot.phase} level={live.level} onOpen={() => onScreen("use")} />}
        </AnimatePresence>
        <div className="flex items-center gap-2 px-2.5 pt-1">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-ink text-[11px] font-semibold text-brand-cream dark:bg-brand-cream dark:text-brand-ink">
            {(live.user?.email ?? "?")[0]!.toUpperCase()}
          </span>
          <span title={live.user?.email ?? undefined} className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{live.user?.email}</span>
          <button title="Sign out" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground" onClick={() => a.signOut()}>
            <LogOut className="size-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * The user's languages as chips: two rows of them, four on a tall window. The rest fold into a
 * "+N" chip that names them in its tooltip and opens the language picker.
 */
function LanguageChips({ codes, onMore }: { codes: string[]; onMore?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  // null while measuring: every chip renders, then we keep the ones in the first two rows.
  const [fit, setFit] = useState<number | null>(null);
  const key = codes.join();
  useLayoutEffect(() => setFit(null), [key]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || fit !== null) return;
    const tops = [...el.querySelectorAll<HTMLElement>("[data-chip]")].map((c) => c.offsetTop);
    const rows = [...new Set(tops)].sort((x, y) => x - y);
    const max = window.innerHeight >= 860 ? 4 : 2;
    // One chip makes room for "+N".
    setFit(rows.length <= max ? codes.length : Math.max(1, tops.filter((t) => t <= rows[max - 1]!).length - 1));
  }, [fit, key]);
  // Re-measure when the rail's width (fonts loading can change it) or the window's height changes.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => el.clientWidth !== w && ((w = el.clientWidth), setFit(null)));
    ro.observe(el);
    const onResize = () => setFit(null);
    window.addEventListener("resize", onResize);
    return () => (ro.disconnect(), window.removeEventListener("resize", onResize));
  }, []);
  const shown = fit === null ? codes : codes.slice(0, fit);
  const rest = codes.slice(shown.length);
  return (
    <div ref={box} className="flex flex-wrap gap-1.5">
      {shown.map((code) => (
        <span key={code} data-chip title={langName(code)} className="max-w-full truncate rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11.5px] font-medium">
          {langName(code)}
        </span>
      ))}
      {rest.length > 0 && (
        <button
          type="button"
          onClick={onMore}
          disabled={!onMore}
          title={rest.map(langName).join(", ")}
          className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11.5px] font-semibold text-muted-foreground tabular-nums hover:text-brand disabled:hover:text-muted-foreground"
        >
          +{rest.length}
        </button>
      )}
    </div>
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
