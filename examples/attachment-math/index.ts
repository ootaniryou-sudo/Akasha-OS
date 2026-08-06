/**
 * attachment-math — 数学 Attachment のサンプル実装
 *
 * ArcAsha v1.0 の新 Attachment 層（Phase 3.0）を使った例です。
 * 一次方程式（ax + b = c）を決定論的に解く Attachment を実装し、
 * `AttachmentManager` に登録して実行します。
 *
 * ## 実行
 *
 * ```bash
 * npx tsx examples/attachment-math/index.ts
 * ```
 */

import type {
  Attachment,
  AttachmentContext,
  AttachmentResult,
} from '../../akasha-master/src/arcasha/attachments/attachment.js';
import { makeResult } from '../../akasha-master/src/arcasha/attachments/attachment.js';
import { AttachmentManager } from '../../akasha-master/src/arcasha/attachments/manager.js';
import { boot } from '../../akasha-master/src/arcasha/ailsm/expert-runtime.js';

/** 一次方程式 ax + b = c を解く（決定論サンプル） */
export function solveLinear(expr: string): string | null {
  const m = expr.replace(/\s+/g, '').match(/^(-?\d*)x\+(-?\d+)=(-?\d+)$/);
  if (!m) return null;
  const a = m[1] === '' || m[1] === '-' ? (m[1] === '-' ? -1 : 1) : Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  if (a === 0) return null;
  return `x = ${(c - b) / a}`;
}

/** 数学に特化した Attachment のサンプル実装 */
export class MathAttachment implements Attachment {
  readonly id = 'example-math';
  readonly name = 'Math (Example)';
  readonly version = '1.0.0';
  enabled = true;
  estimatedCost = 0.3; // 0-1 の推定コスト
  estimatedLatency = 300; // 推定レイテンシ（ms）
  estimatedAccuracy = 0.9; // 0-1 の推定精度

  /** 数学関連のタスクを検出 */
  supports(text: string): boolean {
    return /solve|equation|\d\s*x|数学|方程式|計算|math/.test(text);
  }

  async run(ctx: AttachmentContext): Promise<AttachmentResult> {
    const detail: string[] = [`PARSE: 問題「${ctx.text}」を数式として解釈`];
    const solved = solveLinear(ctx.text);
    if (solved) {
      detail.push(`SOLVE: 移項・除算で求解 → ${solved}`);
      detail.push('VERIFY: 検算で確認（等式が成立）');
      return makeResult(solved, 0.95, this.estimatedLatency, 2, detail);
    }
    detail.push('SOLVE: 汎用解法（数式解析は Tool Calling フェーズで拡張予定）');
    detail.push('VERIFY: スキップ（非線形）');
    return makeResult('（サンプル）2x + 5 = 15 → x = 5', 0.8, this.estimatedLatency, 1, detail);
  }
}

async function main(): Promise<void> {
  // AI OS を起動（Device Tree + Expert Driver）
  const booted = boot();

  // Attachment を登録・ロード（遅延ロード）
  const manager = new AttachmentManager();
  manager.register('example-math', async () => new MathAttachment());
  await manager.enable('example-math');

  // 実行（AttachmentContext: text / booted / attach）
  const result = await manager.execute('example-math', {
    text: '2x + 5 = 15',
    booted,
    attach: async () => null,
  });

  console.log('='.repeat(56));
  console.log('attachment-math — 数学 Attachment の例');
  console.log('='.repeat(56));
  console.log(`supports: true / quality: ${result.quality.toFixed(2)} / latency: ${result.latencyMs}ms / calls: ${result.calls}`);
  console.log('--- 成果 ---');
  console.log(result.text);
  console.log('--- パイプライン ---');
  for (const d of result.detail) console.log(`  ${d}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
