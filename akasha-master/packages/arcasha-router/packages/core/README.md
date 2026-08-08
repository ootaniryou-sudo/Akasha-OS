# arcasha-core

共通型 + Observation (ルールベース評価) + Reward (多目的報酬)。

```ts
import { computeRewards, findOracle, evaluateTask } from 'arcasha-core';

const rewards = computeRewards(experts, results, states, maxLat, maxParams);
const oracle = findOracle(results);   // Quality 最大のノード
```

- 型: `Capability` / `ExpertInfo` / `NodeState` / `Task` / `Subtask` / `Decomposition` / `StepContext` / `EvalResult`
- 報酬: `REWARD_W = { q: 1.0, lat: 0.10, cost: 0.10, stab: 0.10 }` (cost は EstimatedCost proxy)
- 評価: `evaluateCoding/Math/Reasoning`, `evaluateTask`

> MIT License — ArcAsha.

