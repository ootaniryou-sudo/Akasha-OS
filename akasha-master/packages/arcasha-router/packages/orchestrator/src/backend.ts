/**
 * arcasha-orchestrator — ComputeBackend 抽象
 *
 * コントローラは WS ハブに依存せず、このインターフェース経由で任意バックエンド
 * (WS ノード / Ollama / llama.cpp / WebGPU / ブラウザ LLM) に接続する。
 */

import type { EvalResult, ExpertInfo, Task } from 'arcasha-core';

export interface ComputeBackend {
  /** 接続中のエキスパート集合 (静的プロファイル) */
  experts: ExpertInfo[];
  /** エキスパートに推論を依頼し、ルールベース評価済みの結果を返す */
  compute(node: ExpertInfo, task: Task): Promise<EvalResult>;
  /** 生テキスト生成 (LLM Planner 用, 任意) */
  generate?(nodeId: string, prompt: string, maxTokens?: number): Promise<string>;
}

