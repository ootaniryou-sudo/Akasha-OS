/**
 * Planning Attachment（Phase 3.0）— 階層的プランニング
 *
 *   Goal → Sub Goals → Execution Plan → Scheduling
 *   AILSM の Plan SSA（state.plan）を利用して実行計画を構築する。
 */

import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { makeResult } from './attachment.js';
import { AilsmBuilder } from '../ailsm/ailsm.js';
import { plan } from '../ailsm/state.js';

export class PlanningAttachment implements Attachment {
  readonly id = 'planning';
  readonly name = 'Planning';
  readonly version = '1.0.0';
  enabled = true;
  estimatedCost = 0.3;
  estimatedLatency = 250;
  estimatedAccuracy = 0.75;

  supports(text: string): boolean {
    return /計画|手順|どうやって|plan|進め|段階/.test(text);
  }

  async run(ctx: AttachmentContext): Promise<AttachmentResult> {
    const b = new AilsmBuilder();
    const taskId = b.addNode('task', 'plan', 'unknown', { domain: 'planning', intent: 'unknown' });
    let g = b.graph();
    // SUB GOALS（決定論）
    const subgoals = ['調査・情報収集', '設計・仮説構築', '検証・実行', '統合・まとめ'];
    // EXECUTION PLAN（AILSM Plan SSA）
    g = plan(g, taskId, subgoals).graph;
    // SCHEDULE（優先順）
    const schedule = subgoals.map((s, i) => `[${i + 1}] ${s}`);
    return makeResult(schedule.join(' → '), 0.75, this.estimatedLatency, 1, [
      `GOAL: ${ctx.text}`,
      `SUBGOALS: ${subgoals.join(' → ')}`,
      `PLAN: Plan#${g.nodes.find((n) => n.kind === 'plan')?.id}（AILSM）`,
      `SCHEDULE: 優先順で実行`,
    ]);
  }
}
