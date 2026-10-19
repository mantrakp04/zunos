import SwiftUI
internal import Expo
import React
import ReactAppDependencyProvider

// Keep these constants on separate lines for config plugins.
private let windowTitle = "zunos"
private let bundleRoot = ".expo/.virtual-metro-entry"
private let moduleName = "main"

@main
struct ZunosApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

  init() {
    RCTView.zn_guardKeyboardEventsWithoutReactTag()
  }

  var body: some Scene {
    Window(windowTitle, id: "main") {
      // The web UI draws its own title bar: content runs under the traffic lights, and a thin
      // native strip along the top keeps the window draggable (the WebView would swallow drags).
      ReactNativeView(factory: appDelegate.reactNativeFactory)
        .ignoresSafeArea()
        .overlay(alignment: .top) { WindowDragStrip().frame(height: titleBarHeight) }
        .frame(minWidth: 980, minHeight: 620)
    }
    .windowStyle(.hiddenTitleBar)
    .defaultSize(width: 1280, height: 720)

    // The menu-bar item keeps zunos running with its window closed, so the dictation hotkey still works.
    MenuBarExtra("zunos", systemImage: "waveform") {
      MenuBarMenu()
    }
  }
}

struct MenuBarMenu: View {
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    Button("Open zunos") {
      openWindow(id: "main")
      NSApp.activate()
    }
    .keyboardShortcut("o")
    // Handled in JS (dictation.ts) through ZunosNativeModule's onMenu event.
    Button("Paste last dictation") {
      NotificationCenter.default.post(name: Notification.Name("ZunosMenuAction"), object: nil, userInfo: ["action": "pasteLast"])
    }
    .keyboardShortcut("v")
    Divider()
    Button("Quit zunos") { NSApp.terminate(nil) }
      .keyboardShortcut("q")
  }
}

/// Height of the draggable band the web UI keeps free of controls (matches --titlebar in CSS).
private let titleBarHeight: CGFloat = 28

/// Drags the window like a title bar would, and zooms on double-click per the system setting.
struct WindowDragStrip: NSViewRepresentable {
  final class StripView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
      if event.clickCount == 2 {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        if action == "Minimize" { window?.performMiniaturize(nil) } else if action != "None" { window?.performZoom(nil) }
        return
      }
      window?.performDrag(with: event)
    }
  }

  func makeNSView(context: Context) -> NSView { StripView() }
  func updateNSView(_ nsView: NSView, context: Context) {}
}

// MARK: - App Delegate

class AppDelegate: ExpoAppDelegate {
  private let reactNative: (delegate: ReactNativeDelegate, factory: RCTReactNativeFactory) = {
    let delegate = ReactNativeDelegate()
    delegate.dependencyProvider = RCTAppDependencyProvider()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    return (delegate, factory)
  }()

  @objc var reactNativeFactory: RCTReactNativeFactory {
    reactNative.factory
  }
}

// MARK: - React Native Delegate

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // Needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: bundleRoot)
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

// MARK: - React Native SwiftUI View

struct ReactNativeView: NSViewRepresentable {
  let factory: RCTReactNativeFactory

  func makeNSView(context: Context) -> NSView {
    factory.rootViewFactory.view(withModuleName: moduleName)
  }

  func updateNSView(_ nsView: NSView, context: Context) {}
}

// MARK: - Keyboard events that reach a view React doesn't know

extension RCTView {
  /// A key the WebView doesn't handle (say ⌘E) bubbles up to the RCTView hosting it. That view has
  /// no reactTag, and react-native-macos builds `@[viewTag, ...]` for the JS event, which throws on
  /// nil and takes the whole app down. Views without a tag now just pass the key along (macOS beeps).
  static func zn_guardKeyboardEventsWithoutReactTag() {
    let original = #selector(RCTView.handleKeyboardEvent(_:))
    let guarded = #selector(RCTView.zn_handleKeyboardEvent(_:))
    guard let a = class_getInstanceMethod(RCTView.self, original),
          let b = class_getInstanceMethod(RCTView.self, guarded) else { return }
    method_exchangeImplementations(a, b)
  }

  @objc dynamic func zn_handleKeyboardEvent(_ event: NSEvent) -> Bool {
    if reactTag == nil { return false }
    return zn_handleKeyboardEvent(event) // the original, after the exchange
  }
}
