import { cn } from "@zunos/ui/lib/utils";
import { Accessibility, Globe, Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";

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

  const status =
    settings.hotkey === "off"
      ? "Off. Dictate from this window with Space."
      : !live.access.trusted
        ? "Waiting for Accessibility access."
        : !live.access.hotkey
          ? "Starting the hotkey…"
          : "On. Works in every app.";

  return (
    <div className="flex flex-col gap-3">
      <Section
        title="Hotkey"
        aside={
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <span
              className={cn(
                "size-1.5 rounded-full",
                settings.hotkey === "off" ? "bg-muted-foreground/50" : live.access.trusted && live.access.hotkey ? "bg-good" : "bg-warn",
              )}
            />
            {status}
          </span>
        }
      >
        <KeyDeck value={settings.hotkey} pressed={pressed} onChange={(hotkey) => set({ hotkey })} />
        <div className="mt-2.5 flex items-center justify-between gap-3 text-[12px] text-muted-foreground">
          <span>Pick a key. The grey ones keep their usual jobs.</span>
          <button
            type="button"
            onClick={() => set({ hotkey: settings.hotkey === "off" ? "fn" : "off" })}
            className="shrink-0 font-medium text-foreground/75 underline-offset-2 hover:text-brand hover:underline"
          >
            {settings.hotkey === "off" ? "Turn on" : "Turn off"}
          </button>
        </div>
      </Section>

      <Section title="How the key works" dim={settings.hotkey === "off"}>
        <Segmented
          value={settings.mode}
          onChange={(m) => set({ mode: m })}
          options={MODES.map((m) => ({ value: m.id, label: m.label }))}
        />
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={mode.id + keyName}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.16 }}
            className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground"
          >
            {mode.hint(keyName)} <Kbd>esc</Kbd> throws it away.
          </motion.p>
        </AnimatePresence>
        <ModeDiagram mode={settings.mode} />
      </Section>

      <Section title="When it's written" dim={settings.hotkey === "off"}>
        <SwitchRow
          label="Paste into the app in front"
          hint="Lands where your cursor is. Turned off, the text is only copied."
          on={settings.paste}
          onChange={(paste) => set({ paste })}
        />
        <div className="my-3 h-px bg-border/80" />
        <SwitchRow
          label="Put my clipboard back"
          hint="Whatever you had copied comes back right after the paste."
          on={settings.paste && settings.restoreClipboard}
          disabled={!settings.paste}
          onChange={(restoreClipboard) => set({ restoreClipboard })}
        />
      </Section>

      <Section title="Cleanup" aside={<span className="text-[11.5px] text-muted-foreground">Runs on this Mac</span>}>
        {cleanup.state?.status === "ready" || !cleanup.state ? (
          <CleanupStyles cleanup={cleanup} busy={busy} />
        ) : (
          <CleanupStrip cleanup={cleanup} busy={busy} className="-mx-1 rounded-[14px] border-0 bg-foreground/[0.03] px-3 py-2.5" />
        )}
      </Section>

      <ErrorNote error={prefs.error} />
    </div>
  );
}

function Section({ title, aside, dim, children }: { title: string; aside?: ReactNode; dim?: boolean; children: ReactNode }) {
  return (
    <section className={cn("rounded-[20px] bg-card px-5 pt-4 pb-5 shadow-[0_0_0_1px_var(--border),var(--elevate)] transition-opacity", dim && "opacity-55")}>
      <header className="mb-3.5 flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-[13.5px] font-semibold">{title}</h3>
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

function ModeDiagram({ mode }: { mode: DictationSettings["mode"] }) {
  // Each mode as [key-down spans] and [listening spans], in 0..1 of a short timeline.
  const lanes: Record<DictationSettings["mode"], { key: [number, number][]; listen: [number, number][]; marks: string[] }> = {
    hold: { key: [[0.08, 0.62]], listen: [[0.08, 0.62]], marks: ["press", "let go"] },
    toggle: { key: [[0.08, 0.13], [0.62, 0.67]], listen: [[0.08, 0.62]], marks: ["tap", "tap"] },
    hybrid: { key: [[0.04, 0.3], [0.52, 0.56], [0.86, 0.9]], listen: [[0.04, 0.3], [0.52, 0.86]], marks: [] },
  };
  const l = lanes[mode];
  return (
    <div className="mt-3.5 grid grid-cols-[52px_1fr] items-center gap-x-3 gap-y-1.5 font-mono text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
      <span>Key</span>
      <Lane spans={l.key} className="bg-foreground/70" mode={mode} />
      <span>Listening</span>
      <Lane spans={l.listen} className="bg-[linear-gradient(90deg,var(--brand),var(--brand-gold))]" mode={mode} />
    </div>
  );
}

function Lane({ spans, className, mode }: { spans: [number, number][]; className: string; mode: string }) {
  return (
    <div className="relative h-2.5 rounded-full bg-foreground/[0.06]">
      {spans.map(([a, b], i) => (
        <motion.span
          key={`${mode}-${i}`}
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={{ delay: 0.05 + i * 0.12, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%`, transformOrigin: "left" }}
          className={cn("absolute inset-y-0 rounded-full", className)}
        />
      ))}
    </div>
  );
}

/* ---- small controls ---------------------------------------------------------------------------- */

function SwitchRow({ label, hint, on, disabled, onChange }: { label: string; hint: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={cn("flex items-start gap-4", disabled && "opacity-50")}>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">{hint}</span>
      </span>
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

/** The three cleanup styles as cards, each with what it does. */
function CleanupStyles({ cleanup, busy }: { cleanup: Cleanup; busy: boolean }) {
  const { settings, setSettings } = cleanup;
  return (
    <div role="radiogroup" aria-label="Cleanup" className={cn("grid grid-cols-3 gap-2", busy && "pointer-events-none opacity-60")}>
      {CLEANUP_STYLES.map((s) => {
        const on = settings.style === s.id;
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setSettings({ ...settings, style: s.id })}
            className={cn(
              "relative rounded-[14px] px-3 pt-2.5 pb-3 text-left transition-[box-shadow,background] duration-200",
              on
                ? "bg-brand-gold/10 shadow-[0_0_0_1.5px_var(--brand-gold)] dark:bg-brand-gold/12"
                : "shadow-[0_0_0_1px_var(--border)] hover:bg-foreground/[0.03]",
            )}
          >
            <span className="flex items-center justify-between">
              <span className="text-[12.5px] font-semibold">{s.label}</span>
              <span
                className={cn(
                  "grid size-3.5 place-items-center rounded-full transition-colors",
                  on ? "bg-brand-gold" : "shadow-[inset_0_0_0_1px_var(--input)]",
                )}
              >
                {on && <span className="size-1.5 rounded-full bg-white" />}
              </span>
            </span>
            <span className="mt-1 block text-[11.5px] leading-snug text-muted-foreground">{s.hint}</span>
          </button>
        );
      })}
    </div>
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
      exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      className="relative isolate overflow-hidden rounded-[20px] bg-[linear-gradient(140deg,color-mix(in_oklab,var(--brand-gold)_16%,var(--card)),var(--card)_65%)] px-5 py-4 shadow-[0_0_0_1px_color-mix(in_oklab,var(--brand-gold)_45%,transparent),var(--elevate)]"
    >
      <div aria-hidden className="zn-ripples -z-10 opacity-80 [--rx:100%] [--ry:0%]" />
      <div className="flex items-start gap-3.5">
        <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-brand-gold text-brand-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.45),0_4px_12px_-4px_rgb(246_165_60/0.7)]">
          <Accessibility className="size-5" strokeWidth={2.2} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-[17px] leading-tight font-semibold tracking-[-0.01em]">Dictate into any app</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/75">
            For the hotkey to work outside this window and for the text to paste itself, macOS needs to let zunos use Accessibility. You only do this once.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              variant="brand"
              size="sm"
              disabled={request.busy}
              onClick={() => (setAsked(true), request.run())}
            >
              {request.busy && <Loader2 className="size-3.5 animate-spin" />}
              Grant access
            </Button>
            {asked && !request.busy && (
              <span className="text-[12px] text-muted-foreground">Turn zunos on in the list that opened. The hotkey starts by itself.</span>
            )}
          </div>
          <ErrorNote error={request.error} className="mt-2" />
          <p className="mt-3 border-t border-foreground/[0.07] pt-2.5 text-[11.5px] leading-snug text-muted-foreground">
            Rebuilt the app and it stopped working? A Debug build can lose the grant. In System Settings → Privacy &amp; Security →
            Accessibility, remove zunos with <span className="font-semibold">−</span>, then add it again.
          </p>
        </div>
      </div>
    </motion.section>
  );
}
