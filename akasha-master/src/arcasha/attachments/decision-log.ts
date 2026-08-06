/**
 * Decision Log + OS Policy Learning（v1.0）— 意思決定を学習データにする
 *
 *   Task → Executive → Decision → Outcome を記録し、Meta Executive のポリシー
 *   （Attachment ごとの期待ゲイン）をオンライン学習する。
 *
 *   Decision Explanation は静的ゲインではなく、実測から学習したゲインを説明に
 *   使える。これは Transformer の事前学習とは別軸の「OS ポリシー学習」—
 *   「なぜ Reflection/Planning/Debate を使ったのか」を OS が説明でき、
 *   その説明を次のポリシー改善に使える。
 *
 *   学習: 各 Attachment を使った Decision の成果品質から、ベースラインを差し引いた
 *   増分を EMA（指数移動平均）で更新。
 */

import { explainExecutive } from './explain.js';
import type { DecisionExplanation } from './explain.js';
import { BUILTIN_ATTACHMENT_IDS } from './builtin.js';
import type { BootResult } from '../ailsm/expert-runtime.js';
import type { ThinkingMode } from './modes.js';

export interface DecisionRecord {
  task: string;
  mode: ThinkingMode;
  choices: string[]; // 選ばれた Attachment
  expectedGain: number; // その時点の期待ゲイン（説明に使った値）
  outcomeQuality: number; // 実際の成果品質（0-1）
  outcomeLatencyMs: number;
}

export class DecisionLog {
  private records: DecisionRecord[] = [];

  append(r: DecisionRecord): void {
    this.records.push(r);
  }

  all(): DecisionRecord[] {
    return [...this.records];
  }

  byAttachment(id: string): DecisionRecord[] {
    return this.records.filter((r) => r.choices.includes(id));
  }

  size(): number {
    return this.records.length;
  }
}

export interface LearnedGain {
  id: string;
  gain: number; // 学習された期待ゲイン（0-1）
  samples: number;
}

/**
 * ポリシー学習: 観測から Attachment ごとの期待ゲインを EMA で更新。
 *   gain[id] = EMA over (outcomeQuality − baseline) for records including id
 */
export function learnGains(log: DecisionLog, baseline = 0.5, alpha = 0.3): Map<string, LearnedGain> {
  const out = new Map<string, LearnedGain>();
  for (const id of BUILTIN_ATTACHMENT_IDS) {
    const recs = log.byAttachment(id);
    if (recs.length === 0) continue;
    let ema = 0;
    let first = true;
    for (const r of recs) {
      const delta = r.outcomeQuality - baseline;
      ema = first ? delta : ema * (1 - alpha) + delta * alpha;
      first = false;
    }
    out.set(id, { id, gain: Math.max(0, ema), samples: recs.length });
  }
  return out;
}

/** 学習済みゲインで Decision Explanation を生成（未学習の Attachment は静的ゲインにフォールバック） */
export async function explainWithPolicy(
  text: string,
  booted: BootResult,
  log: DecisionLog,
  opts: { mode?: ThinkingMode; budgetMs?: number } = {},
): Promise<DecisionExplanation> {
  const gains = learnGains(log);
  const learnedGains = new Map<string, number>([...gains].map(([id, g]) => [id, g.gain]));
  return explainExecutive(text, booted, { ...opts, learnedGains });
}

export function renderLearnedGains(gains: Map<string, LearnedGain>): string {
  const lines = ['=== Learned Gains（OS ポリシー学習）==='];
  for (const [id, g] of gains) {
    lines.push(`  ${id.padEnd(12)} +${(g.gain * 100).toFixed(0).padStart(2)}%  (samples=${g.samples})`);
  }
  if (gains.size === 0) lines.push('  （データなし — 観測を蓄積すると学習されます）');
  return lines.join('\n');
}

/**
 * デモ: Decision Explanation → 観測蓄積 → ポリシー更新 → 説明が変わる
 *   debate を多用すると高品質が続いた（10 件）→ 学習後は debate の期待ゲインが
 *   静的値（+22%）から実測値（+40%）へ更新され、Decision Explanation に反映される。
 */
export async function runPolicyLearningDemo(): Promise<string> {
  const booted = (await import('../ailsm/expert-runtime.js')).boot() as BootResult;
  const task = '新しいアルゴリズムを考えて';
  const log = new DecisionLog();

  // 学習前（静的ゲイン）
  const before = await explainExecutive(task, booted, { mode: 'auto', budgetMs: 1000 });

  // 観測: debate を含む Decision が高品質（0.9）を 10 件続ける
  for (let i = 0; i < 10; i++) {
    log.append({ task, mode: 'auto', choices: ['planning', 'debate', 'creativity', 'reflection'], expectedGain: 0.22, outcomeQuality: 0.9, outcomeLatencyMs: 1000 });
  }

  // 学習後（実測ゲイン）
  const gains = learnGains(log);
  const after = await explainWithPolicy(task, booted, log, { mode: 'auto', budgetMs: 1000 });

  const pickGain = (e: DecisionExplanation, id: string): number => e.choices.find((c) => c.id === id)?.expectedGain ?? 0;
  return [
    '=== OS Policy Learning（Decision Explanation を学習データにする）===',
    `観測: debate を含む Decision の成果品質 0.9 × 10 件`,
    `学習前: debate の期待ゲイン = +${(pickGain(before, 'debate') * 100).toFixed(0)}%（静的）`,
    `学習後: debate の期待ゲイン = +${(pickGain(after, 'debate') * 100).toFixed(0)}%（実測 EMA）`,
    `総合期待向上: +${(before.totalExpectedGain * 100).toFixed(0)}% → +${(after.totalExpectedGain * 100).toFixed(0)}%`,
    '',
    renderLearnedGains(gains),
    '',
    '学習後 Decision Explanation:',
    ...renderExplanationLines(after),
  ].join('\n');
}

function renderExplanationLines(e: DecisionExplanation): string[] {
  const lines: string[] = [];
  lines.push(`  Task : ${e.task}`);
  lines.push(`  Mode : ${e.mode}`);
  for (const c of e.choices) {
    lines.push(`  ${c.id.padEnd(12)} +${(c.expectedGain * 100).toFixed(0).padStart(2)}%  ${String(c.expectedLatencyMs).padStart(4)}ms`);
  }
  lines.push(`  Expected Gain : +${(e.totalExpectedGain * 100).toFixed(0)}%`);
  return lines;
}
