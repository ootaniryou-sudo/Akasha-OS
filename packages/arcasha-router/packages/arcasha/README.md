# arcasha — ArcAsha (Belief-Driven AI Orchestration)

**1 つの import で全部使えるメタパッケージ。**

```bash
npm install arcasha
```

```ts
import { LinUCBShadowRouter, ArcAshaController, RuleBasedPlanner, Verifier, EpisodeMemory } from 'arcasha';

const ctrl = new ArcAshaController(
  backend,                              // ComputeBackend (Ollama / llama.cpp / WS / WebGPU)
  new LinUCBShadowRouter(experts),      // ODAR: Observation-Driven Adaptive Routing
  new RuleBasedPlanner(),
  new Verifier(0.4),
  new EpisodeMemory(),
);
const run = await ctrl.execute({ id: 't', capability: 'coding', prompt: '...' });
```

## 含まれるパッケージ

| パッケージ | 内容 |
|---|---|
| `arcasha-core` | 型 / Observation (評価) / Reward (Q+L+C+S) |
| `arcasha-belief` | Bayesian 状態推定 (μ, confidence, effective) + EMA |
| `arcasha-router` | **ODAR** — LinUCB-Shadow ルーティング + ベースライン |
| `arcasha-orchestrator` | Planner / Verifier / Memory / Reflection / Tree Search / Controller |

> 研究: *Observation-Driven Routing for Distributed Heterogeneous Language Models*
> (Zenodo 10.5281/zenodo.21755612)。MIT License — ArcAsha (Akasha-OS).
