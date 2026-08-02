/**
 * ArcAsha — Core Types
 *
 * Observation-Driven Routing の統合パイプラインで使う基本型。
 * Phase 4 〜 0003F で検証した設計をそのまま製品型に反映。
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

/** Planner が生成するサブタスク (EXP-0005A Task Decomposition) */
export interface Subtask extends Task {
  parentId: string;
  order: number;
  role: string; // 'design' | 'code' | 'test' | 'review' | ...
}

export interface EvalResult {
  nodeId: string;
  text: string;
  score: number;
  latencyMs: number;
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

/** プランナーの分解結果 */
export interface Decomposition {
  task: Task;
  subtasks: Subtask[];
  rationale: string;
}
