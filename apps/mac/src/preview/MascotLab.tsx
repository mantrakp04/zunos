"use dom";

// Scratch page for the 3D mascot: every state at rail size and large, plus a mic level slider.
// http://localhost:8090/_expo/@dom/MascotLab.tsx?file=file:///Users/barreloflube/voice-data/apps/mac/src/preview/MascotLab.tsx
import "./shim";
import "@zunos/ui/globals.css";
import "../dom/zunos.css";

import type { DOMProps } from "expo/dom";
import { useEffect, useState } from "react";

import { Mascot3D, type MascotState } from "../dom/Mascot3D";

const STATES: MascotState[] = ["sleeping", "waking", "awake", "listening", "thinking", "working", "error"];

export default function MascotLab(_: { dom?: DOMProps }) {
  const q = new URLSearchParams(location.search);
  const [level, setLevel] = useState(Number(q.get("level") ?? 0.5));
  const [auto, setAuto] = useState(q.get("auto") === "1");
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => setT((x) => x + 0.08), 80);
    return () => clearInterval(id);
  }, [auto]);
  const lvl = auto ? 0.5 + 0.5 * Math.sin(t * 5) * Math.sin(t * 1.3) : level;
  const only = q.get("state") as MascotState | null;
  const big = Number(q.get("big") ?? 160);
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mb-4 flex items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          level <input type="range" min={0} max={1} step={0.01} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> fake mic
        </label>
      </div>
      <div className="flex flex-wrap gap-6">
        {(only ? [only] : STATES).map((s) => (
          <div key={s} className="flex flex-col items-center gap-2 rounded-xl border border-border p-3">
            {/* &big=34 shows every state at rail size. */}
            <Mascot3D state={s} level={lvl} size={big} />
            {/* Browsers cap WebGL contexts (~16), so small sizes only render for one state at a time. */}
            {only && (
              <div className="flex items-end gap-3">
                <Mascot3D state={s} level={lvl} size={40} />
                <Mascot3D state={s} level={lvl} size={28} />
              </div>
            )}
            <span className="text-xs text-muted-foreground">{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
