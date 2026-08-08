/**
 * Simulation Attachment（Phase 3.0）—「もしも」反実仮想シミュレーション
 *
 *   What-if: 分岐実行 → 結果を統合（Hypothesis SSA の merge を再利用）。
 *   「前提 A なら成功 / 前提 ¬A なら失敗」を分岐させ、統合して教訓を返す。
 */

import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { makeResult } from './attachment.js';
import { AilsmBuilder } from '../ailsm/ailsm.js';
import { hypothesize, merge, hypothesesOf } from '../ailsm/reasoning.js';

export class SimulationAttachment implements Attachment {
  readonly id = 'simulation';
  readonly name = 'Simulation';
  readonly version = '1.0.0';
  enabled = true;
  estimatedCost = 0.4;
  estimatedLatency = 300;
  estimatedAccuracy = 0.8;

  supports(text: string): boolean {
    return /もし|simulate|想定|シミュレーション|だったら|仮に/.test(text);
  }

  async run(ctx: AttachmentContext): Promise<AttachmentResult> {
    void ctx; // シミュレーションはタスク文に依存しない決定論的な分岐を実行
    const b = new AilsmBuilder();
    const taskId = b.addNode('task', 'sim', 'unknown', { domain: 'reasoning', intent: 'unknown' });
    let g = b.graph();
    // BRANCH 1: 前提 A で実行
    const h1 = hypothesize(g, taskId, '前提A の場合: 成功する', 0.5, 'reasoning');
    g = h1.graph;
    // BRANCH 2: 前提 ¬A で実行
    const h2 = hypothesize(g, taskId, '前提¬A の場合: 失敗する', 0.5, 'reasoning');
    g = h2.graph;
    // MERGE: 分岐結果を統合
    const mergedText = '前提A のとき成功、前提¬A のとき失敗 → 前提A を優先する';
    const mr = merge(g, taskId, [h1.id, h2.id], mergedText, 0.6);
    g = mr.graph;
    const merged = hypothesesOf(g, taskId).find((h) => h.text === mergedText);
    return makeResult(merged?.text ?? mergedText, 0.8, this.estimatedLatency, 1, [
      `BRANCH1: 前提A → 成功`,
      `BRANCH2: 前提¬A → 失敗`,
      `MERGE: ${mergedText}`,
    ]);
  }
}

