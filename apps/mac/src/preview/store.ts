// In-memory stand-in for the native shell: live state, fake data, and mock actions that mutate both
// so flows feel live. Only types come from the app; nothing native is imported.
import type { Actions } from "../services/actions";
import type {
  CleanupState,
  DictationItem,
  DictationResult,
  EngineState,
  LiveState,
  PromptItem,
  RunDetail,
  SavedRecording,
} from "../shared/types";
import { type Data, type DataKind, evalFor, HEARD, inflightRun, makeData, modelFor, rng, statsOf, userFor } from "./fixtures";

/* ---- scenario: what the toolbar controls, mirrored into the URL so reloads keep it ------------- */

export const REMOTE_STAGES = ["starting", "data", "setup", "gen", "filter", "train", "export", "upload"] as const;
export type TransferPhase = NonNullable<LiveState["transfer"]>["phase"];
export type CleanupKind = "none" | CleanupState["status"];

export type Scenario = {
  auth: "in" | "out" | "loading";
  data: DataKind;
  engine: EngineState;
  cleanup: CleanupKind;
  rec: boolean;
  dict: "off" | "listening" | "thinking";
  transfer: "off" | TransferPhase;
  cloud: "off" | (typeof REMOTE_STAGES)[number];
  evalRun: boolean;
  access: boolean;
  slow: boolean;
};

const DEFAULTS: Scenario = {
  auth: "in", data: "full", engine: "ready", cleanup: "ready", rec: false, dict: "off", transfer: "off", cloud: "off",
  evalRun: false, access: true, slow: false,
};

function readUrl(): Scenario {
  const q = new URLSearchParams(location.search);
  const s = { ...DEFAULTS } as Record<string, unknown>;
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const raw = q.get(k);
    if (raw == null) continue;
    s[k] = typeof v === "boolean" ? raw === "1" || raw === "true" : raw;
  }
  return s as Scenario;
}

function writeUrl(sc: Scenario) {
  // Keep the rest of the query (Metro's `file=`) exactly as it was, unencoded.
  const keep = location.search.slice(1).split("&").filter((kv) => kv && !(kv.split("=")[0]! in DEFAULTS));
  const mine = Object.entries(sc)
    .filter(([k, v]) => v !== DEFAULTS[k as keyof Scenario])
    .map(([k, v]) => `${k}=${typeof v === "boolean" ? (v ? "1" : "0") : v}`);
  history.replaceState(null, "", `${location.pathname}?${[...keep, ...mine].join("&")}`);
}

/* ---- state ----------------------------------------------------------------------------------- */

export type PreviewState = {
  live: LiveState;
  scenario: Scenario;
  data: Data;
  /** Bumped when the data set changes so the app remounts and refetches everything. */
  epoch: number;
  log: { name: string; args: string; at: number; failed?: boolean }[];
};

const CLEANUP_BYTES = 2_610_000_000;

function cleanupOf(kind: CleanupKind): CleanupState | null {
  switch (kind) {
    case "none": return null;
    case "absent": return { status: "absent", totalBytes: CLEANUP_BYTES };
    case "downloading": return { status: "downloading", doneBytes: CLEANUP_BYTES * 0.38, totalBytes: CLEANUP_BYTES };
    case "loading": return { status: "loading" };
    case "ready": return { status: "ready" };
    case "error": return { status: "error", message: "Couldn't load the cleanup model: MLX ran out of memory." };
  }
}

function dataFor(sc: Scenario): Data {
  const d = makeData(sc.data);
  if (sc.cloud !== "off") d.runs = [...d.runs, inflightRun(sc.cloud, d.runs.length + 1)];
  return d;
}

function transferRunId(d: Data) {
  const active = d.runs.find((r) => ["uploading", "queued", "running"].includes(r.status));
  return active?.id ?? `r${d.runs.length + 1}`;
}

function liveFor(sc: Scenario, d: Data, prev?: LiveState): LiveState {
  return {
    user: sc.auth === "in" ? userFor(sc.data) : null,
    authReady: sc.auth !== "loading",
    engine: sc.engine,
    engineError: sc.engine === "error" ? "The engine exited (code 1): MPS backend out of memory while loading the model." : null,
    recording: sc.rec || sc.dict === "listening",
    level: 0,
    evalProgress: sc.evalRun ? { done: 0, total: 20 } : null,
    transfer: sc.transfer === "off" ? null : { runId: transferRunId(d), phase: sc.transfer, progress: 0.35 },
    cleanup: cleanupOf(sc.cleanup),
    dictation: sc.dict === "off" ? null : { source: "hotkey", phase: sc.dict },
    access: { trusted: sc.access, hotkey: sc.access },
    dictationsVersion: prev?.dictationsVersion ?? 0,
  };
}

const initialScenario = readUrl();
const initialData = dataFor(initialScenario);
let state: PreviewState = {
  scenario: initialScenario,
  data: initialData,
  live: liveFor(initialScenario, initialData),
  epoch: 0,
  log: [],
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const store = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

function setLive(patch: Partial<LiveState> | ((s: LiveState) => Partial<LiveState>)) {
  const p = typeof patch === "function" ? patch(state.live) : patch;
  state = { ...state, live: { ...state.live, ...p } };
  emit();
}

function setData(fn: (d: Data) => void) {
  const d = structuredClone(state.data);
  fn(d);
  state = { ...state, data: d };
  emit();
}

/** Toolbar entry point: change part of the scenario and apply only what it touches. */
export function setScenario(patch: Partial<Scenario>) {
  const sc = { ...state.scenario, ...patch };
  writeUrl(sc);
  const reseed = "data" in patch || "cloud" in patch || "auth" in patch;
  const data = reseed ? dataFor(sc) : state.data;
  const next = liveFor(sc, data, state.live);
  const live: LiveState = { ...state.live };
  // Only overwrite the live fields the patch is about, so in-flight flows keep their state.
  const fields: Record<keyof Scenario, (keyof LiveState)[]> = {
    auth: ["user", "authReady"], data: [], engine: ["engine", "engineError"], cleanup: ["cleanup"], rec: ["recording", "level"],
    dict: ["dictation", "recording", "level"], transfer: ["transfer"], cloud: [], evalRun: ["evalProgress"],
    access: ["access"], slow: [],
  };
  for (const k of Object.keys(patch) as (keyof Scenario)[]) for (const f of fields[k]) (live as Record<string, unknown>)[f] = next[f];
  state = { ...state, scenario: sc, data, live, epoch: reseed ? state.epoch + 1 : state.epoch };
  emit();
}

export function resetScenario() {
  const sc = { ...DEFAULTS };
  writeUrl(sc);
  const data = dataFor(sc);
  state = { ...state, scenario: sc, data, live: liveFor(sc, data), epoch: state.epoch + 1 };
  emit();
}

/* ---- ticker: mic level, transfer progress, eval progress --------------------------------------- */

const noise = rng(99);
let phase = 0;
let smooth = 0;
// One ticker even across hot reloads of this module.
const g = window as unknown as { __zunosPreviewTicker?: ReturnType<typeof setInterval> };
clearInterval(g.__zunosPreviewTicker);
g.__zunosPreviewTicker = setInterval(() => {
  const L = state.live;
  const patch: Partial<LiveState> = {};
  if (L.recording) {
    // Syllable-ish bursts with pauses: a slow envelope times fast jitter.
    phase += 0.42;
    const env = Math.max(0, Math.sin(phase * 0.55) * 0.6 + Math.sin(phase * 0.17) * 0.5);
    smooth = smooth * 0.5 + (env * (0.55 + noise() * 0.45)) * 0.5;
    patch.level = Math.min(1, smooth);
  }
  if (L.transfer && (L.transfer.phase === "uploading" || L.transfer.phase === "downloading") && !flowOwnsTransfer) {
    const p = L.transfer.progress + 0.008;
    patch.transfer = { ...L.transfer, progress: p > 1 ? 0 : p };
  }
  if (L.evalProgress && !flowOwnsEval) {
    const done = L.evalProgress.done + (noise() < 0.25 ? 1 : 0);
    patch.evalProgress = { ...L.evalProgress, done: done > L.evalProgress.total ? 0 : done };
  }
  if (L.cleanup?.status === "downloading" && !flowOwnsCleanup) {
    const d = L.cleanup.doneBytes + L.cleanup.totalBytes * 0.004;
    patch.cleanup = { ...L.cleanup, doneBytes: d > L.cleanup.totalBytes ? 0 : d };
  }
  if (Object.keys(patch).length) setLive(patch);
}, 62);
let flowOwnsTransfer = false;
let flowOwnsEval = false;
let flowOwnsCleanup = false;

/* ---- mock actions ------------------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const latency = (ms = 220) => sleep(state.scenario.slow ? ms * 6 + 900 : ms);

let take: { promptId: string; startedAt: number } | null = null;
let dictStartedAt = 0;
let heardIndex = 0;

const handlers: Partial<Record<keyof Actions, (...args: never[]) => Promise<unknown>>> = {
  // ---- account
  async sendCode(email: string) {
    await latency(600);
    if (!email.includes("@")) throw new Error("That doesn't look like an email address.");
    return { nonce: "preview-nonce" };
  },
  async verifyCode(code: string) {
    await latency(700);
    if (code === "000000") throw new Error("That code didn't work. Check the latest email and try again.");
    const user = userFor(state.scenario.data);
    setLive({ user });
    state = { ...state, scenario: { ...state.scenario, auth: "in" } };
    writeUrl(state.scenario);
    return user;
  },
  async signOut() {
    await latency();
    setLive({ user: null });
    state = { ...state, scenario: { ...state.scenario, auth: "out" } };
    writeUrl(state.scenario);
  },

  // ---- languages and library
  async languages() {
    await latency(150);
    return state.data.languages;
  },
  async setLanguages(codes: string[]) {
    await latency(400);
    setData((d) => {
      for (const l of d.languages) l.enabled = codes.includes(l.code);
      d.languages.sort((a, b) => Number(b.enabled) - Number(a.enabled));
    });
    return state.data.languages;
  },
  async stats() {
    await latency(150);
    return statsOf(state.data);
  },
  async prompts(lang: string) {
    await latency(180);
    return state.data.prompts.filter((p) => p.lang === lang);
  },
  async createPrompt(lang: string, text: string) {
    await latency(250);
    const lines = text.split(/(?<=[.!?।])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
    const p: PromptItem = { id: `user-${Date.now().toString(36)}`, lang, kind: lines.length > 1 ? "para" : "sentence", title: null, lines, recorded: false };
    setData((d) => void d.prompts.push(p));
    return p;
  },

  // ---- recording a prompt
  async startTake(promptId: string) {
    await latency(250);
    take = { promptId, startedAt: Date.now() };
    setLive({ recording: true, level: 0 });
  },
  async markLine() {},
  async finishTake() {
    if (!take) throw new Error("Not recording.");
    const t = take;
    take = null;
    setLive({ recording: false, level: 0 });
    await latency(700);
    const seconds = Math.max(1.5, (Date.now() - t.startedAt) / 1000);
    const p = state.data.prompts.find((x) => x.id === t.promptId);
    const lines = p?.lines ?? ["(unknown prompt)"];
    const per = seconds / lines.length;
    // Like the app: about one clip in four goes to the held-back test set.
    const offset = Math.floor(Math.random() * 4);
    const clips = lines.map((text, i) => ({
      id: `clip-${Date.now().toString(36)}-${i}`, seconds: per, split: ((i + offset) % 4 === 3 ? "test" : "train") as "train" | "test", text,
    }));
    setData((d) => {
      const pp = d.prompts.find((x) => x.id === t.promptId);
      if (pp) pp.recorded = true;
      const lang = pp?.lang ?? "en";
      const c = (d.clips[lang] ??= { trainSeconds: 0, testSeconds: 0, trainClips: 0, testClips: 0 });
      for (const k of clips) {
        if (k.split === "test") (c.testSeconds += k.seconds), c.testClips++;
        else (c.trainSeconds += k.seconds), c.trainClips++;
      }
    });
    const saved: SavedRecording = { recordingId: `rec-${Date.now().toString(36)}`, seconds, clips };
    return saved;
  },
  async cancelTake() {
    take = null;
    setLive({ recording: false, level: 0 });
  },

  // ---- training
  async trainingQuote() {
    await latency(500);
    return state.data.quote;
  },
  async runs() {
    await latency(200);
    return state.data.runs.map(({ cfg: _c, steps: _s, evals: _e, ...r }) => r);
  },
  async run(id: string) {
    await latency(200);
    return state.data.runs.find((r) => r.id === id) ?? null;
  },
  async startTraining(langs: string[]) {
    const n = state.data.runs.length + 1;
    const id = `r${n}`;
    flowOwnsTransfer = true;
    try {
      setLive({ transfer: { runId: id, phase: "packing", progress: 0 } });
      await sleep(1600);
      for (let p = 0; p <= 1.0001; p += 0.05) {
        setLive({ transfer: { runId: id, phase: "uploading", progress: p } });
        await sleep(120);
      }
      setLive({ transfer: { runId: id, phase: "starting", progress: 1 } });
      await sleep(1200);
      const run = { ...inflightRun("starting", n), cfg: { ...inflightRun("starting", n).cfg, langs } };
      setData((d) => void d.runs.push(run));
    } finally {
      setLive({ transfer: null });
      flowOwnsTransfer = false;
    }
    advanceRun(id);
    return state.data.runs.find((r) => r.id === id) ?? null;
  },
  async stopTraining(id: string) {
    await latency(500);
    setData((d) => {
      const r = d.runs.find((x) => x.id === id);
      if (r) (r.status = "stopped"), (r.stage = null);
    });
  },
  async syncRuns() {},

  // ---- testing
  async models() {
    await latency(150);
    return state.data.models;
  },
  async setActiveModel(id: string) {
    await latency(500);
    const runId = state.data.models.find((m) => m.id === id)?.runId;
    setData((d) => d.models.forEach((m) => (m.active = m.runId === runId)));
    if (state.live.engine === "ready") {
      setLive({ engine: "loading" });
      setTimeout(() => setLive({ engine: "ready" }), 1400);
    }
  },
  async latestEval(modelId: string) {
    await latency(150);
    return state.data.evals[modelId] ?? null;
  },
  async baselines() {
    await latency(150);
    return state.data.baselines;
  },
  async evaluate() {
    const m = state.data.models.find((x) => x.active && x.format === "hf");
    if (!m) throw new Error("No model yet. Train one first.");
    if (state.live.engine === "error") throw new Error(state.live.engineError ?? "The engine isn't running.");
    flowOwnsEval = true;
    const total = 20;
    try {
      setLive({ engine: "busy", evalProgress: { done: 0, total } });
      for (let i = 1; i <= total; i++) {
        await sleep(state.scenario.slow ? 600 : 220);
        setLive({ evalProgress: { done: i, total } });
      }
      const prev = state.data.evals[m.id]?.scores ?? { en: 0.07, hi: 0.14, gu: 0.17 };
      const jig = (x: number) => +(x * (0.94 + Math.random() * 0.1)).toFixed(4);
      const res = evalFor(m.id, { en: jig(prev.en ?? 0.07), hi: jig(prev.hi ?? 0.14), gu: jig(prev.gu ?? 0.17) }, Math.floor(Math.random() * 1000));
      res.createdAt = new Date().toISOString();
      setData((d) => void (d.evals[m.id] = res));
      return res;
    } finally {
      setLive({ engine: "ready", evalProgress: null });
      flowOwnsEval = false;
    }
  },

  // ---- dictation
  async prepareDictation() {
    await latency(200);
    if (state.live.engine === "stopped") {
      setLive({ engine: "starting" });
      await sleep(700);
      setLive({ engine: "loading" });
      await sleep(1100);
      setLive({ engine: "ready" });
    }
    if (!state.live.cleanup) setLive({ cleanup: { status: "absent", totalBytes: CLEANUP_BYTES } });
  },
  async startDictation() {
    if (state.live.engine === "error") throw new Error(state.live.engineError ?? "The engine isn't running.");
    if (!state.data.models.some((m) => m.active)) throw new Error("No model yet. Train one first.");
    await latency(120);
    dictStartedAt = Date.now();
    setLive({ recording: true, level: 0, dictation: { source: "window", phase: "listening" } });
  },
  async stopDictation(): Promise<DictationResult> {
    const seconds = Math.max(0.8, (Date.now() - dictStartedAt) / 1000);
    setLive({ recording: false, level: 0, dictation: { source: "window", phase: "thinking" }, engine: "busy" });
    try {
      await sleep(state.scenario.slow ? 2600 : 900);
      const h = HEARD[heardIndex++ % HEARD.length]!;
      const style = state.data.cleanupSettings.style;
      const cleaned = state.live.cleanup?.status === "ready" && style !== "off";
      const id = `d${Date.now().toString(36)}`;
      const item: DictationItem = {
        id, createdAt: new Date().toISOString(), seconds, lang: h.lang, raw: h.raw, clean: cleaned ? h.clean : null, style: cleaned ? style : null,
        corrected: null, appName: null, status: "ok", error: null, clip: null, hasAudio: true,
      };
      setData((d) => void d.dictations.unshift(item));
      setLive((s) => ({ dictationsVersion: s.dictationsVersion + 1 }));
      return { id, text: h.raw, clean: item.clean, style: item.style, lang: h.lang, seconds, elapsed: 0.84 };
    } finally {
      setLive({ dictation: null, engine: state.live.engine === "busy" ? "ready" : state.live.engine });
    }
  },
  async cancelDictation() {
    setLive({ recording: false, level: 0, dictation: null });
  },
  async dictationSettings() {
    await latency(100);
    return state.data.dictationSettings;
  },
  async setDictationSettings(s: object) {
    await latency(150);
    setData((d) => void Object.assign(d.dictationSettings, s));
    return state.data.dictationSettings;
  },
  async requestAccessibility() {
    await latency(900);
    setLive({ access: { trusted: true, hotkey: state.data.dictationSettings.hotkey !== "off" } });
  },
  async cleanupSettings() {
    await latency(100);
    return state.data.cleanupSettings;
  },
  async setCleanupSettings(s: { style: "off" | "light" | "polished" }) {
    await latency(150);
    setData((d) => void (d.cleanupSettings = s));
  },
  async downloadCleanupModel() {
    if (flowOwnsCleanup) return;
    flowOwnsCleanup = true;
    try {
      for (let f = 0; f <= 1.0001; f += 0.025) {
        setLive({ cleanup: { status: "downloading", doneBytes: CLEANUP_BYTES * f, totalBytes: CLEANUP_BYTES } });
        await sleep(state.scenario.slow ? 250 : 90);
      }
      setLive({ cleanup: { status: "loading" } });
      await sleep(1200);
      setLive({ cleanup: { status: "ready" } });
    } finally {
      flowOwnsCleanup = false;
    }
  },
  async dictations(limit?: number) {
    await latency(150);
    return state.data.dictations.slice(0, limit ?? 200);
  },
  async correctDictation(id: string, text: string) {
    await latency(400);
    setData((d) => {
      const x = d.dictations.find((y) => y.id === id);
      if (x) x.corrected = text.trim() && text.trim() !== x.raw ? text.trim() : null;
    });
    setLive((s) => ({ dictationsVersion: s.dictationsVersion + 1 }));
  },
  async deleteDictation(id: string) {
    await latency(150);
    setData((d) => void (d.dictations = d.dictations.filter((y) => y.id !== id)));
    setLive((s) => ({ dictationsVersion: s.dictationsVersion + 1 }));
  },
  async retryDictation(id: string) {
    await latency(1100);
    const h = HEARD[heardIndex++ % HEARD.length]!;
    setData((d) => {
      const x = d.dictations.find((y) => y.id === id);
      if (x) Object.assign(x, { raw: h.raw, clean: h.clean, lang: h.lang, status: "ok", error: null });
    });
    setLive((s) => ({ dictationsVersion: s.dictationsVersion + 1 }));
  },
  async trainOnDictation(id: string) {
    await latency(400);
    setData((d) => {
      const x = d.dictations.find((y) => y.id === id);
      if (x) x.clip = { id: `clip-${id}`, split: Math.random() < 0.25 ? "test" : "train" };
    });
    setLive((s) => ({ dictationsVersion: s.dictationsVersion + 1 }));
  },
  async copyText(text: string) {
    await navigator.clipboard?.writeText(text).catch(() => {});
  },
};

/** Walks a started run through the remote stages, then brings the model back like syncRuns would. */
async function advanceRun(id: string) {
  const stepMs = () => (state.scenario.slow ? 9000 : 4000);
  const n = Number(id.slice(1));
  for (const stage of REMOTE_STAGES.slice(1)) {
    await sleep(stepMs());
    const r = state.data.runs.find((x) => x.id === id);
    if (!r || r.status !== "running") return;
    const next = inflightRun(stage, n);
    setData((d) => {
      const x = d.runs.find((y) => y.id === id)!;
      Object.assign(x, { stage, steps: next.steps, evals: next.evals, bestStep: next.bestStep, bestScore: next.bestScore, costUsd: next.costUsd });
    });
  }
  await sleep(stepMs());
  flowOwnsTransfer = true;
  try {
    for (let p = 0; p <= 1.0001; p += 0.04) {
      setLive({ transfer: { runId: id, phase: "downloading", progress: p } });
      await sleep(120);
    }
    setLive({ transfer: { runId: id, phase: "installing", progress: 1 } });
    await sleep(1500);
  } finally {
    setLive({ transfer: null });
    flowOwnsTransfer = false;
  }
  setData((d) => {
    const x = d.runs.find((y) => y.id === id) as RunDetail;
    Object.assign(x, { status: "done", stage: "downloaded", costUsd: 1.31 });
    d.models.push(...modelFor(x, false));
  });
}

/* ---- the actions object handed to ZunosApp ------------------------------------------------------ */

// Every action name the app has. Typed as a full Record so `tsc` flags a new action that's missing
// here (the app spreads `...a` from props, so names must be known up front).
const NAMES: Record<keyof Actions, true> = {
  sendCode: true, verifyCode: true, signOut: true, languages: true, setLanguages: true, stats: true, prompts: true, createPrompt: true,
  startTake: true, markLine: true, finishTake: true, cancelTake: true, trainingQuote: true, runs: true, run: true, startTraining: true,
  stopTraining: true, syncRuns: true, models: true, setActiveModel: true, latestEval: true, baselines: true, evaluate: true,
  prepareDictation: true, startDictation: true, stopDictation: true, cancelDictation: true, dictationSettings: true,
  setDictationSettings: true, requestAccessibility: true, cleanupSettings: true, setCleanupSettings: true, downloadCleanupModel: true,
  dictations: true, correctDictation: true, deleteDictation: true, retryDictation: true, trainOnDictation: true, copyText: true,
};

const short = (args: unknown[]) => {
  const s = args.map((a) => (typeof a === "string" ? JSON.stringify(a.length > 24 ? `${a.slice(0, 24)}…` : a) : JSON.stringify(a) ?? String(a))).join(", ");
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

function logCall(name: string, args: unknown[], failed?: boolean) {
  state = { ...state, log: [{ name, args: short(args), at: Date.now(), failed }, ...state.log].slice(0, 30) };
  emit();
}

/** Any name resolves: known names get their fixture handler, the rest an async no-op that logs. */
const proxy = new Proxy(handlers as Record<string, (...a: unknown[]) => Promise<unknown>>, {
  get(target, name) {
    if (typeof name !== "string") return undefined;
    const h = target[name];
    return async (...args: unknown[]) => {
      if (name !== "syncRuns") logCall(name, args);
      if (!h) {
        console.info(`[preview] ${name}(${short(args)}) has no fixture; returning undefined`);
        return undefined;
      }
      try {
        return await h(...args);
      } catch (e) {
        logCall(name, [`✗ ${(e as Error).message}`], true);
        throw e;
      }
    };
  },
});

export const actions = Object.fromEntries(Object.keys(NAMES).map((n) => [n, proxy[n]])) as unknown as Actions;

// For poking at the mock from the browser console: __zunosPreview.store.get(), .setScenario({...}).
(window as unknown as Record<string, unknown>).__zunosPreview = { store, setScenario, resetScenario, actions };
