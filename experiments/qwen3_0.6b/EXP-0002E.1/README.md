# EXP-0002E.1 — Weight Sensitivity Analysis

> **Composite Score の重みが変わると Router の挙動がどう変わるか。**
> **Stability が支配的になる臨界点を測定する。**

## Objective

EXP-0002E では weight(stability)=0.3 で FP16 が全リクエストを獲得した。
この重みを 0.0→1.0 まで変化させ、Routing 結果がどう推移するかを測定する。

## Methodology

```
固定条件:
  Capability(fp16) = Capability(bf16) = 0.95 (coding) / 0.65 (math)
  Stability(fp16)  = 0.992
  Stability(bf16)  = 0.791
  Latency: both ~3ms (localhost, negligible)

変数:
  weight(stability): 0.0, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0
  (他 weight は比例配分で調整)

測定:
  FP16 への routing 割合 (%)
  Composite score margin (FP16 − BF16)
```

## Expected Output

```
  weight(S) │ FP16% │ Margin  │ Behavior
  ──────────┼───────┼─────────┼──────────
  0.0       │  50%  │  0.000  │ Random (equal cap)
  0.1       │  60%  │  0.020  │ Slight stability influence
  0.2       │  85%  │  0.040  │ Growing
  0.3       │ 100%  │  0.060  │ ⚡ CRITICAL POINT
  0.5       │ 100%  │  0.100  │ Dominant
  0.7       │ 100%  │  0.140  │ Overwhelming
  1.0       │ 100%  │  0.201  │ Pure stability
```

### Sensitivity Curve

```
FP16%
100 ┤          ●━━━━━━━━━━━━━━
 80 ┤      ●━━
 60 ┤  ●━━
 40 ┤
 20 ┤
  0 ├────────────────────────
    0.0 0.1 0.2 0.3 0.5 0.7 1.0  weight(stability)
              ↑ critical point
```

## Research Value

> **重み感度解析により、Composite Score のロバスト性と、Stability 項の実効的な影響範囲を定量化できる。**
> **論文における Sensitivity Analysis の標準的な手法。**

## Running

```bash
npx tsx experiments/qwen3_0.6b/EXP-0002E.1/run_sensitivity.ts \
  --stability-weights 0.0,0.1,0.2,0.3,0.5,0.7,1.0
```

Depends on: EXP-0002E (Composite Score Routing)
