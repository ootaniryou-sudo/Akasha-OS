/**
 * Device Router / 分散 Context（Phase 1.3 / 1.4）— Mac・iPhone・iPad へのルーティング
 *
 *   CALL math → DeviceTree → iPad  （Phase 1.3）
 *   Context Page をデバイスへ配置   （Phase 1.4）
 *
 *   Page1: Mac / Page2: iPad / Page3: iPhone
 *   Context Fault → Kernel → Device Tree → ページ取得（実デバイスが処理）
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';
import { DeviceTree } from './device-tree.js';
import type { ModelClient, ModelNode } from './model-client.js';

export type DeviceRole = 'mac' | 'iphone' | 'ipad' | 'other';

export function deviceRoleOf(nodeId: string): DeviceRole {
  if (nodeId.includes('iphone')) return 'iphone';
  if (nodeId.includes('ipad')) return 'ipad';
  if (nodeId.includes('mac')) return 'mac';
  return 'other';
}

/** Hub に接続中の実ノードを DeviceTree へ登録（Phase 1.3。既存ノードはスキップ） */
export function registerHubDevices(deviceTree: DeviceTree, nodes: ModelNode[]): void {
  for (const n of nodes) {
    if (deviceTree.node(n.nodeId)) continue; // 再接続時の重複を防ぐ
    const role = deviceRoleOf(n.nodeId);
    deviceTree.registerNode({
      id: n.nodeId,
      arch: 'arm64',
      cpu: role === 'iphone' ? 'A17 Pro' : role === 'ipad' ? 'M4' : 'Apple Silicon',
      gpu: 'Metal (ggml)',
      ramMB: role === 'mac' ? 16384 : 8192,
      battery: role === 'mac' ? undefined : 75,
      network: true,
      language: 'ja',
      cost: role === 'mac' ? 0.1 : 0.05,
      features: { modelId: n.modelId, paramsM: n.paramsM, online: true },
    });
  }
}

/** CALL の宛先デバイスを決める（決定論: 優先指定 → Mac/ローカル → 最初のノード） */
export function routeCall(deviceTree: DeviceTree, preferred?: string): string | null {
  if (preferred) {
    const n = deviceTree.node(preferred);
    if (n) return n.id;
  }
  const nodes = deviceTree.list();
  const mac = nodes.find((n) => n.id.includes('mac') || n.id.includes('local-pc'));
  if (mac) return mac.id;
  return nodes[0]?.id ?? null;
}

/** ページをデバイスへ配置（分散 Context: page attrs.device） */
export function assignPageDevice(g: AilsmGraph, pageId: number, deviceId: string): AilsmGraph {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(
      n.kind,
      n.label,
      n.type,
      n.id === pageId ? { ...n.attrs, device: deviceId } : n.attrs,
      n.constraints,
    );
    remap.set(n.id, id);
  }
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return b.graph();
}

/** ページが置かれているデバイス */
export function pageDevice(g: AilsmGraph, pageId: number): string | null {
  const p = g.nodes.find((n) => n.id === pageId);
  if (!p) return null;
  const d = p.attrs.device;
  return d === undefined ? null : String(d);
}

export interface DistributedFetch {
  text: string;
  fromDevice: string;
  ms: number;
}

/**
 * 分散 Context Fault: ページが実デバイス上にある場合、そのデバイスへ「読ませる」。
 * （実装: ModelClient 経由でデバイスにページを送り、生成結果を返す）
 */
export async function distributedFault(
  client: ModelClient,
  deviceId: string,
  pageText: string,
): Promise<DistributedFetch> {
  const t0 = Date.now();
  const text = await client.generate(deviceId, `このページを読んで要約してください: ${pageText.slice(0, 200)}`, 32);
  return { text, fromDevice: deviceId, ms: Date.now() - t0 };
}
