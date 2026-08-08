/**
 * llm/backend.ts
 *
 * Akasha-OS — Execution Backend Interface
 * ────────────────────────────────────────
 * Abstracts the underlying inference runtime (WebGPU, Metal, CPU).
 * Allows ArcAsha to select the optimal backend per platform + task.
 *
 * ## Design
 *
 *   - Backend is separate from LLMAdapter (model logic).
 *   - LLMAdapter delegates tensor execution to a Backend.
 *   - New backends (Metal, CUDA, etc.) implement this interface.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Backend Types
// ═════════════════════════════════════════════════════════════════════════════

/** Supported execution backend types. */
export enum BackendType {
  WebGPU = 'webgpu',
  MetalIOS = 'metal_ios',
  CpuFallback = 'cpu_fallback',
  Auto = 'auto',
}

/** Backend selection strategy. */
export enum BackendSelectionPolicy {
  /** Try Metal first on iOS, WebGPU on everything else. */
  PlatformDefault = 'platform_default',
  /** Force a specific backend. */
  Force = 'force',
  /** Auto-detect best available backend. */
  AutoDetect = 'auto_detect',
}

/** Structured latency breakdown (extended from LatencyBreakdown). */
export interface BackendTiming {
  /** Tokenization time (ms). */
  tokenizeMs: number;
  /** Prefill / prompt processing time (ms). */
  prefillMs: number;
  /** Total decode time across all tokens (ms). */
  decodeMsTotal: number;
  /** Total wall-clock time (ms). */
  totalMs: number;
  /** IPC/transport overhead if backend is remote (ms). */
  transportMs: number;
  /** Time to first token (ms) — if measurable. */
  firstTokenLatencyMs: number;
  /** Tokens generated per second. */
  tokensPerSecond: number;
}

/** What a backend can report about itself. */
export interface BackendCapabilities {
  /** Backend type identifier. */
  type: BackendType;
  /** Human-readable backend name. */
  name: string;
  /** Supported precision modes. */
  supportedPrecisions: string[];
  /** Maximum context length this backend supports. */
  maxContextLength: number;
  /** Whether the backend is currently available on this device. */
  available: boolean;
  /** Reason if unavailable (e.g., "WebGPU not exposed on iOS Safari"). */
  unavailableReason?: string;
  /** Platform identifier (e.g., "darwin-arm64", "ios-arm64"). */
  platform: string;
  /** Device identifier (e.g., "Apple A17 Pro", "NVIDIA T4"). */
  device: string;
}

/** Execution request to a backend. */
export interface BackendExecuteRequest {
  /** Tokenized input IDs. */
  inputTokenIds: number[];
  /** Maximum new tokens to generate. */
  maxNewTokens: number;
  /** Sampling temperature. */
  temperature: number;
  /** Nucleus sampling threshold. */
  topP: number;
  /** Top-k sampling. */
  topK: number;
  /** Random seed for reproducibility. */
  seed?: number;
}

/** Execution result from a backend. */
export interface BackendExecuteResult {
  /** Generated token IDs. */
  outputTokenIds: number[];
  /** Decoded text. */
  text: string;
  /** Timing breakdown. */
  timing: BackendTiming;
  /** Backend that processed this request. */
  backendType: BackendType;
}

// ═════════════════════════════════════════════════════════════════════════════
// Backend Interface
// ═════════════════════════════════════════════════════════════════════════════

export interface ExecutionBackend {
  /** Initialize the backend. Called once on startup. Returns true on success. */
  initialize(): Promise<boolean>;

  /** Execute an inference request. */
  execute(request: BackendExecuteRequest): Promise<BackendExecuteResult>;

  /** Shutdown the backend and release resources. */
  shutdown(): Promise<void>;

  /** Report backend capabilities. */
  capabilities(): BackendCapabilities;

  /** Whether this backend is currently usable. */
  isAvailable(): boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Backend Registry
// ═════════════════════════════════════════════════════════════════════════════

/** Error codes for backend operations. */
export enum BackendErrorCode {
  InitFailed = 'INIT_FAILED',
  DeviceUnavailable = 'DEVICE_UNAVAILABLE',
  OutOfMemory = 'OOM',
  KernelFailed = 'KERNEL_FAILED',
  Timeout = 'TIMEOUT',
  InvalidShape = 'INVALID_SHAPE',
  InvalidDtype = 'INVALID_DTYPE',
  NotSupported = 'NOT_SUPPORTED',
}

export class BackendError extends Error {
  constructor(
    public readonly code: BackendErrorCode,
    message: string,
    public readonly backendType: BackendType,
    public readonly detail?: unknown,
  ) {
    super(`[${backendType}] ${code}: ${message}`);
    this.name = 'BackendError';
  }
}

/** Minimal platform detection for backend selection. */
export function detectPlatform(): { isIOS: boolean; isMacOS: boolean; platform: string } {
  // Node.js: process.platform
  // Browser: navigator.platform
  let plat = 'unknown';
  let isIOS = false;
  let isMacOS = false;

  if (typeof process !== 'undefined' && process.platform) {
    plat = process.platform; // 'darwin', 'linux', 'win32'
    isMacOS = plat === 'darwin';
  } else if (typeof navigator !== 'undefined') {
    const np = (navigator as Navigator).platform || '';
    plat = np;
    isIOS = /iPhone|iPad|iPod/.test(np);
    isMacOS = /Mac/.test(np) && !isIOS;
  }

  return { isIOS, isMacOS, platform: plat };
}

/** Select the best backend for the current platform. */
export function selectBackend(
  forcedBackend?: BackendType,
  capabilities?: Partial<Record<BackendType, BackendCapabilities>>,
): BackendType {
  if (forcedBackend && forcedBackend !== BackendType.Auto) {
    return forcedBackend;
  }

  const { isIOS } = detectPlatform();

  if (isIOS) {
    // On iOS, prefer Metal if available
    if (capabilities?.[BackendType.MetalIOS]?.available) {
      return BackendType.MetalIOS;
    }
    // Fallback to CPU
    return BackendType.CpuFallback;
  }

  // On desktop, prefer WebGPU
  if (capabilities?.[BackendType.WebGPU]?.available) {
    return BackendType.WebGPU;
  }

  return BackendType.CpuFallback;
}

