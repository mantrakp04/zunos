import Foundation

/// Runs the Python engine (zunos-engine) as a child process and relays its JSON lines.
final class EngineProcess {
  private var process: Process?
  private var stdin: FileHandle?
  private var buffer = Data()

  var onLine: ((String) -> Void)?
  var onLog: ((String) -> Void)?
  var onExit: ((Int32) -> Void)?

  var isRunning: Bool { process?.isRunning ?? false }

  /// Launches through a login shell so the user's PATH (uv in ~/.local/bin, Homebrew) applies;
  /// GUI apps don't inherit the shell environment.
  func start(command: String, cwd: String?, env: [String: String]) throws {
    if isRunning { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "exec \(command)"]
    if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    p.environment = ProcessInfo.processInfo.environment.merging(env) { _, new in new }

    let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
    p.standardInput = inPipe
    p.standardOutput = outPipe
    p.standardError = errPipe

    outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let data = h.availableData
      guard let self, !data.isEmpty else { return }
      self.buffer.append(data)
      while let nl = self.buffer.firstIndex(of: 0x0A) {
        let line = String(decoding: self.buffer[..<nl], as: UTF8.self)
        self.buffer.removeSubrange(...nl)
        if !line.isEmpty { self.onLine?(line) }
      }
    }
    errPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let data = h.availableData
      if !data.isEmpty { self?.onLog?(String(decoding: data, as: UTF8.self)) }
    }
    p.terminationHandler = { [weak self] proc in
      outPipe.fileHandleForReading.readabilityHandler = nil
      errPipe.fileHandleForReading.readabilityHandler = nil
      self?.onExit?(proc.terminationStatus)
    }
    try p.run()
    process = p
    stdin = inPipe.fileHandleForWriting
  }

  func send(_ line: String) throws {
    guard let stdin, isRunning else { throw EngineError.notRunning }
    stdin.write(Data((line + "\n").utf8))
  }

  func stop() {
    process?.terminate()
    process = nil
    stdin = nil
  }
}

enum EngineError: Error, CustomStringConvertible {
  case notRunning
  var description: String { "The speech engine is not running." }
}
