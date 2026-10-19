import Foundation

/// File uploads and downloads to presigned URLs, streamed from/to disk (datasets and models are large).
final class Transfer: NSObject, URLSessionTaskDelegate, URLSessionDownloadDelegate {
  var onProgress: ((String, Int64, Int64) -> Void)?
  private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
  private var waiters: [Int: (id: String, dest: String?, done: (Result<Int, Error>) -> Void)] = [:]
  private let lock = NSLock()

  func upload(id: String, url: String, path: String, contentType: String, done: @escaping (Result<Int, Error>) -> Void) {
    guard let u = URL(string: url) else { return done(.failure(TransferError.badURL)) }
    var req = URLRequest(url: u)
    req.httpMethod = "PUT"
    req.setValue(contentType, forHTTPHeaderField: "Content-Type")
    let task = session.uploadTask(with: req, fromFile: URL(fileURLWithPath: path))
    track(task, id: id, dest: nil, done: done)
    task.resume()
  }

  func download(id: String, url: String, dest: String, done: @escaping (Result<Int, Error>) -> Void) {
    guard let u = URL(string: url) else { return done(.failure(TransferError.badURL)) }
    let task = session.downloadTask(with: u)
    track(task, id: id, dest: dest, done: done)
    task.resume()
  }

  private func track(_ task: URLSessionTask, id: String, dest: String?, done: @escaping (Result<Int, Error>) -> Void) {
    lock.lock(); waiters[task.taskIdentifier] = (id, dest, done); lock.unlock()
  }

  private func take(_ task: URLSessionTask) -> (id: String, dest: String?, done: (Result<Int, Error>) -> Void)? {
    lock.lock(); defer { lock.unlock() }
    return waiters.removeValue(forKey: task.taskIdentifier)
  }

  private func peek(_ task: URLSessionTask) -> (id: String, dest: String?, done: (Result<Int, Error>) -> Void)? {
    lock.lock(); defer { lock.unlock() }
    return waiters[task.taskIdentifier]
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData _: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    if let w = peek(task) { onProgress?(w.id, totalBytesSent, totalBytesExpectedToSend) }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    if let w = peek(downloadTask) { onProgress?(w.id, totalBytesWritten, totalBytesExpectedToWrite) }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    // The temp file is deleted when this returns, so move it now.
    guard let w = peek(downloadTask), let dest = w.dest else { return }
    let to = URL(fileURLWithPath: dest)
    try? FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: to)
    do { try FileManager.default.moveItem(at: location, to: to) } catch { lock.lock(); waiters[downloadTask.taskIdentifier] = nil; lock.unlock(); w.done(.failure(error)) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let w = take(task) else { return }
    if let error { return w.done(.failure(error)) }
    let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
    w.done(status >= 200 && status < 300 ? .success(status) : .failure(TransferError.http(status)))
  }
}

enum TransferError: Error, CustomStringConvertible {
  case badURL, http(Int)
  var description: String {
    switch self {
    case .badURL: return "Invalid URL."
    case .http(let s): return "The server returned HTTP \(s)."
    }
  }
}
