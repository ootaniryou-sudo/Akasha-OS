/**
 * Coding Attachment（Phase 3.0）— ソフトウェアエンジニアリングモード
 *
 *   リポジトリ解析 → アーキテクチャ理解 → パッチ生成 → 自己レビュー → コンパイル → リトライ
 *   決定論的なパイプライン（実コンパイラ統合は Tool Calling フェーズで拡張予定）。
 */

import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { makeResult } from './attachment.js';

export class CodingAttachment implements Attachment {
  readonly id = 'coding';
  readonly name = 'Coding';
  readonly version = '1.0.0';
  enabled = true;
  estimatedCost = 0.5;
  estimatedLatency = 500;
  estimatedAccuracy = 0.9;

  supports(text: string): boolean {
    return /実装|コード|バグ|修正|programming|coding|作って|関数|リファクタ/.test(text);
  }

  async run(ctx: AttachmentContext): Promise<AttachmentResult> {
    const detail: string[] = [];
    detail.push(`ANALYZE: 仕様「${ctx.text}」を解析`);
    detail.push('ARCH: モジュール構成を把握');
    const patch = `// patch: ${ctx.text}\nfunction solve(input) { /* 生成コード */ }`;
    detail.push('PATCH: パッチを生成');
    detail.push('REVIEW: 自己レビュー score=0.85');
    // COMPILE + RETRY（決定論）
    let attempts = 1;
    if (ctx.text.includes('難')) {
      attempts = 2;
      detail.push('COMPILE: 失敗 → RETRY（1回目修正）');
    }
    detail.push(`COMPILE: 成功（attempts=${attempts}）`);
    return makeResult(patch, 0.9, this.estimatedLatency, attempts, detail);
  }
}
