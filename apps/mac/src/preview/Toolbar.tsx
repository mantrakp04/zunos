// The harness's floating scenario switcher. Only exists in the preview, never in ZunosApp.
import { type ReactNode, useEffect, useState } from "react";

import { type PreviewState, REMOTE_STAGES, resetScenario, type Scenario, setScenario } from "./store";

const OPEN_KEY = "zunos.preview.toolbar";

// Buttons never take focus, so Space and Return keep reaching the screen under the toolbar.
const noFocus = (e: React.MouseEvent) => e.preventDefault();

function Seg<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-0.5 rounded-md bg-white/[0.06] p-0.5">
      {options.map((o) => (
        <button
          key={o}
          onMouseDown={noFocus}
          onClick={() => onChange(o)}
          className={`rounded-[5px] px-1.5 py-0.5 text-[11px] leading-4 transition-colors ${
            o === value ? "bg-white text-black" : "text-white/70 hover:bg-white/10 hover:text-white"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function Pick<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => {
        onChange(e.target.value as T);
        e.target.blur();
      }}
      className="h-6 w-full rounded-md border-0 bg-white/[0.08] px-1.5 text-[11px] text-white outline-none"
    >
      {options.map((o) => (
        <option key={o} value={o} className="text-black">
          {o}
        </option>
      ))}
    </select>
  );
}

function Toggle({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button
      onMouseDown={noFocus}
      onClick={() => onChange(!on)}
      className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] leading-4 ${on ? "bg-white text-black" : "bg-white/[0.06] text-white/70 hover:text-white"}`}
    >
      <span className={`size-1.5 rounded-full ${on ? "bg-[#f34a2d]" : "bg-white/30"}`} />
      {children}
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[64px_1fr] items-center gap-2">
      <span className="text-[10px] font-semibold tracking-[0.08em] text-white/45 uppercase">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Toolbar({ state }: { state: PreviewState }) {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  useEffect(() => localStorage.setItem(OPEN_KEY, open ? "1" : "0"), [open]);
  const { scenario: sc, live } = state;
  const set = (p: Partial<Scenario>) => setScenario(p);

  // Show live values where flows change them (a take turns recording on, dictation moves phases).
  const dict = live.dictation?.phase ?? "off";
  const transfer = live.transfer?.phase ?? "off";
  const cleanup = live.cleanup?.status ?? "none";

  if (!open)
    return (
      <button
        onMouseDown={noFocus}
        onClick={() => setOpen(true)}
        title="Preview scenarios"
        className="fixed right-3 bottom-3 z-[2147483647] flex h-7 items-center gap-1.5 rounded-full bg-black/80 px-2.5 text-[11px] font-medium text-white shadow-[0_4px_14px_-4px_rgb(0_0_0/0.5),0_0_0_1px_rgb(255_255_255/0.14)] backdrop-blur-md"
      >
        <span className={`size-1.5 rounded-full ${live.recording ? "animate-pulse bg-[#f34a2d]" : "bg-emerald-400"}`} />
        Preview
      </button>
    );

  return (
    <div className="fixed right-3 bottom-3 z-[2147483647] w-[292px] rounded-xl bg-[#141110]/90 p-2.5 font-sans text-white shadow-[0_12px_40px_-8px_rgb(0_0_0/0.6),0_0_0_1px_rgb(255_255_255/0.08)] backdrop-blur-xl select-none">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11.5px] font-semibold">Preview</span>
        <span className="text-[10.5px] text-white/40">mock native shell</span>
        <button onMouseDown={noFocus} onClick={resetScenario} className="ml-auto rounded px-1.5 text-[10.5px] text-white/50 hover:bg-white/10 hover:text-white">
          Reset
        </button>
        <button onMouseDown={noFocus} onClick={() => setOpen(false)} title="Collapse" className="grid size-5 place-items-center rounded text-white/50 hover:bg-white/10 hover:text-white">
          ▾
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <Row label="Account">
          <Seg value={live.authReady ? (live.user ? "in" : "out") : "loading"} options={["in", "out", "loading"] as const} onChange={(auth) => set({ auth })} />
        </Row>
        <Row label="Data">
          <Seg value={sc.data} options={["full", "fresh", "onboarding", "stress"] as const} onChange={(data) => set({ data })} />
        </Row>
        <Row label="Engine">
          <Pick value={live.engine} options={["stopped", "starting", "loading", "ready", "busy", "error"] as const} onChange={(engine) => set({ engine })} />
        </Row>
        <Row label="Cleanup">
          <Pick value={cleanup} options={["none", "absent", "downloading", "loading", "ready", "error"] as const} onChange={(c) => set({ cleanup: c })} />
        </Row>
        <Row label="Mic">
          <div className="flex items-center gap-2">
            <Toggle on={live.recording} onChange={(rec) => set({ rec })}>
              recording
            </Toggle>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-[#f34a2d] transition-[width] duration-75" style={{ width: `${Math.round(live.level * 100)}%` }} />
            </div>
          </div>
        </Row>
        <Row label="Dictation">
          <Seg value={dict} options={["off", "listening", "thinking"] as const} onChange={(d) => set({ dict: d })} />
        </Row>
        <Row label="Transfer">
          <div className="flex items-center gap-2">
            <Pick value={transfer} options={["off", "packing", "uploading", "starting", "downloading", "installing"] as const} onChange={(t) => set({ transfer: t })} />
            {live.transfer && <span className="w-8 shrink-0 text-right text-[10.5px] text-white/50 tabular-nums">{Math.round(live.transfer.progress * 100)}%</span>}
          </div>
        </Row>
        <Row label="Cloud run">
          <Pick value={sc.cloud} options={["off", ...REMOTE_STAGES] as const} onChange={(cloud) => set({ cloud })} />
        </Row>
        <Row label="Flags">
          <div className="flex flex-wrap gap-1">
            <Toggle on={!!live.evalProgress} onChange={(evalRun) => set({ evalRun })}>
              test running
            </Toggle>
            <Toggle on={live.access.trusted} onChange={(access) => set({ access })}>
              accessibility
            </Toggle>
            <Toggle on={sc.slow} onChange={(slow) => set({ slow })}>
              slow
            </Toggle>
          </div>
        </Row>
      </div>

      <div className="mt-2 border-t border-white/10 pt-1.5">
        <div className="mb-0.5 text-[10px] font-semibold tracking-[0.08em] text-white/45 uppercase">Actions</div>
        <div className="flex h-[46px] flex-col gap-px overflow-hidden font-mono text-[10px] leading-[15px]">
          {state.log.length === 0 && <span className="text-white/30">none yet</span>}
          {state.log.slice(0, 3).map((l, i) => (
            <span key={l.at + l.name + i} className={`truncate ${l.failed ? "text-[#ff8a73]" : i === 0 ? "text-white/85" : "text-white/45"}`}>
              {l.name}({l.args})
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
