import { useEffect, useRef, useState } from "react";

import { Mascot, type MascotState } from "../../Mascot";

/** What the dictation instrument is doing. */
export type Phase = "loading" | "ready" | "listening" | "thinking" | "error";

type RGB = [number, number, number];

function parseColor(v: string, fallback: RGB): RGB {
  const s = v.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.replace(/./g, (c) => c + c) : hex[1]!;
    const n = parseInt(h, 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : fallback;
}

const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;

function readColors(el: Element) {
  const cs = getComputedStyle(el);
  return {
    fg: parseColor(cs.getPropertyValue("--foreground"), [42, 23, 18]),
    brand: parseColor(cs.getPropertyValue("--brand"), [243, 74, 45]),
    gold: parseColor(cs.getPropertyValue("--brand-gold"), [246, 165, 60]),
    dark: document.documentElement.classList.contains("dark"),
  };
}

const TICKS = 120;
const TURN_SECONDS = 7;

/**
 * The listening instrument: the bean in the middle of a dial of ticks. While you talk a write head
 * sweeps the dial and leaves the voice behind it as a radial trace, and ripples leave the ear in
 * step with the level. Transcribing pulls the ripples back in. Everything level-driven is drawn on
 * a canvas from a ref, smoothed between the ~16 Hz mic samples, so React only re-renders the bean.
 */
export function Instrument({
  phase,
  level,
  mood,
  disabled,
  label,
  onToggle,
}: {
  phase: Phase;
  level: number;
  mood: MascotState;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef({ phase, level });
  input.current.phase = phase;
  input.current.level = level;
  const [unit, setUnit] = useState(1);

  useEffect(() => {
    const el = box.current!;
    const cv = canvas.current!;
    const ctx = cv.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // The canvas bleeds past the instrument's box (the card clips it), so ripples fade out
    // instead of stopping at an edge. cx/cy is the box's centre in canvas coordinates.
    let w = 0;
    let h = 0;
    let cx = 0;
    let cy = 0;
    let bw = 0;
    let bh = 0;
    let dpr = 1;
    let u = 1;
    const resize = () => {
      const b = el.getBoundingClientRect();
      const c = cv.getBoundingClientRect();
      w = c.width;
      h = c.height;
      bw = b.width;
      bh = b.height;
      cx = b.left - c.left + bw / 2;
      cy = b.top - c.top + bh / 2;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      u = Math.max(0.6, Math.min(1.15, Math.min(bw, bh) / 330));
      setUnit(Math.round(u * 20) / 20);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let colors = readColors(el);
    let colorAge = 0;
    const ticks = new Float32Array(TICKS);
    const ripples: { p: number; s: number; life: number; inward: boolean }[] = [];
    let head = 0;
    let lvl = 0;
    let listen = 0;
    let think = 0;
    let load = 0;
    let ready = 0;
    let err = 0;
    let spin = 0;
    let sinceEmit = 10;
    let prevPhase: Phase | null = null;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      if ((colorAge += dt) > 0.5) (colors = readColors(el)), (colorAge = 0);
      const { phase, level } = input.current;
      if (phase !== prevPhase) {
        if (phase === "listening") (head = 0), ticks.fill(0), (sinceEmit = 10);
        prevPhase = phase;
      }

      // Smooth the 16 Hz level: fast attack, slower release.
      const target = phase === "listening" ? Math.max(0, Math.min(1, level)) : 0;
      lvl += (target - lvl) * (1 - Math.exp(-dt * (target > lvl ? 22 : 7)));
      const toward = (v: number, on: boolean, rate = 5) => v + ((on ? 1 : 0) - v) * (1 - Math.exp(-dt * rate));
      listen = toward(listen, phase === "listening");
      think = toward(think, phase === "thinking");
      load = toward(load, phase === "loading", 3);
      ready = toward(ready, phase === "ready", 3);
      err = toward(err, phase === "error", 3);
      spin += dt * (phase === "thinking" ? 4.4 : 1.4);

      // The write head lays the voice onto the dial; older trace fades.
      if (phase === "listening") {
        const from = Math.floor(head);
        head = (head + (dt * TICKS) / TURN_SECONDS) % TICKS;
        const steps = (Math.floor(head) - from + TICKS) % TICKS;
        for (let k = 1; k <= steps; k++) ticks[(from + k) % TICKS] = lvl;
      }
      const fade = Math.exp(-dt / (phase === "listening" ? 6 : 0.8));
      for (let i = 0; i < TICKS; i++) ticks[i]! *= fade;

      // Ripples.
      sinceEmit += dt;
      if (!reduced) {
        if (phase === "listening" && lvl > 0.07 && sinceEmit > 0.14 + (1 - lvl) * 0.5) {
          ripples.push({ p: 0, s: lvl, life: 2.3, inward: false });
          sinceEmit = 0;
        } else if (phase === "ready" && sinceEmit > 3.6) {
          ripples.push({ p: 0, s: 0.32, life: 3.8, inward: false });
          sinceEmit = 0;
        } else if (phase === "thinking" && sinceEmit > 0.38) {
          ripples.push({ p: 0, s: 0.6, life: 1.25, inward: true });
          sinceEmit = 0;
        }
      }

      const tickIn = 86 * u;
      const tickMax = 30 * u;
      const rOut = tickIn + tickMax + 12 * u;
      const rMax = Math.max(Math.hypot(bw, bh) / 2, rOut + 160 * u) + 40 * u;
      const boost = colors.dark ? 1.35 : 1;
      const { fg, brand, gold } = colors;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Warm glow that swells with the voice.
      const glowA = (0.07 + 0.06 * think + 0.05 * ready + listen * (0.06 + 0.34 * lvl)) * boost * (1 - 0.6 * err);
      const glowR = rOut + 40 * u + lvl * 60 * u;
      const g = ctx.createRadialGradient(cx, cy, 20 * u, cx, cy, glowR);
      g.addColorStop(0, rgba(gold, glowA));
      g.addColorStop(0.55, rgba(brand, glowA * 0.32));
      g.addColorStop(1, rgba(brand, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // Guide rings, like the inside of an ear.
      ctx.lineWidth = 1;
      for (let k = 0; k < 4; k++) {
        const r = rOut + 10 * u + k * 30 * u + lvl * listen * 7 * u * (1 - k * 0.2);
        ctx.strokeStyle = rgba(fg, (0.055 - k * 0.011 + lvl * listen * 0.05) * boost);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Ripples: outward with the voice, inward while transcribing.
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i]!;
        rp.p += dt / rp.life;
        if (rp.p >= 1) {
          ripples.splice(i, 1);
          continue;
        }
        const p = rp.p;
        let r: number;
        let a: number;
        if (rp.inward) {
          const from = Math.min(rMax * 0.7, rOut + 120 * u);
          r = from - (from - rOut) * (p * p);
          a = Math.sin(Math.PI * p) * 0.38 * rp.s;
          ctx.strokeStyle = rgba(gold, a * boost);
          ctx.lineWidth = 1.5 * u;
        } else {
          const e = 1 - Math.pow(1 - p, 2.2);
          r = rOut + (rMax - rOut) * e;
          a = rp.s * Math.pow(1 - p, 1.8) * 0.75;
          ctx.strokeStyle = rgba(p < 0.35 ? brand : gold, a * boost);
          ctx.lineWidth = (1 + 2.6 * rp.s) * (1 - p * 0.6) * u;
        }
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // The dial.
      ctx.lineCap = "round";
      const spinAt = (spin % (Math.PI * 2)) - Math.PI / 2;
      const shimmerAt = ((now / 1000) * 0.55) % (Math.PI * 2) - Math.PI / 2;
      const dim = 1 - 0.5 * err;
      for (let i = 0; i < TICKS; i++) {
        const ang = -Math.PI / 2 + (i / TICKS) * Math.PI * 2;
        const major = i % 10 === 0;
        const v = ticks[i]!;
        const comet = Math.pow(Math.max(0, Math.cos(ang - spinAt)), 14) * (think * 0.95 + load * 0.7);
        const shimmer = Math.pow(Math.max(0, Math.cos(ang - shimmerAt)), 40) * ready * 0.22;
        const len = (major ? 8 : 5) * u + v * tickMax + comet * 8 * u;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        const x0 = cx + cos * tickIn;
        const y0 = cy + sin * tickIn;
        const x1 = cx + cos * (tickIn + len);
        const y1 = cy + sin * (tickIn + len);
        ctx.lineWidth = (major ? 2 : 1.6) * u;
        ctx.strokeStyle = rgba(fg, ((major ? 0.26 : 0.15) + shimmer) * dim);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        const lit = Math.min(1, v * 2.4);
        if (lit > 0.02 || comet > 0.02) {
          ctx.strokeStyle = lit >= comet ? rgba(brand, lit) : rgba(gold, comet);
          ctx.lineWidth = 2.2 * u;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      }

      // Write head.
      if (listen > 0.02) {
        const ang = -Math.PI / 2 + (head / TICKS) * Math.PI * 2;
        const r = tickIn - 8 * u;
        ctx.fillStyle = rgba(gold, listen);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, 2.6 * u, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const size = Math.round(150 * unit);
  return (
    <div ref={box} className="relative min-h-0 flex-1">
      <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-x-0 -top-24 -bottom-56 -z-[1] h-[calc(100%+20rem)] w-full" />
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-label={label}
        title={label}
        className="group absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-8 focus-visible:ring-offset-card disabled:cursor-default"
        style={{ width: size, height: size }}
      >
        <span className="block transition-transform duration-300 ease-out group-hover:scale-[1.035] group-active:scale-[0.96] group-disabled:scale-100">
          <Mascot state={mood} level={level} size={size} />
        </span>
      </button>
    </div>
  );
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
};

/** A stopwatch that writes straight into the DOM on each frame while it runs. */
export function Timer({ running, className }: { running: boolean; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!running) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      if (el.current) el.current.textContent = fmt((performance.now() - t0) / 1000);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [running]);
  return (
    <span ref={el} className={className}>
      0:00.0
    </span>
  );
}
