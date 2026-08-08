/**
 * Capability Graph — パズルの凸凹を「データ型」として表現する
 *
 * 各 Expert の inputType / outputType が「接続可能性」を決める。
 * Caravan は型の一致（A.outputType === B.inputType）を見て、
 * タスクごとの一時的な知能グラフ（配線）を自動生成する。
 *
 *   camera → Vision → object-list → Physics → trajectory → Coding → program
 *
 * これは「モデルを選ぶ」のではなく「タスクごとに知能の配線を生成する」
 * （Task-Specific Dynamic Cognitive Graph）の実装。
 */

import type { PoolExpert } from './pool.js';

export interface CapabilityEdge {
  from: string;
  to: string;
  via: string; // やり取りするデータ型（凸凹）
}

export interface ComposedTeam {
  task: string;
  members: PoolExpert[];
  graph: CapabilityEdge[]; // 配線（認知グラフのエッジ）
  order: string[];         // 実行順（expert id）
}

/** 接続可能性: from.outputType === to.inputType なら A → B に配線できる */
export function canConnect(from: PoolExpert, to: PoolExpert): boolean {
  return from.outputType === to.inputType;
}

// 実行順の優先度付き（planning が先頭 = タスク全体の計画を最初に作る）
const ROLE_RE: Record<string, RegExp> = {
  planning: /計画|設計|企画|手順|plan|design|architecture/,
  vision: /画像|映像|検出|視覚|カメラ|物体|vision|image|detect|camera|認識/,
  physics: /物理|運動|軌道|飛行|重力|力|physics|trajectory|flight/,
  coding: /コード|実装|プログラミング|関数|バグ|coding|program|implement/,
  robot: /ロボット|ドローン|自律|移動|robot|drone|navigat/,
  math: /計算|数学|方程式|積分|微分|解いて|求めて|math|solve|equation/,
  search: /検索|調べ|記事|web|情報を探|search|retriev/,
};

/** ドメイン補完: タスクの文脈から暗黙に必要な Role を補う */
const DOMAIN_COMPLEMENT: { re: RegExp; add: string[] }[] = [
  { re: /ドローン|ロボット|自律|飛行|drone|robot|flight/, add: ['physics', 'coding', 'vision', 'robot', 'planning'] },
  { re: /設計|実装|作って|design|implement/, add: ['coding', 'planning'] },
  { re: /カメラ|画像|映像|検出|vision|image|camera/, add: ['vision'] },
];

/** タスクから必要な Role を判定（決定論・ドメイン補完込み） */
export function detectRoles(task: string): string[] {
  const roles = new Set<string>();
  for (const [role, re] of Object.entries(ROLE_RE)) {
    if (re.test(task)) roles.add(role);
  }
  // ドメイン補完（ROLE_RE の順序で追加）
  for (const { re, add } of DOMAIN_COMPLEMENT) {
    if (re.test(task)) {
      for (const r of add) roles.add(r);
    }
  }
  return [...roles];
}

/**
 * タスクから一時チームを自動編成する（凸凹 = データ型）。
 *
 * 1. タスクの Role 要件を検出（ドメイン補完込み）
 * 2. プールから該当 Expert を選択（Role 検出順 = 実行順）
 * 3. 型の接続可能性で配線（出力型が次の入力型に一致するよう接続）
 * 4. 型が合わない箇所は共有メモリ（Memory Expert）を経由
 * 5. 全タスクで共有メモリを 1 つ含める（誰でも読める）
 */
export function composeTeam(pool: PoolExpert[], task: string): ComposedTeam {
  const roles = detectRoles(task);
  // Role 検出順で選択（計画 → 視覚 → 物理 → 実装 → ロボット → ...）
  const byRole = new Map(pool.map((e) => [e.role, e]));
  const members: PoolExpert[] = [];
  for (const r of roles) {
    const e = byRole.get(r);
    if (e && !members.includes(e)) members.push(e);
  }

  // 全タスクで共有メモリ（Memory）を 1 つ含める
  const memory = pool.find((e) => e.role === 'memory')!;
  if (!members.some((e) => e.role === 'memory')) members.push(memory);

  if (members.length === 0) {
    // フォールバック: 汎用チーム（Math + Memory）
    const math = pool.find((e) => e.role === 'math')!;
    members.push(math, memory);
  }

  // 型チェーンで実行順を並べ替え（出力型が次の入力型になる Expert を優先）
  const sorted: PoolExpert[] = [];
  let rest = [...members];
  while (rest.length > 0) {
    const last = sorted[sorted.length - 1];
    let next: PoolExpert | undefined;
    if (last) {
      next = rest.find((r) => r.inputType === last.outputType);
    }
    if (!next) {
      // 起点（入力型が他者の出力でない Expert）を優先。複数ある場合は先頭。
      next = rest.find((r) => !rest.some((o) => o !== r && o.outputType === r.inputType));
    }
    if (!next) next = rest[0];
    sorted.push(next);
    rest = rest.filter((r) => r !== next);
  }

  // 配線: 出力型 → 入力型の一致でつなぐ。合わない場合は共有メモリを経由。
  const graph: CapabilityEdge[] = [];
  const order: string[] = [sorted[0].id];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.outputType === b.inputType) {
      graph.push({ from: a.id, to: b.id, via: a.outputType });
    } else {
      // 凸凹が合わない → 共有メモリを経由してデータを受け渡す
      graph.push({ from: a.id, to: 'memory', via: a.outputType });
      graph.push({ from: 'memory', to: b.id, via: b.inputType });
    }
    order.push(b.id);
  }

  return { task, members: sorted, graph, order };
}

/** 配線をテキスト表示（IR 風） */
export function renderComposition(c: ComposedTeam): string {
  const lines: string[] = [];
  lines.push(`task : ${c.task}`);
  lines.push(`team : ${c.members.map((m) => m.name).join(' · ')}`);
  lines.push(`graph:`);
  for (const e of c.graph) {
    lines.push(`  ${e.from} --(${e.via})--> ${e.to}`);
  }
  lines.push(`order: ${c.order.join(' → ')}`);
  return lines.join('\n');
}

