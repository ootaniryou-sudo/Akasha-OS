/**
 * @arcasha/router — 公開 API
 *
 * Observation-Driven Adaptive Routing (ODAR) — ArcAsha のルーティングコアを
 * スタンドアロン化した軽量パッケージ。WS ハブ・コントローラ・Planner 等に依存しない
 * 純粋なルーティングエンジン (Node / WebGPU / edge で利用可)。
 */

// 型
export * from './core/types.js';

// 観測 (評価 + 多目的報酬 + Oracle)
export * from './core/observation.js';

// 状態推定 (Bayesian Belief / Confidence / EMA latency)
export * from './belief/bayesian.js';

// 線形バンディット (LinUCB)
export { LinUCB } from './router/linucb.js';

// ルーター群 + 特徴量構築
export {
  FEATURE_DIM,
  FEATURE_NAMES,
  buildFeatures,
  LinUCBShadowRouter,
  UCBShadowRouter,
  FixedRouter,
  RandomRouter,
  RoundRobinRouter,
} from './router/router.js';
export type { Router } from './router/router.js';

// シャドウ評価 (フル情報フィードバック)
export { evaluateAll, evaluateWith } from './shadow/shadow.js';
export type { Injection } from './shadow/shadow.js';
