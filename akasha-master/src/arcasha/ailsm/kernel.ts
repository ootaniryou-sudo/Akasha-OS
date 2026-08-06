/**
 * AI Kernel — Kernel-mediated AI Runtime（AI OS のカーネル）
 *
 * Expert（User Space）は Kernel に直接触れない。全て System Call（syscall）で要求し、
 * Kernel が 権限チェック → 適用 する（OS の User/Kernel 分離と同型）。
 *
 * User Space:    Task / Object / Value / Expert / Planner / Verifier
 * Kernel Space:  Memory / Belief / Schedule / Reflection / Capability / Process / Thread / Namespace
 *
 * Memory API:     STORE / LOAD / QUERY / DELETE（Expert は直接 Memory SSA を触れない）
 * Reflection API: REFLECT REQUEST（Kernel → Reflection Node）
 * Capability API: UPDATE_CAPABILITY（権限チェック付き）
 * その他:         EXECUTE / SPAWN / PLAN / VERIFY / ROUTE
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph, NodeKind } from './ailsm.js';
import {
  createProcess,
  plan,
  reflect,
  remember,
  schedule,
  setProcessState,
} from './state.js';
import { SyscallOpcode } from '../ailsa/opcode.js';

export type SyscallKind =
  | 'EXECUTE' | 'SPAWN' | 'PLAN' | 'VERIFY' | 'REFLECT' | 'ROUTE'
  | 'MEMORY_STORE' | 'MEMORY_LOAD' | 'MEMORY_QUERY' | 'MEMORY_DELETE'
  | 'UPDATE_CAPABILITY';

export interface SyscallResult {
  granted: boolean;
  syscallId: number;
  graph: AilsmGraph;
  detail: string;
  value?: unknown;
}

/** syscall 種別 → AILSA オペコード */
export const SYSCALL_OPCODE: Record<SyscallKind, number> = {
  EXECUTE: SyscallOpcode.EXECUTE,
  SPAWN: SyscallOpcode.SPAWN,
  PLAN: SyscallOpcode.PLAN,
  VERIFY: SyscallOpcode.VERIFY,
  REFLECT: SyscallOpcode.REFLECT,
  ROUTE: SyscallOpcode.ROUTE,
  MEMORY_STORE: SyscallOpcode.MEMORY_STORE,
  MEMORY_LOAD: SyscallOpcode.MEMORY_LOAD,
  MEMORY_QUERY: SyscallOpcode.MEMORY_QUERY,
  MEMORY_DELETE: SyscallOpcode.MEMORY_DELETE,
  UPDATE_CAPABILITY: SyscallOpcode.UPDATE_CAPABILITY,
};

/** Kernel Space のノード種別（User Space と分離） */
export const KERNEL_NODE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'memory', 'belief', 'schedule', 'reflection', 'capability', 'process', 'thread', 'namespace',
]);

export function isKernelNode(kind: NodeKind): boolean {
  return KERNEL_NODE_KINDS.has(kind);
}

function taskOfProcess(g: AilsmGraph, processId: number): number | undefined {
  const e = g.edges.find((x) => x.to === processId && x.rel === 'processes');
  return e?.from;
}

function rebuildWith(
  g: AilsmGraph,
  overrides: Map<number, { attrs?: AilsmGraph['nodes'][number]['attrs']; skip?: boolean }>,
): AilsmGraph {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const ov = overrides.get(n.id);
    if (ov?.skip) continue;
    const id = b.addNode(n.kind, n.label, n.type, ov?.attrs ?? n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return b.graph();
}

function removeNode(g: AilsmGraph, nodeId: number): AilsmGraph {
  return rebuildWith(g, new Map([[nodeId, { skip: true }]]));
}

function updateNodeAttrs(g: AilsmGraph, nodeId: number, attrs: AilsmGraph['nodes'][number]['attrs']): AilsmGraph {
  return rebuildWith(g, new Map([[nodeId, { attrs }]]));
}

export class AIKernel {
  private seq = 0;

  private next(): number {
    return this.seq++;
  }

  /** 権限チェック（決定論）: DELETE / UPDATE_CAPABILITY は対象 owner と一致が必要 */
  private checkPermission(kind: SyscallKind, owner: string, targetOwner?: string): string | null {
    if ((kind === 'MEMORY_DELETE' || kind === 'UPDATE_CAPABILITY') && targetOwner !== undefined && targetOwner !== owner) {
      return `permission denied: ${owner} cannot ${kind} on ${targetOwner}`;
    }
    return null;
  }

  private ownerOf(g: AilsmGraph, processId: number): string {
    return String(g.nodes.find((n) => n.id === processId && n.kind === 'process')?.attrs.owner ?? '');
  }

  // ── Memory API ──
  memoryStore(g: AilsmGraph, processId: number, key: string, value: string | number | boolean, namespace?: string): SyscallResult {
    const id = this.next();
    const taskId = taskOfProcess(g, processId);
    if (taskId === undefined) {
      return { granted: false, syscallId: id, graph: g, detail: 'process に紐づく task が無い' };
    }
    const r = remember(g, taskId, key, value);
    let out = r.graph;
    if (namespace) {
      const mem = out.nodes.find((n) => n.kind === 'memory' && n.attrs.key === key);
      if (mem) out = updateNodeAttrs(out, mem.id, { ...mem.attrs, namespace });
    }
    return {
      granted: true,
      syscallId: id,
      graph: out,
      detail: `SYSCALL_MEMORY_STORE #${id}: ${key}=${String(value)}`,
      value,
    };
  }

  memoryLoad(g: AilsmGraph, _processId: number, key: string): SyscallResult {
    const id = this.next();
    const mem = g.nodes.find((n) => n.kind === 'memory' && n.attrs.key === key);
    return {
      granted: true,
      syscallId: id,
      graph: g,
      detail: `SYSCALL_MEMORY_LOAD #${id}: ${key}`,
      value: mem ? mem.attrs.value : null,
    };
  }

  memoryQuery(g: AilsmGraph, _processId: number, pattern: string): SyscallResult {
    const id = this.next();
    const hits = g.nodes
      .filter((n) => n.kind === 'memory' && String(n.attrs.key).includes(pattern))
      .map((n) => n.attrs.key);
    return {
      granted: true,
      syscallId: id,
      graph: g,
      detail: `SYSCALL_MEMORY_QUERY #${id}: ${hits.join(',') || '(none)'}`,
      value: hits,
    };
  }

  memoryDelete(g: AilsmGraph, processId: number, key: string, targetOwner?: string): SyscallResult {
    const id = this.next();
    const denied = this.checkPermission('MEMORY_DELETE', this.ownerOf(g, processId), targetOwner);
    if (denied) return { granted: false, syscallId: id, graph: g, detail: denied };
    const mem = g.nodes.find((n) => n.kind === 'memory' && n.attrs.key === key);
    if (!mem) return { granted: false, syscallId: id, graph: g, detail: `memory ${key} not found` };
    return { granted: true, syscallId: id, graph: removeNode(g, mem.id), detail: `SYSCALL_MEMORY_DELETE #${id}: ${key}` };
  }

  // ── Reflection API ──
  reflectRequest(g: AilsmGraph, processId: number, cause: string, fix = ''): SyscallResult {
    const id = this.next();
    const taskId = taskOfProcess(g, processId);
    if (taskId === undefined) {
      return { granted: false, syscallId: id, graph: g, detail: 'process に紐づく task が無い' };
    }
    const r = reflect(g, taskId, cause, fix);
    return { granted: true, syscallId: id, graph: r.graph, detail: `SYSCALL_REFLECT #${id}: ${cause}` };
  }

  // ── Capability API ──
  updateCapability(g: AilsmGraph, processId: number, expert: string, delta: number, targetOwner?: string): SyscallResult {
    const id = this.next();
    const denied = this.checkPermission('UPDATE_CAPABILITY', this.ownerOf(g, processId), targetOwner);
    if (denied) return { granted: false, syscallId: id, graph: g, detail: denied };
    const cap = g.nodes.find((n) => n.kind === 'capability' && n.attrs.expert === expert);
    if (!cap) return { granted: false, syscallId: id, graph: g, detail: `capability ${expert} not found` };
    const old = Number(cap.attrs.accuracy ?? 0.5);
    const accuracy = Math.min(1, Math.max(0, old + delta));
    const graph = updateNodeAttrs(g, cap.id, { ...cap.attrs, accuracy });
    return {
      granted: true,
      syscallId: id,
      graph,
      detail: `SYSCALL_UPDATE_CAPABILITY #${id}: ${expert} acc ${old.toFixed(2)} -> ${accuracy.toFixed(2)}`,
      value: 'updated',
    };
  }

  // ── その他 syscall ──
  planRequest(g: AilsmGraph, processId: number, steps: string[]): SyscallResult {
    const id = this.next();
    const taskId = taskOfProcess(g, processId);
    if (taskId === undefined) return { granted: false, syscallId: id, graph: g, detail: 'task not found' };
    const r = plan(g, taskId, steps);
    return { granted: true, syscallId: id, graph: r.graph, detail: `SYSCALL_PLAN #${id}: ${steps.join(' > ')}` };
  }

  verifyRequest(g: AilsmGraph, _processId: number, target = ''): SyscallResult {
    const id = this.next();
    // Verifier は決定論ルール（validator.ts）が担当。ここでは受理を返す。
    return { granted: true, syscallId: id, graph: g, detail: `SYSCALL_VERIFY #${id}: ${target || '(n/a)'}` };
  }

  routeRequest(g: AilsmGraph, processId: number, expert: string, priority: number, eta: number, cost: number): SyscallResult {
    const id = this.next();
    const taskId = taskOfProcess(g, processId);
    if (taskId === undefined) return { granted: false, syscallId: id, graph: g, detail: 'task not found' };
    const r = schedule(g, taskId, expert, priority, eta, cost);
    return { granted: true, syscallId: id, graph: r.graph, detail: `SYSCALL_ROUTE #${id}: ${expert} pri=${priority.toFixed(2)}` };
  }

  spawnRequest(g: AilsmGraph, taskId: number, owner: string, priority: number): SyscallResult {
    const id = this.next();
    const r = createProcess(g, taskId, { owner, priority, memoryBytes: 48 * 1024 });
    return {
      granted: true,
      syscallId: id,
      graph: r.graph,
      detail: `SYSCALL_SPAWN #${id}: Process#${r.id} owner=${owner}`,
      value: r.id,
    };
  }

  executeRequest(g: AilsmGraph, processId: number): SyscallResult {
    const id = this.next();
    const r = setProcessState(g, processId, 'running');
    return { granted: true, syscallId: id, graph: r.graph, detail: `SYSCALL_EXECUTE #${id}: Process#${processId} running` };
  }
}
