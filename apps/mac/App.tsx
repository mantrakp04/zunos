import * as SQLite from "expo-sqlite";
import { useState } from "react";
import { Text, View } from "react-native";

import Spike from "./src/dom/Spike";

export default function App() {
  const [status, setStatus] = useState("mounting");
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ padding: 6, fontSize: 11 }}>webview: {status}</Text>
      <Spike
        dom={{
          style: { flex: 1 },
          onLoadStart: (e: any) => setStatus(`loading ${e.nativeEvent.url}`),
          onLoadEnd: () => setStatus((s) => `${s} → loaded`),
          onError: (e: any) => setStatus(`error ${JSON.stringify(e.nativeEvent)}`),
          onHttpError: (e: any) => setStatus(`http ${e.nativeEvent.statusCode}`),
          onLayout: (e: any) =>
            setStatus((s) => `${s} [${Math.round(e.nativeEvent.layout.width)}x${Math.round(e.nativeEvent.layout.height)}]`),
        }}
        ping={async (msg) => {
          const db = await SQLite.openDatabaseAsync("spike.db");
          await db.execAsync("create table if not exists t (v text)");
          await db.runAsync("insert into t values (?)", msg);
          const row = await db.getFirstAsync<{ n: number }>("select count(*) as n from t");
          return `native got "${msg}", sqlite rows=${row?.n}, dir=${SQLite.defaultDatabaseDirectory}`;
        }}
      />
    </View>
  );
}
