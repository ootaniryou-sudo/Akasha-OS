/**
 * AILSM Verifier — 5種類の検証（100% 決定論）
 *
 * Syntax / Semantic / Capability / Consistency / Safety
 * Stage 3（自然言語往復照合）はLLM依存のため、ここでは決定論部分を実装し、
 * 呼び出し側（アプリケーション）が roundtrip 検証を組み込む。
 */

import { Slot, dialectOf } from '../ailsa/vocab.js';
import { Opcode } from '../ailsa/opcode.js';
import { getDialect } from '../ailsa/dialect.js';
import { validateProgram } from '../ailsa/validator.js';
import type { Instruction } from '../ailsa/encoder.js';
import type { AilsmGraph } from './ailsm.js';

export interface VerificationIssue {
  verifier: string;
  message: string;
}

export interface VerificationResult {
  valid: boolean;
  issues: VerificationIssue[];
}

const EXPERT_TO_DIALECT: Record<string, 'math' | 'code' | 'search' | 'reasoning'> = {
  math: 'math',
  code: 'code',
  search: 'search',
  reasoning: 'reasoning',
};

export function verifyCompilation(g: AilsmGraph, instrs: Instruction[]): VerificationResult {
  const issues: VerificationIssue[] = [];

  // 1. Syntax — Phase 0 Validator（CALLスタック・終端命令・スキーマ）
  const v = validateProgram(instrs);
  for (const i of v.issues) {
    issues.push({ verifier: 'Syntax', message: `[${i.index}] ${i.message}` });
  }

  // 2. Semantic — グラフの参照整合
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      issues.push({ verifier: 'Semantic', message: `dangling edge ${e.from} -> ${e.to}` });
    }
  }

  // 3. Capability — Expert が処理できる方言か
  const call = instrs.find((i) => i.opcode === Opcode.CALL);
  const expert = call?.slots?.find((s) => s.slot === Slot.EXPERT)?.value;
  const dialect = expert !== undefined ? EXPERT_TO_DIALECT[String(expert)] : undefined;
  if (dialect) {
    const d = getDialect(dialect);
    for (const instr of instrs) {
      const od = dialectOf(instr.opcode);
      if (od && od !== 'base' && !d.supports(instr.opcode)) {
        issues.push({
          verifier: 'Capability',
          message: `expert=${expert} は 0x${instr.opcode.toString(16)} (${od}) を処理できない`,
        });
      }
    }
  }

  // 4. Consistency — task の domain と intent の矛盾
  const task = g.nodes.find((n) => n.kind === 'task');
  if (task) {
    const domain = String(task.attrs.domain ?? 'unknown');
    const intent = String(task.attrs.intent ?? 'unknown');
    if (domain === 'search' && intent === 'solve') {
      issues.push({ verifier: 'Consistency', message: 'domain=search / intent=solve の矛盾' });
    }
    if (domain === 'code' && intent === 'summarize') {
      issues.push({ verifier: 'Consistency', message: 'domain=code / intent=summarize の矛盾' });
    }
  }

  // 5. Safety — 禁止命令チェック
  // Phase 0 では危険命令の定義なし（reserved 領域は registry に存在しないため
  // 未登録 opcode は Syntax で検出済み）。将来の reserved 命令で拡張する。

  return { valid: issues.length === 0, issues };
}

