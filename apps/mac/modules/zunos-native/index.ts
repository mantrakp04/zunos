import { NativeModule, requireNativeModule } from "expo";

type Events = {
  onLevel(e: { rms: number; peak: number }): void;
  onEngineLine(e: { line: string }): void;
  onEngineLog(e: { text: string }): void;
  onEngineExit(e: { code: number }): void;
};

export type RecordingResult = { path: string; seconds: number; sampleRate: number; peak: number };
export type MicPermission = "granted" | "denied" | "undetermined";

declare class ZunosNativeModule extends NativeModule<Events> {
  dataDir(): string;
  fileExists(path: string): boolean;
  deleteFile(path: string): Promise<void>;
  revealInFinder(path: string): void;
  openURL(url: string): void;
  copyText(text: string): void;

  micPermission(): MicPermission;
  requestMicPermission(): Promise<MicPermission>;
  startRecording(path: string): Promise<{ path: string; sampleRate: number }>;
  stopRecording(): Promise<RecordingResult>;

  startEngine(command: string, cwd: string | null, env: Record<string, string>): Promise<void>;
  sendEngine(line: string): Promise<void>;
  engineRunning(): boolean;
  stopEngine(): Promise<void>;

  keychainGet(key: string): string | null;
  keychainSet(key: string, value: string): boolean;
  keychainDelete(key: string): void;
}

export default requireNativeModule<ZunosNativeModule>("ZunosNative");
