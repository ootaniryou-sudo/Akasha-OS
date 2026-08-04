/**
 * AI OS Init（Phase 1.2）— Hub（demo-web.ts）を AI OS 本体にする
 *
 *   boot（DeviceTree + Kernel + Mock ドライバ）
 *     + ModelClient（実デバイス Qwen/Phi/Gemma）
 *     + RemoteDriver（実LLM）
 *     + DeviceTree（Mac / iPhone / iPad 登録）
 *     + CapabilityLearner（ODAR オンライン学習）
 *
 *   aiosExecute: テキスト → コンパイル → CALL → 実デバイス委譲 → 結果を学習に記録
 *   aiosRelay:   Planner → Math → Search → Reasoning → Planner を AILSA でリレー
 */

import { boot, execute } from './expert-runtime.js';
import type { BootResult, ExpertExecution } from './expert-runtime.js';
import { RemoteDriver } from './remote-driver.js';
import { MockModelClient } from './model-client.js';
import type { ModelClient } from './model-client.js';
import { registerHubDevices, routeCall } from './device-router.js';
import { CapabilityLearner } from './learning.js';
import { runRelay } from './relay.js';
import type { RelayResult, RelayStep } from './relay.js';
import type { ExpertDriver } from './driver.js';

export interface AiOs {
  booted: BootResult;
  client: ModelClient;
  learner: CapabilityLearner;
  remoteDrivers: Map<string, RemoteDriver>; // deviceId → 実LLMドライバ
}

/** AI OS を起動する（実デバイスがあれば自動登録 + RemoteDriver を用意） */
export function initAiOs(client?: ModelClient): AiOs {
  const c = client ?? new MockModelClient();
  const booted = boot();
  const nodes = c.listNodes();
  const remoteDrivers = new Map<string, RemoteDriver>();
  if (nodes.length > 0) {
    registerHubDevices(booted.deviceTree, nodes);
    for (const n of nodes) {
      remoteDrivers.set(
        n.nodeId,
        new RemoteDriver(`remote:${n.nodeId}`, `Qwen@${n.nodeId}`, c, { deviceId: n.nodeId, maxTokens: 64 }),
      );
    }
  }
  return { booted, client: c, learner: new CapabilityLearner(), remoteDrivers };
}

export interface AiosExecution extends ExpertExecution {
  deviceId: string | null;
  learned: boolean;
}

/**
 * AI OS でタスクを実行。CALL は実デバイス（RemoteDriver）へ委譲され、
 * 実実行の観測（latency / 成功）を CapabilityLearner が学習する。
 */
export async function aiosExecute(aios: AiOs, text: string, deviceId?: string): Promise<AiosExecution> {
  const { booted, client, remoteDrivers } = aios;
  const nodes = client.listNodes();
  const target = deviceId ?? routeCall(booted.deviceTree, nodes.length > 0 ? nodes[0].nodeId : undefined);
  const resolver = (expert: string): ExpertDriver | undefined => {
    if (target) {
      const rd = remoteDrivers.get(target);
      if (rd) return rd;
    }
    return booted.drivers.get(expert);
  };
  const ex = await execute(text, booted, resolver);
  if (ex.driverId && ex.driverResponse) {
    aios.learner.observe(ex.driverId, {
      accuracy: ex.driverResponse.ok ? 0.9 : 0.1,
      latencyMs: Math.max(1, ex.ms),
      cost: 0.1,
    });
  }
  return { ...ex, deviceId: target ?? null, learned: ex.driverId !== null };
}

/** 複数 Expert を AILSA でリレー（実デバイスへ委譲可能） */
export async function aiosRelay(aios: AiOs, steps: RelayStep[], deviceId?: string): Promise<RelayResult> {
  const { booted, remoteDrivers } = aios;
  const target = deviceId ?? routeCall(booted.deviceTree);
  const resolver = (expert: string): ExpertDriver | undefined => {
    if (target) {
      const rd = remoteDrivers.get(target);
      if (rd) return rd;
    }
    return booted.drivers.get(expert);
  };
  return runRelay(booted, steps, resolver);
}

/** AI OS の状態表示（aiperf 風） */
export function renderAiOs(aios: AiOs): string {
  const lines: string[] = ['=== AI OS ==='];
  lines.push('DeviceTree:');
  lines.push(aios.booted.deviceTree.describe().split('\n').map((l) => '  ' + l).join('\n'));
  lines.push(`Learner    : ${aios.learner.all().length} expert(s) 学習済み`);
  for (const c of aios.learner.all()) {
    lines.push(`  ${c.expert.padEnd(16)} acc=${c.accuracy.toFixed(2)} lat=${c.latencyMs.toFixed(1)}ms cost=${c.cost.toFixed(2)} n=${c.samples}`);
  }
  return lines.join('\n');
}
