import { NativeModule, requireNativeModule } from "expo";

type Events = {
  onLevel(e: { rms: number; peak: number }): void;
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

export type RecordingResult = { path: string; seconds: number; sampleRate: number; peak: number };
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
  startRecording(path: string): Promise<{ path: string; sampleRate: number }>;
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
