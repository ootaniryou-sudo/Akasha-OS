# ArcAsha OSS Monorepo — 4 Packages

**Belief-Driven AI Orchestration** の公開パッケージ群。論文 ↔ OSS が 1:1 対応する。

```
Applications (WebGPU / Ollama / llama.cpp / ブラウザ LLM / ロボティクス / ゲーム AI)
      ↑
arcasha-orchestrator   — Planner + Verifier + Memory + Reflection + Tree Search  (Paper 2/3)
      ↑
arcasha-router         — ODAR: LinUCB-Shadow ルーティングエンジン              (Paper 1)
      ↑
arcasha-belief         — BayesianBelief / Confidence / EMA                      (独立利用可)
      ↑
arcasha-core           — 共通型 + Observation (評価) + Reward (Q+L+C+S)
```

| パッケージ | 内容 | 論文対応 |
|---|---|---|
| `arcasha-core` | 型 / ルール評価 / 多目的報酬 (Quality+Latency+Cost+Stability) / Oracle | — |
| `arcasha-belief` | Bayesian 状態推定 (μ, confidence=1-exp(-n/8), effective) + EMA。依存なし | Paper 2 (状態推定) |
| `arcasha-router` | **ODAR** — 8 次元特徴量 + LinUCB-Shadow + UCB/Fixed/Random/RoundRobin + シャドウ評価 | Paper 1 |
| `arcasha-orchestrator` | Planner / Verifier / EpisodeMemory (Prior μ₀) / Self Reflection / Tree Search / Controller | Paper 2/3 |

## ビルド & テスト

```bash
npm install          # workspaces で 4 パッケージをシンボリックリンク
npm run build        # tsc -b (依存順: core → belief → router → orchestrator)
npm test             # router + orchestrator のスモークテスト
npm run pack:all     # 4 パッケージの tarball を生成 (公開準備)
```

## 利用例 (最小)

```ts
import { LinUCBShadowRouter, computeRewards, findOracle } from 'arcasha-router';

const router = new LinUCBShadowRouter(experts);   // α=0.3, λ=1.0
// 毎ステップ: シャドウ評価 → rewards → ctx → select → observe (Full-Information)
```

```ts
import { ArcAshaController, RuleBasedPlanner, Verifier, EpisodeMemory } from 'arcasha-orchestrator';
import { LinUCBShadowRouter } from 'arcasha-router';

const ctrl = new ArcAshaController(backend, new LinUCBShadowRouter(experts), new RuleBasedPlanner(), new Verifier(0.4), new EpisodeMemory());
const run = await ctrl.execute({ id: 't', capability: 'coding', prompt: '...' });
```

## 設計 (なぜ ODAR か)

- **フィードバック構造 > 探索**: シャドウ (フル情報) が部分情報の不利を排除 (EXP-0003C.3: gap 94% 解消)
- **capability 推定が支配的**: 特徴量から除去で Regret +37.6% (EXP-0003F)
- **決定論 & 再現性**: T=0 + キャッシュ、30-seed 統計検証 (EXP-0003D)、2 モデルセット一般化 (E)

> 研究: *Observation-Driven Routing for Distributed Heterogeneous Language Models*
> (Zenodo 10.5281/zenodo.21755612)。MIT License — ArcAsha (Akasha-OS).
