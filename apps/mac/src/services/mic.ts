// Live microphone checks for prompt takes and the room check: native statistics in, LiveState.mic out.
import Native, { type MicStats, type RecordingResult } from "../../modules/zunos-native";
import type { AudioMeasure, LiveState, MicDeviceInfo, MicIssue, MicState, RoomCheck } from "../shared/types";
import { dataDir } from "./db";
import * as engine from "./engine";
import { deviceChangedIssue, deviceInfo, deviceIssues, liveIssues, roomVerdict } from "./quality";

type SetLive = (patch: Partial<LiveState>) => void;

const ORDER = { bad: 0, warn: 1, info: 2 } as const;

/** One issue per code, worst first. */
export function worstFirst(issues: MicIssue[]) {
  const seen = new Set<string>();
  return issues.filter((i) => !seen.has(i.code) && seen.add(i.code)).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

export function createMicMonitor(setLive: SetLive) {
  let state: { phase: MicState["phase"]; device: MicDeviceInfo | null; roomSeconds: number; changed: boolean } | null = null;
  let last: MicStats | undefined;

  function publish() {
    if (!state) return setLive({ mic: null });
    const s = last;
    const issues = [...deviceIssues(state.device), ...(s ? liveIssues(s, state.phase, state.roomSeconds) : [])];
    if (state.changed) issues.unshift(deviceChangedIssue());
    setLive({
      mic: {
        phase: state.phase, device: state.device,
        roomTone: state.phase === "room" || (s?.elapsed ?? 0) < state.roomSeconds,
        noiseDb: s?.noiseDb ?? null, speechDb: s?.speechDb ?? null, snrDb: s?.snrDb ?? null, peakDb: s?.peakDb ?? null,
        speaking: s?.speaking ?? false, silenceSec: s?.silenceSec ?? 0, issues: worstFirst(issues),
      },
    });
  }

  Native.addListener("onMicStats", (s) => {
    if (!state) return;
    last = s;
    publish();
  });
  Native.addListener("onRecorderEvent", (e) => {
    if (!state || e.type !== "deviceChanged") return;
    state.changed = true;
    publish();
  });

  return {
    /** Starts showing checks; call after the recorder started (device: what it reported). */
    start(phase: MicState["phase"], device: MicDeviceInfo | null, roomSeconds: number) {
      state = { phase, device, roomSeconds, changed: false };
      last = undefined;
      publish();
    },
    /** Clears LiveState.mic. */
    stop() {
      state = null;
      last = undefined;
      publish();
    },
    /** The microphone that would record now, and what's wrong with it before the user starts. */
    info() {
      const device = deviceInfo(Native.micInfo());
      return { device, issues: worstFirst(deviceIssues(device)) };
    },
  };
}

/**
 * The room check: records `seconds` of the quiet room through `record` (the shared recorder, so it can't
 * overlap a take or a dictation), then judges the noise floor, hum, rumble and the device.
 */
export async function checkRoom(
  seconds: number,
  record: { begin: (path: string) => Promise<void>; end: () => Promise<RecordingResult> },
): Promise<RoomCheck> {
  const path = `${dataDir}/tmp/room-${Date.now()}.wav`;
  await record.begin(path);
  await new Promise((r) => setTimeout(r, seconds * 1000 + 250));
  const res = await record.end();
  try {
    const m = await engine.call<AudioMeasure & { silent?: boolean }>("measure", { path: res.path, room: [0, seconds] }).catch(() => null);
    return roomVerdict(res.stats, m && !m.silent ? m : null, deviceInfo(res.device));
  } finally {
    await Native.deleteFile(res.path);
  }
}
