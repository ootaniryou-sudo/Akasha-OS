# EXP-0002D — Adaptive Capability Profile

> **Static Profile → Measured Profile → Adaptive Profile**
> **実測性能から Capability Score を自動更新する。**

## Objective

EXP-0002C では Capability が固定の事前設定値だった。
EXP-0002D では、各 Node の実際のタスク成功率を測定し、Capability Score を動的に更新する。

```
Initial:  { coding: 0.95, math: 0.65 }  ← 事前設定

↓ 10 coding tasks executed

Measured: { coding: 0.94, math: 0.65 }  ← 実測で 94% 正解

↓ Update

Adaptive: { coding: 0.94, math: 0.65 }  ← 自動反映
```

## Architecture

```
Master Hub
  ├── CapabilityRegistry (static → adaptive)
  ├── TaskEvaluator          ← タスク正解/不正解を判定
  └── ProfileUpdater         ← 実測値からスコアを再計算
```

### Score Update Formula (simple moving average)

```
new_score = α × measured_accuracy + (1-α) × old_score

α = 0.3 (learning rate)
```

## Success Criteria

- [ ] Nodes register with initial capability profiles (static)
- [ ] TaskEvaluator judges correctness of each response
- [ ] After N tasks, capability scores update based on measured accuracy
- [ ] Updated scores diverge from initial static values
- [ ] Router uses updated scores for subsequent routing

## Running

```bash
# Same as EXP-0002C, with --adaptive flag on Master
npx tsx experiments/qwen3_0.6b/EXP-0002D/run_master.ts --port 8080 --adaptive
```

Depends on: EXP-0002C (Capability-Aware Routing)
