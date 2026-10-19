"use dom";

// A still of the mascot for the brand assets (assets/brand/render_icons.py captures #art).
// http://localhost:8090/_expo/@dom/IconLab.tsx?file=file:///Users/barreloflube/voice-data/apps/mac/src/preview/IconLab.tsx&size=400&shading=fabric
import "./shim";
import "@zunos/ui/globals.css";

import { BotAvatar, type BotAvatarShading } from "bot-avatars";
import type { DOMProps } from "expo/dom";

import { MASCOT_COLORS, MASCOT_FABRIC, MASCOT_PATHS } from "../dom/Mascot";

export default function IconLab(_: { dom?: DOMProps }) {
  const q = new URLSearchParams(location.search);
  const size = Number(q.get("size") ?? 400);
  const shading = (q.get("shading") ?? "fabric") as BotAvatarShading;
  const arcs = q.get("arcs") === "1";
  const common = {
    type: "alien" as const,
    size,
    seed: 0.5,
    shading,
    paused: true,
    interactive: false,
    pose: { yaw: Number(q.get("yaw") ?? -0.12), pitch: 0.04, roll: 0 },
    ...(shading === "fabric" ? MASCOT_FABRIC : { saturation: 1.35 }),
    style: { position: "absolute" as const, left: size * 0.25, top: size * 0.25 },
  };
  return (
    <div style={{ background: "transparent", padding: 0 }}>
      <div id="art" style={{ position: "relative", width: size * 1.75, height: size * 1.5 }}>
        <BotAvatar {...common} path={MASCOT_PATHS.ear} color={MASCOT_COLORS.ear} />
        <BotAvatar {...common} path={MASCOT_PATHS.bowl} color={MASCOT_COLORS.bowl} depth={0.4} />
        <BotAvatar {...common} path={MASCOT_PATHS.body} color={MASCOT_COLORS.body} face="mouth" />
        {arcs && (
          <svg viewBox="0 0 100 100" style={{ position: "absolute", left: size * 0.25, top: size * 0.25, width: size, height: size, overflow: "visible" }}>
            {["M104 22Q113 32 110 46", "M111 12Q125 30 119 54"].map((d) => (
              <path key={d} d={d} fill="none" stroke={MASCOT_COLORS.bowl} strokeWidth={4.6} strokeLinecap="round" />
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}
