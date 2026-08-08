/**
 * AI Pool — 未所属の Expert プール（誰も所属していない）
 *
 * Cognitive Graph Runtime の基礎: タスクが来るまで Expert はプールに待機。
 * Caravan がタスクに応じて一時チームを編成し、終われば解散してプールへ戻る。
 *
 * 各 Expert は「凸凹 = データ型」を持つ:
 *   inputType → outputType の接続可能性（Capability Graph）で配線を自動生成する。
 */

export interface PoolExpert {
  id: string;
  name: string;
  role: string;       // planning / vision / physics / coding / math / search / memory / robot
  inputType: string;  // 入力データ型
  outputType: string; // 出力データ型
  cost: number;       // 0-1 推定コスト
  latencyMs: number;  // 推定レイテンシ
  /**
   * 実モデル実行（任意）。指定されれば Cognitive Runtime はこの関数を呼ぶ。
   * 未指定なら決定論の genIr() で IR を生成する（Simulation）。
   * →「Cognitive Graph の仕組み」と「実モデルを接続した状態」を同一インターフェースで扱える。
   */
  execute?: (opts: { task: string; input?: { key: string; value: string } }) => Promise<{ ir: string; ms: number; ok: boolean }>;
}

/** AI Pool — タスクが来るまで誰も所属しない */
export const AI_POOL: PoolExpert[] = [
  { id: 'planning', name: 'Planning', role: 'planning', inputType: 'goal', outputType: 'plan', cost: 0.3, latencyMs: 120 },
  { id: 'vision', name: 'Vision', role: 'vision', inputType: 'camera', outputType: 'object-list', cost: 0.6, latencyMs: 200 },
  { id: 'physics', name: 'Physics', role: 'physics', inputType: 'object-list', outputType: 'trajectory', cost: 0.5, latencyMs: 180 },
  { id: 'coding', name: 'Coding', role: 'coding', inputType: 'trajectory', outputType: 'program', cost: 0.4, latencyMs: 150 },
  { id: 'robot', name: 'Robot', role: 'robot', inputType: 'trajectory', outputType: 'motion', cost: 0.5, latencyMs: 170 },
  { id: 'math', name: 'Math', role: 'math', inputType: 'equation', outputType: 'solution', cost: 0.3, latencyMs: 100 },
  { id: 'search', name: 'Search', role: 'search', inputType: 'query', outputType: 'documents', cost: 0.4, latencyMs: 160 },
  { id: 'memory', name: 'Memory', role: 'memory', inputType: 'context', outputType: 'knowledge', cost: 0.2, latencyMs: 80 },
];

export function poolExpert(id: string): PoolExpert {
  const e = AI_POOL.find((p) => p.id === id);
  if (!e) throw new Error(`AI Pool に ${id} がいません`);
  return e;
}
