/**
 * @arcasha/router — 公開 API
 *
 * Observation-Driven Adaptive Routing (ODAR)。Bayesian Belief (状態推定) を特徴量に
 * 組み込み、LinUCB-Shadow (フル情報フィードバック) で異種 LLM プールをルーティングする。
 * 依存: @arcasha/core (型/報酬), @arcasha/belief (状態推定)。
 */

// ルーター群 + 特徴量構築 (依存: @arcasha/core)
export {
  FEATURE_DIM,
  FEATURE_NAMES,
  buildFeatures,
  LinUCBShadowRouter,
  UCBShadowRouter,
  FixedRouter,
  RandomRouter,
  RoundRobinRouter,
} from './router.js';
export type { Router } from './router.js';

// 線形バンディット
export { LinUCB } from './linucb.js';

// シャドウ評価 (フル情報フィードバック)
export { evaluateAll, evaluateWith } from './shadow.js';
export type { Injection } from './shadow.js';

// 依存パッケージの再エクスポート (利用者の import を 1 本化)
export * from '@arcasha/belief';
export type * from '@arcasha/core';
export { computeRewards, findOracle, REWARD_W } from '@arcasha/core';
