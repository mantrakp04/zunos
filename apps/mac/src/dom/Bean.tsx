import { cn } from "@zunos/ui/lib/utils";
import type { CSSProperties } from "react";

// The listening bean (assets/brand/logo-mark.svg), split into parts so it can react: the ear
// perks up and the sound waves swell with the mic level, the eyes open while it listens.
export type BeanMood = "idle" | "listening" | "thinking" | "happy" | "sleepy";

export function Bean({
  mood = "idle",
  level = 0,
  size = 64,
  className,
  waves = true,
}: {
  mood?: BeanMood;
  /** Mic level 0..1; only used while listening. */
  level?: number;
  size?: number;
  className?: string;
  waves?: boolean;
}) {
  const lvl = mood === "listening" ? Math.max(0, Math.min(1, level)) : 0;
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      aria-hidden="true"
      data-mood={mood}
      className={cn("zn-bean overflow-visible", className)}
      style={{ "--lvl": lvl } as CSSProperties}
    >
      <g className="zn-bean-body">
        <path fill="#F34A2D" d="M137 66C119 52 93 51 73 63C48 77 37 109 29 137C20 164 15 183 25 204C35 225 61 231 107 231C150 231 180 228 190 209C199 191 190 169 180 147L170 87Z" />
        <path fill="#D93428" d="M25 194C41 211 70 217 112 217C150 217 177 211 193 194C196 217 179 231 107 231C58 231 32 226 25 204Z" />
        <ellipse className="zn-bean-cheek" cx="52" cy="140" rx="13" ry="8" fill="#FF8A6B" opacity="0.55" />
      </g>
      <g className="zn-bean-ear">
        <path fill="#FFE4A1" d="M164 34C138 34 129 59 135 85C139 103 148 114 150 130C151 144 149 155 156 162C165 173 184 171 195 155C210 133 208 105 201 80C194 55 185 34 164 34Z" />
        <path fill="#F6A53C" d="M165 50C148 50 146 68 151 84C155 96 167 98 173 106C181 116 175 125 167 125C160 124 160 115 162 111C153 117 159 148 169 151C185 157 195 132 192 111C190 87 182 50 165 50Z" />
      </g>
      <g className="zn-bean-face">
        <path className="zn-bean-eyes-happy" fill="none" stroke="#402019" strokeWidth="9" strokeLinecap="round" d="M59 105Q67 93 75 107M101 111Q110 98 118 114" />
        <g className="zn-bean-eyes-open" fill="#402019">
          <ellipse cx="67" cy="103" rx="7.5" ry="9" />
          <ellipse cx="109" cy="108" rx="7.5" ry="9" />
          <circle cx="69.5" cy="99.5" r="2.4" fill="#fff" />
          <circle cx="111.5" cy="104.5" r="2.4" fill="#fff" />
        </g>
        <path fill="#402019" d="M78 117Q88 137 101 121Z" />
        <ellipse cx="89" cy="117" rx="15" ry="7" transform="rotate(8 89 117)" fill="#FFD064" />
      </g>
      {waves && (
        <g className="zn-bean-waves" fill="none" stroke="#F6A53C" strokeWidth="11" strokeLinecap="round">
          <path className="zn-bean-wave1" d="M208 45Q225 61 220 84" />
          <path className="zn-bean-wave2" d="M224 27Q249 50 242 89" />
          <path className="zn-bean-wave3" d="M240 9Q273 39 264 94" />
        </g>
      )}
    </svg>
  );
}

/** The lowercase zunos lettering from assets/brand/wordmark.svg, drawn as strokes. `draw` animates it in. */
export function Wordmark({ height = 20, className, draw = false }: { height?: number; className?: string; draw?: boolean }) {
  return (
    <svg viewBox="190 50 376 74" height={height} aria-label="zunos" className={cn("overflow-visible", className)}>
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="13"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={draw ? "zn-wordmark-draw" : undefined}
      >
        <path pathLength={1} d="M196 59H246L196 115H246" />
        <path pathLength={1} d="M274 59V92C274 125 323 125 323 92V59" />
        <path pathLength={1} d="M352 115V59M352 82C352 51 402 51 402 82V115" />
        <path pathLength={1} d="M459 57C423 57 423 117 459 117C495 117 495 57 459 57Z" />
        <path pathLength={1} d="M555 63C543 53 514 54 514 72C514 91 558 82 558 102C558 121 528 122 514 112" />
      </g>
    </svg>
  );
}
