import { NativeModule, requireNativeModule } from "expo";

type Events = {
  onLevel(e: { rms: number; peak: number }): void;
  /** Running microphone statistics, about four times a second while recording or listening. */
  onMicStats(e: MicStats): void;
  /** The input device or its format changed mid-take; the take no longer receives audio. */
  onRecorderEvent(e: { type: "deviceChanged"; reason: "configuration" | "defaultInput"; device: MicDevice }): void;
  onEngineLine(e: { line: string }): void;
  onEngineLog(e: { text: string }): void;
  onEngineExit(e: { code: number }): void;
  onTransfer(e: { id: string; done: number; total: number }): void;
  onHotkey(e: { type: "down" | "up" | "cancel" }): void;
  /** A menu-bar item was chosen (AppDelegate posts ZunosMenuAction). */
  onMenu(e: { action: "pasteLast" }): void;
};

export type HotkeyKey = "fn" | "rightOption" | "rightCommand";
export type OverlayState = "hidden" | "listening" | "thinking" | "done" | "error";

export type MicTransport =
  | "builtIn" | "usb" | "bluetooth" | "bluetoothLE" | "continuity" | "aggregate" | "virtual" | "hdmi" | "displayPort"
  | "airPlay" | "thunderbolt" | "pci" | "fireWire" | "avb" | "unknown";

/** The default input device (CoreAudio). inputVolume is 0-1 when the device exposes one. */
export type MicDevice = {
  id?: number;
  name?: string;
  uid?: string;
  transport: MicTransport;
  sampleRate?: number;
  inputVolume?: number;
  micMode?: "standard" | "voiceIsolation" | "wideSpectrum";
  /** Set once recording started: the tap's format and whether voice processing is on (it never is in zunos). */
  formatSampleRate?: number;
  channels?: number;
  voiceProcessing?: boolean;
};

/** Levels in dBFS, durations in seconds. speechDb/snrDb appear once there has been some speech. */
export type MicStats = {
  elapsed: number;
  noiseDb: number;
  speechDb?: number;
  snrDb?: number;
  peakDb: number;
  clipEvents: number;
  clippingNow: boolean;
  pops: number;
  /** Share of frames that were exact digital silence: the device gates or processes its microphone. */
  gatedPct: number;
  speaking: boolean;
  silenceSec: number;
  longestPauseSec: number;
  speechSec: number;
  /** Share of speech frames peaking above -3 dBFS. */
  loudPct: number;
  /** Room tone at the start of the take: its median level, and whether the user talked over it. */
  roomDb?: number;
  roomSpoken?: boolean;
  roomDone?: boolean;
};

export type RecordingResult = {
  path: string; seconds: number; sampleRate: number; peak: number;
  device: MicDevice; deviceChanged: boolean; stats?: MicStats;
};
export type MicPermission = "granted" | "denied" | "undetermined";

declare class ZunosNativeModule extends NativeModule<Events> {
  dataDir(): string;
  resourcePath(): string;
  deleteFile(path: string): Promise<void>;
  copyText(text: string): void;

  accessibilityTrusted(): boolean;
  requestAccessibility(): boolean;
  startHotkey(key: HotkeyKey): Promise<boolean>;
  stopHotkey(): Promise<void>;
  hotkeyRunning(): boolean;
  setHotkeyActive(active: boolean): Promise<void>;
  pasteText(text: string, restoreClipboard: boolean): Promise<boolean>;
  overlay(state: OverlayState, message?: string | null): Promise<void>;
  frontmostApp(): { bundleId: string; name: string } | null;

  micPermission(): MicPermission;
  requestMicPermission(): Promise<MicPermission>;
  micInfo(): MicDevice;
  startRecording(path: string, roomSeconds?: number | null): Promise<{ path: string; sampleRate: number; device: MicDevice }>;
  startListening(roomSeconds: number): Promise<{ path: string; sampleRate: number; device: MicDevice }>;
  stopRecording(): Promise<RecordingResult>;

  startEngine(command: string, cwd: string | null, env: Record<string, string>): Promise<void>;
  sendEngine(line: string): Promise<void>;
  engineRunning(): boolean;
  stopEngine(): Promise<void>;

  uploadFile(id: string, url: string, path: string, contentType: string): Promise<void>;
  downloadFile(id: string, url: string, dest: string): Promise<void>;

  keychainGet(key: string): string | null;
  keychainSet(key: string, value: string): boolean;
  keychainDelete(key: string): void;
}

export default requireNativeModule<ZunosNativeModule>("ZunosNative");
