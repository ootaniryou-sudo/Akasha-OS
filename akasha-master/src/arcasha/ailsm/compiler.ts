/**
 * AILSM Compiler — 自然言語 → AILSM → Optimize → AILSA
 *
 * 3段階精度保証の Stage 1（決定論）+ Stage 3（決定論Verifier）を実装。
 * Stage 2（LLM残差）は辞書で判定できない入力（semantic が解釈不能を返す）を
 * 外部LLMへ委譲するためのプラグイン点であり、ここでは AilsmError で明示する。
 *
 *   Lexer → Parser → Normalizer → Semantic Analyzer → Optimizer(-O0..-O3) → AILSA Generator
 */

import { encode as ailsaEncode } from '../ailsa/codec.js';
import type { Instruction } from '../ailsa/encoder.js';
import { tokenize } from './lexer.js';
import { normalize } from './normalizer.js';
import type { NormalizedInput } from './normalizer.js';
import { parse } from './parser.js';
import { analyze } from './semantic.js';
import type { SemanticResult } from './semantic.js';
import { optimize } from './optimizer.js';
import type { OptimizationLevel, PassResult } from './optimizer.js';
import { generateAilsa } from './generator.js';
import { verifyCompilation } from './verifier.js';
import type { VerificationResult } from './verifier.js';
import { inferCapability } from './capability.js';
import type { CapabilityInference } from './capability.js';
import { execute } from './executor.js';
import type { ExecutorResult } from './executor.js';

export class AilsmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AilsmError';
  }
}

export interface CompileResult {
  text: string;
  normalized: NormalizedInput;
  semantic: SemanticResult;
  optimized: PassResult;
  capability: CapabilityInference;
  instructions: Instruction[];
  bytes: Uint8Array;
  verification: VerificationResult;
  notes: string[];
  confidence: number;
}

/** 自然言語 → AILSM → AILSA。検証を通らないものは絶対に返さない。 */
export function compile(text: string, level: OptimizationLevel = 2): CompileResult {
  if (!text.trim()) throw new AilsmError('空入力');

  const tokens = tokenize(text);
  const norm = normalize(text, tokens);
  const builder = parse(norm);

  const semantic = analyze(builder);
  if (semantic.issues.length > 0) {
    throw new AilsmError(`意味解析失敗: ${semantic.issues.join('; ')}`);
  }

  const optimized = optimize(semantic.graph, level);
  const instructions = generateAilsa(optimized.graph);

  const verification = verifyCompilation(optimized.graph, instructions);
  if (!verification.valid) {
    throw new AilsmError(
      `AILSM 検証失敗: ${verification.issues.map((i) => `[${i.verifier}] ${i.message}`).join('; ')}`,
    );
  }

  const bytes = ailsaEncode(instructions); // Phase 0 Codec（内部で再検証）
  const capability = inferCapability(optimized.graph);

  return {
    text,
    normalized: norm,
    semantic,
    optimized,
    capability,
    instructions,
    bytes,
    verification,
    notes: optimized.notes,
    confidence: norm.confidence,
  };
}

/** バイト列を16進表記へ（デバッグ用） */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** コンパイル → 実行（組み込み演算をLLM無しで解決）。Expert委譲の要否を返す。 */
export function compileAndRun(
  text: string,
  level: OptimizationLevel = 2,
): { compile: CompileResult; execution: ExecutorResult } {
  const result = compile(text, level);
  const execution = execute(result.optimized.graph);
  return { compile: result, execution };
}

export { describeGraph } from './ailsm.js';
export type { AilsmGraph } from './ailsm.js';

