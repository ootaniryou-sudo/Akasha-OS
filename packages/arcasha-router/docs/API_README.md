# ArcAsha API Reference (TypeDoc)

4 パッケージすべての型・関数・クラスの API リファレンス。

## 生成方法

```bash
npm install -D typedoc          # 初回のみ
npx typedoc --options typedoc.json
# 出力: docs/api/index.html
```

## 生成物

| パッケージ | 主なシンボル |
|---|---|
| `@arcasha/core` | `Capability`, `ExpertInfo`, `Task`, `Subtask`, `Decomposition`, `StepContext`, `EvalResult`, `computeRewards`, `findOracle`, `evaluateCoding/Math/Reasoning/Task` |
| `@arcasha/belief` | `BayesianBelief`, `EmaLatency` |
| `@arcasha/router` | `LinUCBShadowRouter`, `UCBShadowRouter`, `FixedRouter`, `RandomRouter`, `RoundRobinRouter`, `buildFeatures`, `evaluateAll`, `evaluateWith` |
| `@arcasha/orchestrator` | `ArcAshaController`, `ComputeBackend`, `RuleBasedPlanner`, `LLMPlanner`, `Verifier`, `EpisodeMemory`, `Reflector`, `PlanGenerator`, `TreeSearch` |

## 例: クイックスタート

```ts
import { LinUCBShadowRouter } from '@arcasha/router';
import { ArcAshaController } from '@arcasha/orchestrator';
```
