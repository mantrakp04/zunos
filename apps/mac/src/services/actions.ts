// The async "native actions" the DOM screens call. Inputs and outputs are plain JSON.
import Native, { type RecordingResult } from "../../modules/zunos-native";
import type { Lang, LiveState, SavedRecording, Script } from "../shared/types";
import * as auth from "./auth";
import { dataDir } from "./db";
import { createDictation, errorText } from "./dictation";
import * as engine from "./engine";
import type { Library } from "./library";
import { checkRoom, createMicMonitor, prefetchCleaningModels } from "./mic";
import { deviceInfo, ROOM_SECONDS } from "./quality";
import * as training from "./training";

export type SetLive = (patch: Partial<LiveState> | ((s: LiveState) => Partial<LiveState>)) => void;

// Saving cleans the take and cuts it into clips; past this the screen stops waiting (the take is kept either way).
const SAVE_TIMEOUT_MS = 3 * 60_000;
const SAVE_SLOW = "Saving this take is taking too long. It's kept and may still finish in the background; if it doesn't get clips, retry it.";

const MIC_BLOCKED =
  "macOS gave zunos pure silence, which means microphone access is off. Open System Settings → Privacy & Security → Microphone and turn on zunos.";

/** The DOM-facing actions, plus the dictation controller app.ts starts at launch. */
export function createActions(lib: Library, setLive: SetLive) {
  // marks[i]: the second the reader moved past line i (null: that call never arrived; segment.py places it).
  let take: { promptId: string; script: Script; rec: { id: string; rel: string; path: string }; startedAt: number; marks: (number | null)[] } | null = null;
  // The take being saved: a second finish (Return pressed twice) waits for it instead of failing.
  let finishing: Promise<SavedRecording> | null = null;
  const mic = createMicMonitor(setLive);
  let loadedModel: string | null = null;
  // One model load at a time: callers that arrive mid-load wait for it instead of loading again.
  let loading: Promise<void> | null = null;

  async function load(path: string) {
    await engine.startEngine();
    setLive({ engine: "loading", engineError: null });
    try {
      await engine.call("load", { model: path });
      loadedModel = path;
      setLive({ engine: "ready" });
    } catch (e) {
      setLive({ engine: "error", engineError: errorText(e) });
      throw e;
    }
  }

  async function ensureModel() {
    const m = await lib.activeModel();
    if (!m) throw new Error("No model yet. Train one first.");
    while (loadedModel !== m.path) {
      loading ??= load(m.path).finally(() => (loading = null));
      await loading;
    }
    return m;
  }

  // A restarted engine has nothing loaded.
  engine.onEngineState((state) => {
    if (state === "exited") loadedModel = null;
  });

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

  async function ensurePermission() {
    let perm = Native.micPermission();
    if (perm === "undetermined") perm = await Native.requestMicPermission();
    if (perm === "denied") throw new Error(MIC_BLOCKED);
  }

  /** watch: show live checks (prompt takes and the room check); roomSeconds of quiet room tone come first. */
  async function beginRecording(path: string, watch?: { phase: "room" | "recording"; roomSeconds: number }) {
    await ensurePermission();
    const started = await Native.startRecording(path, watch?.roomSeconds ?? 0);
    setLive({ recording: true, level: 0 });
    if (watch) mic.start(watch.phase, deviceInfo(started.device), watch.roomSeconds);
  }

  /** Stops the microphone; the live state says "not recording" whatever happens. */
  async function stopRecorder(): Promise<RecordingResult> {
    try {
      return await Native.stopRecording();
    } finally {
      mic.stop();
      setLive({ recording: false, level: 0 });
    }
  }

  async function endRecording(): Promise<RecordingResult> {
    const res = await stopRecorder();
    if (res.peak === 0) {
      await Native.deleteFile(res.path);
      throw new Error(MIC_BLOCKED);
    }
    return res;
  }

  /** The microphone, shared by prompt takes and dictation (one at a time). */
  const recorder = {
    busy: () => take !== null,
    begin: (path: string) => beginRecording(path),
    end: endRecording,
    /** Stops without keeping anything. */
    async cancel() {
      const res = await stopRecorder();
      if (res.path) await Native.deleteFile(res.path);
    },
  };

  const dictation = createDictation({ lib, setLive, ensureModel, recorder });

  const actions = {
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
    createPrompt: (lang: Lang, text: string) => lib.createPrompt(lang, text),
    /** Read (and train) a language in its own script or in English letters; returns the updated language. */
    setLanguageScript: (lang: Lang, script: Script) => lib.setLanguageScript(lang, script),

    // ---- recording a prompt
    /** The microphone that would record now, and what's wrong with it before the user starts. */
    micInfo: async () => mic.info(),
    /**
     * Listens to the room for `seconds` with the user quiet: noise floor, hum, rumble and the device. The
     * Record screen can run it before the first take; every take also starts with ROOM_SECONDS of quiet.
     */
    async checkRoom(seconds = 3) {
      if (take) throw new Error("Already recording.");
      return checkRoom(seconds, { begin: (path) => beginRecording(path, { phase: "room", roomSeconds: seconds }), end: endRecording });
    },
    /** Starts a take. The first ROOM_SECONDS are room tone: the screen should ask for quiet until mic.roomTone is false. */
    async startTake(promptId: string) {
      const rec = lib.newRecordingPath(promptId);
      const script = await lib.takeScript(promptId);
      await beginRecording(rec.path, { phase: "recording", roomSeconds: ROOM_SECONDS });
      prefetchCleaningModels();
      take = { promptId, script, rec, startedAt: Date.now(), marks: [] };
    },
    /**
     * The reader moved past a line. Pass `line`, the index of the line just read, so a lost or repeated
     * call can't shift the lines after it (the first mark for a line wins).
     */
    async markLine(line?: number) {
      if (!take) return;
      const t = (Date.now() - take.startedAt) / 1000;
      if (typeof line !== "number" || !Number.isInteger(line) || line < 0) return void take.marks.push(t);
      while (take.marks.length < line) take.marks.push(null);
      if (take.marks.length === line) take.marks.push(t);
    },
    /**
     * Stops and saves the take; the end of the audio is the end of the line being read. Pass `line`, the
     * line the reader is on: it and every line before it count as read, later ones are dropped. If cutting
     * the take into clips fails, the take is kept and the error says so (retry with resegmentRecording).
     */
    async finishTake(line?: number): Promise<SavedRecording> {
      if (finishing) return finishing;
      if (!take) throw new Error("Not recording.");
      const t = take;
      take = null;
      const read = typeof line === "number" && Number.isInteger(line) && line >= 0 ? line + 1 : undefined;
      finishing = (async () => {
        // The microphone stops first, whatever happens after: a hung save must never leave it recording.
        const res = await endRecording();
        try {
          const save = lib.saveRecording(t.promptId, t.rec, {
            seconds: res.seconds, sampleRate: res.sampleRate, marks: [...t.marks, res.seconds], read, script: t.script,
            room: ROOM_SECONDS, device: deviceInfo(res.device), deviceChanged: res.deviceChanged, stats: res.stats,
          }, (p) => setLive({ takeProcessing: p }));
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(SAVE_SLOW)), SAVE_TIMEOUT_MS);
          });
          save.catch(() => {}); // after a timeout it may still fail on its own; the retry covers that
          return await Promise.race([save, late]).finally(() => clearTimeout(timer));
        } finally {
          setLive({ takeProcessing: null });
        }
      })().finally(() => (finishing = null));
      return finishing;
    },
    /** Cuts a kept take into clips again (one whose cutting failed), the same way finishing it does. */
    resegmentRecording: (id: string) => lib.resegmentRecording(id),
    /** Takes that were kept but have no clips (their cutting failed): retry each with resegmentRecording. */
    unsegmentedRecordings: () => lib.unsegmentedRecordings(),
    async cancelTake() {
      if (finishing) return void (await finishing.catch(() => {})); // already stopped and saving: keep it
      if (!take) return;
      take = null;
      await recorder.cancel();
    },

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
        // The script each language's model learns to write: the one the user reads it in.
        const scripts = Object.fromEntries((await lib.languages()).filter((l) => langs.includes(l.code)).map((l) => [l.code, l.script]));
        await engine.call("pack", { out: archive, langs, ...data, cfg: { scripts } });
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

    // ---- using: dictation, cleanup and history (dictation.ts)
    ...dictation.actions,
    copyText: async (text: string) => Native.copyText(text),
  };

  return { actions, dictation };
}

export type Actions = ReturnType<typeof createActions>["actions"];
