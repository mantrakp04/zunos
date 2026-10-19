import AVFoundation
import CoreAudio

/// Records the default input device to a 16-bit mono WAV at the device's sample rate (48 kHz on most Macs).
/// Echo cancellation, noise suppression and gain control stay off: training wants the raw room sound
/// (the engine cleans a copy for voice cloning afterwards, python/engine enhance.py).
///
/// While it runs it watches the signal (MicMonitor) so the app can tell the user, during the take, about a
/// noisy room, speech that is too quiet or too loud, clipping, pops, long silences, a gated (processed)
/// microphone, or the input device changing. With no path it only listens: the room-tone check.
final class Recorder {
  private let engine = AVAudioEngine()
  private var file: AVAudioFile?
  private var path: String?
  private var listening = false
  private var frames: AVAudioFramePosition = 0
  private var peak: Float = 0
  private var startedAt: Date?
  private var monitor: MicMonitor?
  private var device: [String: Any] = [:]
  private var deviceChanged = false
  private var configObserver: NSObjectProtocol?
  private var defaultInputListener: AudioObjectPropertyListenerBlock?
  private let lock = NSLock()

  var onLevel: ((Float, Float) -> Void)?
  /// Live statistics, about four times a second while listening.
  var onStats: (([String: Any]) -> Void)?
  /// "deviceChanged": the input device or its format changed mid-take (the take stops receiving audio).
  var onEvent: ((String, [String: Any]) -> Void)?

  var isRecording: Bool { listening }

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

  /// `path` nil: listen without writing (room check). `roomSeconds`: how long the start of the take is
  /// treated as room tone (the user was asked to stay quiet).
  func start(path: String?, roomSeconds: Double = 0) throws -> [String: Any] {
    if listening { throw RecorderError.busy }
    let input = engine.inputNode
    let inFormat = input.outputFormat(forBus: 0)
    guard inFormat.sampleRate > 0 else { throw RecorderError.noInput }
    let rate = inFormat.sampleRate

    // Processing format is mono float32; AVAudioFile converts to 16-bit PCM on write.
    guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)
    else { throw RecorderError.noInput }
    var out: AVAudioFile?
    if let path {
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
      out = try AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: settings,
                            commonFormat: .pcmFormatFloat32, interleaved: false)
    }
    let converter = inFormat.channelCount == 1 ? nil : AVAudioConverter(from: inFormat, to: mono)
    var info = Recorder.deviceInfo()
    info["voiceProcessing"] = input.isVoiceProcessingEnabled
    info["formatSampleRate"] = rate
    info["channels"] = Int(inFormat.channelCount)

    lock.lock()
    file = out; self.path = path; frames = 0; peak = 0; startedAt = Date(); listening = true
    monitor = MicMonitor(rate: rate, roomSeconds: roomSeconds)
    device = info; deviceChanged = false
    lock.unlock()
    watchDevice()

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
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      lock.lock(); file = nil; self.path = nil; listening = false; monitor = nil; lock.unlock()
      unwatchDevice()
      throw error
    }
    return ["path": path ?? "", "sampleRate": rate, "device": info]
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
    let stats = monitor?.feed(ch, count: n)
    lock.unlock()
    onLevel?(n > 0 ? sqrt(sum / Float(n)) : 0, p)
    if let stats { onStats?(stats) }
  }

  /// Stops and finalizes the WAV. `peak` 0 means macOS delivered pure silence (no mic permission).
  func stop() -> [String: Any] {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    unwatchDevice()
    lock.lock()
    defer { lock.unlock() }
    let rate = file?.processingFormat.sampleRate ?? monitor?.rate ?? 48000
    var result: [String: Any] = [
      "path": path ?? "",
      "seconds": Double(frames) / rate,
      "sampleRate": rate,
      "peak": Double(peak),
      "device": device,
      "deviceChanged": deviceChanged,
    ]
    if let monitor { result["stats"] = monitor.summary() }
    file = nil; path = nil; listening = false; monitor = nil
    return result
  }

  // MARK: device

  /// The default input device: name, transport (builtIn, usb, bluetooth, bluetoothLE, continuity, ...),
  /// nominal sample rate, input volume (0-1, when the device exposes one) and microphone mode.
  static func deviceInfo() -> [String: Any] {
    var info: [String: Any] = ["transport": "unknown"]
    guard let id = defaultInputDevice() else { return info }
    info["id"] = Int(id)
    if let name: CFString = property(id, kAudioObjectPropertyName) { info["name"] = name as String }
    if let uid: CFString = property(id, kAudioDevicePropertyDeviceUID) { info["uid"] = uid as String }
    if let t: UInt32 = property(id, kAudioDevicePropertyTransportType) { info["transport"] = transportName(t) }
    if let r: Float64 = property(id, kAudioDevicePropertyNominalSampleRate) { info["sampleRate"] = r }
    for element in [kAudioObjectPropertyElementMain, 1] {
      if let v: Float32 = property(id, kAudioDevicePropertyVolumeScalar, scope: kAudioDevicePropertyScopeInput, element: element) {
        info["inputVolume"] = Double(v)
        break
      }
    }
    if #available(macOS 12.0, *) {
      switch AVCaptureDevice.activeMicrophoneMode {
      case .voiceIsolation: info["micMode"] = "voiceIsolation"
      case .wideSpectrum: info["micMode"] = "wideSpectrum"
      default: info["micMode"] = "standard"
      }
    }
    return info
  }

  private static func defaultInputDevice() -> AudioObjectID? {
    var id = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
                                          mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let err = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
    return err == noErr && id != 0 ? id : nil
  }

  private static func property<T>(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector,
                                  scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                                  element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> T? {
    var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
    guard AudioObjectHasProperty(id, &addr) else { return nil }
    var size = UInt32(MemoryLayout<T>.size)
    let ptr = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<T>.alignment)
    defer { ptr.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr) == noErr else { return nil }
    if T.self == CFString.self {
      // CFString properties come back +1 retained.
      return (Unmanaged<CFString>.fromOpaque(ptr.load(as: UnsafeRawPointer.self)).takeRetainedValue() as! T)
    }
    return ptr.load(as: T.self)
  }

  private static func transportName(_ t: UInt32) -> String {
    switch t {
    case kAudioDeviceTransportTypeBuiltIn: return "builtIn"
    case kAudioDeviceTransportTypeUSB: return "usb"
    case kAudioDeviceTransportTypeBluetooth: return "bluetooth"
    case kAudioDeviceTransportTypeBluetoothLE: return "bluetoothLE"
    case kAudioDeviceTransportTypeAggregate, kAudioDeviceTransportTypeAutoAggregate: return "aggregate"
    case kAudioDeviceTransportTypeVirtual: return "virtual"
    case kAudioDeviceTransportTypeHDMI: return "hdmi"
    case kAudioDeviceTransportTypeDisplayPort: return "displayPort"
    case kAudioDeviceTransportTypeAirPlay: return "airPlay"
    case kAudioDeviceTransportTypeThunderbolt: return "thunderbolt"
    case kAudioDeviceTransportTypePCI: return "pci"
    case kAudioDeviceTransportTypeFireWire: return "fireWire"
    case kAudioDeviceTransportTypeAVB: return "avb"
    case kAudioDeviceTransportTypeContinuityCaptureWired, kAudioDeviceTransportTypeContinuityCaptureWireless: return "continuity"
    default: return "unknown"
    }
  }

  /// A take can't survive its device changing: AVAudioEngine stops delivering audio. Flag it.
  private func watchDevice() {
    configObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
    ) { [weak self] _ in self?.changed("configuration") }
    let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.changed("defaultInput") }
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
                                          mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main, block) == noErr {
      defaultInputListener = block
    }
  }

  private func unwatchDevice() {
    if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
    configObserver = nil
    if let block = defaultInputListener {
      var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
                                            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
      AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main, block)
    }
    defaultInputListener = nil
  }

  private func changed(_ why: String) {
    lock.lock()
    let first = listening && !deviceChanged
    if listening { deviceChanged = true }
    lock.unlock()
    if first { onEvent?("deviceChanged", ["reason": why, "device": Recorder.deviceInfo()]) }
  }
}

/// Running statistics of the microphone signal, in 20 ms frames.
final class MicMonitor {
  let rate: Double
  private let frameLen: Int
  private let roomFrames: Int
  private var acc: Float = 0, accLow: Float = 0, accN = 0, hot = 0, hotRun = 0, zeroRun = 0
  private var lp: Float = 0
  private let lpA: Float
  private var recent: [Float] = []  // frame dB, last 3 s
  private var room: [Float] = []
  private var count = 0
  private var speechPow: Float = 0, speechN = 0
  private var lastSpeech = -1, firstSpeech = -1, longestPause = 0
  private var clipEvents = 0, lastClip = -1000
  private var pops = 0, lastPop = -1000
  private var gated = 0, tooLoud = 0
  private var maxPeak: Float = 0, framePeak: Float = 0
  private var lastStats = 0
  private var noiseDb: Float = -90

  init(rate: Double, roomSeconds: Double) {
    self.rate = rate
    frameLen = max(1, Int(rate * 0.02))
    roomFrames = Int(roomSeconds / 0.02)
    lpA = Float(exp(-2 * Double.pi * 150 / rate))  // one-pole low-pass at 150 Hz, for pops
  }

  private func dB(_ p: Float) -> Float { 10 * log10(max(p, 1e-12)) }

  /// Adds samples; returns a stats snapshot about four times a second.
  func feed(_ x: UnsafePointer<Float>, count n: Int) -> [String: Any]? {
    for i in 0..<n {
      let v = x[i]
      acc += v * v
      lp = (1 - lpA) * v + lpA * lp
      accLow += lp * lp
      let a = abs(v)
      framePeak = max(framePeak, a)
      if a >= 0.999 { hotRun += 1; if hotRun == 3 { hot += 1 } } else { hotRun = 0 }
      if v == 0 { zeroRun += 1 } else { zeroRun = 0 }
      accN += 1
      if accN == frameLen { endFrame() }
    }
    if count - lastStats >= 12 {
      lastStats = count
      return snapshot()
    }
    return nil
  }

  private func endFrame() {
    let p = acc / Float(accN)
    let d = dB(p)
    let lowShare = acc > 0 ? accLow / acc : 0
    let wasGated = zeroRun >= accN
    acc = 0; accLow = 0; accN = 0
    maxPeak = max(maxPeak, framePeak)
    if hot > 0 { if count - lastClip > 10 { clipEvents += 1 }; lastClip = count }
    hot = 0
    if wasGated && count > 25 { gated += 1 }
    if count < roomFrames { room.append(d) }
    if !wasGated {
      recent.append(d)
      if recent.count > 150 { recent.removeFirst(recent.count - 150) }
    }
    if recent.count >= 25 {
      let sorted = recent.sorted()
      noiseDb = sorted[sorted.count / 10]
    }
    let speech = d > noiseDb + 12 && d > -60
    if speech {
      speechPow = speechN == 0 ? p : 0.98 * speechPow + 0.02 * p  // ~1 s of speech
      speechN += 1
      if firstSpeech < 0 { firstSpeech = count }
      if lastSpeech >= 0 { longestPause = max(longestPause, count - lastSpeech) }
      lastSpeech = count
      if framePeak > 0.7 { tooLoud += 1 }
      // A pop: most of a loud frame's energy is below 150 Hz.
      if lowShare > 0.75 && framePeak > 0.2 && count - lastPop > 15 { pops += 1; lastPop = count }
    }
    framePeak = 0
    count += 1
  }

  private func snapshot() -> [String: Any] {
    let speechDb: Float? = speechN > 10 ? dB(speechPow) : nil
    var s: [String: Any] = [
      "elapsed": Double(count) * 0.02,
      "noiseDb": Double(noiseDb),
      "peakDb": Double(dB(maxPeak * maxPeak)),
      "clipEvents": clipEvents,
      "clippingNow": count - lastClip < 50,
      "pops": pops,
      "gatedPct": count > 0 ? Double(gated) / Double(count) * 100 : 0,
      "speaking": lastSpeech >= 0 && count - lastSpeech < 15,
      "silenceSec": lastSpeech >= 0 ? Double(count - lastSpeech) * 0.02 : Double(count) * 0.02,
      "longestPauseSec": Double(longestPause) * 0.02,
      "speechSec": Double(speechN) * 0.02,
      "loudPct": speechN > 0 ? Double(tooLoud) / Double(speechN) * 100 : 0,
    ]
    if let speechDb { s["speechDb"] = Double(speechDb); s["snrDb"] = Double(speechDb - noiseDb) }
    if !room.isEmpty {
      let sorted = room.sorted()
      s["roomDb"] = Double(sorted[sorted.count / 2])
      // Talking during the room tone: its loud frames stand far above its median.
      s["roomSpoken"] = (sorted.last ?? -120) - sorted[sorted.count / 2] > 15
      s["roomDone"] = count >= roomFrames
    }
    return s
  }

  func summary() -> [String: Any] { snapshot() }
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
