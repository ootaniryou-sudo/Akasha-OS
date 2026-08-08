/**
 * Hierarchy Runtime（v2 研究テーマ: Hierarchical Runtime Intelligence）
 *
 * > Intelligence is not a monolithic model, but a hierarchical runtime
 * > composed of autonomous decision layers.
 * > （知能は単一モデルではなく、自律的な意思決定層から構成される階層的ランタイムである。）
 *
 * 階層: Master → Caravan（Role 付き）→ Device → Expert
 *
 * 各階層は Decision / Policy / Budget / Memory を持ち、
 * 「考える → 判断する → 命令する → 学習する」を自律的に行う。
 *
 * - Master  : Global Policy  — 全体の判断（どの Caravan に任せるか）
 * - Caravan : Regional Policy — Role 別の判断（配下 Device の割り当て）
 * - Device  : Local Policy   — 実行判断（どの Expert を使うか）
 * - Expert  : Execution      — 実行（Attachment 層とも接続可能）
 *
 * 階層間の情報は「要約」でやり取りする（下位の詳細をそのまま送らない）。
 */

export type HierarchyKind = 'master' | 'caravan' | 'device' | 'expert';

/** 各階層の「最後の判断」（意思決定の記録） */
export interface HierarchyDecision {
  lastDecision: string;
  rationale: string;
  autonomy: number; // 0-1（上位に相談せず判断する度合い）
  decidedAt: number;
  decisionCount: number;
}

/** 各階層のポリシー（判断ルール + 階層ごとの学習） */
export interface HierarchyPolicy {
  name: string;
  rules: string[];
  updatedAt: number;
  gains: Record<string, number>; // 階層ごとの学習（EMA）: key = outcome 種別
  samples: number;
}

/** 各階層の予算（時間・電力・メモリ） */
export interface HierarchyBudget {
  timeMs: number;    // 時間予算
  powerMw: number;   // 電力予算
  memoryMb: number;  // メモリ予算
  usedMs: number;    // 使用済み時間
  usedPowerMw: number; // 使用済み電力
}

/** 各階層の記憶（下位の詳細を上位へ要約して渡す） */
export interface HierarchyMemoryEntry {
  task: string;
  decision: string;
  outcome: number; // 0-1
  at: number;
}

export interface HierarchyMemory {
  capacity: number;
  entries: HierarchyMemoryEntry[];
  summary: string; // 上位へ渡す要約（階層間の情報要約）
}

export interface HierarchyNode {
  id: string;
  kind: HierarchyKind;
  name: string;
  role?: string; // Caravan の役割（Vision / Language / Math / Planning / Search / Robot）
  children: HierarchyNode[];
  decision: HierarchyDecision;
  policy: HierarchyPolicy;
  budget: HierarchyBudget;
  memory: HierarchyMemory;
}

const AUTONOMY: Record<HierarchyKind, number> = {
  master: 0.9,  // 全体を自律判断
  caravan: 0.7, // Role 内で自律判断
  device: 0.5,  // 実行を判断
  expert: 0.3,  // 実行に集中
};

const BUDGET: Record<HierarchyKind, { timeMs: number; powerMw: number; memoryMb: number }> = {
  master: { timeMs: 5000, powerMw: 300, memoryMb: 1024 },
  caravan: { timeMs: 2000, powerMw: 500, memoryMb: 512 },
  device: { timeMs: 800, powerMw: 1500, memoryMb: 256 },
  expert: { timeMs: 300, powerMw: 2000, memoryMb: 64 },
};

/** 階層ノードの生成（デフォルト値の注入） */
export function hierarchyNode(
  partial: Partial<HierarchyNode> & { id: string; kind: HierarchyKind; name: string },
): HierarchyNode {
  const b = BUDGET[partial.kind];
  return {
    role: undefined,
    children: [],
    decision: {
      lastDecision: '初期状態',
      rationale: 'まだ判断していない',
      autonomy: AUTONOMY[partial.kind],
      decidedAt: 0,
      decisionCount: 0,
    },
    policy: { name: `${partial.name} Policy`, rules: [], updatedAt: 0, gains: {}, samples: 0 },
    budget: {
      timeMs: b.timeMs,
      powerMw: b.powerMw,
      memoryMb: b.memoryMb,
      usedMs: 0,
      usedPowerMw: 0,
    },
    memory: { capacity: 10, entries: [], summary: '' },
    ...partial,
  };
}

/** 判断を記録（Decision 更新 + Policy サンプル増加 + Budget 使用量反映） */
export function recordDecision(node: HierarchyNode, decision: string, rationale: string, ms = 0, powerMw = 0): void {
  node.decision.lastDecision = decision;
  node.decision.rationale = rationale;
  node.decision.decidedAt = Date.now();
  node.decision.decisionCount += 1;
  node.policy.samples += 1;
  node.policy.updatedAt = Date.now();
  node.budget.usedMs += ms;
  node.budget.usedPowerMw += powerMw;
}

/**
 * 階層ごとの学習: 実行結果（outcome 0-1）を EMA でポリシーに反映し、
 * Memory に記録して要約を更新する。
 */
export function learnNode(node: HierarchyNode, task: string, outcome: number, alpha = 0.3): void {
  const prev = node.policy.gains['outcome'] ?? 0.5;
  node.policy.gains['outcome'] = Math.round((prev * (1 - alpha) + outcome * alpha) * 100) / 100;
  node.memory.entries.unshift({ task, decision: node.decision.lastDecision, outcome, at: Date.now() });
  if (node.memory.entries.length > node.memory.capacity) node.memory.entries.pop();
}

/** ノードの記憶を要約（階層間の情報要約 — 下位の詳細をそのまま送らない） */
export function summarize(node: HierarchyNode): string {
  const n = node.memory.entries.length;
  if (n === 0) return `${node.name}: 未経験`;
  const avg = node.memory.entries.reduce((s, e) => s + e.outcome, 0) / n;
  const last = node.memory.entries[0];
  return `${node.name}(${n}回, avg ${(avg * 100).toFixed(0)}%) 直近: ${last.decision}`;
}

/**
 * 下位の要約を上位へ集約する（ボトムアップ）。子の要約を親の memory.summary に連結。
 */
export function climbSummary(node: HierarchyNode): string {
  if (node.kind === 'expert') {
    node.memory.summary = summarize(node);
    return node.memory.summary;
  }
  const childrenSum = node.children.map((c) => climbSummary(c));
  node.memory.summary = `${summarize(node)} | ${childrenSum.join(' / ')}`;
  return node.memory.summary;
}

/** Hierarchy Runtime の階層構築（Master → Role 付き Caravan → Device → Expert） */
export function buildHierarchy(): HierarchyNode {
  // Expert（末端・実行）
  const expert = (id: string, name: string, role: string): HierarchyNode =>
    hierarchyNode({ id, kind: 'expert', name, role });

  // Device（実行判断）
  const device = (id: string, name: string, experts: HierarchyNode[]): HierarchyNode =>
    hierarchyNode({ id, kind: 'device', name, children: experts });

  // Caravan（Role 別の Regional Policy）
  const caravan = (id: string, role: string, devices: HierarchyNode[]): HierarchyNode =>
    hierarchyNode({ id, kind: 'caravan', name: `${role} Caravan`, role, children: devices });

  const vision = caravan('caravan-vision', 'Vision', [
    device('device-gpu-1', 'GPU-1 (Metal)', [expert('expert-vision', 'Vision Expert', 'vision')]),
    device('device-edge-1', 'Edge-1 (NPU)', [
      expert('expert-vision-2', 'Vision Expert #2', 'vision'),
      expert('expert-memory', 'Memory Expert', 'memory'),
    ]),
  ]);

  const language = caravan('caravan-language', 'Language', [
    device('device-npu-1', 'NPU-1', [
      expert('expert-translate', 'Translate Expert', 'translate'),
      expert('expert-summarizer', 'Summarizer Expert', 'summarizer'),
    ]),
    device('device-cpu-1', 'CPU-1', [
      expert('expert-reasoning', 'Reasoning Expert', 'reasoning'),
      expert('expert-general', 'General Expert', 'general'),
    ]),
  ]);

  const math = caravan('caravan-math', 'Math', [
    device('device-gpu-2', 'GPU-2 (Metal)', [expert('expert-math', 'Math Expert', 'math')]),
    device('device-cpu-2', 'CPU-2', [
      expert('expert-math-2', 'Math Expert #2', 'math'),
      expert('expert-reasoning-2', 'Reasoning #2', 'reasoning'),
    ]),
  ]);

  const planning = caravan('caravan-planning', 'Planning', [
    device('device-cpu-3', 'CPU-3', [
      expert('expert-planning', 'Planning Expert', 'planning'),
      expert('expert-memory-2', 'Memory #2', 'memory'),
    ]),
  ]);

  const search = caravan('caravan-search', 'Search', [
    device('device-cpu-4', 'CPU-4', [
      expert('expert-search', 'Search Expert', 'search'),
      expert('expert-retriever', 'Retriever Expert', 'retriever'),
    ]),
  ]);

  return hierarchyNode({
    id: 'master-0',
    kind: 'master',
    name: 'ArcAsha Master',
    children: [vision, language, math, planning, search],
  });
}

