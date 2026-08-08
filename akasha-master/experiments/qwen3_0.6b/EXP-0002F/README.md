# EXP-0002F — Shadow Expert Feedback

> **Phase 4: Collaborative Intelligence の最初の実験。**
> **Main Expert の出力を Shadow Expert が検証し、Composite Score を改善する。**
> **Shadow は「検証役」ではなく、Capability/Stability 推定を改善する「教師」。**

## Role in Research Structure

```
Phase 3 (Routing):
  0002C → 0002D → 0002D.1 → 0002E → 0002E.1 → 0002E.2 → 0002E.3
  └── 単一 Expert の選択に特化

Phase 4 (Collaboration):
  0002F ← 現在地（初めて Expert 間の相互作用を扱う）
  0003A Planner
  0003B Critic
  0003C Verifier
  0003D Consensus
```

## Shadow as Teacher

```
Prompt
  │
  ▼
Main Expert
  │
  ├─────────────┐
  ▼             ▼
 Answer      Shadow Expert (異なる backend/precision)
                  │
                  ▼
              Verification
                  │
                  ▼
             Evaluator Update
                  │
                  ▼
        Capability / Stability (dynamic)
                  │
                  ▼
          Composite Score Update
```

> **Shadow Expert は Composite Score を改善する教師。**
> **静的プロファイル → 実行時更新の Stability へ進化。**

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

