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
