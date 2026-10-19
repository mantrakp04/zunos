import { cn } from "@zunos/ui/lib/utils";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { Mascot, type MascotState } from "../../Mascot";

export type StageHandle = {
  /** Something happened (a keystroke, a pick): the ear perks up and a ripple leaves it. */
  poke: (strength?: number) => void;
};

// Where the ear's bowl sits in the mascot's box, in 256ths of its size; ripples leave from here.
const EAR = { x: 218, y: 87 };
// The arcs open toward the upper right, the way the bean's sound waves do.
const FROM = -100;
const TO = 22;

function arc(c: number, r: number) {
  const p = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    return `${(c + r * Math.cos(t)).toFixed(1)} ${(c + r * Math.sin(t)).toFixed(1)}`;
  };
  return `M${p(FROM)}A${r} ${r} 0 0 1 ${p(TO)}`;
}

/**
 * The bean on its stage: ambient ripples drift out of its ear, and `poke()` makes it listen for a
 * moment. Keeps its own state so pokes never re-render the screen around it.
 */
export function Stage({
  ref,
  size,
  mood: forced,
  ambient = true,
  className,
}: {
  ref?: Ref<StageHandle>;
  size: number;
  /** Overrides the poke-driven mood (e.g. "thinking" while a request runs). */
  mood?: MascotState;
  ambient?: boolean;
  className?: string;
}) {
  const [level, setLevel] = useState(0);
  const [pokes, setPokes] = useState<number[]>([]);
  const lvl = useRef(0);
  const raf = useRef(0);
  const seq = useRef(0);
  const lastRipple = useRef(0);

  const decay = useCallback(() => {
    lvl.current = Math.max(0, lvl.current - 0.014);
    setLevel(lvl.current);
    raf.current = lvl.current > 0 ? requestAnimationFrame(decay) : 0;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      poke(strength = 0.55) {
        lvl.current = Math.min(1, lvl.current + strength);
        setLevel(lvl.current);
        if (!raf.current) raf.current = requestAnimationFrame(decay);
        const now = performance.now();
        if (now - lastRipple.current > 140) {
          lastRipple.current = now;
          const id = ++seq.current;
          setPokes((p) => [...p.slice(-5), id]);
        }
      },
    }),
    [decay],
  );
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const R = Math.round(size * 1.3);
  const C = R; // ripple svg is 2R square, centred on the ear
  const left = (EAR.x / 256) * size - R;
  const top = (EAR.y / 256) * size - R;
  const mood: MascotState = forced ?? (level > 0.02 ? "listening" : "idle");

  return (
    <div className={cn("relative", className)} style={{ width: size, height: size }}>
      <svg
        aria-hidden
        width={R * 2}
        height={R * 2}
        viewBox={`0 0 ${R * 2} ${R * 2}`}
        className="pointer-events-none absolute overflow-visible"
        style={{ left, top }}
      >
        {ambient &&
          [0, 1, 2, 3].map((i) => (
            <path
              key={i}
              className="zn-ripple"
              style={{ animationDelay: `${i * 1.5}s`, animationDuration: forced === "thinking" ? "3s" : undefined }}
              d={arc(C, R * 0.96)}
              fill="none"
              stroke="var(--brand-gold)"
              strokeWidth={1.6}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        {pokes.map((id) => (
          <path
            key={id}
            className="zn-ripple-poke"
            d={arc(C, R * 0.96)}
            fill="none"
            stroke="var(--brand)"
            strokeWidth={2.2}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            onAnimationEnd={() => setPokes((p) => p.filter((x) => x !== id))}
          />
        ))}
      </svg>
      <div className="zn-stage-floor" style={{ width: size * 0.78, height: size * 0.09, top: size * 0.86 }} />
      <Mascot state={mood} level={level} size={size} className="relative" />
    </div>
  );
}
