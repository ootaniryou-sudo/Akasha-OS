/**
 * Thinking Modes（Phase 3.1）— ユーザー視点の推論モード + Intelligence Scheduler
 *
 *   他 AI モデルの「Thinking ON/OFF」はブラックボックス（内部で何か長く考えるだけ）。
 *   ArcAsha は同じ OS の上で**実行パイプラインだけを変え**、どの Attachment が
 *   どれだけ時間を使ったかを可視化する（Thinking Budget）。
 *
 *     Fast  : Kernel → Expert Runtime → Answer（Attachment なし = ロボット/リアルタイム）
 *     Auto  : Executive がタスクから自動選択（2+2 → Fast / 批判的レビュー → Reflection+Debate
 *             / 新しいアルゴリズム → Planning+Debate+Creativity）
 *     Deep  : Planning → Debate → Reflection → Simulation（可能な Attachment を積極利用）
 *     Custom: ユーザーが手動で Attachment を選択
 *
 *   Intelligence Scheduler = CPU スケジューラではなく「知能スケジューラ」。
 *   Thinking Budget（時間予算）内で優先度順に Attachment を配分する。
 */

import { AttachmentManager } from './manager.js';
import { AttachmentMonitor } from './observability.js';
import { registerBuiltinAttachments, BUILTIN_ATTACHMENT_IDS } from './builtin.js';
import { attachmentPriority } from './scheduler.js';
import { estimateBudget } from '../ailsm/meta-executive.js';
import type { BootResult } from '../ailsm/expert-runtime.js';
import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { mergeResults, estimateTokens } from './attachment.js';

export type ThinkingMode = 'fast' | 'auto' | 'deep' | 'custom';

export interface ScheduledAttachment {
  id: string;
  priority: number;
  budgetMs: number;
}

export interface ThinkingBreakdown {
  id: string;
  latencyMs: number;
}

export interface ThinkingResult {
  mode: ThinkingMode;
  budgetMs: number;
  usedMs: number;
  pipeline: string[];
  breakdown: ThinkingBreakdown[];
  result: AttachmentResult;
  monitor: AttachmentMonitor;
  actions: string[];
}

/**
 * Intelligence Scheduler: 時間予算（Thinking Budget）内で優先度順に Attachment を配分。
 * 例: budget=300ms → Reflection(150) + Planning(250 は余らない) … / budget=80ms → 最小のみ
 */
export function intelligenceScheduler(attachments: Attachment[], budgetMs: number): ScheduledAttachment[] {
  const sorted = [...attachments].sort((a, b) => attachmentPriority(b) - attachmentPriority(a));
  const out: ScheduledAttachment[] = [];
  let remaining = budgetMs;
  for (const a of sorted) {
    if (a.estimatedLatency > remaining) continue; // 予算超過
    out.push({ id: a.id, priority: attachmentPriority(a), budgetMs: a.estimatedLatency });
    remaining -= a.estimatedLatency;
  }
  return out;
}

/** Executive がモードとタスクから実行パイプライン（Attachment 列）を解決する */
export async function resolvePipeline(
  mode: ThinkingMode,
  manager: AttachmentManager,
  taskText: string,
  opts: { attachments?: string[]; budgetMs?: number } = {},
): Promise<string[]> {
  let ids: string[];
  if (mode === 'fast') {
    ids = [];
  } else if (mode === 'custom') {
    ids = opts.attachments ?? [];
  } else if (mode === 'deep') {
    // 可能な Attachment を積極利用（固定的パイプライン）
    ids = ['planning', 'debate', 'reflection', 'simulation'];
  } else {
    // auto: Executive がタスクから自動選択
    const budget = estimateBudget(taskText);
    if (!budget.allowReasoning) {
      ids = []; // 2+2 → Fast Runtime のみ
    } else {
      ids = manager.list().filter((a) => a.enabled && a.supports(taskText)).map((a) => a.id);
      if (budget.reason === 'high') {
        // 難しいタスク: Planning + Debate + Creativity + Reflection も自動起動
        for (const extra of ['planning', 'debate', 'creativity', 'reflection']) {
          if (!ids.includes(extra)) ids.push(extra);
        }
      }
    }
  }
  // 時間予算（Thinking Budget）で絞る
  const avail = ids.map((id) => manager.get(id)).filter((a): a is Attachment => a !== undefined);
  return intelligenceScheduler(avail, opts.budgetMs ?? 1000).map((s) => s.id);
}

/** Fast の基底結果（Kernel → Expert Runtime → Answer） */
function fastResult(text: string): AttachmentResult {
  return {
    ok: true,
    text,
    quality: 0.5,
    latencyMs: 0,
    calls: 0,
    tokens: estimateTokens(text),
    detail: ['FAST: Attachment なし（Kernel → Expert Runtime → Answer）'],
  };
}

/** Thinking Runtime: モード解決 → 時間予算内で実行 → 内訳を可視化 */
export async function runThinking(
  text: string,
  booted: BootResult,
  opts: { mode: ThinkingMode; budgetMs?: number; attachments?: string[] },
): Promise<ThinkingResult> {
  const monitor = new AttachmentMonitor();
  const manager = new AttachmentManager(monitor);
  registerBuiltinAttachments(manager);
  await Promise.all(BUILTIN_ATTACHMENT_IDS.map((id) => manager.load(id)));
  const budgetMs = opts.budgetMs ?? 1000;
  const ctx: AttachmentContext = { text, booted, attach: (id) => manager.execute(id, ctx) };

  const pipeline = await resolvePipeline(opts.mode, manager, text, { attachments: opts.attachments, budgetMs });
  const actions: string[] = [`MODE: ${opts.mode} budget=${budgetMs}ms`];
  const results: AttachmentResult[] = [];
  const breakdown: ThinkingBreakdown[] = [];
  for (const id of pipeline) {
    const r = await manager.execute(id, ctx);
    results.push(r);
    breakdown.push({ id, latencyMs: r.latencyMs });
    actions.push(`  ${id}: ${r.latencyMs}ms (q=${r.quality.toFixed(2)})`);
  }
  const result = results.length > 0 ? mergeResults('thinking', results) : fastResult(text);
  const usedMs = breakdown.reduce((s, b) => s + b.latencyMs, 0);
  return { mode: opts.mode, budgetMs, usedMs, pipeline, breakdown, result, monitor, actions };
}

/** 思考内訳の表示（Thinking Budget の可視化 = 他モデルにはない透明性） */
export function renderThinking(r: ThinkingResult): string {
  const lines = [`=== Thinking (${r.mode}) budget=${r.budgetMs}ms used=${r.usedMs}ms ===`];
  for (const b of r.breakdown) lines.push(`  ${b.id.padEnd(12)} ${b.latencyMs}ms`);
  if (r.breakdown.length === 0) lines.push('  （Attachment なし = Fast Runtime）');
  lines.push(`  TOTAL       ${r.usedMs}ms / quality=${r.result.quality.toFixed(2)}`);
  lines.push(`  ANSWER: ${r.result.text.slice(0, 60)}`);
  return lines.join('\n');
}

export interface ThinkingBenchmarkRow {
  mode: string;
  latencyMs: number;
  tokens: number;
  quality: number;
}

/** モード比較ベンチ（Fast / Auto / Deep）—「必要なときだけ高度な推論を起動する」有効性を示す */
export async function runThinkingBenchmark(task = 'この論文を批判的にレビューして'): Promise<ThinkingBenchmarkRow[]> {
  const booted = (await import('../ailsm/expert-runtime.js')).boot();
  const fast = await runThinking(task, booted, { mode: 'fast' });
  const auto = await runThinking(task, booted, { mode: 'auto' });
  const deep = await runThinking(task, booted, { mode: 'deep' });
  return [
    { mode: 'Fast', latencyMs: fast.usedMs, tokens: fast.result.tokens, quality: fast.result.quality },
    { mode: 'Auto', latencyMs: auto.usedMs, tokens: auto.result.tokens, quality: auto.result.quality },
    { mode: 'Deep', latencyMs: deep.usedMs, tokens: deep.result.tokens, quality: deep.result.quality },
  ];
}

export function renderThinkingBenchmark(rows: ThinkingBenchmarkRow[]): string {
  const lines = ['=== Thinking Benchmark ===', 'mode  latency  tokens  quality'];
  for (const r of rows) {
    lines.push(`${r.mode.padEnd(6)} ${String(r.latencyMs).padStart(6)}ms ${String(r.tokens).padStart(6)}   ${r.quality.toFixed(2)}`);
  }
  return lines.join('\n');
}

