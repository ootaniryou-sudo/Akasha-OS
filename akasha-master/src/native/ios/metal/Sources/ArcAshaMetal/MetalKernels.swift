import Foundation
import Metal

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - Custom Metal Kernel Wrapper
// ═══════════════════════════════════════════════════════════════════════════════

/// Wraps custom Metal shader functions from qwen_ops.metal.
/// Falls back to MPS when custom kernels are not needed.
final class MetalKernels {
  private let device: MTLDevice
  private let library: MTLLibrary
  private let commandQueue: MTLCommandQueue

  // Kernel functions
  private let rmsNormPipeline: MTLComputePipelineState
  private let rmsNormF16Pipeline: MTLComputePipelineState
  private let ropePipeline: MTLComputePipelineState
  private let swigluPipeline: MTLComputePipelineState
  private let swigluF16Pipeline: MTLComputePipelineState
  private let kvCacheUpdatePipeline: MTLComputePipelineState

  init() throws {
    guard let device = MTLCreateSystemDefaultDevice() else {
      throw MetalBridgeError.deviceUnavailable("No Metal device")
    }
    self.device = device

    guard let queue = device.makeCommandQueue() else {
      throw MetalBridgeError.deviceUnavailable("No command queue")
    }
    self.commandQueue = queue

    // Compile Metal shader library
    guard let libPath = Bundle.module.path(forResource: "qwen_ops", ofType: "metal") else {
      // Fallback: compile from source string embedded in app
      let shaderSource = try MetalKernels.embeddedShaderSource()
      self.library = try device.makeLibrary(source: shaderSource, options: nil)
      self.rmsNormPipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "rms_norm")!)
      self.rmsNormF16Pipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "rms_norm_f16")!)
      self.ropePipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "rope")!)
      self.swigluPipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "swiglu")!)
      self.swigluF16Pipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "swiglu_f16")!)
      self.kvCacheUpdatePipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "kv_cache_update")!)
      return
    }

    self.library = try device.makeLibrary(filepath: libPath)
    self.rmsNormPipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "rms_norm")!)
    self.rmsNormF16Pipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "rms_norm_f16")!)
    self.ropePipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "rope")!)
    self.swigluPipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "swiglu")!)
    self.swigluF16Pipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "swiglu_f16")!)
    self.kvCacheUpdatePipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "kv_cache_update")!)
  }

  // ─── RMSNorm ──────────────────────────────────────────────────────────────

  func rmsNorm(
    x: MTLBuffer, weight: MTLBuffer, y: MTLBuffer,
    size: Int, eps: Float, useFP16: Bool = true
  ) throws {
    guard let cb = commandQueue.makeCommandBuffer(),
          let encoder = cb.makeComputeCommandEncoder() else {
      throw MetalBridgeError.kernelFailed("Cannot create command encoder")
    }

    let pipeline = useFP16 ? rmsNormF16Pipeline : rmsNormPipeline
    encoder.setComputePipelineState(pipeline)
    encoder.setBuffer(x, offset: 0, index: 0)
    encoder.setBuffer(weight, offset: 0, index: 1)
    encoder.setBuffer(y, offset: 0, index: 2)
    var s = UInt32(size); encoder.setBytes(&s, length: 4, index: 3)
    var e = eps; encoder.setBytes(&e, length: 4, index: 4)

    let threadsPerGroup = MTLSize(width: min(256, pipeline.maxTotalThreadsPerThreadgroup), height: 1, depth: 1)
    let groups = MTLSize(width: (size + threadsPerGroup.width - 1) / threadsPerGroup.width, height: 1, depth: 1)
    encoder.dispatchThreadgroups(groups, threadsPerThreadgroup: threadsPerGroup)
    encoder.endEncoding()

    cb.commit()
    cb.waitUntilCompleted()
    if let error = cb.error { throw MetalBridgeError.kernelFailed(error.localizedDescription) }
  }

  // ─── SwiGLU ───────────────────────────────────────────────────────────────

  func swiglu(
    gate: MTLBuffer, up: MTLBuffer, output: MTLBuffer,
    size: Int, useFP16: Bool = true
  ) throws {
    guard let cb = commandQueue.makeCommandBuffer(),
          let encoder = cb.makeComputeCommandEncoder() else {
      throw MetalBridgeError.kernelFailed("Cannot create command encoder")
    }

    let pipeline = useFP16 ? swigluF16Pipeline : swigluPipeline
    encoder.setComputePipelineState(pipeline)
    encoder.setBuffer(gate, offset: 0, index: 0)
    encoder.setBuffer(up, offset: 0, index: 1)
    encoder.setBuffer(output, offset: 0, index: 2)
    var s = UInt32(size); encoder.setBytes(&s, length: 4, index: 3)

    let threadsPerGroup = MTLSize(width: min(256, pipeline.maxTotalThreadsPerThreadgroup), height: 1, depth: 1)
    let groups = MTLSize(width: (size + threadsPerGroup.width - 1) / threadsPerGroup.width, height: 1, depth: 1)
    encoder.dispatchThreadgroups(groups, threadsPerThreadgroup: threadsPerGroup)
    encoder.endEncoding()

    cb.commit()
    cb.waitUntilCompleted()
    if let error = cb.error { throw MetalBridgeError.kernelFailed(error.localizedDescription) }
  }

  // ─── KV Cache Update ──────────────────────────────────────────────────────

  func updateKVCache(
    newK: MTLBuffer, newV: MTLBuffer,
    cacheK: MTLBuffer, cacheV: MTLBuffer,
    cachePos: Int, headDim: Int, numKvHeads: Int
  ) throws {
    guard let cb = commandQueue.makeCommandBuffer(),
          let encoder = cb.makeComputeCommandEncoder() else {
      throw MetalBridgeError.kernelFailed("Cannot create command encoder")
    }

    encoder.setComputePipelineState(kvCacheUpdatePipeline)
    encoder.setBuffer(newK, offset: 0, index: 0)
    encoder.setBuffer(newV, offset: 0, index: 1)
    encoder.setBuffer(cacheK, offset: 0, index: 2)
    encoder.setBuffer(cacheV, offset: 0, index: 3)
    var pos = UInt32(cachePos); encoder.setBytes(&pos, length: 4, index: 4)
    var dim = UInt32(headDim); encoder.setBytes(&dim, length: 4, index: 5)
    var heads = UInt32(numKvHeads); encoder.setBytes(&heads, length: 4, index: 6)

    let total = headDim * numKvHeads
    let threadsPerGroup = MTLSize(width: min(256, kvCacheUpdatePipeline.maxTotalThreadsPerThreadgroup), height: 1, depth: 1)
    let groups = MTLSize(width: (total + threadsPerGroup.width - 1) / threadsPerGroup.width, height: 1, depth: 1)
    encoder.dispatchThreadgroups(groups, threadsPerThreadgroup: threadsPerGroup)
    encoder.endEncoding()

    cb.commit()
    cb.waitUntilCompleted()
    if let error = cb.error { throw MetalBridgeError.kernelFailed(error.localizedDescription) }
  }

  // ─── Embedded Shader Source (fallback) ────────────────────────────────────

  private static func embeddedShaderSource() throws -> String {
    // Fallback: minimal shader source embedded in Swift
    // In production: use Bundle.module to load .metal files
    return """
    #include <metal_stdlib>
    using namespace metal;

    kernel void rms_norm(device const float *x [[buffer(0)]], device const float *w [[buffer(1)]], device float *y [[buffer(2)]], constant uint &n [[buffer(3)]], constant float &eps [[buffer(4)]], uint tid [[thread_position_in_grid]]) {
      if (tid >= n) return;
      threadgroup float s = 0; float v = x[tid]; s += v * v;
      threadgroup float sh[256]; short lane = tid & 255; sh[lane] = s;
      threadgroup_barrier(mem_flags::mem_threadgroup);
      for (uint st = 128; st > 0; st >>= 1) { if (lane < st) sh[lane] += sh[lane + st]; threadgroup_barrier(mem_flags::mem_threadgroup); }
      y[tid] = x[tid] * w[tid] / sqrt(sh[0] / float(n) + eps);
    }

    kernel void rms_norm_f16(device const half *x [[buffer(0)]], device const half *w [[buffer(1)]], device half *y [[buffer(2)]], constant uint &n [[buffer(3)]], constant float &eps [[buffer(4)]], uint tid [[thread_position_in_grid]]) {
      if (tid >= n) return;
      threadgroup float s = 0; float v = float(x[tid]); s += v * v;
      threadgroup float sh[256]; short lane = tid & 255; sh[lane] = s;
      threadgroup_barrier(mem_flags::mem_threadgroup);
      for (uint st = 128; st > 0; st >>= 1) { if (lane < st) sh[lane] += sh[lane + st]; threadgroup_barrier(mem_flags::mem_threadgroup); }
      y[tid] = half(float(x[tid]) * float(w[tid]) / sqrt(sh[0] / float(n) + eps));
    }

    kernel void swiglu(device const float *gate [[buffer(0)]], device const float *up [[buffer(1)]], device float *out [[buffer(2)]], constant uint &n [[buffer(3)]], uint tid [[thread_position_in_grid]]) {
      if (tid >= n) return;
      float g = gate[tid]; out[tid] = (1.0 / (1.0 + exp(-g))) * up[tid];
    }

    kernel void swiglu_f16(device const half *gate [[buffer(0)]], device const half *up [[buffer(1)]], device half *out [[buffer(2)]], constant uint &n [[buffer(3)]], uint tid [[thread_position_in_grid]]) {
      if (tid >= n) return;
      float g = float(gate[tid]); out[tid] = half((1.0 / (1.0 + exp(-g))) * float(up[tid]));
    }

    kernel void kv_cache_update(device const float *nk [[buffer(0)]], device const float *nv [[buffer(1)]], device float *ck [[buffer(2)]], device float *cv [[buffer(3)]], constant uint &pos [[buffer(4)]], constant uint &hd [[buffer(5)]], constant uint &nh [[buffer(6)]], uint tid [[thread_position_in_grid]]) {
      uint t = hd * nh; if (tid >= t) return;
      uint off = pos * t + tid; ck[off] = nk[tid]; cv[off] = nv[tid];
    }
    """
  }
}

