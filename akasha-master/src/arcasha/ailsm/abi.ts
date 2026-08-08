/**
 * AI ABI（Phase 0.17）— Application Binary Interface
 *
 * Expert 間・Kernel-Expert 間の受け渡し規約を定義する（LLVM IR → ABI → Machine Code の ABI 相当）。
 *
 * - Argument ABI: Type / Shape / Ownership / Alignment
 * - Return ABI:   Result / Type / Status
 * - Error ABI:    ERROR_CODE / ERROR_MESSAGE / RECOVERABLE / RETRYABLE
 * - Version Negotiation: Kernel が Expert の ABI バージョンを確認してから CALL
 * - Capability ABI: requires / supports / prefers（Expert の交換可能性）
 */

export type AbiType = 'float32' | 'float16' | 'int32' | 'tensor' | 'matrix' | 'string' | 'any' | 'context';

/**
 * Long Context ABI（Phase 0.20）— 実体ではなく参照を Expert へ渡す
 *
 * Linux の file descriptor に近い。Expert は ContextID / PageID しか見ない。
 * 実体（テキスト）は Kernel（Context Object）が保持し、Slice Loader が必要ページだけを供給する。
 */
export interface ContextRef {
  contextId: number;
  pageIds: number[]; // ロードするページ（Slice）
  sliceId?: number; // どのスライスか
}

export interface ContextAbiArgument extends AbiArgument {
  type: 'context';
  ref: ContextRef;
}

/** ContextRef → ABI 引数（ownership=borrow: 実体は Kernel が持つ） */
export function buildContextArgument(index: number, ref: ContextRef): ContextAbiArgument {
  return { index, type: 'context', ref, ownership: 'borrow', alignment: 8 };
}

export interface AbiArgument {
  index: number;
  type: AbiType;
  shape?: number[];
  ownership: 'borrow' | 'own';
  alignment: number; // bytes
}

export interface AbiReturn {
  type: AbiType;
  status: 'ok' | 'error';
}

export interface ErrorAbi {
  code: number;
  message: string;
  recoverable: boolean;
  retryable: boolean;
}

export interface AbiVersion {
  major: number;
  minor: number;
}

export interface CapabilityAbi {
  requires: AbiType[];
  supports: AbiType[];
  prefers: AbiType[];
}

export const ABI_VERSION_1_0: AbiVersion = { major: 1, minor: 0 };

/** Kernel が Expert を呼べるか（major 一致 + kernel.minor >= expert.minor） */
export function supportsAbi(kernel: AbiVersion, expert: AbiVersion): boolean {
  return kernel.major === expert.major && kernel.minor >= expert.minor;
}

export const ERRORS = {
  DIVISION_BY_ZERO: { code: 1001, message: 'division by zero', recoverable: false, retryable: true },
  UNSUPPORTED_OP: { code: 2001, message: 'unsupported opcode', recoverable: false, retryable: false },
  UNSUPPORTED_ABI: { code: 2002, message: 'ABI version mismatch', recoverable: true, retryable: false },
  TIMEOUT: { code: 3001, message: 'timeout', recoverable: true, retryable: true },
} as const;

/** Capability ABI: requires を満たすか（Expert の交換判定） */
export function capabilityFulfills(required: AbiType[], capability: CapabilityAbi): boolean {
  return required.every((t) => capability.supports.includes(t) || capability.requires.includes(t));
}
