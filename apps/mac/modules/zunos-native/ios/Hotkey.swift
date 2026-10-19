import AppKit
import ApplicationServices

/// System-wide push-to-talk on a single modifier key (fn, right ⌥ or right ⌘), through a Quartz event
/// tap. It reports raw presses; the hold-versus-tap decision is made in JS.
///
/// Events: "down", "up", and "cancel" (Esc while held or recording, or another key pressed with the
/// modifier, which means the user was typing a shortcut). Needs the Accessibility permission.
final class Hotkey {
  enum Key: String {
    case fn, rightOption, rightCommand

    var keyCode: Int64 {
      switch self {
      case .fn: return 63
      case .rightOption: return 61
      case .rightCommand: return 54
      }
    }

    /// The flag bit for this physical key. The right-hand keys use the device-dependent bits
    /// (NX_DEVICERALTKEYMASK, NX_DEVICERCMDKEYMASK) so the left-hand ones don't count.
    var flagBit: UInt64 {
      switch self {
      case .fn: return CGEventFlags.maskSecondaryFn.rawValue
      case .rightOption: return 0x40
      case .rightCommand: return 0x10
      }
    }
  }

  var key: Key = .rightOption
  /// While true, Esc is reported as "cancel" even when the key isn't held (a toggled recording).
  var active = false
  var onEvent: ((String) -> Void)?

  private var tap: CFMachPort?
  private var source: CFRunLoopSource?
  private var held = false
  private var wakeObserver: NSObjectProtocol?

  static var trusted: Bool { AXIsProcessTrusted() }

  /// Shows the system prompt that sends the user to Privacy & Security → Accessibility.
  static func requestTrust() -> Bool {
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    return AXIsProcessTrustedWithOptions(opts)
  }

  var running: Bool { tap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false }

  /// Installs the tap. Returns false without the Accessibility permission.
  @discardableResult
  func start() -> Bool {
    if tap != nil { return true }
    guard Self.trusted else { return false }
    let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
    let me = Unmanaged.passUnretained(self).toOpaque()
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                      eventsOfInterest: CGEventMask(mask), callback: { _, type, event, ctx in
      let hotkey = Unmanaged<Hotkey>.fromOpaque(ctx!).takeUnretainedValue()
      return hotkey.handle(type, event)
    }, userInfo: me) else { return false }
    self.tap = tap
    source = CFMachPortCreateRunLoopSource(nil, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    // Taps can die across sleep; rebuild after wake.
    wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) {
      [weak self] _ in self?.restart()
    }
    return true
  }

  func stop() {
    if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
    if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
    if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
    tap = nil
    source = nil
    wakeObserver = nil
    held = false
  }

  func restart() {
    stop()
    start()
  }

  private func emit(_ name: String) {
    DispatchQueue.main.async { self.onEvent?(name) }
  }

  private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
    switch type {
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
      // macOS switches slow or interrupted taps off; switch it back on.
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return Unmanaged.passUnretained(event)

    case .flagsChanged:
      guard event.getIntegerValueField(.keyboardEventKeycode) == key.keyCode else { break }
      let down = event.flags.rawValue & key.flagBit != 0
      if down != held {
        held = down
        emit(down ? "down" : "up")
      }
      // fn on its own opens the emoji picker or system dictation; keep it for zunos.
      if key == .fn { return nil }

    case .keyDown:
      let code = event.getIntegerValueField(.keyboardEventKeycode)
      if code == 53, held || active { // Esc
        held = false
        emit("cancel")
        return nil
      }
      if held { // a shortcut such as ⌥← or ⌘C, not dictation
        held = false
        emit("cancel")
      }

    default:
      break
    }
    return Unmanaged.passUnretained(event)
  }
}
