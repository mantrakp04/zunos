import { memo, type RefObject, useEffect, useRef } from "react";

// The voice ribbon: sound leaves the bean's ear (the left edge) and drifts right, fading out.
// The mic level arrives at ~16 Hz; we ease toward each sample on rAF so the motion stays smooth,
// and draw to a canvas so nothing in React re-renders per frame. The loop stops when idle.

const N = 150; // history samples across the width
const STEP = 1 / 48; // seconds per history sample (scroll speed)
const STRANDS = [
  { f: 0.11, s: 3.1, p: 0, w: 2.2, a: 0.95, k: 1 },
  { f: 0.17, s: -2.3, p: 1.9, w: 1.5, a: 0.6, k: 0.8 },
  { f: 0.07, s: 1.7, p: 3.7, w: 1.1, a: 0.42, k: 0.6 },
];

export const VoiceRibbon = memo(function VoiceRibbon({
  levelRef,
  active,
  onFrame,
  className,
}: {
  /** Latest mic level 0..1, written by the parent on every render. */
  levelRef: RefObject<number>;
  active: boolean;
  /** Called every frame with the smoothed level (for other light, cheap effects). */
  onFrame?: (level: number) => void;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const hist = new Float32Array(N);
    const tmp = new Float32Array(N);
    const env = new Float32Array(N);
    let w = 0, h = 0, dpr = 1;
    let smooth = 0, acc = 0, t = 0, last = 0, raf = 0, running = false;
    let stroke: CanvasGradient | null = null;
    let fill: CanvasGradient | null = null;

    const paint = () => {
      stroke = ctx.createLinearGradient(0, 0, w, 0);
      stroke.addColorStop(0, media.matches ? "#ff5a3c" : "#f34a2d");
      stroke.addColorStop(0.35, "#f6a53c");
      stroke.addColorStop(1, "rgba(246,165,60,0)");
      fill = ctx.createLinearGradient(0, 0, w, 0);
      fill.addColorStop(0, media.matches ? "rgba(255,90,60,0.24)" : "rgba(243,74,45,0.13)");
      fill.addColorStop(0.55, media.matches ? "rgba(246,165,60,0.1)" : "rgba(246,165,60,0.1)");
      fill.addColorStop(1, "rgba(246,165,60,0)");
    };

    const draw = (frac: number) => {
      if (!w || !h) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const mid = h / 2;
      const dx = w / (N - 2);
      const xAt = (i: number) => (i === 0 ? 0 : (i - 1 + frac) * dx + dx * 0.5);
      // Full height near the ear, tapering as the sound travels and fades. Two light blur passes
      // over the history keep the edge a ribbon rather than a jagged meter.
      for (let i = 0; i < N; i++) tmp[i] = Math.sqrt(hist[i]!);
      for (let pass = 0; pass < 2; pass++) {
        env[0] = tmp[0]!;
        env[N - 1] = tmp[N - 1]!;
        for (let i = 1; i < N - 1; i++) env[i] = (tmp[i - 1]! + 2 * tmp[i]! + tmp[i + 1]!) / 4;
        tmp.set(env);
      }
      const amp = (i: number) => env[i]! * (mid - 2) * Math.pow(1 - i / N, 0.8) * Math.min(1, (i + 1.5) / 4);

      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.strokeStyle = stroke!;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.fillStyle = fill!;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let i = 0; i < N; i++) ctx.lineTo(xAt(i), mid - amp(i));
      for (let i = N - 1; i >= 0; i--) ctx.lineTo(xAt(i), mid + amp(i));
      ctx.closePath();
      ctx.fill();

      if (media.matches) ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const s of STRANDS) {
        ctx.globalAlpha = s.a;
        ctx.lineWidth = s.w;
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
          const y = mid + amp(i) * s.k * Math.sin((i + frac) * s.f + t * s.s + s.p);
          if (i === 0) ctx.moveTo(xAt(i), y);
          else ctx.lineTo(xAt(i), y);
        }
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      t += dt;
      const lvl = levelRef.current ?? 0;
      const target = activeRef.current ? Math.max(0, Math.min(1, lvl)) : 0;
      // Fast attack, softer release, like a VU meter.
      const tau = target > smooth ? 0.05 : 0.14;
      smooth += (target - smooth) * (1 - Math.exp(-dt / tau));
      acc += dt;
      while (acc >= STEP) {
        acc -= STEP;
        hist.copyWithin(1, 0, N - 1);
      }
      hist[0] = smooth;
      draw(acc / STEP);
      onFrameRef.current?.(smooth);
      if (!activeRef.current) {
        let e = 0;
        for (let i = 0; i < N; i++) e = Math.max(e, hist[i]!);
        if (e < 0.003) {
          hist.fill(0);
          smooth = 0;
          draw(0);
          onFrameRef.current?.(0);
          running = false;
          last = 0;
          return;
        }
      }
      raf = requestAnimationFrame(frame);
    };

    kick.current = () => {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width;
      h = r.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      paint();
      if (!running) draw(0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const onScheme = () => (paint(), running || draw(0));
    media.addEventListener("change", onScheme);
    if (activeRef.current) kick.current();
    return () => {
      cancelAnimationFrame(raf);
      running = false;
      ro.disconnect();
      media.removeEventListener("change", onScheme);
    };
  }, [levelRef]);

  useEffect(() => {
    if (active) kick.current();
  }, [active]);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} />;
});
