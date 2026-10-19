import AppKit
import ExpoModulesCore

public class ZunosNativeModule: Module {
  private let recorder = Recorder()
  private let engine = EngineProcess()
  private var lastLevelEvent = Date.distantPast

  public func definition() -> ModuleDefinition {
    Name("ZunosNative")

    Events("onLevel", "onEngineLine", "onEngineLog", "onEngineExit")

    OnCreate {
      recorder.onLevel = { [weak self] rms, peak in
        guard let self else { return }
        // ~30 updates a second is plenty for a meter.
        let now = Date()
        if now.timeIntervalSince(self.lastLevelEvent) < 0.033 { return }
        self.lastLevelEvent = now
        self.sendEvent("onLevel", ["rms": Double(rms), "peak": Double(peak)])
      }
      engine.onLine = { [weak self] line in self?.sendEvent("onEngineLine", ["line": line]) }
      engine.onLog = { [weak self] text in self?.sendEvent("onEngineLog", ["text": text]) }
      engine.onExit = { [weak self] code in self?.sendEvent("onEngineExit", ["code": Int(code)]) }
    }

    OnDestroy {
      engine.stop()
    }

    // MARK: paths

    /// ~/Library/Application Support/zunos (created if missing). The app is not sandboxed.
    Function("dataDir") { () -> String in
      let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      let dir = base.appendingPathComponent("zunos", isDirectory: true)
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      return dir.path
    }

    Function("fileExists") { (path: String) -> Bool in
      FileManager.default.fileExists(atPath: path)
    }

    AsyncFunction("deleteFile") { (path: String) in
      try? FileManager.default.removeItem(atPath: path)
    }

    Function("revealInFinder") { (path: String) in
      NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    Function("openURL") { (url: String) in
      if let u = URL(string: url) { NSWorkspace.shared.open(u) }
    }

    Function("copyText") { (text: String) in
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    }

    // MARK: microphone

    Function("micPermission") { () -> String in Recorder.permission() }

    AsyncFunction("requestMicPermission") { (promise: Promise) in
      Recorder.requestPermission { promise.resolve($0) }
    }

    AsyncFunction("startRecording") { (path: String) -> [String: Any] in
      try self.recorder.start(path: path)
    }

    AsyncFunction("stopRecording") { () -> [String: Any] in
      self.recorder.stop()
    }

    // MARK: engine

    AsyncFunction("startEngine") { (command: String, cwd: String?, env: [String: String]) in
      try self.engine.start(command: command, cwd: cwd, env: env)
    }

    AsyncFunction("sendEngine") { (line: String) in
      try self.engine.send(line)
    }

    Function("engineRunning") { () -> Bool in self.engine.isRunning }

    AsyncFunction("stopEngine") {
      self.engine.stop()
    }

    // MARK: keychain

    Function("keychainGet") { (key: String) -> String? in Keychain.get(key) }
    Function("keychainSet") { (key: String, value: String) -> Bool in Keychain.set(key, value) }
    Function("keychainDelete") { (key: String) in Keychain.delete(key) }
  }
}
