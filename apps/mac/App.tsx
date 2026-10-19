import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";

import Native from "./modules/zunos-native";
import ZunosApp from "./src/dom/ZunosApp";
import { createActions } from "./src/services/actions";
import * as auth from "./src/services/auth";
import { openDb } from "./src/services/db";
import * as engine from "./src/services/engine";
import { createLibrary, type Library } from "./src/services/library";
import type { LiveState } from "./src/shared/types";

const initial: LiveState = {
  user: null, authReady: false, engine: "stopped", engineError: null, recording: false, level: 0, evalProgress: null, transfer: null,
};

export default function App() {
  const [lib, setLib] = useState<Library | null>(null);
  const [live, setLiveState] = useState(initial);
  const setLive = (patch: Partial<LiveState> | ((s: LiveState) => Partial<LiveState>)) =>
    setLiveState((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));

  useEffect(() => {
    openDb().then(({ db }) => setLib(createLibrary(db)));
    auth.currentUser()
      .then((user) => setLive({ user, authReady: true }))
      .catch(() => setLive({ authReady: true }));

    // The engine starts in the background so the first transcription is quick.
    setLive({ engine: "starting" });
    engine.startEngine().catch((e) => setLive({ engine: "error", engineError: String(e.message ?? e) }));
    const offEngine = engine.onEngineState((state, info) =>
      setLive(state === "ready" ? { engine: "ready", engineError: null } : { engine: "error", engineError: info ?? null }));

    let last = 0;
    const level = Native.addListener("onLevel", ({ rms }) => {
      const now = Date.now();
      if (now - last < 60) return; // ~16 updates a second is enough for the meter
      last = now;
      setLive({ level: Math.min(1, Math.sqrt(rms) * 1.6) });
    });
    return () => {
      offEngine();
      level.remove();
    };
  }, []);

  const actions = useMemo(() => (lib ? createActions(lib, setLive) : null), [lib]);

  // Cloud training: poll in-flight runs every 30 s while signed in.
  useEffect(() => {
    if (!actions || !live.user) return;
    const tick = () => actions.syncRuns().catch(() => {});
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [actions, live.user?.id]);
  if (!actions) return <View style={{ flex: 1 }} />;

  return (
    <View style={{ flex: 1 }}>
      <ZunosApp {...actions} live={live} dom={{ style: { flex: 1 } }} />
    </View>
  );
}
