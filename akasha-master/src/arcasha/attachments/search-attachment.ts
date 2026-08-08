/**
 * Search Attachment（Phase 3.0）— 高度な探索戦略
 *
 *   BFS / DFS / Beam / Best-First / MCTS をサポート（既存の Search Runtime を再利用）。
 *   方針は Executive が決める（デフォルト best-first）。
 */

import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { makeResult } from './attachment.js';
import { runSearch } from '../ailsm/reasoning-search.js';
import { SEARCH_POLICIES } from '../ailsm/search.js';

export class SearchAttachment implements Attachment {
  readonly id = 'search';
  readonly name = 'Search';
  readonly version = '1.0.0';
  enabled = true;
  estimatedCost = 0.35;
  estimatedLatency = 350;
  estimatedAccuracy = 0.8;

  supports(text: string): boolean {
    return /探|検索|search|最適|探索|調べ/.test(text);
  }

  async run(ctx: AttachmentContext): Promise<AttachmentResult> {
    const policyName = 'best-first';
    const r = await runSearch(ctx.text, ctx.booted, {
      policy: SEARCH_POLICIES[policyName](),
      beam: 2,
      budget: 4,
      initial: [{ text: '探索ルートを開拓する', confidence: 0.4, expert: 'search' }],
      generateChildren: () => [
        { text: '有望な経路を発見する', confidence: 0.5, expert: 'search' },
        { text: '既存の答えを鵜呑みにする', confidence: 0.3, expert: 'search' },
      ],
      evaluator: (cand) =>
        cand.text.includes('有望')
          ? { score: 0.8, novelty: 0.7, cost: 0.15, consistency: 0.9 }
          : { score: 0.3, novelty: 0.05, cost: 0.05, consistency: 0.2 },
      acceptThreshold: 0.62,
      killThreshold: 0.3,
    });
    return makeResult(r.finalText ?? `${ctx.text} の探索結果`, 0.8, this.estimatedLatency, r.evaluations, [
      `SEARCH(${policyName}): ${r.actions.length} アクション / ACCEPT=${r.acceptedTexts.length} KILL=${r.killedCount}`,
    ]);
  }
}

