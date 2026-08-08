/**
 * Built-in Attachments（Phase 3.0）— 組み込みプラグインの遅延ロード登録
 *
 *   全て AttachmentManager へローダーとして登録する（load されるまで実体を生成しない）。
 *   無効化された Attachment は Core に何も影響しない（Linux のオプションカーネルモジュール）。
 */

import type { AttachmentManager } from './manager.js';
import { ReflectionAttachment } from './reflection.js';
import { DebateAttachment } from './debate.js';
import { PlanningAttachment } from './planning.js';
import { CreativityAttachment } from './creativity.js';
import { SearchAttachment } from './search-attachment.js';
import { SimulationAttachment } from './simulation.js';
import { CodingAttachment } from './coding.js';

export const BUILTIN_ATTACHMENT_IDS = ['reflection', 'debate', 'planning', 'creativity', 'search', 'simulation', 'coding'] as const;

/** 全組み込み Attachment を遅延ローダーとして登録 */
export function registerBuiltinAttachments(manager: AttachmentManager): void {
  manager.register('reflection', async () => new ReflectionAttachment());
  manager.register('debate', async () => new DebateAttachment());
  manager.register('planning', async () => new PlanningAttachment());
  manager.register('creativity', async () => new CreativityAttachment());
  manager.register('search', async () => new SearchAttachment());
  manager.register('simulation', async () => new SimulationAttachment());
  manager.register('coding', async () => new CodingAttachment());
}

