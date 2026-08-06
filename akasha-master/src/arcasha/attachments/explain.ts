/**
 * Decision Explanation（Phase 4.2）—「Why did Executive choose this?」
 *
 *   Executive がなぜその Thinking Mode / Attachment 構成を選んだのかを説明する。
 *   多くの LLM では「Thinking ON → 内部で何か長く考える」だけで見えない部分 —
 *   ArcAsha は「OS が推論を管理する」ことを、構成ごとの期待ゲイン・予算・理由で
 *   外から見える形にする（強いデモ）。
 *
 *   期待ゲインは決定論モデル（タスク特性から固定・文書化）。
 */

import { estimateBudget } from '../ailsm/meta-executive.js';
import { resolvePipeline } from './modes.js';
import type { ThinkingMode } from './modes.js';
import { AttachmentManager } from './manager.js';
import { registerBuiltinAttachments, BUILTIN_ATTACHMENT_IDS } from './builtin.js';
import type { BootResult } from '../ailsm/expert-runtime.js';

export interface AttachmentChoice {
  id: string;
  expectedGain: number; // 品質向上の見込み（0-1）
  expectedLatencyMs: number;
  reason: string; // なぜ選んだか
}

export interface DecisionExplanation {
  task: string;
  mode: ThinkingMode;
  budgetMs: number;
  usedMs: number;
  baselineQuality: number;
  choices: AttachmentChoice[];
  totalExpectedGain: number; // 総合期待向上（0-1）
  modeReason: string; // なぜこのモードか
}

/** 期待ゲインの決定論モデル（タスク特性で固定） */
function gainOf(id: string, task: string): { gain: number; reason: string } {
  switch (id) {
    case 'planning':
      return /設計|計画|アルゴリズム|新|考える|どうやって|研究/.test(task)
        ? { gain: 0.31, reason: '目標分解・実行手順が必要（高複雑度タスク）' }
        : { gain: 0.12, reason: '手順の整理に有効' };
    case 'debate':
      return { gain: 0.22, reason: '複数視点の検討で新規性・妥当性を担保' };
    case 'creativity':
      return { gain: 0.28, reason: '新規仮説生成が必要（「考えて/新しい/アイデア」）' };
    case 'reflection':
      return { gain: 0.19, reason: '自己批判（Answer→Score→Revise）で品質を向上' };
    case 'search':
      return { gain: 0.15, reason: '探索で情報不足・最適解を補う' };
    case 'simulation':
      return { gain: 0.2, reason: '反実仮想（What-if）でリスクを評価' };
    case 'coding':
      return { gain: 0.26, reason: 'コード生成・自己レビュー・コンパイルで実装を保証' };
    default:
      return { gain: 0.1, reason: '汎用補助' };
  }
}

/** モード選択の理由（estimateBudget と連携） */
function modeReasonOf(mode: ThinkingMode, b: ReturnType<typeof estimateBudget>): string {
  if (mode === 'fast') return 'Fast: 低レイテンシ優先（ロボット/リアルタイム制御）。Attachment なし（Kernel → Expert → Answer）。';
  if (mode === 'custom') return 'Custom: ユーザー指定の Attachment 構成を実行。';
  if (mode === 'deep') return 'Deep: 可能な Attachment を積極利用（研究・長時間推論向け）。';
  if (!b.allowReasoning) return `Auto: ${b.reason}（考える必要なし）→ Fast Runtime のみ。`;
  if (b.reason === 'high') return 'Auto: estimateBudget が高複雑度と判定（「考える/アイデア/アルゴリズム」等）→ Planning+Debate+Creativity+Reflection を自動起動。';
  return `Auto: ${b.reason} → supports ベースで Attachment を自動選択。`;
}

/**
 * Executive の意思決定を説明する:
 *   モード解決 → 選ばれた Attachment 列 → 各 Attachment の期待ゲイン・予算・理由
 */
export async function explainExecutive(
  text: string,
  booted: BootResult,
  opts: { mode?: ThinkingMode; budgetMs?: number; attachments?: string[]; learnedGains?: Map<string, number> } = {},
): Promise<DecisionExplanation> {
  const mode = opts.mode ?? 'auto';
  const budgetMs = opts.budgetMs ?? 1000;
  void booted; // 実モデル呼び出しは Phase 1 Device Runtime と統合可能
  const manager = new AttachmentManager();
  registerBuiltinAttachments(manager);
  await Promise.all(BUILTIN_ATTACHMENT_IDS.map((id) => manager.load(id)));

  const pipeline = await resolvePipeline(mode, manager, text, { attachments: opts.attachments, budgetMs });
  const b = estimateBudget(text);
  const baselineQuality = b.allowReasoning ? 0.5 : 0.6;
  const choices: AttachmentChoice[] = pipeline.map((id) => {
    const a = manager.get(id)!;
    const g = gainOf(id, text);
    // 学習済みゲインがあればそれを使う（OS ポリシー学習）
    const learned = opts.learnedGains?.get(id);
    return { id, expectedGain: learned ?? g.gain, expectedLatencyMs: a.estimatedLatency, reason: g.reason };
  });
  const usedMs = choices.reduce((s, c) => s + c.expectedLatencyMs, 0);
  // 総合期待向上 = 最有力 Attachment の効果 + 相乗効果 3%（重複を考慮した保守的見積もり）
  const totalExpectedGain = choices.length === 0 ? 0 : Math.min(1, Math.max(...choices.map((c) => c.expectedGain)) + 0.03);
  return {
    task: text,
    mode,
    budgetMs,
    usedMs,
    baselineQuality,
    choices,
    totalExpectedGain,
    modeReason: modeReasonOf(mode, b),
  };
}

export function renderExplanation(e: DecisionExplanation): string {
  const lines: string[] = [];
  lines.push('=== Decision Explanation（なぜ Executive はこの構成を選んだか）===');
  lines.push(`Task : "${e.task}"`);
  lines.push(`Mode : ${e.mode} — ${e.modeReason}`);
  lines.push(`Base : quality=${e.baselineQuality.toFixed(2)}`);
  lines.push('');
  if (e.choices.length === 0) {
    lines.push('Selected: なし（Fast Runtime — Attachment 不要）');
  } else {
    lines.push(`Selected (${e.choices.length}):`);
    for (const c of e.choices) {
      lines.push(`  ${c.id.padEnd(12)} +${(c.expectedGain * 100).toFixed(0).padStart(2)}%  ${String(c.expectedLatencyMs).padStart(4)}ms  ${c.reason}`);
    }
  }
  lines.push('');
  lines.push(`Budget : ${e.budgetMs}ms (used ${e.usedMs}ms)`);
  lines.push(`Expected Gain : +${(e.totalExpectedGain * 100).toFixed(0)}%`);
  return lines.join('\n');
}
