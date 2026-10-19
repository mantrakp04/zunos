import { cn } from "@zunos/ui/lib/utils";
import { Accessibility, Globe, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useRef, useState } from "react";

import type { Actions } from "../../../services/actions";
import type { DictationSettings, HotkeyKey, LiveState } from "../../../shared/types";
import { Button, ErrorNote, Kbd, message, Segmented, useAction, useAsync } from "../../ui";
import { type Cleanup, CLEANUP_STYLES, CleanupStrip } from "./cleanup";

/*
 * System-wide dictation: a key held (or tapped) in any app records, transcribes, cleans up and
 * pastes into the app in front. Native runs the key tap and the floating recorder; this file is the
 * settings for it and the Accessibility permission it needs.
 */

const DEFAULTS: DictationSettings = { hotkey: "fn", mode: "hybrid", paste: true, restoreClipboard: true };

export function useDictationSettings(a: Actions) {
  const saved = useAsync(() => a.dictationSettings(), []);
  // Changes show at once; the save happens behind them and rolls back if it fails.
  const [picked, setPicked] = useState<Partial<DictationSettings>>({});
  const [error, setError] = useState<string | null>(null);
  const settings: DictationSettings = { ...DEFAULTS, ...saved.data, ...picked };

  const set = (s: Partial<DictationSettings>) => {
    setPicked((p) => ({ ...p, ...s }));
    setError(null);
    a.setDictationSettings(s)
      .then((next) => (saved.setData(next), setPicked({})))
      .catch((e) => (setError(message(e)), setPicked({})));
  };
  return { settings, set, loaded: !!saved.data, error: error ?? saved.error };
}

export type DictationPrefs = ReturnType<typeof useDictationSettings>;

export const KEYS: Record<HotkeyKey, { glyph: ReactNode; name: string; short: string }> = {
  fn: { glyph: <Globe className="size-[1em]" strokeWidth={2} />, name: "fn", short: "fn" },
  rightOption: { glyph: "⌥", name: "right option", short: "right ⌥" },
  rightCommand: { glyph: "⌘", name: "right command", short: "right ⌘" },
};

export const MODES: { id: DictationSettings["mode"]; label: string; hint: (key: string) => string }[] = [
  { id: "hybrid", label: "Hold or tap", hint: (k) => `Hold ${k} and talk, let go to finish. Or tap it once, talk, and tap again.` },
  { id: "hold", label: "Hold", hint: (k) => `Talk while ${k} is down. Let go and it's written.` },
  { id: "toggle", label: "Tap", hint: (k) => `Tap ${k} to start, tap again to finish.` },
];

/** "Hold fn anywhere", "Tap right ⌥ anywhere"… the hotkey in one short phrase. */
export function hotkeyPhrase(s: DictationSettings) {
  if (s.hotkey === "off") return null;
  const verb = s.mode === "toggle" ? "Tap" : "Hold";
  return `${verb} ${KEYS[s.hotkey].short}`;
}

/* ---- the settings panel ------------------------------------------------------------------------ */

export function DictationSettingsPanel({
  a,
  live,
  prefs,
  cleanup,
  busy,
}: {
  a: Actions;
  live: LiveState;
  prefs: DictationPrefs;
  cleanup: Cleanup;
  busy: boolean;
}) {
  const { settings, set } = prefs;
  const keyName = settings.hotkey === "off" ? "the key" : KEYS[settings.hotkey].name;
  const mode = MODES.find((m) => m.id === settings.mode) ?? MODES[0]!;
  const pressed = live.dictation?.source === "hotkey" && live.dictation.phase === "listening";
  // Where a press stops being a tap and becomes holding to talk (hybrid mode). Local until
  // DictationSettings carries it (holdMs); the engine uses a fixed 300 ms today.
  const [holdMs, setHoldMs] = useState(HOLD_DEFAULT_MS);

  const status =
    settings.hotkey === "off"
      ? "Off. Dictate from this window with Space."
      : !live.access.trusted
        ? "Waiting for Accessibility access."
        : !live.access.hotkey
          ? "Starting the hotkey…"
          : "On. Works in every app.";

  return (
    <div className="flex flex-col">
      <Section
        title="Hotkey"
        aside={
          <span className="flex min-w-0 items-center gap-3 text-[11.5px] text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  settings.hotkey === "off" ? "bg-muted-foreground/50" : live.access.trusted && live.access.hotkey ? "bg-good" : "bg-warn",
                )}
              />
              <span className="truncate" title={status}>{status}</span>
            </span>
            <button
              type="button"
              onClick={() => set({ hotkey: settings.hotkey === "off" ? "fn" : "off" })}
              className="shrink-0 font-medium text-foreground/75 underline-offset-2 hover:text-brand hover:underline"
            >
              {settings.hotkey === "off" ? "Turn on" : "Turn off"}
            </button>
          </span>
        }
      >
        <KeyDeck value={settings.hotkey} pressed={pressed} onChange={(hotkey) => set({ hotkey })} />
      </Section>

      <Section title="How the key works" dim={settings.hotkey === "off"}>
        <Segmented
          className="max-w-full [&_button]:whitespace-nowrap"
          value={settings.mode}
          onChange={(m) => set({ mode: m })}
          options={MODES.map((m) => ({ value: m.id, label: <span title={`${m.hint(keyName)} Esc cancels.`}>{m.label}</span> }))}
        />
        <ModeDiagram mode={settings.mode} holdMs={holdMs} onHoldMs={setHoldMs} />
      </Section>

      <Section title="When it's written" dim={settings.hotkey === "off"}>
        <SwitchRow
          label="Paste into the app in front"
          hint="Lands where your cursor is. Turned off, the text is only copied."
          on={settings.paste}
          onChange={(paste) => set({ paste })}
        />
        <SwitchRow
          label="Put my clipboard back"
          hint="Whatever you had copied comes back right after the paste."
          on={settings.paste && settings.restoreClipboard}
          disabled={!settings.paste}
          onChange={(restoreClipboard) => set({ restoreClipboard })}
        />
      </Section>

      <Section title="Cleanup" aside={<span className="text-[11.5px] text-muted-foreground">On this Mac</span>}>
        {cleanup.state?.status === "ready" || !cleanup.state ? (
          <Segmented
            className={cn("max-w-full [&_button]:whitespace-nowrap", busy && "pointer-events-none opacity-60")}
            value={cleanup.settings.style}
            onChange={(style) => cleanup.setSettings({ ...cleanup.settings, style })}
            options={CLEANUP_STYLES.map((c) => ({ value: c.id, label: <span title={c.hint}>{c.label}</span> }))}
          />
        ) : (
          <CleanupStrip cleanup={cleanup} busy={busy} className="-mx-0 border-0 bg-transparent px-0 py-0" />
        )}
      </Section>

      <ErrorNote error={prefs.error} className="mt-3" />
    </div>
  );
}

/** One group of settings: a title row, then its controls; groups are divided by hairlines, not boxed. */
function Section({ title, aside, dim, children }: { title: string; aside?: ReactNode; dim?: boolean; children: ReactNode }) {
  return (
    <section className={cn("border-t border-border py-5 transition-opacity first:border-t-0 first:pt-1", dim && "opacity-55")}>
      <header className="mb-3.5 flex min-h-5 items-center justify-between gap-x-3">
        <h3 className="shrink-0 text-[13.5px] font-semibold">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

/* ---- the key deck: the bottom row of a Mac keyboard, with the three keys you can pick --------- */

type DeckKey = { id: HotkeyKey | null; top: ReactNode; label: string; grow: number };
const DECK: DeckKey[] = [
  { id: "fn", top: <Globe className="size-[13px]" strokeWidth={2} />, label: "fn", grow: 1 },
  { id: null, top: "⌃", label: "control", grow: 1 },
  { id: null, top: "⌥", label: "option", grow: 1 },
  { id: null, top: "⌘", label: "command", grow: 1.3 },
  { id: null, top: "", label: "", grow: 1.8 },
  { id: "rightCommand", top: "⌘", label: "command", grow: 1.3 },
  { id: "rightOption", top: "⌥", label: "option", grow: 1 },
];

export function KeyDeck({ value, pressed, onChange }: { value: DictationSettings["hotkey"]; pressed: boolean; onChange: (k: HotkeyKey) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Hotkey"
      className="@container/deck flex gap-[5px] rounded-[14px] bg-[linear-gradient(180deg,rgb(64_32_25/0.07),rgb(64_32_25/0.035))] p-[6px] shadow-[inset_0_1px_2px_rgb(64_32_25/0.14),inset_0_0_0_0.5px_rgb(64_32_25/0.08)] dark:bg-[linear-gradient(180deg,rgb(0_0_0/0.35),rgb(0_0_0/0.2))] dark:shadow-[inset_0_1px_2px_rgb(0_0_0/0.5),inset_0_0_0_0.5px_rgb(255_255_255/0.05)]"
    >
      {DECK.map((k, i) => {
        const on = k.id != null && k.id === value;
        const down = on && pressed;
        const Tag = k.id ? motion.button : motion.div;
        return (
          <Tag
            key={i}
            {...(k.id ? { type: "button", role: "radio", "aria-checked": on, onClick: () => onChange(k.id!) } : { "aria-hidden": true })}
            title={k.id ? KEYS[k.id].name : undefined}
            style={{ flexGrow: k.grow, flexBasis: 0 }}
            animate={{ y: down ? 2 : 0 }}
            whileTap={k.id ? { y: 2 } : undefined}
            transition={{ type: "spring", stiffness: 700, damping: 30 }}
            className={cn(
              "relative flex h-[46px] min-w-0 flex-col justify-between rounded-[8px] px-[6px] pt-[5px] pb-[5px] text-left transition-[background,box-shadow,color] duration-200",
              k.id ? "cursor-default" : "pointer-events-none",
              on
                ? "bg-[linear-gradient(180deg,#ff6a48,var(--brand)_60%,var(--brand-deep))] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_2px_0_#a8261b,0_6px_16px_-4px_rgb(243_74_45/0.65)]"
                : k.id
                  ? "bg-card text-foreground/85 shadow-[inset_0_1px_0_rgb(255_255_255/0.7),0_0_0_0.5px_var(--input),0_2px_0_var(--input)] hover:text-foreground dark:bg-[#3a302b] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_2px_0_rgb(0_0_0/0.55)]"
                  : "bg-card/55 text-muted-foreground/45 shadow-[0_0_0_0.5px_var(--input),0_2px_0_color-mix(in_oklab,var(--input)_60%,transparent)] dark:bg-white/[0.035] dark:shadow-[0_2px_0_rgb(0_0_0/0.35)]",
              down && "shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_0_0_#a8261b,0_2px_10px_-2px_rgb(243_74_45/0.8)]",
            )}
          >
            <span className={cn("flex justify-end text-[13px] leading-none", k.id === "fn" && "justify-start")}>{k.top}</span>
            {k.label && (
              <span className={cn("hidden truncate text-[9.5px] leading-none font-medium @min-[400px]/deck:block", k.id === "fn" && "text-right", on ? "text-white/85" : "")}>
                {k.label}
              </span>
            )}
            {down && <span className="absolute inset-0 animate-pulse rounded-[8px] bg-white/15" />}
          </Tag>
        );
      })}
    </div>
  );
}

/* ---- how each mode reads: key presses on top, the time zunos listens below --------------------- */

const HOLD_DEFAULT_MS = 300;
const HOLD_MIN_MS = 150;
const HOLD_MAX_MS = 800;
/** The diagram's timeline, in ms. */
const SPAN_MS = 2400;

function ModeDiagram({ mode, holdMs, onHoldMs }: { mode: DictationSettings["mode"]; holdMs: number; onHoldMs: (ms: number) => void }) {
  const t = (ms: number) => ms / SPAN_MS;
  // Each mode as [key-down spans] and [listening spans], in 0..1 of the timeline. In hybrid, the
  // first press is held past the threshold (talk while held), the second is a tap (talk until the next tap).
  const lanes: Record<DictationSettings["mode"], { key: [number, number][]; listen: [number, number][] }> = {
    hold: { key: [[0.06, 0.62]], listen: [[0.06, 0.62]] },
    toggle: { key: [[0.06, 0.1], [0.6, 0.64]], listen: [[0.06, 0.6]] },
    hybrid: { key: [[HELD_AT, 0.42], [0.5, 0.5 + t(Math.min(holdMs - 60, 220))], [0.88, 0.92]], listen: [[HELD_AT, 0.42], [0.5, 0.88]] },
  };
  const l = lanes[mode];
  return (
    <div className="mt-4 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 font-mono text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
      <span>Key</span>
      {mode === "hybrid" ? (
        <HoldLane spans={l.key} mode={mode} holdMs={holdMs} onHoldMs={onHoldMs} />
      ) : (
        <Lane spans={l.key} className="bg-foreground/70" mode={mode} />
      )}
      <span className="w-[3.4rem] text-right tracking-normal normal-case tabular-nums text-foreground/75" title={mode === "hybrid" ? "Held longer than this, the key talks while it's down; shorter, it's a tap." : undefined}>
        {mode === "hybrid" ? `${holdMs} ms` : ""}
      </span>
      <span>Listening</span>
      <Lane spans={l.listen} className="bg-[linear-gradient(90deg,var(--brand),var(--brand-gold))]" mode={mode} />
      <span />
    </div>
  );
}

/** Where the held press starts on the timeline; the hold threshold is measured from here. */
const HELD_AT = 0.04;

function Lane({ spans, className, mode }: { spans: [number, number][]; className: string; mode: string }) {
  return (
    <div className="relative h-2.5 rounded-full bg-foreground/[0.06]">
      {spans.map(([a, b], i) => (
        <motion.span
          key={`${mode}-${i}`}
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: 1, left: `${a * 100}%`, width: `${(b - a) * 100}%` }}
          transition={{ delay: 0.05 + i * 0.12, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          style={{ transformOrigin: "left" }}
          className={cn("absolute inset-y-0 rounded-full", className)}
        />
      ))}
    </div>
  );
}

/**
 * The key lane in hybrid mode, with a handle on the held press where it turns from a tap into a hold.
 * Drag it, click the lane, or use the arrow keys (Page Up/Down for bigger steps, Home/End for the
 * ends). Snaps to 50 ms.
 */
function HoldLane({ spans, mode, holdMs, onHoldMs }: { spans: [number, number][]; mode: string; holdMs: number; onHoldMs: (ms: number) => void }) {
  const lane = useRef<HTMLDivElement>(null);
  const step = 50;
  const snap = (ms: number) => Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, Math.round(ms / step) * step));
  const fromX = (x: number) => {
    const r = lane.current!.getBoundingClientRect();
    return snap(((x - r.left) / r.width - HELD_AT) * SPAN_MS);
  };
  const at = HELD_AT + holdMs / SPAN_MS;
  return (
    <div
      ref={lane}
      role="slider"
      tabIndex={0}
      aria-label="Hold after"
      aria-valuemin={HOLD_MIN_MS}
      aria-valuemax={HOLD_MAX_MS}
      aria-valuenow={holdMs}
      aria-valuetext={`${holdMs} ms`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus();
        onHoldMs(fromX(e.clientX));
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && onHoldMs(fromX(e.clientX))}
      onKeyDown={(e) => {
        const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -step * 4, PageUp: step * 4 }[e.key];
        if (d != null) (e.preventDefault(), onHoldMs(snap(holdMs + d)));
        else if (e.key === "Home") (e.preventDefault(), onHoldMs(HOLD_MIN_MS));
        else if (e.key === "End") (e.preventDefault(), onHoldMs(HOLD_MAX_MS));
      }}
      className="group relative h-4 cursor-default touch-none rounded-full outline-none"
    >
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2">
        <Lane spans={spans} className="bg-foreground/70" mode={mode} />
      </div>
      {/* Before the handle the held press is still a tap: drawn lighter. */}
      <span
        className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-l-full bg-background/45"
        style={{ left: `${HELD_AT * 100}%`, width: `${(at - HELD_AT) * 100}%` }}
      />
      <span
        className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3),0_0_0_0.5px_rgb(0_0_0/0.12)] transition-shadow group-focus-visible:shadow-[0_1px_3px_rgb(0_0_0/0.3),0_0_0_3px_color-mix(in_oklab,var(--brand)_45%,transparent)]"
        style={{ left: `${at * 100}%` }}
      />
    </div>
  );
}

/* ---- small controls ---------------------------------------------------------------------------- */

function SwitchRow({ label, hint, on, disabled, onChange }: { label: string; hint: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label title={hint} className={cn("flex items-center gap-4 py-1.5", disabled && "opacity-50")}>
      <span className="min-w-0 flex-1 text-[13px] font-medium">{label}</span>
      <Switch on={on} disabled={disabled} onChange={onChange} label={label} />
    </label>
  );
}

export function Switch({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200",
        on ? "bg-brand shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.1)]" : "bg-foreground/15 shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.06)]",
      )}
    >
      <motion.span
        initial={false}
        animate={{ x: on ? 18 : 2 }}
        transition={{ type: "spring", stiffness: 600, damping: 34 }}
        className="absolute top-[2px] left-0 size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25),0_0_0_0.5px_rgb(0_0_0/0.06)]"
      />
    </button>
  );
}

/* ---- Accessibility ----------------------------------------------------------------------------- */

/** Shown until macOS trusts zunos: the hotkey tap and pasting both need Accessibility. */
export function AccessCard({ a }: { a: Actions }) {
  const request = useAction(() => a.requestAccessibility());
  const [asked, setAsked] = useState(false);
  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      className="border-l-2 border-brand-gold py-1 pl-4"
    >
      <h3 className="flex items-center gap-2 text-[14px] font-semibold">
        <Accessibility className="size-4 shrink-0 text-[#b56c10] dark:text-brand-gold" strokeWidth={2.2} />
        Dictate into any app
      </h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">The hotkey and pasting need Accessibility access, once.</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="brand" size="sm" disabled={request.busy} onClick={() => (setAsked(true), request.run())}>
          {request.busy && <Loader2 className="size-3.5 animate-spin" />}
          Grant access
        </Button>
        {asked && !request.busy && <span className="text-[12px] text-muted-foreground">Turn zunos on in the list that opened.</span>}
      </div>
      <ErrorNote error={request.error} className="mt-2" />
      <p className="mt-2.5 text-[11.5px] leading-snug text-muted-foreground">
        After a Debug rebuild, remove zunos with <span className="font-semibold">−</span> in Privacy &amp; Security → Accessibility, then add it again.
      </p>
    </motion.section>
  );
}
