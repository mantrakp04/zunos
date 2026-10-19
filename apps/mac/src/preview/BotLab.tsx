"use dom";

// Scratch page for the mascot: shading × listening cue, in each state.
// http://localhost:8090/_expo/@dom/BotLab.tsx?file=file:///Users/barreloflube/voice-data/apps/mac/src/preview/BotLab.tsx
import "./shim";
import "@zunos/ui/globals.css";

import type { DOMProps } from "expo/dom";

import { Mascot, type MascotState } from "../dom/Mascot";

const STATES: MascotState[] = ["idle", "listening", "working", "sleeping"];

export default function BotLab(_: { dom?: DOMProps }) {
  const q = new URLSearchParams(location.search);
  const size = Number(q.get("size") ?? 150);
  const only = q.get("state") as MascotState | null;
  return (
    <div className="dark min-h-screen bg-[#1c1513] p-6 text-[#f3e6dc]">
      {(["fabric", "plastic"] as const).flatMap((look) =>
        (["ear", "headphones"] as const).map((wear) => (
          <div key={look + wear} className="mb-3 flex flex-wrap items-end gap-10">
            {(only ? [only] : STATES).map((s) => (
              <div key={s} className="flex flex-col items-center gap-1">
                <Mascot look={look} wear={wear} state={s} level={0.6} size={size} />
                <span className="text-[11px] opacity-60">{look} · {wear} · {s}</span>
              </div>
            ))}
          </div>
        )),
      )}
    </div>
  );
}
