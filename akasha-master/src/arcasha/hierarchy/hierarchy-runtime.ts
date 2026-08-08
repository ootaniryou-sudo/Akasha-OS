/**
 * Hierarchy Runtime — 各階層が「考える → 判断する → 命令する → 学習する」
 *
 * 実行の流れ:
 *   1. Master がタスクを解釈 → Role に合う Caravan を選択（Global Policy）
 *   2. Caravan が Budget 内で Device を選択（Regional Policy）
 *   3. Device が Expert を選択して実行（Local Policy）
 *   4. 各階層が結果を Memory に記録し、要約を上位へ渡す（階層間の情報要約）
 *
 * 実行は決定論モック（kind: simulation）。実機ドライバ / Attachment への
 * 差し替えは Expert ノードの実行部分で行える。
 */

import {
  buildHierarchy,
  climbSummary,
  learnNode,
  recordDecision,
  summarize,
  type HierarchyNode,
  type HierarchyKind,
} from './hierarchy.js';

export interface HierarchyRunStep {
  level: HierarchyKind;
  nodeId: string;
  role?: string;
  decision: string;
  rationale: string;
  ms: number;
  powerMw: number;
}

export interface HierarchyRunResult {
  task: string;
  role: string;
  root: HierarchyNode;
  steps: HierarchyRunStep[];
  result: string;
  totalMs: number;
  totalPowerMw: number;
  summary: string; // Master が最終的に上位（人間）へ渡す要約
}

const ROLE_RE: Record<string, RegExp> = {
  Vision: /画像|映像|物体|検出|目視|vision|image|detect|認識/,
  Language: /翻訳|要約|言語|文章|校正|作文|translate|summar|language/,
  Math: /計算|数学|方程式|積分|微分|math|solve|足し|掛け|割り|解いて/,
  Planning: /計画|スケジュール|手順|段取り|タスク管理|plan|schedul/,
  Search: /検索|調べ|記事|web|情報を探|search|retriev/,
};

/** タスクから Role を判定（決定論） */
export function detectRole(task: string): string {
  for (const [role, re] of Object.entries(ROLE_RE)) {
    if (re.test(task)) return role;
  }
  return 'Language'; // フォールバック
}

/** 配下で Role が一致する子を探す */
function findChildByRole(node: HierarchyNode, role: string): HierarchyNode | null {
  return node.children.find((c) => c.role === role) ?? null;
}

/** 実行可能な Expert（末端）まで降りる。Role 一致がなければ最初の子へ。 */
function findExpert(node: HierarchyNode, role: string): HierarchyNode | null {
  if (node.kind === 'expert') return node;
  const matched = findChildByRole(node, role);
  if (matched) return findExpert(matched, role);
  for (const c of node.children) {
    const e = findExpert(c, role);
    if (e) return e;
  }
  return null;
}

/** 決定論モック実行（kind: simulation） */
function mockExecute(expertRole: string, task: string): { result: string; ms: number; ok: boolean } {
  let h = 0;
  for (let i = 0; i < task.length; i++) h = (h * 31 + task.charCodeAt(i)) >>> 0;
  const ms = 15 + (h % 60);
  const result = `[${expertRole}]「${task}」→ 完了 (${ms}ms)`;
  return { result, ms, ok: true };
}

/**
 * Hierarchy Runtime 実行: 各階層が「考える → 判断する → 命令する → 学習する」。
 * Master は最後まで細かく命令しない — 各階層が自律的に判断して委譲する。
 */
export async function runHierarchy(root: HierarchyNode, task: string): Promise<HierarchyRunResult> {
  const steps: HierarchyRunStep[] = [];
  const t0 = Date.now();

  // ── 1. Master の判断（考える → 判断する → 命令する）───────────────
  const role = detectRole(task);
  const masterMs = 2 + task.length % 5;
  recordDecision(root, `「${role}」Caravan へ委譲`, `Global Policy: role=${role} と判定`, masterMs, 40);
  steps.push({
    level: 'master', nodeId: root.id, role,
    decision: root.decision.lastDecision,
    rationale: `タスクを解釈 → role=${role}。詳細は下位に委ねる（自律度 ${root.decision.autonomy}）`,
    ms: masterMs, powerMw: 40,
  });

  // ── 2. Caravan の判断（Regional Policy: 配下 Device の割り当て）───
  const caravan = findChildByRole(root, role) ?? root.children[0]!;
  if (caravan.kind === 'caravan') {
    const cMs = 3 + task.length % 4;
    recordDecision(caravan, 'Budget 内で Device を選択', `${caravan.role} 配下 ${caravan.children.length} 台から最適 Device を割当`, cMs, 60);
    steps.push({
      level: 'caravan', nodeId: caravan.id, role: caravan.role,
      decision: caravan.decision.lastDecision,
      rationale: `${caravan.children.length} 台の Device から Budget 内で選択（自律度 ${caravan.decision.autonomy}）`,
      ms: cMs, powerMw: 60,
    });
  }

  // ── 3. Device の判断（Local Policy: 実行 Expert の選択）───────────
  const device = caravan.children[0] ?? root;
  if (device.kind === 'device') {
    const dMs = 4 + task.length % 3;
    recordDecision(device, '実行 Expert を選択', `Local Policy: 予算内で最速の Expert を選定`, dMs, 100);
    steps.push({
      level: 'device', nodeId: device.id,
      decision: device.decision.lastDecision,
      rationale: `${device.children.length} 個の Expert から実行対象を決定（自律度 ${device.decision.autonomy}）`,
      ms: dMs, powerMw: 100,
    });
  }

  // ── 4. Expert の実行（決定論モック）───────────────────────────────
  const expertNode = findExpert(device, role) ?? device;
  let result = '';
  let totalMs = 0;
  let totalPowerMw = 0;
  if (expertNode.kind === 'expert') {
    const exe = mockExecute(expertNode.role ?? 'general', task);
    const eMs = exe.ms + 2;
    recordDecision(expertNode, `実行: ${expertNode.name}`, `${expertNode.role} Expert が担当`, eMs, 1200);
    steps.push({
      level: 'expert', nodeId: expertNode.id, role: expertNode.role,
      decision: `実行: ${expertNode.name}`,
      rationale: `${expertNode.role} Expert がタスクを実行`,
      ms: eMs, powerMw: 1200,
    });
    result = exe.result;
    totalMs = Date.now() - t0;
    totalPowerMw = root.budget.usedPowerMw + caravan.budget.usedPowerMw + device.budget.usedPowerMw + expertNode.budget.usedPowerMw;
  } else {
    result = `[no-expert]「${task}」→ 実行可能な Expert なし`;
    totalMs = Date.now() - t0;
  }

  // ── 5. 学習（各階層が outcome を Memory に記録 + 要約を上位へ）────
  const outcome = result.startsWith('[no-expert]') ? 0.3 : 0.9;
  learnNode(root, task, outcome);
  if (caravan.kind === 'caravan') learnNode(caravan, task, outcome);
  if (device.kind === 'device') learnNode(device, task, outcome);
  if (expertNode.kind === 'expert') learnNode(expertNode, task, outcome);

  // ボトムアップで要約を集約（階層間の情報要約）
  climbSummary(root);

  return {
    task,
    role,
    root,
    steps,
    result,
    totalMs,
    totalPowerMw,
    summary: root.memory.summary,
  };
}

/** 決定論デモ: 複数タスクを Hierarchy Runtime で実行 */
export async function runHierarchyDemo(): Promise<HierarchyRunResult[]> {
  const root = buildHierarchy();
  const tasks = [
    '画像から物体を検出して',
    'この文章を英語に翻訳して',
    'x^2 + 3x + 2 = 0 を解いて',
    'プロジェクトの計画を立てて',
    '関連記事を検索して',
  ];
  const out: HierarchyRunResult[] = [];
  for (const t of tasks) {
    out.push(await runHierarchy(root, t));
  }
  return out;
}

/** 階層ツリーの描画（各階層の判断・予算・要約を表示） */
export function renderHierarchy(r: HierarchyRunResult): string {
  const lines: string[] = [];
  lines.push('═'.repeat(56));
  lines.push('Hierarchy Runtime — Hierarchical Runtime Intelligence');
  lines.push('═'.repeat(56));
  lines.push(`task  : ${r.task}`);
  lines.push(`role  : ${r.role}`);
  lines.push(`result: ${r.result}`);
  lines.push(`total : ${r.totalMs}ms / ${(r.totalPowerMw / 1000).toFixed(2)}W`);
  lines.push('');
  lines.push('判断の連鎖（考える → 判断する → 命令する）:');
  for (const s of r.steps) {
    const arrow = s.level === 'master' ? '▼' : '  ▼';
    lines.push(`  ${arrow} [${s.level}] ${s.nodeId}${s.role ? ` (${s.role})` : ''}`);
    lines.push(`      決定: ${s.decision}`);
    lines.push(`      理由: ${s.rationale}  (${s.ms}ms/${s.powerMw}mW)`);
  }
  lines.push('');
  lines.push('階層間の情報要約（ボトムアップ）:');
  lines.push(`  ${r.summary}`);
  lines.push('');
  lines.push('各階層の状態（Decision / Policy / Budget / Memory）:');
  lines.push(renderNodeTree(r.root, 0));
  return lines.join('\n');
}

function renderNodeTree(node: HierarchyNode, depth: number): string {
  const pad = '  '.repeat(depth + 1);
  const icon = node.kind === 'master' ? '◆' : node.kind === 'caravan' ? '◇' : node.kind === 'device' ? '○' : '·';
  const roleTag = node.role ? ` [${node.role}]` : '';
  const budgetPct = node.budget.timeMs > 0 ? Math.round((node.budget.usedMs / node.budget.timeMs) * 100) : 0;
  const line =
    `${pad}${icon} ${node.name}${roleTag}\n` +
    `${pad}  decision: ${node.decision.lastDecision}（${node.decision.decisionCount}回）\n` +
    `${pad}  budget  : ${node.budget.usedMs}/${node.budget.timeMs}ms (${budgetPct}%) · ${(node.budget.usedPowerMw / 1000).toFixed(2)}W\n` +
    `${pad}  memory  : ${summarize(node)}`;
  const children = node.children.map((c) => renderNodeTree(c, depth + 1));
  return [line, ...children].join('\n');
}

/** Hierarchy Runtime の状態スナップショット（/api/hierarchy 用） */
export function hierarchySnapshot(root: HierarchyNode): {
  id: string;
  kind: HierarchyKind;
  name: string;
  role?: string;
  decision: { lastDecision: string; rationale: string; autonomy: number; decisionCount: number };
  policy: { name: string; gains: Record<string, number>; samples: number };
  budget: { timeMs: number; powerMw: number; usedMs: number; usedPowerMw: number };
  memory: { entries: number; summary: string };
  children: ReturnType<typeof hierarchySnapshot>[];
} {
  return {
    id: root.id,
    kind: root.kind,
    name: root.name,
    role: root.role,
    decision: { ...root.decision },
    policy: { name: root.policy.name, gains: { ...root.policy.gains }, samples: root.policy.samples },
    budget: { timeMs: root.budget.timeMs, powerMw: root.budget.powerMw, usedMs: root.budget.usedMs, usedPowerMw: root.budget.usedPowerMw },
    memory: { entries: root.memory.entries.length, summary: root.memory.summary },
    children: root.children.map((c) => hierarchySnapshot(c)),
  };
}

/** デモ実行（CLI から呼ぶ） */
export async function runHierarchyDemoCli(): Promise<void> {
  const results = await runHierarchyDemo();
  for (const r of results) {
    console.log(renderHierarchy(r));
    console.log('');
  }
}

