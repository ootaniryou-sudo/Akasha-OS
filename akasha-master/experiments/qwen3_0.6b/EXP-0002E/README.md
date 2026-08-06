# EXP-0002E — Composite Score Routing

> **EXP-0001（数値特性）と EXP-0002（分散ルーティング）が初めて一本につながった。**
> **ArcAsha の重要な節目。**

## Proven

> **Under equal capability scores, the stability component dominated the composite routing score.**

```
Capability(fp16) = Capability(bf16)

Stability(fp16) = 0.992  →  selected for ALL 10 requests
Stability(bf16) = 0.791  →  selected for 0 requests
```

> これは Composite Score が設計どおり機能したことを示す。
> 「Stability wins at every step」ではなく、同等能力条件下で Stability が支配的だった、と表現するのが科学的に正確。

## Router Evolution

```
0002C:  Capability ──────────────────────→ Routing

0002D:  Capability → Adaptive Update ────→ Routing

0002D.1: Capability → Confidence ────────→ Routing

0002E:  Capability ┐
        Latency    ├→ Composite Score ──→ Routing
        Stability  │
        Confidence ┘
```

## Composite Score Formula

```
Score(node) = w_cap × Capability(eff) + w_conf × Confidence
            + w_lat × Latency(1−norm)  + w_stab × Stability(backend)
```

### Weights (configurable)

| Component | Weight | Source |
|-----------|:---:|--------|
| Capability (effective) | 0.40 | 0002D.1 |
| Confidence | 0.15 | 0002D.1 |
| Latency | 0.15 | 0002A |
| Stability | 0.30 | 0001 |

### Stability Database (from EXP-0001)

| Backend | Stability |
|---------|:---:|
| mps-fp32 | 1.000 |
| mps-fp16 | 0.992 |
| mps-bf16 | 0.791 |
| cpu-fp32 | 1.000 |
| onnx-fp16 | 0.992 |

## Results (2026-08-01)

```
  ┌──────────────┬──────────┬──────────┬──────────┬──────────┐
  │ Node         │ Cap(eff) │ Stability│ Latency  │ Reqs     │
  ├──────────────┼──────────┼──────────┼──────────┼──────────┤
  │ node-fp16    │ 0.134    │ 0.992    │ 3.7ms    │ 10 ✅    │
  │ node-bf16    │ 0        │ 0.791    │ 3.2ms    │  0       │
  └──────────────┴──────────┴──────────┴──────────┴──────────┘

  Composite range: FP16 0.298~0.380 vs BF16 0.237~0.320
  Margin: Δstab(0.201) × weight(0.3) = 0.060 → FP16 always wins
```

## Next: Weight Sensitivity Analysis (0002E.1)

```
weight(stability): 0.0 → 0.1 → 0.2 → 0.3 → 0.5 → 0.7 → 1.0

Measure: at what weight does routing flip from BF16 to FP16?
```

## Future: Generalized Policy-Based Router

```
Score(node) = w_cap·Capability + w_lat·Latency + w_stab·Stability
            + w_conf·Confidence + w_cost·Cost + w_energy·Energy
            + w_vram·VRAM + w_queue·QueueLength + ...
```

> Composite Score の重みをどう決めるか、重みが変わると Router の挙動がどう変わるか。
> ここまで実験できれば、さらに説得力のある研究になる。

Full results: [`output/summary.json`](output/summary.json)

Depends on: EXP-0001 (Stability), EXP-0002A (Latency), EXP-0002D.1 (Confidence)
