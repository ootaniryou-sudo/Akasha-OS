# EXP-0002F — Shadow Expert Verification

> **Main Expert の出力を Shadow Expert が検証する。**
> **EXP-0001 の数値安定性が「検証役」として活きる。**

## Objective

同一プロンプトを Main Expert と Shadow Expert（異なる backend/precision）の両方で実行し、
出力の一貫性を検証する。EXP-0001 で確立した Numerical Stability Profile を
実用的な検証メカニズムとして応用する。

## Architecture

```
Prompt
  │
  ├── Main Expert (FP16, MPS)
  │     └── Answer
  │
  └── Shadow Expert (FP32, MPS)
        └── Verification
              │
              ├── Token match ≥ threshold → ACCEPT
              └── Token match < threshold → FLAG (numerical instability)
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
