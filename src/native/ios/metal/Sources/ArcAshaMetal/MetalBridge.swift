import Foundation
import Metal

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - Metal Bridge Errors
// ═══════════════════════════════════════════════════════════════════════════════

enum MetalBridgeError: Error, CustomStringConvertible {
  case deviceUnavailable(String)
  case modelNotFound(String)
  case outOfMemory(String)
  case kernelFailed(String)
  case timeout(String)
  case invalidShape(String)
  case invalidDtype(String)
  case notInitialized(String)

  var description: String {
    switch self {
    case .deviceUnavailable(let m): return "DEVICE_UNAVAILABLE: \(m)"
    case .modelNotFound(let m): return "MODEL_NOT_FOUND: \(m)"
    case .outOfMemory(let m): return "OOM: \(m)"
    case .kernelFailed(let m): return "KERNEL_FAILED: \(m)"
    case .timeout(let m): return "TIMEOUT: \(m)"
    case .invalidShape(let m): return "INVALID_SHAPE: \(m)"
    case .invalidDtype(let m): return "INVALID_DTYPE: \(m)"
    case .notInitialized(let m): return "NOT_INITIALIZED: \(m)"
    }
  }

  var code: String {
    switch self {
    case .deviceUnavailable: return "DEVICE_UNAVAILABLE"
    case .modelNotFound: return "MODEL_NOT_FOUND"
    case .outOfMemory: return "OOM"
    case .kernelFailed: return "KERNEL_FAILED"
    case .timeout: return "TIMEOUT"
    case .invalidShape: return "INVALID_SHAPE"
    case .invalidDtype: return "INVALID_DTYPE"
    case .notInitialized: return "NOT_INITIALIZED"
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - Metal Device Info
// ═══════════════════════════════════════════════════════════════════════════════

struct MetalDeviceInfo: Codable {
  let gpuFamily: String
  let maxBufferSize: Int
  let unifiedMemory: Bool
  let metalVersion: String
  let available: Bool
  let recommendedMaxWorkingSetSize: UInt64
  let hasUnifiedMemory: Bool
  let supportsFamilyApple7: Bool
  let supportsFamilyApple8: Bool
  let supportsFamilyApple9: Bool

  static func current(device: MTLDevice) -> MetalDeviceInfo {
    MetalDeviceInfo(
      gpuFamily: device.name,
      maxBufferSize: device.maxBufferLength,
      unifiedMemory: device.hasUnifiedMemory,
      metalVersion: "Metal \(device.supportsFamily(.apple9) ? "3" : device.supportsFamily(.apple8) ? "3" : "2")",
      available: true,
      recommendedMaxWorkingSetSize: device.recommendedMaxWorkingSetSize,
      hasUnifiedMemory: device.hasUnifiedMemory,
      supportsFamilyApple7: device.supportsFamily(.apple7),
      supportsFamilyApple8: device.supportsFamily(.apple8),
      supportsFamilyApple9: device.supportsFamily(.apple9)
    )
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - Bridge Request / Response
// ═══════════════════════════════════════════════════════════════════════════════

/// Request from TypeScript to native Metal.
struct MetalBridgeRequest: Codable {
  let modelId: String
  let inputTokenIds: [Int]
  let maxNewTokens: Int
  let temperature: Float
  let topP: Float
  let topK: Int
  let precision: String
}

/// Response from native Metal to TypeScript.
struct MetalBridgeResponse: Codable {
  let outputTokenIds: [Int]
  let text: String
  let timing: TimingInfo
  let error: ErrorInfo?

  struct TimingInfo: Codable {
    let prefillMs: Double
    let decodeMs: Double
    let totalMs: Double
  }

  struct ErrorInfo: Codable {
    let code: String
    let message: String
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - Metal Bridge — Main Entry Point
// ═══════════════════════════════════════════════════════════════════════════════

/// Main bridge class connecting TypeScript ↔ Metal inference.
///
/// ## Integration with TypeScript
///
/// This class is called from TypeScript via:
///   - WKScriptMessageHandler (in-browser WebKit)
///   - JavaScriptCore JSContext (native app)
///   - Custom URL scheme handler
///
/// The bridge receives JSON requests, runs Metal inference,
/// and returns JSON responses with tokens + timing.
final class MetalBridge: NSObject {
  private var engine: MPSInferenceEngine?
  private var deviceInfo: MetalDeviceInfo?
  private var isInitialized = false
  private var tokenizer: TokenizerBridge?

  // ─── Initialization ─────────────────────────────────────────────────────

  func initialize(modelPath: String? = nil) throws -> Bool {
    guard let device = MTLCreateSystemDefaultDevice() else {
      throw MetalBridgeError.deviceUnavailable("No Metal-capable GPU found on this device")
    }

    deviceInfo = MetalDeviceInfo.current(device: device)
    engine = try MPSInferenceEngine(config: MPSInferenceConfig())

    if let path = modelPath {
      try engine?.loadModel(from: path)
    }

    // Initialize tokenizer bridge (connects to ArcAsha tokenizer)
    tokenizer = TokenizerBridge()

    isInitialized = true
    return true
  }

  // ─── Capabilities ───────────────────────────────────────────────────────

  func getCapabilities() -> [String: Any] {
    guard let info = deviceInfo else {
      return ["available": false, "reason": "not_initialized"]
    }

    return [
      "type": "metal_ios",
      "name": "Asha Metal (iOS Metal/MPS)",
      "supportedPrecisions": ["fp16", "fp32"],
      "maxContextLength": engine.map { _ in 32768 } ?? 0,
      "available": isInitialized,
      "platform": "ios-arm64",
      "device": info.gpuFamily,
      "metalVersion": info.metalVersion,
      "unifiedMemory": info.unifiedMemory,
      "maxBufferSize": info.maxBufferSize,
      "supportsAppleGPUFamily7": info.supportsFamilyApple7,
      "supportsAppleGPUFamily8": info.supportsFamilyApple8,
      "supportsAppleGPUFamily9": info.supportsFamilyApple9
    ]
  }

  func isMetalAvailable() -> Bool {
    return MTLCreateSystemDefaultDevice() != nil
  }

  // ─── Inference ──────────────────────────────────────────────────────────

  /// Process an inference request from TypeScript.
  /// - Parameter json: JSON string matching MetalBridgeRequest format.
  /// - Returns: JSON string matching MetalBridgeResponse format.
  func processRequest(json: String) -> String {
    guard isInitialized, let engine = engine else {
      return errorResponse(code: "NOT_INITIALIZED", message: "MetalBridge not initialized")
    }

    guard let data = json.data(using: .utf8),
          let request = try? JSONDecoder().decode(MetalBridgeRequest.self, from: data) else {
      return errorResponse(code: "INVALID_REQUEST", message: "Cannot parse request JSON")
    }

    // Validate shapes
    guard !request.inputTokenIds.isEmpty else {
      return errorResponse(code: "INVALID_SHAPE", message: "Empty input token sequence")
    }

    let tStart = CACurrentMediaTime()

    do {
      let (tokens, metrics) = try engine.runInference(
        inputTokenIds: request.inputTokenIds,
        maxNewTokens: request.maxNewTokens,
        temperature: request.temperature,
        topP: request.topP,
        topK: request.topK
      )

      // Detokenize
      let text = tokenizer?.decode(tokens) ?? "[token ids: \(tokens.prefix(10).map(String.init).joined(separator: ", "))...]"

      let transportMs = (CACurrentMediaTime() - tStart) * 1000 - metrics.totalMs

      let response = MetalBridgeResponse(
        outputTokenIds: tokens,
        text: text,
        timing: MetalBridgeResponse.TimingInfo(
          prefillMs: metrics.prefillMs,
          decodeMs: metrics.decodeMsTotal,
          totalMs: metrics.totalMs
        ),
        error: nil
      )

      return String(data: try! JSONEncoder().encode(response), encoding: .utf8)!
    } catch let error as MetalBridgeError {
      return errorResponse(code: error.code, message: error.description)
    } catch {
      return errorResponse(code: "KERNEL_FAILED", message: error.localizedDescription)
    }
  }

  /// Shutdown and release Metal resources.
  func shutdown() {
    engine = nil
    isInitialized = false
    tokenizer = nil
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private func errorResponse(code: String, message: String) -> String {
    let resp = MetalBridgeResponse(
      outputTokenIds: [],
      text: "",
      timing: MetalBridgeResponse.TimingInfo(prefillMs: 0, decodeMs: 0, totalMs: 0),
      error: MetalBridgeResponse.ErrorInfo(code: code, message: message)
    )
    return String(data: try! JSONEncoder().encode(resp), encoding: .utf8)!
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - Tokenizer Bridge
// ═══════════════════════════════════════════════════════════════════════════════

/// Minimal tokenizer bridge for Qwen3 tokenizer.
/// In production, this uses the ArcAsha tokenizer from TypeScript side.
/// For standalone Metal testing, a basic vocabulary is loaded.
final class TokenizerBridge {
  private var vocab: [Int: String] = [:]
  private var reverseVocab: [String: Int] = [:]

  init() {
    // Load minimal vocabulary for Qwen3 tokenizer
    // In production: load full 151936-token vocabulary from tokenizer.json
    // For now: basic ASCII mapping for testing
    for i in 32...126 {
      let char = String(UnicodeScalar(i)!)
      vocab[i] = char
      reverseVocab[char] = i
    }
    // Common tokens
    let commonTokens: [(Int, String)] = [
      (0, "<unk>"), (1, "<s>"), (2, "</s>"),
      (3838, "What"), (374, " is"), (220, " 2"), (17, " +"), (488, " +"),
      (576, " The"), (6722, " capital"), (315, " of"), (6323, " Japan"),
      (26194, " Tokyo"), (13, "."),
    ]
    for (id, token) in commonTokens {
      vocab[id] = token
      reverseVocab[token] = id
    }
  }

  func encode(_ text: String) -> [Int] {
    // Simple word-level encoding (production uses full BPE tokenizer)
    return text.split(separator: " ").compactMap { word in
      reverseVocab[String(word)] ?? Int(word.hashValue & 0xFFFF)
    }
  }

  func decode(_ tokenIds: [Int]) -> String {
    return tokenIds.compactMap { vocab[$0] ?? "[\($0)]" }.joined(separator: "")
  }
}
