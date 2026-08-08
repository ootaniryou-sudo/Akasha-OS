# arcasha-router — Observation-Driven Adaptive Routing (ODAR)

Belief-driven routing engine for heterogeneous LLM pools. 検証済み LinUCB-Shadow を
コアに、`arcasha-belief` (状態推定) と `arcasha-core` (型/報酬) の上に構築。

```ts
import { LinUCBShadowRouter, BayesianBelief, computeRewards, findOracle } from 'arcasha-router';

const router = new LinUCBShadowRouter(experts);
// 1 ステップ: 全エキスパート評価 (shadow) → rewards → ctx → select → observe
const chosen = router.select(ctx);
router.observe(ctx); // Full-Information 更新
```

- ルーター: `LinUCBShadowRouter` (提案) / `UCBShadowRouter` / `FixedRouter` / `RandomRouter` / `RoundRobinRouter`
- 特徴量: `buildFeatures` (8 次元: bias, capability μ, latency, cost, stability, confidence, memory, temperature)
- シャドウ: `evaluateAll` / `evaluateWith` (フル情報フィードバック)
- 再エクスポート: `arcasha-belief` (BayesianBelief 等) + `arcasha-core` (computeRewards 等)

> 研究: Zenodo 10.5281/zenodo.21755612 — MIT License.

