"use dom";

// Browser preview of the zunos UI: the real ZunosApp with a mocked native shell (live state and
// actions from ./store) plus a scenario toolbar. Served by the app's Metro:
// http://localhost:8090/_expo/@dom/Preview.tsx?file=file:///Users/barreloflube/voice-data/apps/mac/src/preview/Preview.tsx
import "./shim";

import type { DOMProps } from "expo/dom";
import { useSyncExternalStore } from "react";

import ZunosApp from "../dom/ZunosApp";
import { actions, store } from "./store";
import { Toolbar } from "./Toolbar";

export default function Preview(_: { dom?: DOMProps }) {
  const s = useSyncExternalStore(store.subscribe, store.get);
  return (
    <>
      <ZunosApp key={s.epoch} {...actions} live={s.live} />
      <Toolbar state={s} />
    </>
  );
}
