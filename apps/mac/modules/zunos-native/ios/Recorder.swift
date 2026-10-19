import AVFoundation

/// Records the default input device to a 16-bit mono WAV at the device's sample rate (48 kHz on most Macs).
/// Echo cancellation, noise suppression and gain control stay off: training wants the raw room sound.
final class Recorder {
  private let engine = AVAudioEngine()
  private var file: AVAudioFile?
  private var path: String?
  private var frames: AVAudioFramePosition = 0
  private var peak: Float = 0
  private var startedAt: Date?
  private let lock = NSLock()

  var onLevel: ((Float, Float) -> Void)?

  var isRecording: Bool { file != nil }

  static func permission() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    default: return "undetermined"
    }
  }

  static func requestPermission(_ done: @escaping (String) -> Void) {
    AVCaptureDevice.requestAccess(for: .audio) { granted in done(granted ? "granted" : "denied") }
  }

  func start(path: String) throws -> [String: Any] {
    if isRecording { throw RecorderError.busy }
    let input = engine.inputNode
    let inFormat = input.outputFormat(forBus: 0)
    guard inFormat.sampleRate > 0 else { throw RecorderError.noInput }
    let rate = inFormat.sampleRate

    try FileManager.default.createDirectory(
      atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: rate,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
    ]
    // Processing format is mono float32; AVAudioFile converts to 16-bit PCM on write.
    guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)
    else { throw RecorderError.noInput }
    let out = try AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: settings,
                              commonFormat: .pcmFormatFloat32, interleaved: false)
    let converter = inFormat.channelCount == 1 ? nil : AVAudioConverter(from: inFormat, to: mono)

    lock.lock()
    file = out; self.path = path; frames = 0; peak = 0; startedAt = Date()
    lock.unlock()

    input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
      guard let self else { return }
      var buf = buffer
      if let converter {
        guard let m = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength) else { return }
        var fed = false
        converter.convert(to: m, error: nil) { _, status in
          if fed { status.pointee = .noDataNow; return nil }
          fed = true; status.pointee = .haveData; return buffer
        }
        buf = m
      }
      self.write(buf)
    }
    engine.prepare()
    try engine.start()
    return ["path": path, "sampleRate": rate]
  }

  private func write(_ buf: AVAudioPCMBuffer) {
    guard let ch = buf.floatChannelData?[0] else { return }
    let n = Int(buf.frameLength)
    var sum: Float = 0, p: Float = 0
    for i in 0..<n { let v = ch[i]; sum += v * v; p = max(p, abs(v)) }
    lock.lock()
    try? file?.write(from: buf)
    frames += AVAudioFramePosition(n)
    peak = max(peak, p)
    lock.unlock()
    onLevel?(n > 0 ? sqrt(sum / Float(n)) : 0, p)
  }

  /// Stops and finalizes the WAV. `peak` 0 means macOS delivered pure silence (no mic permission).
  func stop() -> [String: Any] {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    lock.lock()
    defer { lock.unlock() }
    let rate = file?.processingFormat.sampleRate ?? 48000
    let result: [String: Any] = [
      "path": path ?? "",
      "seconds": Double(frames) / rate,
      "sampleRate": rate,
      "peak": Double(peak),
    ]
    file = nil; path = nil
    return result
  }
}

enum RecorderError: Error, CustomStringConvertible {
  case busy, noInput
  var description: String {
    switch self {
    case .busy: return "Already recording."
    case .noInput: return "No microphone input is available."
    }
  }
}
