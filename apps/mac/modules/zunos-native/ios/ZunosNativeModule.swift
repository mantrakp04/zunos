import AppKit
import ExpoModulesCore

public class ZunosNativeModule: Module {
  private let recorder = Recorder()
  private let engine = EngineProcess()
  private let transfer = Transfer()
  private let hotkey = Hotkey()
  private let overlay = Overlay()
  private var lastLevelEvent = Date.distantPast
  private var menuObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("ZunosNative")

    Events("onLevel", "onMicStats", "onRecorderEvent", "onEngineLine", "onEngineLog", "onEngineExit", "onTransfer", "onHotkey", "onMenu")

    OnCreate {
      recorder.onLevel = { [weak self] rms, peak in
        guard let self else { return }
        DispatchQueue.main.async { self.overlay.level(rms) }
        // ~30 updates a second is plenty for a meter.
        let now = Date()
        if now.timeIntervalSince(self.lastLevelEvent) < 0.033 { return }
        self.lastLevelEvent = now
        self.sendEvent("onLevel", ["rms": Double(rms), "peak": Double(peak)])
      }
      recorder.onStats = { [weak self] stats in self?.sendEvent("onMicStats", stats) }
      recorder.onEvent = { [weak self] type, data in
        var e = data
        e["type"] = type
        self?.sendEvent("onRecorderEvent", e)
      }
      engine.onLine = { [weak self] line in self?.sendEvent("onEngineLine", ["line": line]) }
      engine.onLog = { [weak self] text in self?.sendEvent("onEngineLog", ["text": text]) }
      engine.onExit = { [weak self] code in self?.sendEvent("onEngineExit", ["code": Int(code)]) }
      hotkey.onEvent = { [weak self] type in self?.sendEvent("onHotkey", ["type": type]) }
      // The menu-bar item (AppDelegate) lives outside React; it reaches JS through this notification.
      menuObserver = NotificationCenter.default.addObserver(forName: Notification.Name("ZunosMenuAction"), object: nil, queue: .main) {
        [weak self] note in
        guard let action = note.userInfo?["action"] as? String else { return }
        self?.sendEvent("onMenu", ["action": action])
      }
      transfer.onProgress = { [weak self] id, done, total in
        self?.sendEvent("onTransfer", ["id": id, "done": Double(done), "total": Double(total)])
      }
    }

    OnDestroy {
      engine.stop()
      DispatchQueue.main.async { [hotkey] in hotkey.stop() }
      if let menuObserver { NotificationCenter.default.removeObserver(menuObserver) }
    }

    // MARK: paths

    /// ~/Library/Application Support/zunos (created if missing). The app is not sandboxed.
    /// The app bundle's Resources folder (the packaged engine lives in Resources/engine).
    Function("resourcePath") { () -> String in Bundle.main.resourcePath ?? "" }

    Function("dataDir") { () -> String in
      let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      let dir = base.appendingPathComponent("zunos", isDirectory: true)
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      return dir.path
    }

    AsyncFunction("deleteFile") { (path: String) in
      try? FileManager.default.removeItem(atPath: path)
    }

    Function("copyText") { (text: String) in
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    }

    // MARK: system-wide dictation

    Function("accessibilityTrusted") { () -> Bool in Hotkey.trusted }

    /// Opens the system prompt for Accessibility (needed for the hotkey and for pasting).
    Function("requestAccessibility") { () -> Bool in Hotkey.requestTrust() }

    /// Starts listening for the push-to-talk key; false without the Accessibility permission.
    AsyncFunction("startHotkey") { (key: String) -> Bool in
      self.hotkey.key = Hotkey.Key(rawValue: key) ?? .rightOption
      return self.hotkey.start()
    }.runOnQueue(.main)

    AsyncFunction("stopHotkey") {
      self.hotkey.stop()
    }.runOnQueue(.main)

    Function("hotkeyRunning") { () -> Bool in self.hotkey.running }

    /// While a toggled recording runs, Esc cancels it even though the key isn't held.
    AsyncFunction("setHotkeyActive") { (active: Bool) in
      self.hotkey.active = active
    }.runOnQueue(.main)

    AsyncFunction("pasteText") { (text: String, restoreClipboard: Bool, promise: Promise) in
      Paster.paste(text, restoreClipboard: restoreClipboard) { promise.resolve($0) }
    }.runOnQueue(.main)

    /// The floating recorder: hidden | listening | thinking | done | error.
    AsyncFunction("overlay") { (state: String, message: String?) in
      self.overlay.set(Overlay.State(rawValue: state) ?? .hidden, message: message)
    }.runOnQueue(.main)

    /// The app the user is in (bundle id and name); zunos itself when its window is in front.
    Function("frontmostApp") { () -> [String: String]? in
      guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
      return ["bundleId": app.bundleIdentifier ?? "", "name": app.localizedName ?? ""]
    }

    // MARK: microphone

    Function("micPermission") { () -> String in Recorder.permission() }

    AsyncFunction("requestMicPermission") { (promise: Promise) in
      Recorder.requestPermission { promise.resolve($0) }
    }

    /// The default input device (name, transport, sample rate, input volume, mic mode), without recording.
    Function("micInfo") { () -> [String: Any] in Recorder.deviceInfo() }

    /// roomSeconds: the start of the take the user was asked to keep quiet (room tone).
    AsyncFunction("startRecording") { (path: String, roomSeconds: Double?) -> [String: Any] in
      try self.recorder.start(path: path, roomSeconds: roomSeconds ?? 0)
    }

    /// Listens without writing a file (the room check); stop with stopRecording.
    AsyncFunction("startListening") { (roomSeconds: Double) -> [String: Any] in
      try self.recorder.start(path: nil, roomSeconds: roomSeconds)
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

    // MARK: transfers

    AsyncFunction("uploadFile") { (id: String, url: String, path: String, contentType: String, promise: Promise) in
      self.transfer.upload(id: id, url: url, path: path, contentType: contentType) { result in
        switch result {
        case .success: promise.resolve(nil)
        case .failure(let e): promise.reject("ERR_UPLOAD", String(describing: e))
        }
      }
    }

    AsyncFunction("downloadFile") { (id: String, url: String, dest: String, promise: Promise) in
      self.transfer.download(id: id, url: url, dest: dest) { result in
        switch result {
        case .success: promise.resolve(nil)
        case .failure(let e): promise.reject("ERR_DOWNLOAD", String(describing: e))
        }
      }
    }

    // MARK: keychain

    Function("keychainGet") { (key: String) -> String? in Keychain.get(key) }
    Function("keychainSet") { (key: String, value: String) -> Bool in Keychain.set(key, value) }
    Function("keychainDelete") { (key: String) in Keychain.delete(key) }
  }
}
