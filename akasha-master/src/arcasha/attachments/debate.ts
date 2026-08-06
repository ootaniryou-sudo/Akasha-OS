/**
 * Debate Attachment（Phase 3.0）— 複数 Expert が議論して合意形成
 *
 *   Expert A → Expert B → Expert C → Judge → Consensus
 *   既存の Reasoning Search Runtime を再利用（各立場 = Hypothesis、Judge = ACCEPT）。
 */

import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { makeResult } from './attachment.js';
import { runSearch } from '../ailsm/reasoning-search.js';
import { BeamSearchPolicy } from '../ailsm/search.js';

export class DebateAttachment implements Attachment {
  readonly id = 'debate';
  readonly name = 'Debate';
  readonly version = '1.0.0';
  enabled = true;
  estimatedCost = 0.4;
  estimatedLatency = 400;
  estimatedAccuracy = 0.85;

  supports(text: string): boolean {
    return /議論|批判的|判断|どっち|比較|debate|賛成|反対/.test(text);
  }

  async run(ctx: AttachmentContext): Promise<AttachmentResult> {
    // ルート仮説から 3 立場を EXPAND し（Reasoning Search は子だけを評価）、
    // Judge（ACCEPT）で合意を選ぶ — Reasoning Search Runtime を再利用
    const r = await runSearch(ctx.text, ctx.booted, {
      policy: new BeamSearchPolicy(),
      beam: 3,
      budget: 3,
      initial: [{ text: `${ctx.text} を議論する`, confidence: 0.4, expert: 'reasoning' }],
      generateChildren: (p) =>
        p.text.includes('議論')
          ? [
              { text: '肯定的な立場から評価する', confidence: 0.5, expert: 'reasoning' },
              { text: '否定的な立場から批判する', confidence: 0.5, expert: 'reasoning' },
              { text: '中立的に統合する', confidence: 0.5, expert: 'reasoning' },
            ]
          : [],
      evaluator: (cand) => {
        if (cand.text.includes('肯定的')) return { score: 0.7, novelty: 0.4, cost: 0.1, consistency: 0.8 };
        if (cand.text.includes('否定的')) return { score: 0.55, novelty: 0.5, cost: 0.1, consistency: 0.7 };
        return { score: 0.8, novelty: 0.6, cost: 0.1, consistency: 0.9 };
      },
      acceptThreshold: 0.62,
      killThreshold: 0.3,
    });
    const consensus = r.finalText ?? (r.acceptedTexts.length > 0 ? r.acceptedTexts.join(' + ') : '合意に至らず');
    return makeResult(`【合意】${consensus}`, 0.85, this.estimatedLatency, r.evaluations, [
      ...r.actions.map((a) => `DEBATE: ${a}`),
      `JUDGE: ${consensus}`,
    ]);
  }
}
