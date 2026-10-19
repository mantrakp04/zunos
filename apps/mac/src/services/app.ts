// App state that outlives the window. Closing the window destroys the React Native surface (App
// unmounts) while the JS runtime keeps running for the menu-bar item and the dictation hotkey, so the
// live state, the database, the engine and the timers live here, at module level, started once.
import Native from "../../modules/zunos-native";
import type { LiveState } from "../shared/types";
import { createActions, type Actions, type SetLive } from "./actions";
import * as auth from "./auth";
import { openDb } from "./db";
import * as engine from "./engine";
import { createLibrary } from "./library";

const initial: LiveState = {
  user: null, authReady: false, engine: "stopped", engineError: null, recording: false, level: 0, evalProgress: null, transfer: null,
  cleanup: null, dictation: null, access: { trusted: false, hotkey: false }, dictationsVersion: 0,
};

function boot() {
  // ---- the LiveState store (read by App with useSyncExternalStore)
  let live = initial;
  const subscribers = new Set<() => void>();
  const getLive = () => live;
  const setLive: SetLive = (patch) => {
    live = { ...live, ...(typeof patch === "function" ? patch(live) : patch) };
    subscribers.forEach((fn) => fn());
  };
  const subscribe = (fn: () => void) => {
    subscribers.add(fn);
    return () => void subscribers.delete(fn);
  };

  auth.currentUser()
    .then((user) => setLive({ user, authReady: true }))
    .catch(() => setLive({ authReady: true }));

  // The engine starts in the background so the first transcription is quick.
  setLive({ engine: "starting" });
  engine.startEngine().catch((e) => setLive({ engine: "error", engineError: String(e.message ?? e) }));
  engine.onEngineState((state, info) =>
    setLive(state === "ready" ? { engine: "ready", engineError: null } : { engine: "error", engineError: info ?? null }));

  let lastLevel = 0;
  Native.addListener("onLevel", ({ rms }) => {
    const now = Date.now();
    if (now - lastLevel < 60) return; // ~16 updates a second is enough for the meter
    lastLevel = now;
    setLive({ level: Math.min(1, Math.sqrt(rms) * 1.6) });
  });

  let actions: Actions | null = null;
  const ready: Promise<Actions> = openDb().then(({ db }) => {
    const created = createActions(createLibrary(db), setLive);
    actions = created.actions;
    // The hotkey and menu-bar item, then Whisper and the cleanup model, so the first dictation is quick.
    created.dictation.start()
      .catch((e) => console.warn("zunos: dictation start failed", e))
      .then(() => created.dictation.warm())
      .catch(() => {}); // no model yet: dictation loads it when there is one
    syncRunsWhileSignedIn(created.actions);
    return created.actions;
  });
  ready.catch((e) => console.error("zunos: could not open the database", e));

  // Cloud training: poll in-flight runs every 30 s while signed in, and right after signing in.
  function syncRunsWhileSignedIn(a: Actions) {
    const tick = () => {
      if (live.user) a.syncRuns().catch(() => {});
    };
    let user = live.user?.id ?? null;
    subscribe(() => {
      if ((live.user?.id ?? null) === user) return;
      user = live.user?.id ?? null;
      tick();
    });
    tick();
    setInterval(tick, 30_000);
  }

  return { getLive, setLive, subscribe, ready, actions: () => actions };
}

// Kept on globalThis so Fast Refresh re-running this module doesn't start a second engine client,
// hotkey listener or timer. Changes here need a full reload.
const g = globalThis as { __zunosApp?: ReturnType<typeof boot> };
const app = (g.__zunosApp ??= boot());

export const { getLive, setLive, subscribe, ready } = app;
/** The actions once the database is open (null before), so a reopened window renders at once. */
export const currentActions = app.actions;
