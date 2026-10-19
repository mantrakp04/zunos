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
