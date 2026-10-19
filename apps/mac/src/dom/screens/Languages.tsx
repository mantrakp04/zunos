import "./onboarding/onboarding.css";

import { cn } from "@zunos/ui/lib/utils";
import { ArrowLeft, Check, Search, X } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Lang, Language, Script } from "../../shared/types";
import { Bean } from "../Bean";
import { Button, ErrorNote, Kbd, useAction } from "../ui";
import type { ScreenProps } from "../ZunosApp";
import { endonym, GREETINGS, ROMANIZED_SAMPLE } from "./onboarding/endonyms";
import { ScriptToggle } from "./record/ScriptToggle";

const STEPS = [
  { title: "Languages", description: "What you speak" },
  { title: "Record", description: "Read short passages aloud" },
  { title: "Train", description: "About an hour on a cloud GPU" },
  { title: "Dictate", description: "On your Mac, offline" },
];
const spring = { type: "spring", stiffness: 420, damping: 34 } as const;
const flight = { type: "spring", stiffness: 260, damping: 28 } as const;

type Props = ScreenProps & {
  initial: Language[];
  onDone: () => void | Promise<void>;
  /** True when editing from the app (there's somewhere to go back to); false on first run. */
  canCancel?: boolean;
  onCancel?: () => void;
};

export default function Languages({ a, initial, onDone, canCancel = false, onCancel }: Props) {
  const [picked, setPicked] = useState<Lang[]>(() => initial.filter((l) => l.enabled).map((l) => l.code));
  const [query, setQuery] = useState("");
  const [hop, setHop] = useState(0);
  const save = useAction(async () => {
    await a.setLanguages(picked);
    await onDone();
  });

  const byCode = useMemo(() => new Map(initial.map((l) => [l.code, l])), [initial]);

  // Read in native script or English letters, per language. Saved as soon as it's picked.
  const [scripts, setScripts] = useState<Partial<Record<Lang, Script>>>(() => Object.fromEntries(initial.map((l) => [l.code, l.script])));
  // The list we were handed can predate a change made on Record; read the current choices once.
  const touched = useRef(new Set<Lang>());
  useEffect(() => {
    let live = true;
    a.languages()
      .then((ls) => live && setScripts((x) => ({ ...x, ...Object.fromEntries(ls.filter((l) => !touched.current.has(l.code)).map((l) => [l.code, l.script])) })))
      .catch(() => {});
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setScript = useAction(async (lang: Lang, s: Script) => {
    touched.current.add(lang);
    const was = scripts[lang];
    setScripts((x) => ({ ...x, [lang]: s }));
    try {
      await a.setLanguageScript(lang, s);
    } catch (e) {
      setScripts((x) => ({ ...x, [lang]: was }));
      throw e;
    }
  });
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      initial.filter(
        (l) => !q || l.code === q || l.name.toLowerCase().includes(q) || endonym(l.code, l.name).toLowerCase().includes(q),
      ),
    [initial, q],
  );
  const pickedLangs = picked.map((c) => byCode.get(c)).filter((l): l is Language => !!l);

  // Stable, so the 100 memoized tiles don't re-render on every pick.
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const toggle = useCallback((c: Lang) => {
    const on = pickedRef.current.includes(c);
    setPicked((p) => (on ? p.filter((x) => x !== c) : p.includes(c) ? p : [...p, c]));
    if (!on) setHop((h) => h + 1);
  }, []);
  const canSave = picked.length > 0 && !save.busy;

  // Esc clears the search, then cancels (when editing). ⌘↩ continues.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (query) setQuery("");
        else if (canCancel && !save.busy) onCancel?.();
      } else if (e.key === "Enter" && e.metaKey && canSave) {
        e.preventDefault();
        save.run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <LayoutGroup>
      <div className="flex h-screen overflow-hidden bg-rail text-foreground select-none">
        {/* ---- left: the question, your voice, continue ---- */}
        <aside className="relative flex w-[clamp(366px,32vw,420px)] shrink-0 flex-col px-7 pt-[calc(var(--titlebar)+18px)] pb-6">
          <div className="flex h-7 items-center">
            {canCancel ? (
              <button
                onClick={onCancel}
                disabled={save.busy}
                className="-ml-2.5 inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-45"
              >
                <ArrowLeft className="size-3.5" /> Cancel <Kbd>esc</Kbd>
              </button>
            ) : (
              <Journey />
            )}
          </div>

          <div className="mt-7">
            <Greeting hop={hop} />
            <h1 className="mt-4 font-display text-[32px] leading-[1.04] font-bold tracking-[-0.03em] text-balance">
              Which languages do you speak?
            </h1>
          </div>

          <Tray langs={pickedLangs} onRemove={toggle} />

          <ReadIn langs={pickedLangs.filter((l) => l.hasRoman)} scripts={scripts} busy={setScript.busy} onChange={(l, s) => setScript.run(l, s)} />
          <ErrorNote error={setScript.error} className="mt-2" />


          <div className="mt-4 flex flex-col gap-2.5">
            <Button variant="brand" size="lg" className="w-full" disabled={!picked.length} loading={save.busy} onClick={() => save.run()}>
              {canCancel
                ? `Save ${picked.length || ""} language${picked.length === 1 ? "" : "s"}`.replace("  ", " ")
                : `Continue${picked.length ? ` with ${picked.length} language${picked.length === 1 ? "" : "s"}` : ""}`}
            </Button>
            <ErrorNote error={save.error} />
          </div>
        </aside>

        {/* ---- right: every language, in its own words ---- */}
        <main className="relative my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] bg-background shadow-[0_0_0_1px_var(--rail-line),0_1px_3px_rgb(0_0_0/0.05)]">
          <div className="flex items-center gap-3 px-6 pt-7 pb-2">
            <label
              className={cn(
                "flex h-11 flex-1 items-center gap-2.5 rounded-[14px] bg-card px-3.5 transition-shadow",
                "shadow-[0_0_0_1px_var(--input),0_1px_2px_rgb(64_32_25/0.05)] focus-within:shadow-[0_0_0_1.5px_var(--brand),0_0_0_4px_rgb(243_74_45/0.12)]",
              )}
            >
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Enter picks the only match, so you can type "guj⏎" and move on.
                  if (e.key === "Enter" && !e.metaKey && q && shown.length === 1) {
                    if (!picked.includes(shown[0]!.code)) toggle(shown[0]!.code);
                    setQuery("");
                  }
                }}
                placeholder={`Search ${initial.length} languages, in English or their own script`}
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-muted-foreground/70"
              />
              {query && (
                <button onClick={() => setQuery("")} className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground" title="Clear (esc)">
                  <X className="size-3.5" />
                </button>
              )}
            </label>
          </div>

          <motion.div layoutScroll className="zn-fade-y min-h-0 flex-1 overflow-y-auto px-6 pt-3 pb-8">
            {shown.length ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(158px,1fr))] gap-2.5">
                {shown.map((l) => (
                  <Tile key={l.code} lang={l} on={picked.includes(l.code)} roman={scripts[l.code] === "roman"} onToggle={toggle} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1 pt-20 text-center">
                <p className="max-w-full font-display text-[18px] font-semibold [overflow-wrap:anywhere]">No language matches “{query.trim()}”</p>
                <p className="text-[13px] text-muted-foreground">zunos covers the {initial.length} languages Whisper knows. Try its English name.</p>
              </div>
            )}
          </motion.div>
        </main>
      </div>
    </LayoutGroup>
  );
}

/* ---- the four steps, compact ---------------------------------------------------------------- */

function Journey() {
  return (
    <ol className="flex items-center gap-[5px] text-[11.5px]" aria-label="Getting started">
      {STEPS.map((s, i) => (
        <li key={s.title} title={s.description} className="flex items-center gap-[5px]">
          <span
            className={cn(
              "grid size-4 place-items-center rounded-full text-[9.5px] font-bold tabular-nums",
              i === 0 ? "bg-brand text-white shadow-[0_2px_6px_-1px_rgb(243_74_45/0.6)]" : "bg-foreground/[0.07] text-muted-foreground",
            )}
          >
            {i + 1}
          </span>
          <span className={i === 0 ? "font-semibold" : "text-muted-foreground"}>{s.title}</span>
          {i < STEPS.length - 1 && <span className="mx-[3px] h-px w-2.5 bg-foreground/15" />}
        </li>
      ))}
    </ol>
  );
}

/* ---- the bean, saying hello in a dozen languages ------------------------------------------- */

function Greeting({ hop }: { hop: number }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % GREETINGS.length), 1900);
    return () => clearInterval(id);
  }, []);
  const g = GREETINGS[i]!;
  return (
    <div className="flex items-end gap-3">
      <Bean key={hop} mood={hop ? "happy" : "idle"} size={56} className="-ml-1 shrink-0" />
      <div className="relative mb-6 h-8 overflow-hidden rounded-[13px] rounded-bl-[4px] bg-card px-3 shadow-[0_0_0_1px_var(--input),0_4px_12px_-6px_rgb(64_32_25/0.25)]">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={i}
            initial={{ y: 22, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -22, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            lang={g.lang}
            className="flex h-8 items-center font-display text-[15px] font-semibold whitespace-nowrap"
          >
            {g.text}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ---- your voice: the picked languages collect here ----------------------------------------- */

/** Picked languages that can be read either way, each with its "Read in" choice. */
function ReadIn({ langs, scripts, busy, onChange }: {
  langs: Language[]; scripts: Partial<Record<Lang, Script>>; busy: boolean; onChange: (l: Lang, s: Script) => void;
}) {
  if (!langs.length) return null;
  return (
    <div className="mt-4 shrink-0">
      <div className="mb-1.5 px-0.5 text-[10.5px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Read in</div>
      <div className="flex max-h-[176px] flex-col overflow-y-auto">
        {langs.map((l) => (
          <div key={l.code} className="flex min-w-0 items-center justify-between gap-3 border-t border-foreground/[0.06] py-1.5 first:border-t-0">
            <span className="min-w-0 truncate text-[13px] font-medium" title={l.name}>
              {l.name}
            </span>
            <ScriptToggle lang={l} script={scripts[l.code] ?? l.script} disabled={busy} onChange={(s) => onChange(l.code, s)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Tray({ langs, onRemove }: { langs: Language[]; onRemove: (c: Lang) => void }) {
  // Past a handful, the English names would push most chips out of view; the title still has them.
  const compact = langs.length > 6;
  return (
    <div className="mt-6 flex min-h-[112px] flex-1 flex-col">
      <div className="mb-2 flex items-baseline justify-between px-0.5">
        <span className="text-[10.5px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Your voice</span>
        <span className="text-[11.5px] text-muted-foreground tabular-nums">
          {langs.length ? `${langs.length} language${langs.length === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto rounded-[18px] bg-background/70 p-2.5 shadow-[inset_0_0_0_1px_var(--rail-line),inset_0_1px_3px_rgb(64_32_25/0.05)] dark:bg-background/50">
        <motion.div layout className="flex flex-wrap content-start gap-1.5">
          <AnimatePresence initial={false} mode="popLayout">
            {langs.map((l) => {
              const endo = endonym(l.code, l.name);
              return (
                <motion.button
                  key={l.code}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, scale: 0.7, transition: { duration: 0.14 } }}
                  transition={spring}
                  onClick={() => onRemove(l.code)}
                  title={endo !== l.name ? `Remove ${endo} (${l.name})` : `Remove ${l.name}`}
                  className={cn(
                    "group flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-full pr-1.5 pl-3",
                    "bg-card shadow-[0_0_0_1px_var(--input),0_1px_2px_rgb(64_32_25/0.08),0_6px_14px_-8px_rgb(243_74_45/0.45)]",
                  )}
                >
                  <motion.span layoutId={`lang-${l.code}`} transition={flight} dir="auto" lang={l.code} className="inline-block min-w-0 truncate font-display text-[15px]/[1.15] font-semibold">
                    {endo}
                  </motion.span>
                  {endo !== l.name && !compact && <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{l.name}</span>}
                  <span className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground/70 transition-colors group-hover:bg-destructive/10 group-hover:text-destructive">
                    <X className="size-3" strokeWidth={2.5} />
                  </span>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </motion.div>
        {!langs.length && (
          <div className="absolute inset-2.5 grid place-items-center rounded-[13px] border border-dashed border-foreground/15 px-6 text-center text-[12.5px] leading-relaxed text-muted-foreground">
            Nothing yet. Pick from the list; they'll gather here.
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- the mark on languages written in English letters (its tooltip says so) ------------------- */

function AaBadge({ className, on }: { className?: string; on?: boolean }) {
  return (
    <span
      title="Written in English letters"
      className={cn(
        "inline-grid h-[18px] shrink-0 place-items-center rounded-[6px] px-1 font-display text-[10.5px] font-bold tracking-tight",
        on ? "bg-brand/15 text-brand" : "bg-brand-gold/20 text-[#a2600c] dark:text-brand-gold",
        className,
      )}
    >
      Aa
    </span>
  );
}

/* ---- one language ------------------------------------------------------------------------- */

const Tile = memo(function Tile({ lang: l, on, roman, onToggle }: { lang: Language; on: boolean; roman: boolean; onToggle: (c: Lang) => void }) {
  const endo = endonym(l.code, l.name);
  const glyph = Array.from(endo)[0];
  const size = endo.length > 14 ? "text-[15px]/[1.15]" : endo.length > 11 ? "text-[16.5px]/[1.15]" : "text-[20px]/[1.15]";
  const text = cn("inline-block max-w-full min-w-0 truncate font-display font-semibold", size);
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={() => onToggle(l.code)}
      aria-pressed={on}
      title={endo !== l.name ? `${endo} · ${l.name}` : l.name}
      className={cn(
        "group relative flex h-[84px] flex-col justify-between overflow-hidden rounded-[16px] p-3.5 text-left transition-[background-color,box-shadow,transform] duration-200",
        on
          ? "bg-[color-mix(in_oklab,var(--brand-cream)_45%,var(--card))] shadow-[0_0_0_1.5px_var(--brand),0_8px_20px_-12px_rgb(243_74_45/0.6)] dark:bg-[color-mix(in_oklab,var(--brand)_13%,var(--card))]"
          : "bg-card shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(64_32_25/0.04)] hover:-translate-y-px hover:shadow-[0_0_0_1px_var(--input),0_8px_18px_-10px_rgb(64_32_25/0.3)]",
      )}
    >
      {/* the script's first letter, large and faint: the typographic texture of the grid */}
      <span
        aria-hidden
        lang={l.code}
        className={cn(
          "pointer-events-none absolute -right-1 -bottom-5 font-display text-[78px] leading-none font-bold transition-opacity",
          on ? "text-brand opacity-[0.13]" : "text-foreground opacity-[0.045] group-hover:opacity-[0.08]",
        )}
      >
        {glyph}
      </span>
      <div className="relative flex items-start justify-between gap-2">
        {on ? (
          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.12 }} dir="auto" lang={l.code} className={cn(text, "text-brand-deep dark:text-brand")}>
            {endo}
          </motion.span>
        ) : (
          <motion.span layoutId={`lang-${l.code}`} transition={flight} dir="auto" lang={l.code} className={text}>
            {endo}
          </motion.span>
        )}
        <span
          className={cn(
            "mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full transition-all duration-200",
            on ? "scale-100 bg-brand text-white" : "scale-90 shadow-[inset_0_0_0_1.5px_var(--input)] opacity-0 group-hover:opacity-100",
          )}
        >
          {on && <Check className="size-3" strokeWidth={3} />}
        </span>
      </div>
      <div className="relative flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <span className="min-w-0 truncate">{l.name}</span>
        {roman && <AaBadge on={on} />}
      </div>
    </motion.button>
  );
});
