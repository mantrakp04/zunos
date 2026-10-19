import { cn } from "@zunos/ui/lib/utils";
import { AlertCircle, Loader2 } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { type ButtonHTMLAttributes, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export { languageName as langName } from "@zunos/db/languages";

type ButtonVariant = "primary" | "brand" | "ghost" | "outline" | "danger" | "soft";

export function Button({
  variant = "primary",
  size = "md",
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap outline-none select-none",
        "transition-[transform,background-color,box-shadow,color,opacity] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        size === "sm" && "h-7 px-3 text-[12.5px]",
        size === "md" && "h-9 px-4 text-[13.5px]",
        size === "lg" && "h-11 px-6 text-[15px]",
        variant === "primary" && "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.2)] hover:opacity-90",
        variant === "brand" &&
          "bg-[linear-gradient(180deg,#ff6a4a,var(--brand)_45%,var(--brand-deep))] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),inset_0_-1px_0_rgb(0_0_0/0.12),0_1px_2px_rgb(160_30_10/0.35),0_8px_20px_-8px_rgb(243_74_45/0.7)] hover:brightness-[1.06]",
        variant === "soft" && "bg-brand/12 text-brand hover:bg-brand/18 dark:bg-brand/18 dark:hover:bg-brand/25",
        variant === "outline" && "bg-card text-foreground shadow-[0_0_0_1px_var(--input),0_1px_2px_rgb(64_32_25/0.06)] hover:bg-accent",
        variant === "ghost" && "text-muted-foreground hover:bg-accent hover:text-foreground",
        variant === "danger" && "text-destructive hover:bg-destructive/10",
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("zn-surface p-5 text-card-foreground", className)}>{children}</div>;
}

/** Small uppercase label above a value or a section. */
export function Eyebrow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("text-[10.5px] font-semibold tracking-[0.12em] text-muted-foreground uppercase", className)}>{children}</div>;
}

export function Stat({ label, value, hint, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Eyebrow>{label}</Eyebrow>
      <span className="font-display text-[28px] leading-none font-semibold tracking-tight tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

export function Badge({ tone = "muted", className, children }: { tone?: "muted" | "brand" | "good" | "warn" | "ink"; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-semibold whitespace-nowrap",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "brand" && "bg-brand/12 text-brand dark:bg-brand/20",
        tone === "good" && "bg-good/12 text-good dark:bg-good/18",
        tone === "warn" && "bg-warn/14 text-warn",
        tone === "ink" && "bg-foreground text-background",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="zn-kbd">{children}</kbd>;
}

export function ErrorNote({ error, className }: { error: string | null | undefined; className?: string }) {
  if (!error) return null;
  return (
    <motion.p
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("flex items-start gap-2 rounded-xl bg-destructive/8 px-3 py-2 text-[13px] text-destructive", className)}
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 select-text [overflow-wrap:anywhere]">{error}</span>
    </motion.p>
  );
}

/** Screen title. Big, rounded, with an optional line of context and actions on the right. */
export function PageHeader({ eyebrow, title, subtitle, children }: { eyebrow?: ReactNode; title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    // Wraps: on a narrow window the actions drop under the title instead of squeezing the subtitle.
    <div className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 flex-[1_1_26rem]">
        {eyebrow && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
        <h1 className="font-display text-[34px] leading-[1.05] font-bold tracking-[-0.025em]">{title}</h1>
        {subtitle && <p className="mt-2 max-w-[44rem] text-[14px] leading-relaxed text-muted-foreground">{subtitle}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** A segmented control in the macOS style: a sliding thumb under the selected option. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  size?: "sm" | "md";
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("inline-flex rounded-full bg-muted p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "relative rounded-full font-medium transition-colors",
            size === "sm" ? "h-6 px-2.5 text-[11.5px]" : "h-7 px-3.5 text-[12.5px]",
            value === o.value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value === o.value && (
            <motion.span
              layoutId={`seg-${id}`}
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
              className="absolute inset-0 rounded-full bg-card shadow-[0_0_0_0.5px_var(--input),0_1px_3px_rgb(64_32_25/0.12)]"
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A progress ring. `value` is 0..1. */
export function Ring({ value, size = 36, stroke = 4, className, children, color = "var(--brand)" }: {
  value: number; size?: number; stroke?: number; className?: string; children?: ReactNode; color?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={cn("relative inline-grid place-items-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.12} strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={false}
          animate={{ strokeDashoffset: c * (1 - v) }}
          transition={{ type: "spring", stiffness: 120, damping: 22 }}
        />
      </svg>
      {children && <div className="absolute inset-0 grid place-items-center">{children}</div>}
    </div>
  );
}

/** A thin progress bar. `value` is 0..1. */
export function Meter({ value, className, tone = "brand" }: { value: number; className?: string; tone?: "brand" | "good" | "ink" }) {
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-foreground/8", className)}>
      <motion.div
        className={cn(
          "h-full rounded-full",
          tone === "brand" && "bg-[linear-gradient(90deg,var(--brand),var(--brand-gold))]",
          tone === "good" && "bg-good",
          tone === "ink" && "bg-foreground",
        )}
        initial={false}
        animate={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
        transition={{ type: "spring", stiffness: 140, damping: 24 }}
      />
    </div>
  );
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Recorded speech per language that's enough to train on. Training waits until every enabled
 * language has this much; more still makes a better model.
 */
export const ENOUGH_SECONDS = 5 * 60;

/** Enabled languages still short of ENOUGH_SECONDS, with how many seconds each still needs. */
export const shortOf = (stats: { lang: string; trainSeconds: number; testSeconds: number }[]) =>
  stats.map((s) => ({ lang: s.lang, need: ENOUGH_SECONDS - s.trainSeconds - s.testSeconds })).filter((s) => s.need > 0);

export const minutes = (s: number) =>
  s < 60 ? `${Math.round(s)} s` : s < 6000 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s / 60).toLocaleString("en-US")} min`;

export const pct = (x: number | undefined | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);

/** Runs an async loader on mount (and when deps change); exposes data, error and reload. */
/**
 * A row that scrolls sideways when it doesn't fit. The edges fade only on a side with more to see,
 * items snap (give them `snap-start`), a vertical wheel scrolls it sideways until it reaches an end,
 * and the child with `data-strip-key={active}` is kept in view.
 */
export function ScrollStrip({ active, className, innerClassName, fade = 28, children }: {
  active?: string | null; className?: string; innerClassName?: string; fade?: number; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<[boolean, boolean]>([false, false]);
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const l = el.scrollLeft > 1;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e[0] === l && e[1] === r ? e : [l, r]));
  }, []);
  useLayoutEffect(() => {
    const el = ref.current!;
    // Snapped items rest at the strip's own padding, the same inset as top and bottom, at both ends.
    const cs = getComputedStyle(el);
    el.style.scrollPaddingInline = `${cs.paddingLeft} ${cs.paddingRight}`;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0 || (e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => (ro.disconnect(), el.removeEventListener("wheel", onWheel));
  }, [update]);
  useEffect(() => {
    const el = ref.current;
    if (!el || active == null) return;
    const item = el.querySelector<HTMLElement>(`[data-strip-key="${CSS.escape(active)}"]`);
    if (!item) return;
    // Scroll only this strip; scrollIntoView would also drag the page around it.
    const box = el.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    if (r.left < box.left + fade) el.scrollBy({ left: r.left - box.left - fade, behavior: "smooth" });
    else if (r.right > box.right - fade) el.scrollBy({ left: r.right - box.right + fade, behavior: "smooth" });
  }, [active, fade]);
  const mask = `linear-gradient(90deg, ${edges[0] ? "transparent" : "#000"}, #000 ${fade}px, #000 calc(100% - ${fade}px), ${edges[1] ? "transparent" : "#000"})`;
  return (
    <div
      ref={ref}
      onScroll={update}
      className={cn("scrollbar-none min-w-0 snap-x snap-proximity overflow-x-auto overscroll-x-contain", className)}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      <div className={cn("flex w-max", innerClassName)}>{children}</div>
    </div>
  );
}

/**
 * Whether this screen is still the one on show. A screen you leave stays mounted for its exit
 * animation, so window-level key handlers check this to stop acting on keys meant for the next one.
 */
export function usePresent() {
  const present = useIsPresent();
  const ref = useRef(present);
  ref.current = present;
  return ref;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    return fn()
      .then((d) => (setData(d), setError(null)))
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Wraps an async handler with loading and error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (...args: A): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn(...args);
    } catch (e) {
      setError(message(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, setError };
}
