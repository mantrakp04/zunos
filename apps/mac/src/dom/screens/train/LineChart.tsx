import { cn } from "@zunos/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

// A hand-built SVG line chart: smooth monotone curves that draw in, dashed reference lines,
// a marked step, a crosshair shared with sibling charts (hover is in data units, not pixels),
// direct labels in a right gutter, and values that run off the top flagged instead of hidden.

export type Pt = { x: number; y: number };
export type Line = {
  key: string;
  label: string;
  color: string;
  points: Pt[];
  width?: number;
  /** Soft gradient under the curve. */
  area?: boolean;
  /** Reference value shown next to this line's value in the tooltip (the reference recognizer). */
  ref?: number;
  /** Pulse the last point: the run is still going. */
  live?: boolean;
};
export type RefLine = { key: string; label: string; color: string; y: number };

const EASE = [0.65, 0, 0.35, 1] as const;

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A tick step of 1, 2, 2.5 or 5 × 10^k giving about `count` ticks over `span`. */
export function niceStep(span: number, count = 4) {
  const raw = span / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Monotone cubic (Fritsch–Carlson): smooth, but never overshoots the data. */
export function monotonePath(pts: [number, number][]) {
  const n = pts.length;
  if (!n) return "";
  if (n === 1) return `M${pts[0]![0]},${pts[0]![1]}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1]![0] - pts[i]![0];
    m[i] = (pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1);
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) {
    t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / m[i - 1]! + (dx[i]! + 2 * dx[i - 1]!) / m[i]!);
  }
  t[n - 1] = m[n - 2]!;
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${x0 + h},${y0 + t[i]! * h},${x1 - h},${y1 - t[i + 1]! * h},${x1},${y1}`;
  }
  return d;
}

/** Push labels apart vertically so none overlap; keeps them inside [lo, hi]. */
function spread<T extends { y: number }>(items: T[], gap: number, lo: number, hi: number): (T & { ly: number })[] {
  const out = [...items].sort((a, b) => a.y - b.y).map((it) => ({ ...it, ly: Math.max(lo, Math.min(hi, it.y)) }));
  for (let i = 1; i < out.length; i++) out[i]!.ly = Math.max(out[i]!.ly, out[i - 1]!.ly + gap);
  const over = out.length ? out[out.length - 1]!.ly - hi : 0;
  if (over > 0) {
    out[out.length - 1]!.ly = hi;
    for (let i = out.length - 2; i >= 0; i--) out[i]!.ly = Math.min(out[i]!.ly, out[i + 1]!.ly - gap);
  }
  return out;
}

const nearest = (pts: Pt[], x: number) => pts.reduce<Pt | null>((b, p) => (!b || Math.abs(p.x - x) < Math.abs(b.x - x) ? p : b), null);

export function LineChart({
  lines,
  refs = [],
  height,
  xDomain,
  yDomain,
  yFormat,
  marker,
  hoverX,
  onHoverX,
  tooltipTitle,
  gutter = true,
  drawKey,
  className,
}: {
  lines: Line[];
  refs?: RefLine[];
  height: number;
  xDomain: [number, number];
  yDomain: [number, number];
  yFormat: (v: number) => string;
  /** A vertical marker, e.g. the best step. */
  marker?: { x: number; label: string } | null;
  hoverX: number | null;
  onHoverX: (x: number | null) => void;
  tooltipTitle: (x: number) => ReactNode;
  gutter?: boolean;
  /** Change to replay the draw-in animation. */
  drawKey: string;
  className?: string;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const padT = marker ? 26 : 12;
  const H = height - padT - 24;
  // Direct labels only while they fit down the side; past that the legend and tooltip carry the names.
  const drawn = lines.filter((l) => l.points.length).length;
  const showGutter = gutter && width >= 520 && drawn * LABEL_GAP <= H + LABEL_GAP;
  const pad = { l: 38, r: showGutter ? 128 : 14, t: padT, b: 24 };
  const W = Math.max(0, width - pad.l - pad.r);
  const [x0, x1] = xDomain;
  const [y0, y1] = yDomain;
  const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0 || 1)) * W;
  const sy = (y: number) => pad.t + H - ((Math.min(y, y1) - y0) / (y1 - y0 || 1)) * H;

  const yTicks = useMemo(() => {
    const s = niceStep(y1 - y0, 4);
    const out: number[] = [];
    for (let v = Math.ceil(y0 / s) * s; v <= y1 + 1e-9; v += s) out.push(+v.toFixed(6));
    return out;
  }, [y0, y1]);
  const xTicks = useMemo(() => {
    const s = niceStep(x1 - x0, W < 420 ? 3 : 6);
    const out: number[] = [];
    for (let v = Math.ceil(x0 / s) * s; v <= x1 + 1e-9; v += s) out.push(Math.round(v));
    return out;
  }, [x0, x1, W]);

  // Snap the crosshair to the first line's samples.
  const snapX = hoverX == null || !lines[0] ? null : (nearest(lines[0].points, hoverX)?.x ?? null);
  const hovered = snapX == null ? [] : lines.map((l) => ({ line: l, p: nearest(l.points, snapX) })).filter((h) => h.p);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    onHoverX(x0 + fx * (x1 - x0));
  };

  const labels = showGutter
    ? spread(
        lines.filter((l) => l.points.length).map((l) => ({ l, y: sy(l.points[l.points.length - 1]!.y) })),
        LABEL_GAP,
        pad.t + 4,
        pad.t + H,
      )
    : [];
  // Reference labels sit just above their line; when two are close, the upper one moves up, and one
  // that would end up far from its line (or off the top) is dropped rather than stacked on another.
  // Past a handful the labels bury the curves; the dashed lines and the table below still carry them.
  const refLabels: { r: RefLine; ly: number }[] = [];
  for (const r of refs.length <= 6 ? [...refs].sort((a, b) => a.y - b.y) : []) {
    const y = Math.max(pad.t + 8, sy(r.y) - 5);
    const prev = refLabels[refLabels.length - 1];
    const ly = prev && y > prev.ly - 12 ? prev.ly - 12 : y;
    if (ly >= pad.t + 8 && y - ly <= 18) refLabels.push({ r, ly });
  }

  // The tooltip sits beside the crosshair, on whichever side has room, and never past the chart's edges.
  const tip = useRef<HTMLDivElement>(null);
  const [tipW, setTipW] = useState(0);
  const tipX = snapX == null ? 0 : sx(snapX);
  const toRight = tipX + 14 + tipW <= width;
  const toLeft = tipX - 14 - tipW >= 0;
  const tipLeft =
    toRight && (tipX <= pad.l + W * 0.62 || !toLeft) ? tipX + 14 : toLeft ? tipX - 14 - tipW : Math.max(0, Math.min(tipX - tipW / 2, width - tipW));
  // Many rows: two columns of name and value, so the box stays inside the plot's height.
  const tipRows = snapX == null ? 0 : lines.filter((l) => l.points.length).length;
  const tipCols = tipRows > 10;
  useLayoutEffect(() => {
    const w = tip.current?.offsetWidth ?? 0;
    if (w !== tipW) setTipW(w);
  });

  return (
    <div ref={wrap} className={cn("relative select-none", className)} style={{ height }}>
      {width > 0 && (
        // Out of flow, so its pixel width never props the box open when the window narrows.
        <svg width={width} height={height} className="absolute top-0 left-0 block overflow-visible">
          <defs>
            <clipPath id={`clip${uid}`}>
              <rect x={pad.l - 4} y={pad.t - 6} width={W + 8} height={H + 8} />
            </clipPath>
            {lines.map((l) => (
              <linearGradient key={l.key} id={`g${uid}${l.key}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={l.color} stopOpacity={0.09} />
                <stop offset="100%" stopColor={l.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>

          {/* grid + axes */}
          <g className="text-[10.5px] tabular-nums" fill="var(--muted-foreground)">
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={pad.l} x2={pad.l + W} y1={sy(v)} y2={sy(v)} stroke="var(--foreground)" strokeOpacity={v === y0 ? 0.14 : 0.06} />
                <text x={pad.l - 8} y={sy(v)} dy="0.32em" textAnchor="end">
                  {yFormat(v)}
                </text>
              </g>
            ))}
            {xTicks.map((v) => (
              <text key={v} x={sx(v)} y={pad.t + H + 16} textAnchor="middle">
                {v}
              </text>
            ))}
          </g>

          {/* reference lines (dashed) */}
          <g>
            {refs.map((r, i) => (
              <motion.line
                key={`${drawKey}-${r.key}`}
                x1={pad.l}
                x2={pad.l + W}
                y1={sy(r.y)}
                y2={sy(r.y)}
                stroke={r.color}
                strokeOpacity={0.6}
                strokeWidth={1.25}
                strokeDasharray="5 4"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 + i * 0.08, duration: 0.5 }}
              />
            ))}
          </g>

          {/* best-step marker */}
          {marker && marker.x >= x0 && marker.x <= x1 && (
            <motion.g key={`${drawKey}-m`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.9, duration: 0.4 }}>
              <line x1={sx(marker.x)} x2={sx(marker.x)} y1={pad.t - 4} y2={pad.t + H} stroke="var(--brand)" strokeOpacity={0.55} strokeDasharray="2 3" />
              <MarkerFlag x={sx(marker.x)} y={pad.t - 13} label={marker.label} min={Math.min(pad.l, 30)} max={Math.min(pad.l + W, width - 31)} />
            </motion.g>
          )}

          {/* the curves */}
          <g clipPath={`url(#clip${uid})`}>
            {lines.map((l, i) => {
              const pts = l.points.map((p) => [sx(p.x), sy(p.y)] as [number, number]);
              const d = monotonePath(pts);
              return (
                <g key={`${drawKey}-${l.key}`}>
                  {l.area && pts.length > 1 && (
                    <motion.path
                      d={`${d}L${pts[pts.length - 1]![0]},${pad.t + H}L${pts[0]![0]},${pad.t + H}Z`}
                      fill={`url(#g${uid}${l.key})`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.6, duration: 0.8 }}
                    />
                  )}
                  <motion.path
                    d={d}
                    fill="none"
                    stroke={l.color}
                    strokeWidth={l.width ?? 1.75}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{ pathLength: { duration: 1.1, ease: EASE, delay: i * 0.09 }, opacity: { duration: 0.15, delay: i * 0.09 } }}
                  />
                  {l.live && pts.length > 0 && (
                    <g>
                      <circle className="zt-live" cx={pts[pts.length - 1]![0]} cy={pts[pts.length - 1]![1]} r={4} fill={l.color} />
                      <circle cx={pts[pts.length - 1]![0]} cy={pts[pts.length - 1]![1]} r={3} fill={l.color} stroke="var(--card)" strokeWidth={1.5} />
                    </g>
                  )}
                </g>
              );
            })}
          </g>

          {/* values that run off the top of the chart: a notch per line, the highest value once */}
          {[...new Set(lines.flatMap((l) => l.points.filter((p) => p.y > y1).map((p) => p.x)))].map((x) => {
            const over = lines.flatMap((l) => l.points.filter((p) => p.x === x && p.y > y1).map((p) => ({ l, y: p.y })));
            const top = Math.max(...over.map((o) => o.y));
            return (
              <g key={`over-${x}`} transform={`translate(${sx(x)},${pad.t - 2})`}>
                {over.map((o, i) => (
                  <path key={o.l.key} d="M-4,3L0,-2L4,3Z" transform={`translate(${(i - (over.length - 1) / 2) * 9},0)`} fill={o.l.color} />
                ))}
                <text y={-6} textAnchor="middle" className="text-[9.5px] font-medium tabular-nums" fill="var(--muted-foreground)" style={haloStyle}>
                  {yFormat(top)}
                </text>
              </g>
            );
          })}

          {/* reference labels: at the left end of each dashed line */}
          {refLabels.map(({ r, ly }) => (
            <text key={r.key} x={pad.l + 6} y={ly} className="text-[9.5px] font-medium tabular-nums" fill="var(--muted-foreground)" style={haloStyle}>
              {r.label} {yFormat(r.y)}
            </text>
          ))}

          {/* direct labels */}
          {labels.map(({ l, y, ly }) => (
            <g key={l.key}>
              {Math.abs(ly - y) > 3 && (
                <path d={`M${pad.l + W + 6},${y}L${pad.l + W + 12},${ly}`} stroke={l.color} strokeOpacity={0.5} fill="none" />
              )}
              <circle cx={pad.l + W + 16} cy={ly} r={3} fill={l.color} />
              <text x={pad.l + W + 24} y={ly} dy="0.33em" className="text-[11px]" fill="var(--foreground)">
                <title>{l.label}</title>
                <tspan className="font-medium">{clip(l.label, 11)}</tspan>
                <tspan dx={5} fill="var(--muted-foreground)" className="tabular-nums">
                  {yFormat(l.points[l.points.length - 1]!.y)}
                </tspan>
              </text>
            </g>
          ))}

          {/* crosshair */}
          {snapX != null && (
            <g pointerEvents="none">
              <line x1={sx(snapX)} x2={sx(snapX)} y1={pad.t - 4} y2={pad.t + H} stroke="var(--foreground)" strokeOpacity={0.28} />
              {hovered.map(({ line, p }) => (
                <circle key={line.key} cx={sx(p!.x)} cy={sy(p!.y)} r={4} fill={line.color} stroke="var(--card)" strokeWidth={2} />
              ))}
            </g>
          )}

          <rect
            x={pad.l}
            y={0}
            width={W}
            height={height}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => onHoverX(null)}
            style={{ cursor: "crosshair" }}
          />
        </svg>
      )}

      <AnimatePresence>
        {snapX != null && hovered.length > 0 && (
          <motion.div
            key="tip"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            ref={tip}
            className="pointer-events-none absolute z-10 w-max max-w-full min-w-[11rem] rounded-xl bg-popover/95 px-3 py-2.5 text-[12px] whitespace-nowrap text-popover-foreground shadow-[0_0_0_1px_var(--border),0_10px_30px_-10px_rgb(40_20_10/0.35)] backdrop-blur"
            style={{ top: tipCols ? Math.max(0, pad.t - 8) : pad.t, left: tipLeft }}
          >
            <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{tooltipTitle(snapX)}</div>
            <div
              className={cn(tipCols ? "grid grid-flow-col grid-cols-2 gap-x-5 gap-y-0.5 leading-tight" : "flex flex-col gap-1")}
              style={tipCols ? { gridTemplateRows: `repeat(${Math.ceil(hovered.length / 2)}, auto)` } : undefined}
            >
              {[...hovered]
                .sort((a, b) => (b.line.width ?? 0) - (a.line.width ?? 0) || a.p!.y - b.p!.y)
                .map(({ line, p }) => (
                  <div key={line.key} className="flex min-w-0 items-center gap-2">
                    <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: line.color }} />
                    <span className={cn("min-w-0 flex-1 truncate", line.width && line.width > 2 && "font-semibold")}>{line.label}</span>
                    <span className="font-semibold tabular-nums">{yFormat(p!.y)}</span>
                    {line.ref != null && !tipCols && <span className="ml-1 text-right text-[11px] whitespace-nowrap tabular-nums text-muted-foreground">Ref {yFormat(line.ref)}</span>}
                  </div>
                ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const LABEL_GAP = 15;

/** Cut a label for the narrow gutter; the full name is in the SVG title. */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const haloStyle = { paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3, strokeLinejoin: "round" } as const;

function MarkerFlag({ x, y, label, min, max }: { x: number; y: number; label: string; min: number; max: number }) {
  const w = label.length * 6 + 18;
  const left = Math.max(min - 30, Math.min(max + 30 - w, x - w / 2));
  return (
    <g>
      <rect x={left} y={y - 9} width={w} height={18} rx={9} fill="var(--brand)" />
      <text x={left + w / 2} y={y} dy="0.34em" textAnchor="middle" className="text-[10.5px] font-semibold tabular-nums" fill="#fff">
        {label}
      </text>
    </g>
  );
}

/** A tiny curve for a card: fixed box, no axes. */
export function Sparkline({ points, best, max = 0.6, className }: { points: Pt[]; best?: number | null; max?: number; className?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const h = 30;
  const [x0, x1] = [points[0]?.x ?? 0, points[points.length - 1]?.x ?? 1];
  const sx = (x: number) => 2 + ((x - x0) / (x1 - x0 || 1)) * (width - 4);
  const sy = (y: number) => 3 + (Math.min(y, max) / max) * (h - 6);
  const fy = (y: number) => h - sy(y);
  const bp = best != null ? points.find((p) => p.x === best) : null;
  const d = monotonePath(points.map((p) => [sx(p.x), fy(p.y)]));
  return (
    <div ref={ref} className={cn("relative", className)} style={{ height: h }}>
      {width > 0 && points.length > 1 && (
        <svg width={width} height={h} className="absolute top-0 left-0 block overflow-visible">
          <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
          {bp && <circle cx={sx(bp.x)} cy={fy(bp.y)} r={3} fill="var(--brand)" stroke="var(--card)" strokeWidth={1.5} />}
        </svg>
      )}
    </div>
  );
}
