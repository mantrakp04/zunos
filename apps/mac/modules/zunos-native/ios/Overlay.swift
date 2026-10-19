import AppKit
import SwiftUI

/// The floating recorder shown while dictating from the global hotkey: a capsule near the bottom of
/// the screen that never takes focus (so ⌘V lands in the app the user was typing in) and ignores the
/// mouse. Drawn natively; the web UI only runs inside the main window.
final class Overlay {
  enum State: String { case hidden, listening, thinking, done, error }

  private let model = OverlayModel()
  private var panel: NSPanel?
  private var hideWork: DispatchWorkItem?

  func set(_ state: State, message: String?) {
    hideWork?.cancel()
    if state == .hidden { return hide() }
    let p = panel ?? makePanel()
    if state == .listening, model.state != .listening { model.startedAt = Date(); model.levels = Array(repeating: 0, count: OverlayModel.bars) }
    withAnimation(.spring(response: 0.32, dampingFraction: 0.78)) {
      model.state = state
      model.message = message
    }
    if !p.isVisible {
      place(p)
      p.alphaValue = 0
      p.orderFrontRegardless()
      NSAnimationContext.runAnimationGroup { $0.duration = 0.18; p.animator().alphaValue = 1 }
    }
    if state == .done || state == .error {
      let work = DispatchWorkItem { [weak self] in self?.hide() }
      hideWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + (state == .done ? 1.1 : 3.5), execute: work)
    }
  }

  /// Mic level 0...1, about 30 times a second while listening.
  func level(_ v: Float) {
    guard model.state == .listening else { return }
    model.levels.removeFirst()
    model.levels.append(CGFloat(min(1, sqrt(v) * 1.8)))
  }

  private func hide() {
    guard let p = panel, p.isVisible else { return }
    NSAnimationContext.runAnimationGroup({ $0.duration = 0.2; p.animator().alphaValue = 0 }) {
      p.orderOut(nil)
      self.model.state = .hidden
    }
  }

  private func makePanel() -> NSPanel {
    let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 480, height: 64),
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isFloatingPanel = true
    p.level = .statusBar
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.ignoresMouseEvents = true
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    p.hidesOnDeactivate = false
    let host = NSHostingView(rootView: OverlayView(model: model))
    host.frame = p.contentRect(forFrameRect: p.frame)
    p.contentView = host
    panel = p
    return p
  }

  /// Bottom centre of the screen with the mouse on it, above the Dock.
  private func place(_ p: NSPanel) {
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    guard let f = screen?.visibleFrame else { return }
    p.setFrameOrigin(NSPoint(x: f.midX - p.frame.width / 2, y: f.minY + 72))
  }
}

final class OverlayModel: ObservableObject {
  static let bars = 22
  @Published var state: Overlay.State = .hidden
  @Published var message: String?
  @Published var levels: [CGFloat] = Array(repeating: 0, count: bars)
  var startedAt = Date()
}

private let brand = Color(red: 0xf3 / 255, green: 0x4a / 255, blue: 0x2d / 255)
private let gold = Color(red: 0xf6 / 255, green: 0xa5 / 255, blue: 0x3c / 255)

private struct OverlayView: View {
  @ObservedObject var model: OverlayModel

  var body: some View {
    HStack(spacing: 10) {
      badge
      content.frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.leading, 8)
    .padding(.trailing, 16)
    .frame(height: 44)
    .fixedSize(horizontal: true, vertical: false)
    .background(
      Capsule().fill(.ultraThinMaterial)
        .overlay(Capsule().fill(Color.black.opacity(0.55)))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
    )
    .environment(\.colorScheme, .dark)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  @ViewBuilder private var badge: some View {
    ZStack {
      Circle().fill(model.state == .error ? Color.red.opacity(0.9) : model.state == .done ? gold : brand)
      switch model.state {
      case .done: Image(systemName: "checkmark").font(.system(size: 12, weight: .heavy))
      case .error: Image(systemName: "exclamationmark").font(.system(size: 12, weight: .heavy))
      case .thinking: ProgressView().controlSize(.mini).tint(.white)
      default: Image(systemName: "mic.fill").font(.system(size: 12, weight: .semibold))
      }
    }
    .foregroundStyle(.white)
    .frame(width: 28, height: 28)
    .overlay {
      if model.state == .listening {
        Circle().stroke(brand.opacity(0.5), lineWidth: 2).scaleEffect(1 + (model.levels.last ?? 0) * 0.45)
          .animation(.easeOut(duration: 0.12), value: model.levels.last)
      }
    }
  }

  @ViewBuilder private var content: some View {
    switch model.state {
    case .listening:
      HStack(spacing: 10) {
        HStack(alignment: .center, spacing: 2.5) {
          ForEach(Array(model.levels.enumerated()), id: \.offset) { i, v in
            Capsule()
              .fill(LinearGradient(colors: [gold, brand], startPoint: .top, endPoint: .bottom))
              .frame(width: 3, height: 4 + v * 22)
              .opacity(0.45 + Double(i) / Double(OverlayModel.bars) * 0.55)
          }
        }
        .animation(.easeOut(duration: 0.09), value: model.levels)
        TimelineView(.periodic(from: .now, by: 0.25)) { ctx in
          let s = Int(ctx.date.timeIntervalSince(model.startedAt))
          Text(String(format: "%d:%02d", s / 60, s % 60)).font(.system(size: 12, weight: .semibold, design: .monospaced))
            .foregroundStyle(.white.opacity(0.75))
        }
      }
    case .thinking:
      Text("Writing it down…").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
    case .done:
      Text(model.message ?? "Pasted").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
    case .error:
      Text(model.message ?? "Something went wrong").font(.system(size: 12.5, weight: .medium)).foregroundStyle(.white)
        .lineLimit(2).frame(maxWidth: 320, alignment: .leading)
    case .hidden:
      EmptyView()
    }
  }
}
