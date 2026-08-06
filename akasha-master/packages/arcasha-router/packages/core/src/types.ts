/**
 * arcasha-router — Core Types
 *
 * Observation-Driven Adaptive Routing (ODAR) の統合パイプラインで使う基本型。
 * ArcAsha (Belief-Driven AI Orchestration) の検証済み設計をそのまま抽出。
 */

export type Capability = 'coding' | 'math' | 'reasoning';

/** エキスパート (ノード) の静的プロファイル + 動的観測 */
export interface ExpertInfo {
  nodeId: string;
  modelId: string;
  family: string;
  paramsM: number;      // EstimatedCost の基準 (実測ではない)
  memoryGB: number;
  temperature: number;
}

/** エキスパートの動的状態 (Router の入力) */
export interface NodeState {
  /** タスク別の信念 (μ, n, confidence) */
  capability: Record<Capability, { mu: number; n: number; confidence: number; effective: number }>;
  /** 直近の観測レイテンシ (注入後) */
  latencyMs: number;
  stability: number;
}

export interface Task {
  id: string;
  capability: Capability;
  prompt: string;
}

/** 1 ステップ分のスナップショット (シャドウ評価済み) */
export interface StepSnapshot {
  task: Task;
  oracle: string;                       // 最良ノード (Quality 基準)
  results: Record<string, EvalResult>;  // 全ノード評価 (Full Information)
  maxLatencyMs: number;
  maxParamsM: number;
}

/** Router の 1 ステップ入力 */
export interface StepContext {
  task: Task;
  states: Record<string, NodeState>;
  rewards: Record<string, number>;      // シャドウ評価で計算済みの報酬
  order: string[];                      // タイブレーク順 (シード/乱数)
  step: number;
}

export interface EvalResult {
  nodeId: string;
  text: string;
  score: number;
  latencyMs: number;
}

/** Planner が生成するサブタスク (タスク分解) */
export interface Subtask extends Task {
  parentId: string;
  order: number;
  role: string;
  /** topK: コミットするエキスパート数 (committee) / force: 強制ルーティング先 */
  expertPolicy?: { topK?: number; force?: string };
}

/** プランナーの分解結果 */
export interface Decomposition {
  task: Task;
  subtasks: Subtask[];
  rationale: string;
  /** サブタスクを並列実行するか */
  parallel?: boolean;
}
