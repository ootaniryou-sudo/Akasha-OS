/**
 * Decision Replay（v1.1）—「なぜこの回答になったのか」をステップごとに再生
 *
 *   Task → Decision Log → Replay:
 *     Round1 Planning → Round2 Debate → Round3 Reflection → ... → Final
 *
 *   普通の LLM は「入力 → 出力」で終わり、中身を追えない。
 *   ArcAsha は実行パイプライン全体（各 Attachment の選択理由・期待ゲイン・
 *   出力・最終品質）を記録・再生できる — 動画のように追える。
 *   これは Explainable Reasoning の核。
 */

import { explainExecutive } from './explain.js';
import { runThinking } from './modes.js';
import type { ThinkingMode } from './modes.js';
import { AttachmentManager } from './manager.js';
import { registerBuiltinAttachments, BUILTIN_ATTACHMENT_IDS } from './builtin.js';
import type { AttachmentContext } from './attachment.js';
import type { BootResult } from '../ailsm/expert-runtime.js';

export interface ReplayStep {
  round: number;
  id: string;
  reason: string; // なぜこの Attachment を選んだか
  expectedGain: number;
  latencyMs: number;
  output: string; // その Attachment の出力（短縮）
}

export interface ReplayTrace {
  task: string;
  mode: ThinkingMode;
  budgetMs: number;
  usedMs: number;
  baselineQuality: number;
  steps: ReplayStep[];
  finalQuality: number;
  finalText: string;
}

/** 実行パイプライン全体を記録（Decision Explanation の選択理由 + 各ステップの実出力） */
export async function captureReplay(
  text: string,
  booted: BootResult,
  opts: { mode?: ThinkingMode; budgetMs?: number } = {},
): Promise<ReplayTrace> {
  const mode = opts.mode ?? 'auto';
  const budgetMs = opts.budgetMs ?? 1000;
  const exp = await explainExecutive(text, booted, { mode, budgetMs });

  const manager = new AttachmentManager();
  registerBuiltinAttachments(manager);
  await Promise.all(BUILTIN_ATTACHMENT_IDS.map((id) => manager.load(id)));
  const ctx: AttachmentContext = { text, booted, attach: (id) => manager.execute(id, ctx) };

  // 各ステップを順に実行・記録
  const steps: ReplayStep[] = [];
  let usedMs = 0;
  for (const choice of exp.choices) {
    const r = await manager.execute(choice.id, ctx);
    steps.push({
      round: steps.length + 1,
      id: choice.id,
      reason: choice.reason,
      expectedGain: choice.expectedGain,
      latencyMs: r.latencyMs,
      output: r.text.length > 60 ? `${r.text.slice(0, 57)}...` : r.text,
    });
    usedMs += r.latencyMs;
  }

  // 最終結果（並列 + 最良採用）
  const th = await runThinking(text, booted, { mode, budgetMs });
  return {
    task: text,
    mode,
    budgetMs,
    usedMs,
    baselineQuality: exp.baselineQuality,
    steps,
    finalQuality: th.result.quality,
    finalText: th.result.text,
  };
}

export function replayStepCount(t: ReplayTrace): number {
  return t.steps.length;
}

/** 全ステップの再生（トランスクリプト） */
export function renderReplay(t: ReplayTrace): string {
  const lines: string[] = [];
  lines.push('=== Decision Replay ===');
  lines.push(`Task : ${t.task}`);
  lines.push(`Mode : ${t.mode} (budget ${t.budgetMs}ms / base quality ${t.baselineQuality.toFixed(2)})`);
  lines.push('');
  for (const s of t.steps) {
    lines.push(`Round${s.round}: ${s.id} (+${(s.expectedGain * 100).toFixed(0)}% / ${s.latencyMs}ms)`);
    lines.push(`  reason: ${s.reason}`);
    lines.push(`  output: ${s.output}`);
  }
  lines.push('');
  lines.push(`Final : quality=${t.finalQuality.toFixed(2)} / used ${t.usedMs}ms`);
  lines.push(`  ${t.finalText.length > 70 ? `${t.finalText.slice(0, 67)}...` : t.finalText}`);
  return lines.join('\n');
}

/** 1 ステップだけ再生（GUI アニメーションの 1 コマ相当） */
export function renderReplayStep(t: ReplayTrace, index: number): string {
  const s = t.steps[index];
  if (!s) return `END: quality=${t.finalQuality.toFixed(2)} → ${t.finalText.slice(0, 40)}`;
  return `[${index + 1}/${t.steps.length}] Round${s.round}: ${s.id} +${(s.expectedGain * 100).toFixed(0)}% ${s.latencyMs}ms\n  → ${s.output}`;
}

/** デモ: 「新しいアルゴリズムを考えて」をステップ再生 */
export async function runReplayDemo(): Promise<string> {
  const booted = (await import('../ailsm/expert-runtime.js')).boot() as BootResult;
  const t = await captureReplay('新しいアルゴリズムを考えて', booted, { mode: 'auto', budgetMs: 1000 });
  // ステップごとの「再生」を順に出力（動画のように）
  const out = [renderReplay(t), '', '--- ステップ再生（1 コマずつ）---'];
  for (let i = 0; i < t.steps.length; i++) {
    out.push(`\n${renderReplayStep(t, i)}`);
  }
  out.push(`\n${renderReplayStep(t, t.steps.length)}`); // END
  return out.join('\n');
}

