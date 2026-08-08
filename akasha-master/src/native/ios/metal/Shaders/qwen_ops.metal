// ═══════════════════════════════════════════════════════════════════════════════
// qwen_ops.metal — Custom Metal Shaders for Qwen3-0.6B Operations
// ═══════════════════════════════════════════════════════════════════════════════
//
// These shaders implement performance-critical operations that benefit from
// custom Metal kernel optimization beyond what MPS provides out-of-the-box.
//
// Target: Apple GPU Family 7+ (A14+), Family 8+ (A15+), Family 9+ (A17 Pro+)
//
// ═══════════════════════════════════════════════════════════════════════════════

#include <metal_stdlib>
using namespace metal;

// ─── RMS Normalization ──────────────────────────────────────────────────────

/// RMSNorm: y = x * weight / sqrt(mean(x^2) + eps)
/// Used in every transformer layer before attention and FFN.
kernel void rms_norm(
  device const float *x    [[buffer(0)]],
  device const float *weight [[buffer(1)]],
  device float       *y    [[buffer(2)]],
  constant uint     &size  [[buffer(3)]],
  constant float    &eps   [[buffer(4)]],
  uint tid [[thread_position_in_grid]]
) {
  if (tid >= size) return;

  // Compute mean square in a single pass (threadgroup reduction)
  threadgroup float sum_sq = 0;
  float val = x[tid];
  sum_sq += val * val;

  // Threadgroup memory for reduction
  threadgroup float shared[256];
  short lane = tid & 255;
  shared[lane] = sum_sq;
  threadgroup_barrier(mem_flags::mem_threadgroup);

  // Reduction within threadgroup
  for (uint stride = 128; stride > 0; stride >>= 1) {
    if (lane < stride) {
      shared[lane] += shared[lane + stride];
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
  }

  float rms = sqrt(shared[0] / float(size) + eps);
  y[tid] = x[tid] * weight[tid] / rms;
}

// ─── Rotary Position Embedding (RoPE) ────────────────────────────────────────

/// Apply RoPE to query and key tensors.
/// Qwen3 uses standard RoPE with base frequency 10000.
kernel void rope(
  device float       *q      [[buffer(0)]],  // [seq_len, num_heads, head_dim]
  device float       *k      [[buffer(1)]],  // [seq_len, num_kv_heads, head_dim]
  constant uint     &seqLen  [[buffer(2)]],
  constant uint     &headDim [[buffer(3)]],
  constant float    &base    [[buffer(4)]],
  uint tid [[thread_position_in_grid]]
) {
  uint total = seqLen * headDim / 2;
  if (tid >= total) return;

  uint pos = tid / (headDim / 2);
  uint dim = tid % (headDim / 2);

  float theta = 1.0 / pow(base, float(2 * dim) / float(headDim));
  float cos_theta = cos(float(pos) * theta);
  float sin_theta = sin(float(pos) * theta);

  // Apply rotation to pairs (2i, 2i+1)
  uint idx0 = tid * 2;
  uint idx1 = idx0 + 1;

  float q0 = q[idx0], q1 = q[idx1];
  q[idx0] = q0 * cos_theta - q1 * sin_theta;
  q[idx1] = q0 * sin_theta + q1 * cos_theta;

  float k0 = k[idx0], k1 = k[idx1];
  k[idx0] = k0 * cos_theta - k1 * sin_theta;
  k[idx1] = k0 * sin_theta + k1 * cos_theta;
}

// ─── SwiGLU Activation ──────────────────────────────────────────────────────

/// SwiGLU: output = sigmoid(x * gate) * (x * up)
/// Used in the FFN intermediate layer.
kernel void swiglu(
  device const float *gate   [[buffer(0)]],
  device const float *up     [[buffer(1)]],
  device float       *output [[buffer(2)]],
  constant uint     &size    [[buffer(3)]],
  uint tid [[thread_position_in_grid]]
) {
  if (tid >= size) return;

  float g = gate[tid];
  float u = up[tid];

  // Sigmoid: 1 / (1 + exp(-x))
  float sigmoid = 1.0 / (1.0 + exp(-g));
  output[tid] = sigmoid * u;
}

// ─── FP16 Variants ───────────────────────────────────────────────────────────

/// RMSNorm for FP16 precision.
kernel void rms_norm_f16(
  device const half *x       [[buffer(0)]],
  device const half *weight  [[buffer(1)]],
  device half       *y       [[buffer(2)]],
  constant uint    &size     [[buffer(3)]],
  constant float   &eps      [[buffer(4)]],
  uint tid [[thread_position_in_grid]]
) {
  if (tid >= size) return;

  threadgroup float sum_sq = 0;
  float val = float(x[tid]);
  sum_sq += val * val;

  threadgroup float shared[256];
  short lane = tid & 255;
  shared[lane] = sum_sq;
  threadgroup_barrier(mem_flags::mem_threadgroup);

  for (uint stride = 128; stride > 0; stride >>= 1) {
    if (lane < stride) { shared[lane] += shared[lane + stride]; }
    threadgroup_barrier(mem_flags::mem_threadgroup);
  }

  float rms = sqrt(shared[0] / float(size) + eps);
  y[tid] = half(float(x[tid]) * float(weight[tid]) / rms);
}

/// SwiGLU for FP16 precision.
kernel void swiglu_f16(
  device const half *gate   [[buffer(0)]],
  device const half *up     [[buffer(1)]],
  device half       *output [[buffer(2)]],
  constant uint    &size    [[buffer(3)]],
  uint tid [[thread_position_in_grid]]
) {
  if (tid >= size) return;

  float g = float(gate[tid]);
  float u = float(up[tid]);
  float sigmoid = 1.0 / (1.0 + exp(-g));
  output[tid] = half(sigmoid * u);
}

// ─── Top-K Sampling ──────────────────────────────────────────────────────────

/// Find top-K indices and values from logits.
/// Used for efficient sampling without full sort.
kernel void topk_sampling(
  device const float *logits  [[buffer(0)]],
  device int         *indices [[buffer(1)]],
  device float       *values  [[buffer(2)]],
  constant uint     &vocabSize [[buffer(3)]],
  constant uint     &k         [[buffer(4)]],
  uint tid [[thread_position_in_grid]]
) {
  // Bitonic sort for top-K on GPU
  // Simplified: production would use radix sort or bitonic sort
  if (tid < k) {
    values[tid] = logits[tid];
    indices[tid] = int(tid);
  }

  // In production: full parallel top-K via bitonic sort
  // For now: CPU fallback handles the sorting
}

// ─── KV Cache Update ─────────────────────────────────────────────────────────

/// Update KV cache with new token's key/value projections.
kernel void kv_cache_update(
  device const float *new_k     [[buffer(0)]],
  device const float *new_v     [[buffer(1)]],
  device float       *kv_cache_k [[buffer(2)]],
  device float       *kv_cache_v [[buffer(3)]],
  constant uint     &cachePos   [[buffer(4)]],
  constant uint     &headDim    [[buffer(5)]],
  constant uint     &numKvHeads [[buffer(6)]],
  uint tid [[thread_position_in_grid]]
) {
  uint total = headDim * numKvHeads;
  if (tid >= total) return;

  uint offset = cachePos * total + tid;
  kv_cache_k[offset] = new_k[tid];
  kv_cache_v[offset] = new_v[tid];
}

