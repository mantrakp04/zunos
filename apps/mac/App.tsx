import { useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";

import ZunosApp from "./src/dom/ZunosApp";
import { currentActions, getLive, ready, subscribe } from "./src/services/app";

// The window's view of the app. State, the engine and the hotkey live in src/services/app.ts, which
// keeps running after the window closes (this component unmounts then, and mounts again on reopen).
export default function App() {
  const live = useSyncExternalStore(subscribe, getLive);
  const [actions, setActions] = useState(currentActions);

  useEffect(() => {
    let mounted = true;
    ready.then((a) => mounted && setActions(a));
    return () => {
      mounted = false;
    };
  }, []);

  if (!actions) return <View style={{ flex: 1 }} />;

  return (
    <View style={{ flex: 1 }}>
      <ZunosApp {...actions} live={live} dom={{ style: { flex: 1 } }} />
    </View>
  );
}
