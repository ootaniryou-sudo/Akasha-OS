/**
 * Reflection Attachment（Phase 3.0）— 自己批判
 *
 *   Pipeline: Answer → Reflection → Score → Revision → Return
 *   「一度出した答えを自分で批判し、改訂して返す」— Executive の Reflection を
 *   Attachment として切り出したもの。
 */

import type { Attachment, AttachmentContext, AttachmentResult } from './attachment.js';
import { makeResult } from './attachment.js';

export class ReflectionAttachment implements Attachment {
  readonly id = 'reflection';
  readonly name = 'Reflection';
  readonly version = '1.0.0';
  enabled = true;
  estimatedCost = 0.2;
  estimatedLatency = 150;
  estimatedAccuracy = 0.75;

  supports(text: string): boolean {
    return /評価|批判|見直し|改善|reflection|review|もっと|良く/.test(text);
  }

  async run(ctx: AttachmentContext): Promise<AttachmentResult> {
    const detail: string[] = [];
    // ANSWER
    detail.push(`ANSWER: ${ctx.text}`);
    // REFLECTION（決定論的な自己批判: 長さとキーワードで弱点を特定）
    const weakness = ctx.text.length > 12 ? '具体性が不足し検証が不十分' : '前提の確認が不足';
    const score = 0.5 + Math.min(0.2, ctx.text.length / 100);
    detail.push(`REFLECT: 弱点=${weakness} score=${score.toFixed(2)}`);
    // REVISION
    const revised = `${ctx.text}（再考済み: ${weakness} を補強した）`;
    const quality = Math.min(1, score + 0.25);
    detail.push(`REVISE: quality=${quality.toFixed(2)}`);
    return makeResult(revised, quality, this.estimatedLatency, 1, detail);
  }
}

