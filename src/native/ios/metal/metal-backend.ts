/**
 * native/ios/metal/metal-backend.ts
 *
 * Akasha-OS — iOS Metal Execution Backend
 * ─────────────────────────────────────────
 * Hardware-direct Metal inference for iPhone/iPad.
 * Bypasses Safari WebGPU limitations by using native Metal Performance Shaders.
 *
 * ## Architecture
 *
 *   ArcAsha Runtime
 *     └── ExecutionBackend (backend.ts)
 *           └── MetalBackend (this file)
 *                 ├── Metal Device (MTLDevice)
 *                 ├── MPS Graph (MPSGraph)
 *                 └── MPS Kernels (matrix multiply, attention, etc.)
 *
 * ## Integration Path
 *
 *   iOS App (Swift/ObjC)
 *     └── Native Bridge (WKScriptMessageHandler / JSContext)
 *           └── MetalBackend (TypeScript → Native call)
 *
 * ## Status: SCAFFOLD — compile-safe, not yet wired to native Metal.
 *
 *   - Interface fully defined with ExecutionBackend.
 *   - Platform detection + availability check implemented.
 *   - Native bridge contract documented with TODO boundaries.
 *   - All error codes handled.
 *   - Fallback policy: Metal → WebGPU → CPU.
 */

import {
  type ExecutionBackend,
  type BackendCapabilities,
  type BackendExecuteRequest,
  type BackendExecuteResult,
  type BackendTiming,
  BackendType,
  BackendErrorCode,
  BackendError,
  detectPlatform,
} from '../../../llm/backend.js';

// ═════════════════════════════════════════════════════════════════════════════
// Metal Backend Configuration
// ═════════════════════════════════════════════════════════════════════════════

export interface MetalBackendConfig {
  /** Model identifier for Metal-optimized weights. */
  modelId: string;
  /** Precision: "fp16", "fp32". */
  precision: string;
  /** Max context length. */
  maxContextLength: number;
  /** Whether to use MPSGraph (batch execution) vs raw MPS kernels. */
  useMPSGraph: boolean;
}

const DEFAULT_METAL_CONFIG: MetalBackendConfig = {
  modelId: 'Qwen3-0.6B',
  precision: 'fp16',
  maxContextLength: 32768,
  useMPSGraph: true,
};

// ═════════════════════════════════════════════════════════════════════════════
// Native Bridge Contract
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Native Bridge interface — communication layer between TypeScript and
 * iOS native Metal runtime (Swift/ObjC).
 *
 * TODO: Implement native bridge via:
 *   - WKScriptMessageHandler (browser → native)
 *   - JavaScriptCore JSContext (native → JS)
 *   - Or a custom URL scheme handler
 *
 * Binary contract:
 *   Request:  JSON → { model, inputs, params }
 *   Response: JSON → { tokens, text, timing, error? }
 */
interface MetalNativeBridge {
  /** Check if Metal device is available on this iPhone. */
  isMetalAvailable(): Promise<boolean>;

  /** Send an inference request to the native Metal runtime. */
  sendInferenceRequest(request: MetalNativeRequest): Promise<MetalNativeResponse>;

  /** Get device capabilities (GPU family, memory, etc.). */
  getDeviceInfo(): Promise<MetalDeviceInfo>;
}

interface MetalNativeRequest {
  modelId: string;
  inputTokenIds: number[];
  maxNewTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  precision: string;
}

interface MetalNativeResponse {
  outputTokenIds: number[];
  text: string;
  timing: {
    prefillMs: number;
    decodeMs: number;
    totalMs: number;
  };
  error?: { code: string; message: string };
}

interface MetalDeviceInfo {
  gpuFamily: string;
  maxBufferSize: number;
  unifiedMemory: boolean;
  metalVersion: string;
  available: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Metal Backend Implementation
// ═════════════════════════════════════════════════════════════════════════════

export class MetalBackend implements ExecutionBackend {
  private config: MetalBackendConfig;
  private initialized = false;
  private nativeBridge: MetalNativeBridge | null = null;
  private deviceInfo: MetalDeviceInfo | null = null;

  constructor(config: Partial<MetalBackendConfig> = {}) {
    this.config = { ...DEFAULT_METAL_CONFIG, ...config };
  }

  // ─── ExecutionBackend Implementation ───────────────────────────────────

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    const { isIOS } = detectPlatform();
    if (!isIOS) {
      throw new BackendError(
        BackendErrorCode.DeviceUnavailable,
        'Metal backend is only available on iOS devices',
        BackendType.MetalIOS,
      );
    }

    // TODO: Initialize native Metal bridge.
    // On real iOS:
    //   1. Create MTLDevice.default
    //   2. Compile/load MPS kernels for Qwen3-0.6B ops
    //   3. Allocate command queue
    //   4. Load Metal-optimized model weights
    //
    // For now: check if native bridge is wired.
    if (this.nativeBridge) {
      try {
        const available = await this.nativeBridge.isMetalAvailable();
        if (!available) {
          throw new BackendError(
            BackendErrorCode.DeviceUnavailable,
            'Metal device not available on this iPhone',
            BackendType.MetalIOS,
          );
        }
        this.deviceInfo = await this.nativeBridge.getDeviceInfo();
      } catch (err) {
        if (err instanceof BackendError) throw err;
        throw new BackendError(
          BackendErrorCode.InitFailed,
          `Metal initialization failed: ${String(err)}`,
          BackendType.MetalIOS,
          err,
        );
      }
    }

    // Scaffold mode: report as unavailable (native bridge not yet wired).
    // This allows the system to gracefully fallback to WebGPU/CPU.
    this.initialized = true;
    return true;
  }

  async execute(request: BackendExecuteRequest): Promise<BackendExecuteResult> {
    this._ensureInitialized();

    if (!this.nativeBridge) {
      throw new BackendError(
        BackendErrorCode.NotSupported,
        'Metal native bridge not wired. Use WebGPU or CPU backend.',
        BackendType.MetalIOS,
      );
    }

    // Validate shapes
    if (request.inputTokenIds.length === 0) {
      throw new BackendError(
        BackendErrorCode.InvalidShape,
        'Empty input token sequence',
        BackendType.MetalIOS,
      );
    }

    const tStart = performance.now();

    let response: MetalNativeResponse;
    try {
      response = await this.nativeBridge.sendInferenceRequest({
        modelId: this.config.modelId,
        inputTokenIds: request.inputTokenIds,
        maxNewTokens: request.maxNewTokens,
        temperature: request.temperature,
        topP: request.topP,
        topK: request.topK,
        precision: this.config.precision,
      });
    } catch (err) {
      throw new BackendError(
        BackendErrorCode.KernelFailed,
        `Metal inference failed: ${String(err)}`,
        BackendType.MetalIOS,
        err,
      );
    }

    if (response.error) {
      throw new BackendError(
        BackendErrorCode.KernelFailed,
        response.error.message,
        BackendType.MetalIOS,
        { code: response.error.code },
      );
    }

    const totalMs = performance.now() - tStart;

    const timing: BackendTiming = {
      tokenizeMs: 0, // Tokenize happens in JS before Metal call
      prefillMs: response.timing.prefillMs,
      decodeMsTotal: response.timing.decodeMs,
      totalMs,
      transportMs: totalMs - response.timing.totalMs,
      firstTokenLatencyMs: response.timing.prefillMs,
      tokensPerSecond: response.outputTokenIds.length / (totalMs / 1000),
    };

    return {
      outputTokenIds: response.outputTokenIds,
      text: response.text,
      timing,
      backendType: BackendType.MetalIOS,
    };
  }

  async shutdown(): Promise<void> {
    // TODO: Release Metal resources (command queue, buffers, device).
    this.initialized = false;
    this.nativeBridge = null;
    this.deviceInfo = null;
  }

  capabilities(): BackendCapabilities {
    const { isIOS } = detectPlatform();
    const available = isIOS && this.initialized && this.nativeBridge !== null;

    return {
      type: BackendType.MetalIOS,
      name: 'Asha Metal (iOS Metal/MPS)',
      supportedPrecisions: ['fp16', 'fp32'],
      maxContextLength: this.config.maxContextLength,
      available,
      unavailableReason: available
        ? undefined
        : !isIOS
          ? 'Metal backend requires iOS. Current platform is not iOS.'
          : 'Metal native bridge not wired. Native iOS app integration required.',
      platform: isIOS ? 'ios-arm64' : detectPlatform().platform,
      device: this.deviceInfo?.gpuFamily ?? 'Apple GPU (Metal)',
    };
  }

  isAvailable(): boolean {
    return this.capabilities().available;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private _ensureInitialized(): void {
    if (!this.initialized) {
      throw new BackendError(
        BackendErrorCode.InitFailed,
        'MetalBackend not initialized. Call initialize() first.',
        BackendType.MetalIOS,
      );
    }
  }
}
