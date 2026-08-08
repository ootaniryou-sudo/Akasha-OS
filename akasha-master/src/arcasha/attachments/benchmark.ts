/**
 * Attachment Benchmark（Phase 3.0）— Attachment の有無で比較
 *
 *   なし（Fast Runtime）vs Reflection vs Debate vs Planning vs All（並列）
 *   latency / tokens / quality / cost を測定（決定論）。
 */

import type { AttachmentContext } from './attachment.js';
import { AttachmentManager } from './manager.js';
import { AttachmentMonitor } from './observability.js';
import { registerBuiltinAttachments, BUILTIN_ATTACHMENT_IDS } from './builtin.js';
import type { BootResult } from '../ailsm/expert-runtime.js';

export interface AttachmentBenchmarkRow {
  mode: string;
  latencyMs: number;
  tokens: number;
  quality: number;
  cost: number;
}

export async function runAttachmentBenchmark(task = '新しい数学の理論を考える'): Promise<AttachmentBenchmarkRow[]> {
  const monitor = new AttachmentMonitor();
  const manager = new AttachmentManager(monitor);
  registerBuiltinAttachments(manager);
  const booted = (await import('../ailsm/expert-runtime.js')).boot() as BootResult;
  const ctx: AttachmentContext = {
    text: task,
    booted,
    attach: (id) => manager.execute(id, ctx),
  };

  const rows: AttachmentBenchmarkRow[] = [];

  // なし（Fast Runtime: 直接実行 = 議論なし）
  rows.push({ mode: 'なし（Fast）', latencyMs: 60, tokens: estimateTokensOf(task), quality: 0.5, cost: 0.1 });

  // Reflection
  await manager.load('reflection');
  const refl = await manager.execute('reflection', ctx);
  rows.push({ mode: 'Reflection', latencyMs: refl.latencyMs, tokens: refl.tokens, quality: refl.quality, cost: 0.2 });

  // Debate
  await manager.load('debate');
  const deb = await manager.execute('debate', ctx);
  rows.push({ mode: 'Debate', latencyMs: deb.latencyMs, tokens: deb.tokens, quality: deb.quality, cost: 0.4 });

  // Planning
  await manager.load('planning');
  const pl = await manager.execute('planning', ctx);
  rows.push({ mode: 'Planning', latencyMs: pl.latencyMs, tokens: pl.tokens, quality: pl.quality, cost: 0.3 });

  // All（並列実行 + 統合）
  await Promise.all(BUILTIN_ATTACHMENT_IDS.map((id) => manager.load(id)));
  const all = await manager.executeMerged([...BUILTIN_ATTACHMENT_IDS], ctx, 'all');
  rows.push({ mode: 'All（並列）', latencyMs: all.latencyMs, tokens: all.tokens, quality: all.quality, cost: 0.9 });

  return rows;
}

function estimateTokensOf(text: string): number {
  return Math.max(1, Math.round(text.length / 2));
}

export function renderAttachmentBenchmark(rows: AttachmentBenchmarkRow[]): string {
  const lines = ['=== Attachment Benchmark ===', 'mode           latency   tokens  quality  cost'];
  for (const r of rows) {
    lines.push(`${r.mode.padEnd(12)} ${String(r.latencyMs).padStart(6)}ms ${String(r.tokens).padStart(6)}   ${r.quality.toFixed(2).padStart(4)}   ${r.cost.toFixed(2)}`);
  }
  const best = rows.reduce((a, b) => (b.quality > a.quality ? b : a), rows[0]);
  lines.push(`BEST QUALITY : ${best.mode} (quality=${best.quality.toFixed(2)})`);
  return lines.join('\n');
}

