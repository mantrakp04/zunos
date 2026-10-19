// Client for the local Python engine (python/engine, `zunos-engine`): JSON lines over stdio.
import Native from "../../modules/zunos-native";
import { config } from "../config";
import { dataDir } from "./db";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onEvent?: (event: string, data: any) => void };

export class EngineError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

let nextId = 1;
const pending = new Map<number, Pending>();
let ready: Promise<void> | null = null;
let markReady: (() => void) | null = null;
const listeners = new Set<(state: "ready" | "exited", info?: string) => void>();
let lastLog = "";

Native.addListener("onEngineLine", ({ line }) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.event === "ready" && msg.id == null) {
    markReady?.();
    listeners.forEach((l) => l("ready"));
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  if (msg.event) return p.onEvent?.(msg.event, msg.data);
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new EngineError(msg.error, msg.code));
});

Native.addListener("onEngineLog", ({ text }) => {
  lastLog = (lastLog + text).slice(-4000);
});

Native.addListener("onEngineExit", ({ code }) => {
  ready = null;
  const err = new EngineError(`The speech engine stopped (exit ${code}). ${lastLog.split("\n").filter(Boolean).slice(-3).join(" ")}`, "exited");
  pending.forEach((p) => p.reject(err));
  pending.clear();
  listeners.forEach((l) => l("exited", err.message));
});

export function onEngineState(fn: (state: "ready" | "exited", info?: string) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Command that starts the engine. Development uses the repo's uv workspace. */
function engineCommand() {
  if (config.repoRoot) return { command: `uv run --project "${config.repoRoot}/python" zunos-engine`, cwd: `${config.repoRoot}/python` };
  // Packaged app: the engine source and a uv binary ship in the app bundle (see apps/mac/scripts/bundle-engine).
  return { command: `"${dataDir}/engine/bin/uv" run --project "${dataDir}/engine/python" zunos-engine`, cwd: `${dataDir}/engine/python` };
}

export function startEngine() {
  if (ready && Native.engineRunning()) return ready;
  if (Native.engineRunning()) {
    // The JS side reloaded while the engine process kept running: it already sent its ready event.
    ready = Promise.resolve();
    queueMicrotask(() => listeners.forEach((l) => l("ready")));
    return ready;
  }
  ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    const { command, cwd } = engineCommand();
    Native.startEngine(command, cwd, { PYTHONUNBUFFERED: "1", TOKENIZERS_PARALLELISM: "false" }).catch(reject);
    // First start syncs the Python environment, which can take minutes on a new machine.
    setTimeout(() => reject(new EngineError("The speech engine did not start in time.", "timeout")), 20 * 60_000);
  });
  return ready;
}

export async function call<T = any>(cmd: string, args: Record<string, unknown> = {}, onEvent?: Pending["onEvent"]): Promise<T> {
  await startEngine();
  const id = nextId++;
  const result = new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject, onEvent }));
  await Native.sendEngine(JSON.stringify({ id, cmd, ...args }));
  return result;
}

export const stopEngine = () => Native.stopEngine();
