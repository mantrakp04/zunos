import { cn } from "@zunos/ui/lib/utils";
import { BotAvatar, type BotAvatarState } from "bot-avatars";
import { type ComponentProps, type CSSProperties, useEffect, useRef, useState } from "react";

// The zunos mascot: a plush red-orange bean with a big cupped ear, drawn by bot-avatars (a lit,
// inflated 2D-canvas body; no WebGL). The ear and its gold bowl are their own avatars stacked
// behind the body in the same 100×100 box. They share the body's seed, state and settings, so
// their rigs move in lockstep and the three read as one toy. Each outline keeps clear of the face's
// spot (bot-avatars clips the face to the outline), so only the body wears the face.
export type MascotState = "idle" | "listening" | "thinking" | "working" | "happy" | "sleeping" | "waking" | "error";

const BODY = "M42 15C27 15 18 30 13 47C8 64 4 79 8 88C12 96 26 97 43 97C60 97 75 96 79 88C83 79 79 64 74 48C69 30 57 15 42 15Z";
const EAR = "M84 5C96 5 101 18 100 33C99 48 93 62 82 65C74 67 67 61 66 53C65 46 70 41 71 33C72 23 71 5 84 5Z";
const BOWL = "M84 13C91 13 94.5 24 94 34C93.5 44 89 53 82 54.5C77 55.5 74.5 51 75.5 47C76.5 43 78.5 40 78.5 34C78.5 26 77 13 84 13Z";

export const MASCOT_COLORS = { body: "#FF5A36", ear: "#FFE4A1", bowl: "#F6A53C" } as const;
export const MASCOT_PATHS = { body: BODY, ear: EAR, bowl: BOWL } as const;
/** The plush look's settings, shared by every layer. */
export const MASCOT_FABRIC = { brightness: 1.05, saturation: 1.35, lightFront: 50, furLength: 0.6, furFuzz: 0.5 } as const;

type Look = "fabric" | "plastic";

/** How each app state plays on the bot's three states. */
function cue(state: MascotState): { bot: BotAvatarState; turn: number; speed: number } {
  switch (state) {
    case "listening":
      return { bot: "default", turn: 0, speed: 1 }; // attentive: faces you, eyes open
    case "thinking":
    case "working":
      return { bot: "working", turn: 1, speed: 1 };
    case "sleeping":
      return { bot: "sleeping", turn: 1, speed: 1 };
    case "error":
      return { bot: "sleeping", turn: 1, speed: 0.6 };
    case "waking":
      return { bot: "default", turn: 0.3, speed: 0.7 };
    default:
      return { bot: "default", turn: 0.35, speed: 1 };
  }
}

const ARCS = [
  "M104 22Q113 32 110 46",
  "M111 12Q125 30 119 54",
  "M118 2Q137 28 128 62",
];

export function Mascot({
  state = "idle",
  level = 0,
  size = 64,
  look = "fabric",
  wear = "ear",
  className,
  style,
}: {
  state?: MascotState;
  /** Mic level 0..1 while listening: sound arcs leave the ear with it. */
  level?: number;
  size?: number;
  look?: Look;
  /** The listening cue: our own ear, or bot-avatars' headphones. */
  wear?: "ear" | "headphones";
  className?: string;
  style?: CSSProperties;
}) {
  const [seed] = useState(() => Math.random());
  const { bot, turn, speed } = cue(state);
  const body = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // "happy" is one hop, the one a click gives. A click on the body is passed to the ear layers so
  // their rigs make the same hop.
  useEffect(() => {
    if (state === "happy") body.current?.click();
  }, [state]);
  const forward = () => {
    for (const c of box.current?.querySelectorAll<HTMLCanvasElement>("canvas[data-layer]") ?? []) c.click();
  };

  const shared: Partial<ComponentProps<typeof BotAvatar>> = {
    type: "alien",
    size,
    seed,
    state: bot,
    turn,
    speed,
    shading: look,
    jumpEvery: 0,
    jumpSpin: 0,
    ...(look === "fabric"
      ? MASCOT_FABRIC
      : { saturation: 1.6 }),
    style: { position: "absolute", left: 0, top: 0 },
  };
  const lvl = state === "listening" ? Math.max(0, Math.min(1, level)) : 0;
  const arcs = wear === "ear" && size >= 72 && state === "listening";

  return (
    <div
      ref={box}
      className={cn("zn-mascot relative inline-block shrink-0", className)}
      style={{ width: size, height: size, ...style }}
      data-state={state}
      role="img"
      aria-label="zunos"
    >
      {wear === "ear" && (
        <>
          <BotAvatar {...shared} path={EAR} color={MASCOT_COLORS.ear} data-layer="" aria-hidden style={{ ...shared.style, pointerEvents: "none" }} />
          <BotAvatar {...shared} path={BOWL} color={MASCOT_COLORS.bowl} depth={0.4} data-layer="" aria-hidden style={{ ...shared.style, pointerEvents: "none" }} />
        </>
      )}
      <BotAvatar
        {...shared}
        ref={body}
        path={BODY}
        color={MASCOT_COLORS.body}
        face="mouth"
        headphones={wear === "headphones"}
        accessoryColor={MASCOT_COLORS.ear}
        onClick={forward}
        aria-hidden
      />
      {arcs && (
        <svg
          viewBox="0 0 100 100"
          className="pointer-events-none absolute inset-0 overflow-visible"
          style={{ width: size, height: size }}
          aria-hidden
        >
          {ARCS.map((d, i) => (
            <path
              key={d}
              d={d}
              fill="none"
              stroke={MASCOT_COLORS.bowl}
              strokeWidth={4.2}
              strokeLinecap="round"
              style={{
                opacity: Math.max(0, Math.min(1, lvl * 3 - i)) * 0.9,
                transform: `translate(${lvl * (2 + i * 1.5)}px, ${-lvl * (1 + i)}px)`,
                transition: "opacity 120ms linear, transform 120ms linear",
              }}
            />
          ))}
        </svg>
      )}
    </div>
  );
}
