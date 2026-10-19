import { cn } from "@zunos/ui/lib/utils";

// zunos's own small marks, drawn on lucide's 24px grid with round strokes so they sit with its icons.

type MarkProps = { className?: string; strokeWidth?: number };

const svg = (strokeWidth = 2) => ({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

/** Speech turning into text: voice bars that run into a text cursor. The Dictate screen's mark. */
export function DictateMark({ className, strokeWidth }: MarkProps) {
  return (
    <svg {...svg(strokeWidth)} className={className}>
      <path d="M4 10v4M7.5 7v10M11 9.5v5M14 11v2" />
      <path d="M19 5v14M17 5h4M17 19h4" />
    </svg>
  );
}

/** Cleanup: a line of text with the filler word taken out of it. */
export function TidyMark({ className, strokeWidth }: MarkProps) {
  return (
    <svg {...svg(strokeWidth)} className={className}>
      <path d="M4 6.5h16M4 17.5h10" />
      <path d="M13.5 12H20" />
      <rect x="4" y="9.5" width="6" height="5" rx="2.5" strokeOpacity={0.55} />
      <path d="M3 15.5 11 8.5" />
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
