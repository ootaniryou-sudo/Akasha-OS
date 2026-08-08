/**
 * Creativity Attachment（Phase 3.0）— 複数の新しい仮説を生成
 *
 *   既存の Hypothesis SSA（hypothesize / expand）を再利用して、
 *   複数の新規仮説を SPAWN する。
 */

import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { makeResult } from './attachment.js';
import { AilsmBuilder } from '../ailsm/ailsm.js';
import { hypothesize, expand, markExpanded, hypothesesOf } from '../ailsm/reasoning.js';

export class CreativityAttachment implements Attachment {
  readonly id = 'creativity';
  readonly name = 'Creativity';
  readonly version = '1.0.0';
  enabled = true;
  estimatedCost = 0.3;
  estimatedLatency = 200;
  estimatedAccuracy = 0.8;

  supports(text: string): boolean {
    return /アイデア|新しい|発想|創造|creativity|novel|考え/.test(text);
  }

  async run(ctx: AttachmentContext): Promise<AttachmentResult> {
    const b = new AilsmBuilder();
    const taskId = b.addNode('task', 'create', 'unknown', { domain: 'reasoning', intent: 'unknown' });
    let g = b.graph();
    const rootText = `${ctx.text} の枠組み`;
    const root = hypothesize(g, taskId, rootText, 0.4, 'reasoning');
    g = root.graph;
    const ex = expand(g, taskId, root.id, [
      { text: 'アナロジーで捉える', confidence: 0.5, expert: 'reasoning' },
      { text: '逆転の発想をする', confidence: 0.5, expert: 'reasoning' },
      { text: '最小構成から考える', confidence: 0.5, expert: 'reasoning' },
    ]);
    g = ex.graph;
    g = markExpanded(g, root.id).graph;
    const hyps = hypothesesOf(g, taskId).filter((h) => h.depth === 1);
    const texts = hyps.map((h) => h.text);
    return makeResult(texts.join(' / '), 0.8, this.estimatedLatency, 1, [
      `SPAWN: ${rootText}`,
      `EXPAND: ${texts.join(', ')}`,
    ]);
  }
}

