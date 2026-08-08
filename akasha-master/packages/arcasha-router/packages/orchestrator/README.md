# arcasha-orchestrator — Belief-Driven AI Orchestration

Planner → Router → Verifier → Memory → Reflection → Tree Search を統合した実行系。
バックエンド (WS / Ollama / llama.cpp / WebGPU) は `ComputeBackend` で抽象化。

```ts
import { ArcAshaController, RuleBasedPlanner, Verifier, EpisodeMemory } from 'arcasha-orchestrator';
import { LinUCBShadowRouter } from 'arcasha-router';

const ctrl = new ArcAshaController(backend, new LinUCBShadowRouter(experts), new RuleBasedPlanner(), new Verifier(0.4), new EpisodeMemory());
await ctrl.warmup(tasks);                                   // シャドウ学習
const run = await ctrl.execute(task);                        // 分解 → ルーティング → 検証 → 統合
const rr = await ctrl.executeReflective(task);               // 失敗 → Belief 診断 → 改善
const ts = await new TreeSearch(ctrl, gen).search(task);     // 複数プラン → Beam → 最良
ctrl.seedBeliefsFromMemory(task);                            // 記憶 → 事前信念 μ₀
```

- `ComputeBackend`: `experts` + `compute(node, task)` (+ 任意 `generate`)
- `RuleBasedPlanner` / `LLMPlanner` (EXP-0005A/B)、Dynamic Assignment (topK/parallel, EXP-0005C)
- `Verifier` (EXP-0005D) / `EpisodeMemory` + Vector Memory + `priorFor` (EXP-0005E)
- `Reflector` (Self Reflection) / `PlanGenerator` + `TreeSearch` (Emergent Planning)

> 研究: Zenodo 10.5281/zenodo.21755612 — MIT License.

