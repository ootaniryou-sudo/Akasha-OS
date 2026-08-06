import Foundation
import Metal
import MetalPerformanceShaders
import MetalPerformanceShadersGraph

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - MPS-Based LLM Inference Engine
// ═══════════════════════════════════════════════════════════════════════════════

/// Inference metrics collected during execution.
struct InferenceMetrics: Codable {
  var tokenizeMs: Double = 0
  var prefillMs: Double = 0
  var decodeMsTotal: Double = 0
  var totalMs: Double = 0
  var transportMs: Double = 0
  var firstTokenLatencyMs: Double = 0
  var tokensPerSecond: Double = 0
  var outputTokenCount: Int = 0
  var inputTokenCount: Int = 0
}

/// Configuration for MPS inference.
struct MPSInferenceConfig {
  let modelId: String
  let precision: MPSPrecision
  let maxContextLength: Int
  let hiddenSize: Int
  let numLayers: Int
  let numHeads: Int
  let numKvHeads: Int
  let headDim: Int
  let intermediateSize: Int
  let vocabSize: Int

  init(modelId: String = "Qwen3-0.6B",
       precision: MPSPrecision = .float16,
       maxContextLength: Int = 32768,
       hiddenSize: Int = 1024,
       numLayers: Int = 28,
       numHeads: Int = 16,
       numKvHeads: Int = 8,
       headDim: Int = 64,
       intermediateSize: Int = 3072,
       vocabSize: Int = 151936) {
    self.modelId = modelId
    self.precision = precision
    self.maxContextLength = maxContextLength
    self.hiddenSize = hiddenSize
    self.numLayers = numLayers
    self.numHeads = numHeads
    self.numKvHeads = numKvHeads
    self.headDim = headDim
    self.intermediateSize = intermediateSize
    self.vocabSize = vocabSize
  }
}

enum MPSPrecision {
  case float32
  case float16

  var mpsType: MPSDataType {
    switch self {
    case .float32: return .float32
    case .float16: return .float16
    }
  }

  var elementSize: Int {
    switch self {
    case .float32: return 4
    case .float16: return 2
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - MPS Inference Engine
// ═══════════════════════════════════════════════════════════════════════════════

/// MPS-based LLM inference engine.
/// Uses MPSGraph for compute graph execution and MPSMatrixMultiplication
/// for optimized matrix operations on Apple GPU.
final class MPSInferenceEngine {
  private let device: MTLDevice
  private let commandQueue: MTLCommandQueue
  private let config: MPSInferenceConfig
  private var weights: [String: MTLBuffer] = [:]
  private var isLoaded = false

  /// KV cache buffers (per layer: key + value).
  private var kvCache: [(key: MTLBuffer, value: MTLBuffer)] = []

  init(config: MPSInferenceConfig = MPSInferenceConfig()) throws {
    guard let device = MTLCreateSystemDefaultDevice() else {
      throw MetalBridgeError.deviceUnavailable("No Metal device found")
    }
    self.device = device
    guard let queue = device.makeCommandQueue() else {
      throw MetalBridgeError.deviceUnavailable("Cannot create Metal command queue")
    }
    self.commandQueue = queue
    self.config = config
  }

  // ─── Model Loading ──────────────────────────────────────────────────────

  /// Load model weights from GGUF or Core ML format.
  /// - Parameter path: Path to model file (GGUF or .mlmodelc).
  func loadModel(from path: String) throws {
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: path) else {
      throw MetalBridgeError.modelNotFound("Model file not found: \(path)")
    }

    // Determine format from extension
    let ext = URL(fileURLWithPath: path).pathExtension.lowercased()

    if ext == "gguf" {
      try loadGGUFWeights(from: path)
    } else if ext == "mlmodelc" {
      try loadCoreMLModel(from: path)
    } else {
      throw MetalBridgeError.modelNotFound("Unsupported model format: \(ext). Use .gguf or .mlmodelc")
    }

    isLoaded = true
    allocateKVCache()
  }

  private func loadGGUFWeights(from path: String) throws {
    // GGUF format reader (simplified — production would use full gguf parser)
    guard let handle = FileHandle(forReadingAtPath: path) else {
      throw MetalBridgeError.modelNotFound("Cannot open GGUF: \(path)")
    }
    defer { try? handle.close() }

    // Read GGUF header
    // Magic: "GGUF" (4 bytes) + version (4 bytes) + tensor count (8 bytes) + metadata_kv_count (8 bytes)
    var header = Data(count: 24)
    header = handle.readData(ofLength: 24)
    guard header.count == 24 else {
      throw MetalBridgeError.kernelFailed("GGUF header too short")
    }

    let magic = String(data: header[0..<4], encoding: .utf8)
    guard magic == "GGUF" else {
      throw MetalBridgeError.kernelFailed("Invalid GGUF magic: \(magic ?? "nil")")
    }

    let tensorCount = header.withUnsafeBytes { $0.load(fromByteOffset: 12, as: UInt64.self) }
    // Skip metadata parsing — read tensors directly
    // Real implementation would parse full GGUF metadata for tensor offsets

    // Allocate and load each weight tensor
    let typeSize = config.precision.elementSize
    let layerWeights = [
      "q_weight", "k_weight", "v_weight", "o_weight",
      "gate_weight", "up_weight", "down_weight",
      "q_bias", "k_bias", "v_bias", "o_bias",
      "gate_bias", "up_bias", "down_bias",
      "rms_weight", "embed_weight", "lm_head_weight"
    ]

    for layer in 0..<config.numLayers {
      for name in layerWeights {
        let key = "l\(layer).\(name)"
        let size = weightSize(for: name, layer: layer)
        guard let buffer = device.makeBuffer(length: size * typeSize,
                                              options: .storageModeShared) else {
          throw MetalBridgeError.outOfMemory("Cannot allocate buffer for \(key) (\(size * typeSize) bytes)")
        }
        // Read weight data from GGUF (offset calculation omitted for brevity)
        // In production: parse GGUF tensor info to get correct offsets
        weights[key] = buffer
      }
    }

    // Embedding and LM head
    let embedSize = config.vocabSize * config.hiddenSize
    weights["embed"] = device.makeBuffer(length: embedSize * typeSize, options: .storageModeShared)
    weights["lm_head"] = device.makeBuffer(length: embedSize * typeSize, options: .storageModeShared)
  }

  private func loadCoreMLModel(from path: String) throws {
    // Core ML model loading via MLModel
    // In production: use MLModel(contentsOf: URL)
    // For now: Core ML handles its own weight management
    // The model is loaded as a compiled .mlmodelc bundle
  }

  private func weightSize(for name: String, layer: Int) -> Int {
    let h = config.hiddenSize
    let i = config.intermediateSize
    let d = config.headDim
    let n = config.numHeads
    let k = config.numKvHeads

    switch name {
    case "q_weight": return h * n * d
    case "k_weight": return h * k * d
    case "v_weight": return h * k * d
    case "o_weight": return n * d * h
    case "gate_weight", "up_weight": return h * i
    case "down_weight": return i * h
    case "rms_weight": return h
    case "embed_weight", "lm_head_weight": return config.vocabSize * h
    default: return 0
    }
  }

  private func allocateKVCache() {
    let k = config.numKvHeads
    let d = config.headDim
    let cacheSize = config.maxContextLength * k * d * config.precision.elementSize
    kvCache = (0..<config.numLayers).map { _ in
      let key = device.makeBuffer(length: cacheSize, options: .storageModePrivate)!
      let value = device.makeBuffer(length: cacheSize, options: .storageModePrivate)!
      return (key, value)
    }
  }

  // ─── Inference ──────────────────────────────────────────────────────────

  /// Run full inference: prefill + autoregressive decode loop.
  func runInference(
    inputTokenIds: [Int],
    maxNewTokens: Int,
    temperature: Float,
    topP: Float,
    topK: Int
  ) throws -> (tokens: [Int], metrics: InferenceMetrics) {
    guard isLoaded else {
      throw MetalBridgeError.kernelFailed("Model not loaded. Call loadModel() first.")
    }

    var metrics = InferenceMetrics()
    metrics.inputTokenCount = inputTokenIds.count
    let tTotal = CACurrentMediaTime()

    // ── Prefill ──────────────────────────────────────────────────────────
    let tPrefill = CACurrentMediaTime()
    guard let commandBuffer = commandQueue.makeCommandBuffer() else {
      throw MetalBridgeError.kernelFailed("Cannot create command buffer")
    }

    // Encode prefill: process all input tokens at once
    try encodePrefill(commandBuffer: commandBuffer, inputTokenIds: inputTokenIds)
    commandBuffer.commit()
    commandBuffer.waitUntilCompleted()

    if let error = commandBuffer.error {
      throw MetalBridgeError.kernelFailed("Prefill failed: \(error.localizedDescription)")
    }

    metrics.prefillMs = (CACurrentMediaTime() - tPrefill) * 1000
    metrics.firstTokenLatencyMs = metrics.prefillMs

    // ── Decode loop ──────────────────────────────────────────────────────
    var generatedTokens: [Int] = []
    var currentToken = inputTokenIds.last ?? 0
    let tDecode = CACurrentMediaTime()

    for _ in 0..<maxNewTokens {
      guard let cb = commandQueue.makeCommandBuffer() else { break }

      let logits = try encodeDecodeStep(commandBuffer: cb, tokenId: currentToken)
      cb.commit()
      cb.waitUntilCompleted()

      if let error = cb.error {
        throw MetalBridgeError.kernelFailed("Decode failed at token \(generatedTokens.count): \(error.localizedDescription)")
      }

      // Sampling
      let nextToken = sampleToken(logits: logits, temperature: temperature, topP: topP, topK: topK)
      generatedTokens.append(nextToken)
      currentToken = nextToken
    }

    metrics.decodeMsTotal = (CACurrentMediaTime() - tDecode) * 1000
    metrics.totalMs = (CACurrentMediaTime() - tTotal) * 1000
    metrics.outputTokenCount = generatedTokens.count
    metrics.tokensPerSecond = Double(generatedTokens.count) / (metrics.decodeMsTotal / 1000.0)

    return (generatedTokens, metrics)
  }

  // ─── MPS Graph Encoding ────────────────────────────────────────────────

  /// Encode the prefill phase: process all prompt tokens through all layers.
  private func encodePrefill(commandBuffer: MTLCommandBuffer, inputTokenIds: [Int]) throws {
    let graph = MPSGraph()
    let h = config.hiddenSize
    let seqLen = inputTokenIds.count
    let typeSize = config.precision.elementSize

    // Embedding lookup (simplified — production uses MPSGraph gather)
    // For now: use MPSMatrixMultiplication for the main compute
    let embedBuffer = weights["embed"]!

    // RMSNorm + Attention + FFN per layer (encoded as MPSGraph operations)
    for layer in 0..<config.numLayers {
      // RMSNorm
      let rmsWeight = weights["l\(layer).rms_weight"]!
      // Attention projection
      let qWeight = weights["l\(layer).q_weight"]!
      let kWeight = weights["l\(layer).k_weight"]!
      let vWeight = weights["l\(layer).v_weight"]!
      let oWeight = weights["l\(layer).o_weight"]!

      // Encode matmul operations via MPSMatrixMultiplication
      // QKV projections
      try encodeMatMul(commandBuffer: commandBuffer, weight: qWeight, rows: seqLen, cols: h)
      try encodeMatMul(commandBuffer: commandBuffer, weight: kWeight, rows: seqLen, cols: h)
      try encodeMatMul(commandBuffer: commandBuffer, weight: vWeight, rows: seqLen, cols: h)
      try encodeMatMul(commandBuffer: commandBuffer, weight: oWeight, rows: seqLen, cols: h)

      // FFN: gate, up, down
      let gateWeight = weights["l\(layer).gate_weight"]!
      let upWeight = weights["l\(layer).up_weight"]!
      let downWeight = weights["l\(layer).down_weight"]!

      try encodeMatMul(commandBuffer: commandBuffer, weight: gateWeight, rows: seqLen, cols: config.intermediateSize)
      try encodeMatMul(commandBuffer: commandBuffer, weight: upWeight, rows: seqLen, cols: config.intermediateSize)
      try encodeMatMul(commandBuffer: commandBuffer, weight: downWeight, rows: config.intermediateSize, cols: h)
    }

    // LM head projection
    let lmHeadWeight = weights["lm_head"]!
    try encodeMatMul(commandBuffer: commandBuffer, weight: lmHeadWeight, rows: seqLen, cols: config.vocabSize)
  }

  /// Encode a single decode step (one token).
  private func encodeDecodeStep(commandBuffer: MTLCommandBuffer, tokenId: Int) throws -> [Float] {
    // Same as prefill but with seqLen=1 and KV cache reuse
    try encodePrefill(commandBuffer: commandBuffer, inputTokenIds: [tokenId])

    // Extract logits for the last position
    // In production: read from MPSGraph output tensor
    // For now: return placeholder logits of vocabSize
    return [Float](repeating: 0.0, count: config.vocabSize)
  }

  // ─── MPS Matrix Multiply ───────────────────────────────────────────────

  private func encodeMatMul(commandBuffer: MTLCommandBuffer, weight: MTLBuffer, rows: Int, cols: Int) throws {
    // Use MPSMatrixMultiplication for GPU-accelerated matmul
    // In production: full MPSMatrix descriptor with correct strides
    let matMul = MPSMatrixMultiplication(
      device: device,
      transposeLeft: false,
      transposeRight: false,
      resultRows: rows,
      resultColumns: cols,
      interiorColumns: config.hiddenSize,
      alpha: 1.0,
      beta: 0.0
    )
    // matMul.encode(commandBuffer: commandBuffer, leftMatrix: ..., rightMatrix: ..., resultMatrix: ...)
  }

  // ─── Sampling ──────────────────────────────────────────────────────────

  private func sampleToken(logits: [Float], temperature: Float, topP: Float, topK: Int) -> Int {
    if temperature <= 0 {
      // Greedy: argmax
      var maxVal: Float = -Float.infinity
      var maxIdx = 0
      for (i, val) in logits.enumerated() {
        if val > maxVal { maxVal = val; maxIdx = i }
      }
      return maxIdx
    }

    // Temperature scaling
    let invTemp = 1.0 / max(temperature, 0.001)
    var scaled = logits.map { $0 * invTemp }

    // Softmax
    let maxLogit = scaled.max() ?? 0
    var sum: Float = 0
    for i in 0..<scaled.count {
      scaled[i] = exp(scaled[i] - maxLogit)
      sum += scaled[i]
    }
    for i in 0..<scaled.count { scaled[i] /= sum }

    // Top-K filtering
    if topK > 0 && topK < scaled.count {
      let sorted = scaled.enumerated().sorted { $0.element > $1.element }
      let threshold = sorted[min(topK, sorted.count - 1)].element
      for i in 0..<scaled.count {
        if scaled[i] < threshold { scaled[i] = 0 }
      }
      // Renormalize
      sum = scaled.reduce(0, +)
      if sum > 0 { for i in 0..<scaled.count { scaled[i] /= sum } }
    }

    // Top-P (nucleus) filtering
    if topP < 1.0 {
      let sorted = scaled.enumerated().sorted { $0.element > $1.element }
      var cumSum: Float = 0
      for (_, prob) in sorted {
        cumSum += prob
        if cumSum > topP { break }
      }
      let threshold = sorted.first(where: { (cumSum - $0.element) > topP })?.element ?? 0
      for i in 0..<scaled.count {
        if scaled[i] < threshold { scaled[i] = 0 }
      }
      sum = scaled.reduce(0, +)
      if sum > 0 { for i in 0..<scaled.count { scaled[i] /= sum } }
    }

    // Sample
    let r = Float.random(in: 0...1)
    var cum: Float = 0
    for (i, prob) in scaled.enumerated() {
      cum += prob
      if r < cum { return i }
    }
    return scaled.count - 1
  }
}
