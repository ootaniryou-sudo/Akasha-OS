/**
 * @arcasha/router — Shadow Evaluation (EXP-0002F / 0003C.3)
 *
 * 全エキスパートを毎ステップ評価 (オラクル = シャドウ) し、フル情報フィードバックを
 * Router に供給する。compute は呼び出し側 (WS/WebGPU/任意バックエンド) が注入する。
 */

import type { EvalResult, ExpertInfo, Task } from '../core/types.js';
import { evaluateTask } from '../core/observation.js';

export interface Injection {
  type: 'latency' | 'capability';
  node: string;
  factor: number;
}

/** 全エキスパートを評価 (compute は呼び出し側のバックエンド + キャッシュ) */
export async function evaluateAll(
  experts: ExpertInfo[],
  task: Task,
  compute: (node: ExpertInfo, task: Task) => Promise<EvalResult>,
  inject?: Injection | null,
): Promise<Record<string, EvalResult>> {
  const out: Record<string, EvalResult> = {};
  for (const n of experts) {
    const raw = await compute(n, task);
    let score = raw.score;
    let latency = raw.latencyMs;
    if (inject?.type === 'capability' && inject.node === n.nodeId) {
      score = Math.round(score * inject.factor * 1000) / 1000;
    }
    if (inject?.type === 'latency' && inject.node === n.nodeId) {
      latency = Math.round(latency * inject.factor);
    }
    out[n.nodeId] = { nodeId: n.nodeId, text: raw.text, score, latencyMs: latency };
  }
  return out;
}

/** ルールベース評価で EvalResult を作る (キャッシュ可能な生成) */
export function evaluateWith(node: ExpertInfo, task: Task, text: string, latencyMs: number): EvalResult {
  return { nodeId: node.nodeId, text, score: evaluateTask(task.capability, text), latencyMs };
}
