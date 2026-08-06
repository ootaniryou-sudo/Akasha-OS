/**
 * attachment-code — コード生成 Attachment のサンプル実装
 *
 * ArcAsha v1.0 の新 Attachment 層（Phase 3.0）を使った例です。
 * `Attachment` インターフェースを実装し、`AttachmentManager` に登録します。
 * Kernel 状態は直接変更せず、`AttachmentContext` 経由でのみ実行します。
 *
 * ## 実行
 *
 * ```bash
 * npx tsx examples/attachment-code/index.ts
 * ```
 *
 * ## 旧 v1 の plugin 層との違い
 *
 * - 旧: `AkashaExpertPlugin`（テンソル入出力・ルーター直結・Expert ノード前提）
 * - 新: `Attachment`（テキスト成果 + 品質/コスト/レイテンシのメタ情報。Executive が選択）
 */

import type {
  Attachment,
  AttachmentContext,
  AttachmentResult,
} from '../../akasha-master/src/arcasha/attachments/attachment.js';
import { makeResult } from '../../akasha-master/src/arcasha/attachments/attachment.js';
import { AttachmentManager } from '../../akasha-master/src/arcasha/attachments/manager.js';
import { boot } from '../../akasha-master/src/arcasha/ailsm/expert-runtime.js';

/** コード生成に特化した Attachment のサンプル実装 */
export class CodeAttachment implements Attachment {
  readonly id = 'example-code';
  readonly name = 'Code (Example)';
  readonly version = '1.0.0';
  enabled = true;
  estimatedCost = 0.5; // 0-1 の推定コスト
  estimatedLatency = 400; // 推定レイテンシ（ms）
  estimatedAccuracy = 0.85; // 0-1 の推定精度

  /** コード関連のタスクを検出 */
  supports(text: string): boolean {
    return /コード|実装|関数|バグ|修正|リファクタ|coding|implement|function|refactor/.test(text);
  }

  async run(ctx: AttachmentContext): Promise<AttachmentResult> {
    const detail: string[] = [
      `ANALYZE: 仕様「${ctx.text}」を解析`,
      'ARCH: モジュール構成を設計',
      'PATCH: パッチを生成',
      'REVIEW: 自己レビュー score=0.86',
      'COMPILE: 成功',
    ];
    const patch = [
      '// patch: サンプル生成コード',
      'export function solve(input: number[]): number {',
      '  return input.reduce((a, b) => a + b, 0);',
      '}',
    ].join('\n');
    return makeResult(patch, 0.85, this.estimatedLatency, 3, detail);
  }
}

async function main(): Promise<void> {
  // AI OS を起動（Device Tree + Expert Driver）
  const booted = boot();

  // Attachment を登録・ロード（遅延ロード）
  const manager = new AttachmentManager();
  manager.register('example-code', async () => new CodeAttachment());
  await manager.enable('example-code');

  // 実行（AttachmentContext: text / booted / attach）
  const result = await manager.execute('example-code', {
    text: '数値配列の合計を返す関数を実装して',
    booted,
    attach: async () => null,
  });

  console.log('='.repeat(56));
  console.log('attachment-code — コード生成 Attachment の例');
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
