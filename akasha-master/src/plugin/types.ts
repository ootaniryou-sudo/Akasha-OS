/**
 * akasha-plugin-types.ts
 *
 * Akasha OS — Open Plugin Interface Standard
 * ──────────────────────────────────────────
 * Any developer can contribute a specialised AI model to the Akasha swarm
 * by implementing a single async function behind this interface.
 *
 * Design principles:
 *  - **Zero boilerplate** — one interface, one function, 10 lines of glue code.
 *  - **Binary-only data plane** — input/output are Float32Array tensors;
 *    no JSON, no string marshalling, no heap pressure.
 *  - **Hot-plug capable** — plugins can be registered at runtime without
 *    restarting the orchestrator.
 *  - **Language-agnostic wire format** — the same plugin spec can be
 *    implemented in any language that can speak WebSocket + 48-byte header.
 */

// ─── Plugin identity ───────────────────────────────────────────────────────

/** Machine-readable expert classification. */
export type ExpertDomain =
  | 'general'
  | 'math'
  | 'code'
  | 'language'
  | 'medical'
  | 'legal'
  | 'science'
  | 'creative'
  | 'custom';

/** Semantic cluster ID assigned at registration time (or 0 = auto). */
export type PluginClusterId = number;

export interface PluginMetadata {
  /** Globally unique plugin id (reverse-domain convention recommended). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Major version (semver). */
  version: string;
  /** Expert domain classification. */
  expertDomain: ExpertDomain;
  /** Approximate parameter count label (e.g. "0.1B", "3.8B", "7B"). */
  parameterSize: string;
  /** One-line description shown in the marketplace. */
  description: string;
  /** Author / organisation name. */
  author: string;
  /** URL to documentation / model card. */
  homepage?: string;
  /** List of trigger keywords for semantic routing. */
  keywords: string[];
  /** Expected hidden size of input tensor (floats). 0 = any. */
  expectedInputDim: number;
  /** Expected hidden size of output tensor (floats). 0 = same as input. */
  expectedOutputDim: number;
  /** Estimated single-inference latency on reference hardware (μs). */
  estimatedLatencyUs: number;
  /** Preferred cluster ID (0 = auto-assign by orchestrator). */
  preferredClusterId: PluginClusterId;
}

// ─── Core plugin interface (THE public contract) ────────────────────────────

/**
 * ## AkashaExpertPlugin
 *
 * The one and only interface every Akasha plugin must implement.
 *
 * ### Example (minimal math expert):
 * ```ts
 * const myMathPlugin: AkashaExpertPlugin = {
 *   metadata: {
 *     id: 'com.example.phi3-math',
 *     name: 'Phi-3 Math Expert',
 *     version: '1.0.0',
 *     expertDomain: 'math',
 *     parameterSize: '3.8B',
 *     description: 'Fine-tuned Phi-3-mini for mathematical reasoning.',
 *     author: 'example-dev',
 *     keywords: ['math', 'arithmetic', 'algebra', 'calculus'],
 *     expectedInputDim: 3072,
 *     expectedOutputDim: 3072,
 *     estimatedLatencyUs: 8_000,
 *     preferredClusterId: 0,
 *   },
 *   execute: async (inputTensor: Float32Array): Promise<Float32Array> => {
 *     // Run your model inference here
 *     const output = await myModel.forward(inputTensor);
 *     return output;
 *   },
 * };
 * ```
 */
export interface AkashaExpertPlugin {
  /** Immutable plugin identity / capability declaration. */
  readonly metadata: PluginMetadata;

  /**
   * Core inference function.
   *
   * @param inputTensor  — Raw Float32Array of hidden states / embeddings.
   *                       Shape [hiddenSize] or [batch, hiddenSize] flattened.
   *                       The buffer is OWNED by the caller; implementors
   *                       MUST NOT mutate it in-place.
   * @returns             — New Float32Array of output activations.
   *                       Shape [hiddenSize].  Ownership is transferred
   *                       to the caller (will be recycled via buffer pool).
   *
   * ## Contract
   * - **No side effects** on input.
   * - **Must not throw** for valid inputs (return zero-filled tensor on error).
   * - **Timeout**: orchestrator may abort via AbortSignal in future versions.
   * - **Zero-copy friendly**: if your runtime supports it, you may return a
   *   subarray of a pre-allocated buffer; the caller will copy if needed.
   */
  execute(inputTensor: Float32Array): Promise<Float32Array>;
}

// ─── Plugin lifecycle hooks (optional) ─────────────────────────────────────

/**
 * Extended plugin with lifecycle awareness.
 * Implement these if your plugin needs initialisation / teardown.
 */
export interface AkashaLifecyclePlugin extends AkashaExpertPlugin {
  /**
   * Called once when the plugin is registered with the orchestrator.
   * Use for model loading, GPU warm-up, buffer pre-allocation.
   */
  onRegister?(): Promise<void>;

  /**
   * Called when the plugin is unregistered or the orchestrator shuts down.
   * Use for GPU memory release, WebSocket close, persistence flush.
   */
  onUnregister?(): Promise<void>;

  /**
   * Called periodically (default every 30 s) for health reporting.
   * Return an object with custom metrics; the orchestrator may log or
   * display them in the dashboard.
   */
  onHealthCheck?(): Promise<PluginHealthStatus>;
}

export interface PluginHealthStatus {
  healthy: boolean;
  uptimeSeconds: number;
  totalInferences: number;
  averageLatencyUs: number;
  lastError?: string;
  custom?: Record<string, number | string>;
}

// ─── Plugin manifest (for static discovery) ────────────────────────────────

/**
 * Static plugin descriptor that can be resolved to an AkashaExpertPlugin
 * at registration time.  Useful for marketplace / package.json discovery.
 */
export interface PluginManifest {
  /** Path to a JS/TS module that default-exports an AkashaExpertPlugin. */
  entry: string;
  /** Inline metadata (overrides the plugin's own metadata if provided). */
  metadata?: Partial<PluginMetadata>;
  /** Whether to auto-register on orchestrator start. */
  autoRegister: boolean;
}

// ─── Type guard ────────────────────────────────────────────────────────────

export function isLifecyclePlugin(p: AkashaExpertPlugin): p is AkashaLifecyclePlugin {
  return (
    typeof (p as AkashaLifecyclePlugin).onRegister === 'function' ||
    typeof (p as AkashaLifecyclePlugin).onUnregister === 'function' ||
    typeof (p as AkashaLifecyclePlugin).onHealthCheck === 'function'
  );
}
