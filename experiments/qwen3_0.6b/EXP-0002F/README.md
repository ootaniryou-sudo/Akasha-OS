# EXP-0002F — Shadow Expert Verification

> **Main Expert の出力を Shadow Expert が検証する。**
> **Shadow は単なる検証役ではなく、Evaluator への高品質フィードバック源。**
> **0002D.1 → 0002E → 0002F の研究スレッドの最終段階。**

## Role in the Research Thread

```
0002D.1: Evaluator の精度改善
   ↓
0002E:   Composite Score に Stability 統合
   ↓
0002F:   Shadow が Evaluator に高品質フィードバックを供給
```

Architecture:

```
Prompt
  │
  ├── Main Expert → Primary Answer
  │
  └── Shadow Expert (異なる backend/precision)
        │
        ▼
      Verification
        │
        ▼
      Evaluator ← Shadow の検証結果が評価精度を向上させる
        │
        ▼
      Capability Update
```

## Verification Modes

| Mode | Main | Shadow | Use Case |
|------|------|--------|----------|
| Exact Shadow | FP16 MPS | FP16 MPS | Replication check (EXP-0001.8: σ=0) |
| Cross-Precision | FP16 MPS | FP32 MPS | Stability gate (EXP-0001.7: 99.2%) |
| Cross-Backend | MPS | ONNX WebGPU | Platform validation |

## Success Criteria

- [ ] Main + Shadow both execute same prompt
- [ ] Output tokens compared (exact match / overlap %)
- [ ] High-stability pairs (FP16↔FP32): ≥99% accept
- [ ] Low-stability pairs (BF16 MPS): appropriate flag rate (~21%)
- [ ] Verification result logged as metadata

## Integration with EXP-0002C/E

```
Extended Router:

  Select Main Expert  (by capability + latency + stability)
  Select Shadow Expert (different backend/precision, highest stability)
  Execute both
  Compare → Accept / Flag
```

## Running

```bash
npx tsx experiments/qwen3_0.6b/EXP-0002F/run_master.ts --port 8080 \
  --shadow-mode cross-precision
```

Depends on: EXP-0001 (Numerical Stability), EXP-0002C (Routing)
