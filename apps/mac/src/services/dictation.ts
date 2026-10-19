// Dictation, from the Dictate screen or system-wide with the push-to-talk hotkey (a floating recorder,
// then the text is pasted into the app that was in front). Also transcript cleanup with the local LLM,
// the dictation history, and corrected dictations becoming training clips.
import Native from "../../modules/zunos-native";
import type {
  CleanupSettings, CleanupStyle, DictationItem, DictationResult, DictationSettings, Lang, LiveState,
} from "../shared/types";
import { abs, dataDir } from "./db";
import * as engine from "./engine";
import type { Library } from "./library";

type SetLive = (patch: Partial<LiveState> | ((s: LiveState) => Partial<LiveState>)) => void;

type Deps = {
  lib: Library;
  setLive: SetLive;
  ensureModel: () => Promise<{ id: string; path: string }>;
  /** The shared microphone (also used for prompt takes). */
  recorder: {
    busy: () => boolean;
    begin: (path: string) => Promise<void>;
    end: () => Promise<{ path: string; seconds: number; sampleRate: number }>;
    cancel: () => Promise<void>;
  };
};

const CLEANUP_DIR = `${dataDir}/models/cleanup`;
const ZUNOS_BUNDLE = "com.zunos.app";
const DEFAULTS: DictationSettings = { hotkey: "rightOption", mode: "hybrid", paste: true, restoreClipboard: true };
// A press held longer than this is push-to-talk; a shorter one is a tap that toggles recording.
const HOLD_MS = 300;
// Hotkey recordings shorter than this are accidental presses and are dropped.
const MIN_SECONDS = 0.5;
// Whisper's window is 30 s; a training clip must fit it with its exact text.
const MAX_CLIP_SECONDS = 28;
const MAX_HINTS = 40;

type Hint = { heard: string; meant: string; count: number };

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createDictation({ lib, setLive, ensureModel, recorder }: Deps) {
  const bump = () => setLive((s) => ({ dictationsVersion: s.dictationsVersion + 1 }));

  // ---- transcript cleanup (a small local LLM in the engine)
  const cleanup = { checked: false, here: false, loaded: false, downloading: false };

  async function cleanupSettings(): Promise<CleanupSettings> {
    return { style: "light", ...(await lib.setting<CleanupSettings>("cleanup")) };
  }

  async function loadCleanup() {
    if (!cleanup.loaded) {
      setLive({ cleanup: { status: "loading" } });
      await engine.call("cleanup_load", { dir: CLEANUP_DIR });
      cleanup.loaded = true;
    }
    setLive({ cleanup: { status: "ready" } });
  }

  async function checkCleanup() {
    cleanup.checked = true;
    const st = await engine.call<{ downloaded: boolean; totalBytes: number | null }>("cleanup_status", { dir: CLEANUP_DIR });
    cleanup.here = st.downloaded;
    if (!st.downloaded) return setLive({ cleanup: { status: "absent", totalBytes: st.totalBytes ?? 0 } });
    if ((await cleanupSettings()).style === "off") return setLive({ cleanup: { status: "ready" } });
    await loadCleanup();
  }

  async function hints(): Promise<[string, string][]> {
    return ((await lib.setting<Hint[]>("cleanup_hints")) ?? []).map((h) => [h.heard, h.meant]);
  }

  /** The cleaned version of `text`, or nulls when cleanup is off, not ready, or its output was rejected. */
  async function clean(text: string): Promise<{ clean: string | null; style: CleanupStyle | null }> {
    const { style } = await cleanupSettings();
    if (!text || style === "off" || !cleanup.loaded) return { clean: null, style: null };
    // A failed cleanup still leaves the raw transcript, which is the useful part.
    const c = await engine.call<{ text: string; used: boolean }>("cleanup", { text, style, hints: await hints() }).catch(() => null);
    return c?.used ? { clean: c.text, style } : { clean: null, style: null };
  }

  async function transcribe(path: string) {
    const model = await ensureModel();
    setLive({ engine: "busy" });
    try {
      const out = await engine.call<{ text: string; lang: string; seconds: number; elapsed: number }>("transcribe", { path });
      return { ...out, ...(await clean(out.text)), modelId: model.id };
    } finally {
      setLive({ engine: "ready" });
    }
  }

  /** Loads Whisper and the cleanup model ahead of time, so the first dictation is quick. */
  async function warm() {
    await ensureModel();
    if (!cleanup.checked) await checkCleanup().catch((e) => setLive({ cleanup: { status: "error", message: errorText(e) } }));
  }

  // ---- a dictation session
  type Session = {
    id: string; rel: string; path: string; source: "window" | "hotkey";
    app: { bundleId: string; name: string } | null; started: Promise<void>;
  };
  let session: Session | null = null;

  async function begin(source: Session["source"]) {
    if (session) throw new Error("Already dictating.");
    if (recorder.busy()) throw new Error("Finish the recording on the Record screen first.");
    const front = Native.frontmostApp();
    const d = lib.newDictation();
    const s: Session = {
      ...d, source, app: front && front.bundleId !== ZUNOS_BUNDLE ? front : null, started: recorder.begin(d.path),
    };
    session = s;
    setLive({ dictation: { source, phase: "listening" } });
    if (source === "hotkey") {
      Native.overlay("listening");
      Native.setHotkeyActive(true);
    }
    warm().catch(() => {});
    return s.started.catch((e) => {
      session = null;
      setLive({ dictation: null });
      if (source === "hotkey") Native.overlay("error", errorText(e));
      throw e;
    });
  }

  async function cancel() {
    const s = session;
    if (!s) return;
    session = null;
    Native.setHotkeyActive(false);
    Native.overlay("hidden");
    setLive({ dictation: null });
    await s.started.catch(() => {});
    await recorder.cancel();
  }

  async function finish(): Promise<DictationResult | null> {
    const s = session;
    if (!s) throw new Error("Not dictating.");
    session = null;
    const hotkey = s.source === "hotkey";
    Native.setHotkeyActive(false);
    try {
      await s.started;
      const rec = await recorder.end();
      if (hotkey && rec.seconds < MIN_SECONDS) {
        await Native.deleteFile(rec.path);
        Native.overlay("hidden");
        return null;
      }
      setLive({ dictation: { source: s.source, phase: "thinking" } });
      if (hotkey) Native.overlay("thinking");
      await lib.addDictation({
        id: s.id, audio: s.rel, sampleRate: rec.sampleRate, seconds: rec.seconds, app: s.app?.bundleId ?? null, appName: s.app?.name ?? null,
      });
      bump();
      try {
        const out = await transcribe(rec.path);
        await lib.updateDictation(s.id, { raw: out.text, lang: out.lang, clean: out.clean, style: out.style, modelId: out.modelId, elapsed: out.elapsed });
        await deliver(out.clean ?? out.text, s);
        return { id: s.id, text: out.text, clean: out.clean, style: out.style, lang: out.lang, seconds: out.seconds, elapsed: out.elapsed };
      } catch (e) {
        await lib.updateDictation(s.id, { status: "failed", error: errorText(e) });
        throw e;
      }
    } catch (e) {
      if (hotkey) Native.overlay("error", errorText(e));
      throw e;
    } finally {
      setLive({ dictation: null });
      bump();
    }
  }

  /** Pastes into the app the dictation started in, or copies when there's none (or zunos was in front). */
  async function deliver(text: string, s: Session) {
    const hotkey = s.source === "hotkey";
    if (!text) {
      if (hotkey) Native.overlay("error", "Didn't catch anything.");
      return;
    }
    if (hotkey && settings.paste && s.app) {
      if (await Native.pasteText(text, settings.restoreClipboard)) return Native.overlay("done", "Pasted");
      Native.copyText(text);
      return Native.overlay("error", "Allow zunos in Accessibility to paste. The text is on your clipboard.");
    }
    Native.copyText(text);
    if (hotkey) Native.overlay("done", "Copied");
  }

  // ---- the push-to-talk hotkey
  let settings = DEFAULTS;
  let downAt = 0;
  let trustPoll: ReturnType<typeof setInterval> | null = null;

  function onHotkey(type: "down" | "up" | "cancel") {
    if (type === "cancel") return void cancel().catch(() => {});
    if (type === "down") {
      downAt = Date.now();
      // A press while recording stops it (a tap after a tap, or the Dictate screen's recording).
      if (session) return void (settings.mode !== "hold" && finish().catch(() => {}));
      if (recorder.busy()) return void Native.overlay("error", "Finish the recording on the Record screen first.");
      return void begin("hotkey").catch(() => {});
    }
    if (session?.source !== "hotkey") return;
    const held = Date.now() - downAt;
    if (settings.mode === "hold" || (settings.mode === "hybrid" && held >= HOLD_MS)) finish().catch(() => {});
  }

  /** (Re)starts the hotkey for the current settings; polls for Accessibility until it's granted. */
  async function applyHotkey() {
    const trusted = Native.accessibilityTrusted();
    let on = false;
    await Native.stopHotkey();
    if (settings.hotkey !== "off" && trusted) on = await Native.startHotkey(settings.hotkey);
    setLive({ access: { trusted, hotkey: on } });
    if (!trusted && settings.hotkey !== "off" && !trustPoll) {
      trustPoll = setInterval(() => {
        if (!Native.accessibilityTrusted()) return;
        clearInterval(trustPoll!);
        trustPoll = null;
        applyHotkey();
      }, 2000);
    }
  }

  async function bestText(id: string) {
    const d = await lib.dictation(id);
    return d ? d.clean ?? d.corrected ?? d.raw : null;
  }

  /** Hooks up the hotkey and the menu-bar item, and warms the models. Called once at launch. */
  async function start() {
    settings = { ...DEFAULTS, ...(await lib.setting<Partial<DictationSettings>>("dictation")) };
    // A restarted engine has no cleanup model loaded.
    engine.onEngineState((state) => {
      if (state === "exited") cleanup.checked = cleanup.loaded = false;
    });
    Native.addListener("onHotkey", ({ type }) => onHotkey(type));
    Native.addListener("onMenu", async ({ action }) => {
      if (action !== "pasteLast") return;
      const [last] = await lib.dictations(1);
      const text = last && (await bestText(last.id));
      if (text) Native.pasteText(text, settings.restoreClipboard);
    });
    await applyHotkey();
  }

  return {
    start,
    warm,
    actions: {
      // ---- dictating from the Dictate screen
      async prepareDictation() {
        await warm();
      },
      async startDictation() {
        await begin("window");
      },
      /** Transcribes, cleans up when cleanup is on, saves to history and copies the cleaned (or raw) text. */
      async stopDictation(): Promise<DictationResult> {
        return (await finish())!;
      },
      async cancelDictation() {
        await cancel();
      },

      // ---- system-wide dictation
      async dictationSettings(): Promise<DictationSettings> {
        return settings;
      },
      async setDictationSettings(s: Partial<DictationSettings>) {
        settings = { ...settings, ...s };
        await lib.setSetting("dictation", settings);
        await applyHotkey();
        return settings;
      },
      /** Opens the system prompt for Accessibility; the hotkey starts as soon as it's granted. */
      async requestAccessibility() {
        Native.requestAccessibility();
        await applyHotkey();
      },

      // ---- transcript cleanup
      cleanupSettings,
      async setCleanupSettings(s: CleanupSettings) {
        await lib.setSetting("cleanup", s);
        if (s.style !== "off" && cleanup.here && !cleanup.loaded)
          await loadCleanup().catch((e) => setLive({ cleanup: { status: "error", message: errorText(e) } }));
      },
      /** Downloads the cleanup model if it isn't here yet, then loads it. Also the retry after an error. */
      async downloadCleanupModel() {
        if (cleanup.downloading) return;
        try {
          if (!cleanup.here) {
            cleanup.downloading = true;
            setLive({ cleanup: { status: "downloading", doneBytes: 0, totalBytes: 0 } });
            await engine.call("cleanup_download", { dir: CLEANUP_DIR }, (event, d) => {
              if (event === "progress") setLive({ cleanup: { status: "downloading", doneBytes: d.done, totalBytes: d.total } });
            });
            cleanup.here = true;
          }
          if ((await cleanupSettings()).style === "off") setLive({ cleanup: { status: "ready" } });
          else await loadCleanup();
        } catch (e) {
          setLive({ cleanup: { status: "error", message: errorText(e) } });
        } finally {
          cleanup.downloading = false;
        }
      },

      // ---- history
      dictations: (limit?: number): Promise<DictationItem[]> => lib.dictations(limit),
      /**
       * Saves the user's fix of what was said. The fix teaches the cleanup model (heard → meant hints),
       * the cleaned text is redone from it, and a clip made earlier gets the corrected text.
       */
      async correctDictation(id: string, text: string) {
        const d = await lib.dictation(id);
        if (!d) throw new Error("That dictation is gone.");
        const fixed = text.trim();
        const corrected = fixed && fixed !== d.raw ? fixed : null;
        if (corrected) await learn(d.raw, corrected);
        const c = await clean(corrected ?? d.raw);
        await lib.updateDictation(id, { corrected, clean: c.clean, style: c.style });
        if (d.clipId) await lib.setClipText(d.clipId, corrected ?? d.raw);
        bump();
      },
      async deleteDictation(id: string) {
        await lib.deleteDictation(id);
        bump();
      },
      /** Transcribes a dictation's audio again, with the current model and cleanup settings. */
      async retryDictation(id: string) {
        const d = await lib.dictation(id);
        if (!d?.audio) throw new Error("This dictation's audio is gone.");
        try {
          const out = await transcribe(abs(d.audio));
          const c = d.corrected ? await clean(d.corrected) : out;
          await lib.updateDictation(id, {
            raw: out.text, lang: out.lang, clean: c.clean, style: c.style, modelId: out.modelId, elapsed: out.elapsed, status: "ok", error: null,
          });
        } finally {
          bump();
        }
      },
      /**
       * Adds a dictation to the voice library as a clip with its corrected (or confirmed) text, so the
       * next training run learns from it. Like recordings, about one in four goes to the test set.
       */
      async trainOnDictation(id: string) {
        const d = await lib.dictation(id);
        if (!d) throw new Error("That dictation is gone.");
        if (d.clipId) return;
        const text = (d.corrected ?? d.raw).trim();
        if (!text) throw new Error("There's no text to train on. Type what you said first.");
        if (d.seconds > MAX_CLIP_SECONDS) throw new Error(`Training clips must be under ${MAX_CLIP_SECONDS} s; this one is ${Math.round(d.seconds)} s.`);
        const lang: Lang | null = d.lang && d.lang !== "?" ? d.lang : null;
        if (!lang) throw new Error("The language of this dictation isn't known. Retry it first.");
        await lib.clipFromDictation(id, text, lang);
        bump();
      },
    },
  };

  /** Records heard → meant substitutions from a correction, most frequent first. */
  async function learn(raw: string, corrected: string) {
    const found = substitutions(raw, corrected);
    if (!found.length) return;
    const all = (await lib.setting<Hint[]>("cleanup_hints")) ?? [];
    for (const [heard, meant] of found) {
      const h = all.find((x) => x.heard.toLowerCase() === heard.toLowerCase());
      if (h) (h.meant = meant), h.count++;
      else all.push({ heard, meant, count: 1 });
    }
    all.sort((a, b) => b.count - a.count);
    await lib.setSetting("cleanup_hints", all.slice(0, MAX_HINTS));
  }
}

/** Short replaced word runs between two texts: [[heard, meant], ...], ignoring case and punctuation. */
export function substitutions(a: string, b: string): [string, string][] {
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const A = a.split(/\s+/).filter(Boolean), B = b.split(/\s+/).filter(Boolean);
  const n = A.length, m = B.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = norm(A[i]!) === norm(B[j]!) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: [string, string][] = [];
  let i = 0, j = 0, del: string[] = [], add: string[] = [];
  // Words as written, minus surrounding punctuation ("seventy-two," → "seventy-two").
  const bare = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, "");
  const flush = () => {
    const heard = del.map((w) => bare(w).toLowerCase()).filter(Boolean).join(" "), meant = add.map(bare).filter(Boolean).join(" ");
    if (heard && meant && del.length <= 3 && add.length <= 3 && heard !== meant.toLowerCase()) out.push([heard, meant]);
    del = [];
    add = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && norm(A[i]!) === norm(B[j]!)) (flush(), i++, j++);
    else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) del.push(A[i++]!);
    else add.push(B[j++]!);
  }
  flush();
  return out;
}
