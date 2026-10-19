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

// `&screen=record|train|test|use` (and `&tab=history|settings` for Dictate) pick what opens, per tab:
// localStorage is shared by every preview tab, so a URL beats setting it by hand.
const q = new URLSearchParams(location.search);
if (q.get("screen")) localStorage.setItem("zunos.screen", q.get("screen")!);
if (q.get("tab")) localStorage.setItem("zunos.dictate.tab", q.get("tab")!);

export default function Preview(_: { dom?: DOMProps }) {
  const s = useSyncExternalStore(store.subscribe, store.get);
  return (
    <>
      <ZunosApp key={s.epoch} {...actions} live={s.live} />
      <Toolbar state={s} />
    </>
  );
}
