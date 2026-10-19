// The async "native actions" the DOM screens call. Inputs and outputs are plain JSON.
import Native from "../../modules/zunos-native";
import type { Lang, LiveState, SavedRecording } from "../shared/types";
import * as auth from "./auth";
import { dataDir } from "./db";
import * as engine from "./engine";
import type { Library } from "./library";
import * as training from "./training";

type SetLive = (patch: Partial<LiveState> | ((s: LiveState) => Partial<LiveState>)) => void;

const MIC_BLOCKED =
  "macOS gave zunos pure silence, which means microphone access is off. Open System Settings → Privacy & Security → Microphone and turn on zunos.";

export function createActions(lib: Library, setLive: SetLive) {
  let take: { promptId: string; rec: { id: string; rel: string; path: string }; startedAt: number; marks: number[] } | null = null;
  let loadedModel: string | null = null;

  async function ensureModel() {
    const m = await lib.activeModel();
    if (!m) throw new Error("No model yet. Train one first.");
    if (loadedModel !== m.path) {
      setLive({ engine: "loading", engineError: null });
      await engine.call("load", { model: m.path });
      loadedModel = m.path;
    }
    setLive({ engine: "ready" });
    return m;
  }

  async function installModel(runId: string, url: string) {
    const archive = `${dataDir}/tmp/models/${runId}.tar`;
    const sub = Native.addListener("onTransfer", (e) => {
      if (e.id === runId && e.total > 0) setLive({ transfer: { runId, phase: "downloading", progress: e.done / e.total } });
    });
    try {
      setLive({ transfer: { runId, phase: "downloading", progress: 0 } });
      await Native.downloadFile(runId, url, archive);
      setLive({ transfer: { runId, phase: "installing", progress: 1 } });
      const { path } = await engine.call<{ path: string }>("unpack", { archive, dest: `${dataDir}/models` });
      const run = await lib.run(runId);
      await lib.addModel(runId, path.replace(`${dataDir}/`, ""), run?.evals.at(-1) ? { step: run.bestStep, score: run.bestScore } : null);
    } finally {
      sub.remove();
      setLive({ transfer: null });
      await Native.deleteFile(archive);
    }
  }

  async function beginRecording(path: string) {
    let perm = Native.micPermission();
    if (perm === "undetermined") perm = await Native.requestMicPermission();
    if (perm === "denied") throw new Error(MIC_BLOCKED);
    await Native.startRecording(path);
    setLive({ recording: true, level: 0 });
  }

  async function endRecording() {
    const res = await Native.stopRecording();
    setLive({ recording: false, level: 0 });
    if (res.peak === 0) {
      await Native.deleteFile(res.path);
      throw new Error(MIC_BLOCKED);
    }
    return res;
  }

  return {
    // ---- account
    async sendCode(email: string) {
      return { nonce: await auth.sendCode(email.trim()) };
    },
    async verifyCode(code: string, nonce: string) {
      const user = await auth.verifyCode(code, nonce);
      setLive({ user });
      return user;
    },
    async signOut() {
      await auth.signOut();
      setLive({ user: null });
    },

    // ---- languages and library
    languages: () => lib.languages(),
    async setLanguages(codes: Lang[]) {
      for (const l of await lib.languages()) await lib.setLanguageEnabled(l.code, codes.includes(l.code));
      return lib.languages();
    },
    stats: () => lib.stats(),
    prompts: (lang: Lang) => lib.prompts(lang),

    // ---- recording a prompt
    async startTake(promptId: string) {
      const rec = lib.newRecordingPath(promptId);
      await beginRecording(rec.path);
      take = { promptId, rec, startedAt: Date.now(), marks: [] };
    },
    /** The reader moved past a line. */
    async markLine() {
      if (take) take.marks.push((Date.now() - take.startedAt) / 1000);
    },
    async finishTake(): Promise<SavedRecording> {
      if (!take) throw new Error("Not recording.");
      const t = take;
      take = null;
      const res = await endRecording();
      return lib.saveRecording(t.promptId, t.rec, { seconds: res.seconds, sampleRate: res.sampleRate, marks: [...t.marks, res.seconds] });
    },
    async cancelTake() {
      if (!take) return;
      const res = await Native.stopRecording();
      setLive({ recording: false, level: 0 });
      await Native.deleteFile(res.path);
      take = null;
    },
    deleteRecording: (id: string) => lib.deleteRecording(id),

    // ---- training (cloud GPU through the zunos backend)
    trainingQuote: () => training.quote(),
    runs: () => lib.runs(),
    run: (id: string) => lib.run(id),
    async startTraining(langs: Lang[]) {
      const quote = await training.quote();
      if (!quote.available) throw new Error(quote.reason ?? "No GPU is available within the budget right now.");
      const { id, uploadUrl } = await training.createRun(langs);
      await lib.createRun(id, langs, quote.gpu);
      const archive = `${dataDir}/tmp/datasets/${id}.tar.gz`;
      try {
        setLive({ transfer: { runId: id, phase: "packing", progress: 0 } });
        const data = await lib.trainingDataset(langs);
        await engine.call("pack", { out: archive, langs, ...data, cfg: {} });
        setLive({ transfer: { runId: id, phase: "uploading", progress: 0 } });
        const sub = Native.addListener("onTransfer", (e) => {
          if (e.id === id && e.total > 0) setLive({ transfer: { runId: id, phase: "uploading", progress: e.done / e.total } });
        });
        try {
          await Native.uploadFile(id, uploadUrl, archive, "application/gzip");
        } finally {
          sub.remove();
        }
        setLive({ transfer: { runId: id, phase: "starting", progress: 1 } });
        const remote = await training.startRun(id);
        await lib.updateRun(id, remote);
        return lib.run(id);
      } catch (e) {
        await lib.updateRun(id, { status: "failed", stage: null, costUsd: 0, steps: [], evals: [], error: String((e as Error).message ?? e) });
        throw e;
      } finally {
        setLive({ transfer: null });
        await Native.deleteFile(archive);
      }
    },
    async stopTraining(id: string) {
      await lib.updateRun(id, await training.stopRun(id));
    },
    /** Refresh in-flight cloud runs; downloads and installs finished models. Called on a timer. */
    async syncRuns() {
      for (const r of await lib.activeRuns()) {
        if (r.status === "uploading") continue; // startTraining owns this phase
        const remote = await training.getRun(r.remoteId!);
        await lib.updateRun(r.id, remote);
        if (remote.status === "done" && remote.modelUrl && !(await lib.hasModelForRun(r.id))) await installModel(r.id, remote.modelUrl);
      }
    },

    // ---- testing
    models: () => lib.models(),
    setActiveModel: async (id: string) => {
      await lib.setActiveModel(id);
      loadedModel = null;
    },
    latestEval: (modelId: string) => lib.latestEval(modelId),
    baselines: () => lib.baselines(),
    async evaluate() {
      const m = await ensureModel();
      const clips = await lib.testClips();
      setLive({ engine: "busy", evalProgress: { done: 0, total: clips.length } });
      try {
        const out = await engine.call("eval", { model: m.path, clips, beams: 4 }, (event) => {
          if (event === "clip") setLive((s) => ({ evalProgress: { done: (s.evalProgress?.done ?? 0) + 1, total: clips.length } }));
        });
        await lib.saveEval(m.id, 4, out);
        return lib.latestEval(m.id);
      } finally {
        setLive({ engine: "ready", evalProgress: null });
      }
    },

    // ---- using: dictation
    async prepareDictation() {
      await ensureModel();
    },
    async startDictation() {
      await beginRecording(`${dataDir}/tmp/dictation.wav`);
    },
    async stopDictation() {
      const res = await endRecording();
      setLive({ engine: "busy" });
      try {
        const out = await engine.call<{ text: string; lang: string; seconds: number; elapsed: number }>("transcribe", { path: res.path });
        if (out.text) Native.copyText(out.text);
        return out;
      } finally {
        setLive({ engine: "ready" });
      }
    },
    copyText: async (text: string) => Native.copyText(text),

    // ---- misc
    revealData: async () => Native.revealInFinder(dataDir),
    openURL: async (url: string) => Native.openURL(url),
  };
}

export type Actions = ReturnType<typeof createActions>;
