# @arcasha/router

**Observation-Driven Adaptive Routing (ODAR)** — belief-driven routing engine for
heterogeneous LLM pools. これは ArcAsha (Belief-Driven AI Orchestration) のルーティングコアを
スタンドアロン化した軽量パッケージです。WS ハブ・コントローラ・Planner には依存せず、
WebGPU アプリやエッジ AI プロジェクトに「ルーティングエンジン」として埋め込めます。

> 研究: *Observation-Driven Routing for Distributed Heterogeneous Language Models*
> (Zenodo 10.5281/zenodo.21755612)。30-seed 統計検証 (EXP-0003D) / モデル一般化 (E) /
> アブレーション (F) で検証済み。

## 何が入っているか (検証済みパイプライン)

```
Observation → Bayesian Belief (μ, n, confidence) → Feature Vector (8-dim)
           → LinUCB-Shadow (Full-Information) → Routing
```

| モジュール | 内容 |
|---|---|
| `BayesianBelief` | 状態推定 (μ 更新, confidence=1-exp(-n/8), effective=μ×confidence, 事前分布シード対応) |
| `LinUCBShadowRouter` | 提案手法 — disjoint LinUCB + フル情報 (シャドウ) フィードバック |
| `UCBShadowRouter` / `FixedRouter` / `RandomRouter` / `RoundRobinRouter` | 比較用ベースライン |
| `buildFeatures` | 8 次元特徴量 `[1, μ, 1-lat, 1-cost, stability, confidence, memory, temperature]` |
| `computeRewards` / `findOracle` | 多目的報酬 (Q+L+C+S) と Oracle 計算 (Full Information 用) |
| `evaluateAll` / `evaluateTask` | ルールベース評価 (coding/math/reasoning) |

## インストール & ビルド

```bash
cd packages/arcasha-router
npm install          # devDependency: typescript
npm run build        # dist/esm + dist/cjs
npm test             # build + consumer smoke test
npm pack             # 発行用 tarball を生成
```

## 使い方 (フル情報 / シャドウループ)

```ts
import {
  BayesianBelief, LinUCBShadowRouter, computeRewards, findOracle,
  type ExpertInfo, type StepContext, type Task,
} from '@arcasha/router';

const experts: ExpertInfo[] = [
  { nodeId: 'node-a', modelId: 'M1', family: 'qwen', paramsM: 596, memoryGB: 1.2, temperature: 0.6 },
  // ... 各エキスパート
];

// 状態推定 (node × capability)
const beliefs = new Map<string, Record<Capability, BayesianBelief>>();
for (const e of experts) beliefs.set(e.nodeId, {
  coding: new BayesianBelief(), math: new BayesianBelief(), reasoning: new BayesianBelief(),
});

const router = new LinUCBShadowRouter(experts); // α=0.3, λ=1.0

// 1 ステップ: タスク → 全エキスパート評価 (シャドウ) → 報酬 → 選択 → 更新
async function routeOnce(task: Task, compute: (node: ExpertInfo, task: Task) => Promise<{ score: number; latencyMs: number }>) {
  const results = {};
  for (const e of experts) {
    const r = await compute(e, task);
    results[e.nodeId] = { nodeId: e.nodeId, text: '', score: r.score, latencyMs: r.latencyMs };
  }
  const states = {}; // 各ノードの NodeState (capability スナップショット, latencyMs, stability)
  for (const e of experts) states[e.nodeId] = makeState(e, beliefs);
  const maxLat = Math.max(...experts.map(e => states[e.nodeId].latencyMs), 1);
  const maxParams = Math.max(...experts.map(e => e.paramsM), 1);
  const rewards = computeRewards(experts, results, states, maxLat, maxParams);

  const ctx: StepContext = { task, states, rewards, order: experts.map(e => e.nodeId), step: 0 };
  const chosen = router.select(ctx);
  router.observe(ctx); // Full-Information: 全アームの報酬で更新
  return { chosen, oracle: findOracle(results), regret: results[findOracle(results)].score - results[chosen].score };
}
```

## 設計メモ (なぜ LinUCB-Shadow か)

- **Feedback structure > exploration**: シャドウ (フル情報) は部分情報バンディットの不利を排除
  (EXP-0003C.3: gap 94% 解消; D: p<0.001)。
- **Capability estimation が支配的**: 特徴量から capability を除くと Regret +37.6%
  (EXP-0003F)。Belief 由来の μ を第 2 特徴量に持つ。
- **決定論 & 再現性**: T=0 + (node,prompt) キャッシュで実験再現が容易。

## ライセンス

MIT — ArcAsha (Akasha-OS)。詳細: https://github.com/ootaniryou-sudo/ArcAsha-os
