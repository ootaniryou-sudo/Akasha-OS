# EXP-0002F.2 — Stability Recovery

> **Drift Detection だけでなく Recovery Detection まで扱う。**
> **Router は「悪いノードを避ける」だけでなく、「環境変化に追従して評価を更新する適応型システム」へ。**

## Problem (from EXP-0002F.1)

```
EXP-0002F.1 では Drift のみ観測:

  Stability: 0.992 → 0.743 (down only)

まだ検証していない:
  ノードが正常に戻ったら Stability も回復するか?
```

## Objective

```
Stability trajectory with recovery:

  1.000
    ↓ (normal)
  0.950
    ↓ (drift: cross-backend mismatch)
  0.743
    ↓ (recovery: node returns to normal behavior)
  0.810
    ↓
  0.900
    ↓
  0.970   ← 回復を検出できるか?
```

## Design: Two-Phase Verification

```
Phase A: Drift (degraded shadow)
  - Main: ONNX
  - Shadow: PyTorch MPS (known mismatch) → FLAGs → Stability down

Phase B: Recovery (healthy shadow)
  - Main: ONNX
  - Shadow: ONNX (same runtime → 100% match) → ACCEPTs → Stability up

同一ノードの Stability が Phase A で下がり、Phase B で上がることを確認。
```

## Protocol

```
Phase A (N prompts):  Shadow = cross-backend → expect drift
Phase B (N prompts):  Shadow = same-runtime → expect recovery

Stability(t) を全ステップ記録
```

## Success Criteria

- [ ] Phase A: Stability declines (drift detected)
- [ ] Phase B: Stability recovers (recovery detected)
- [ ] Recovery rate measured (slope of recovery)
- [ ] Hysteresis analyzed (recovery slower/faster than drift?)
- [ ] Router adapts to both degradation and improvement

## Expected Output

```
Stability
1.00 ─●───────────────
0.95 ─│\  ●●●
0.90 ─│ \ ●  ●●●
0.85 ─│  ●      ●●●
0.80 ─│           ●
0.75 ─│            ●
0.70 ─└────────────────
       PhaseA( drift )  PhaseB( recovery )
```

## Research Value

> **Adaptive Router は環境変化（劣化と回復の両方）に追従できるか。**
> Static Knowledge ではなく Observed Evidence で状態を維持する。

## Running

```bash
# Terminal 1: Master
npx tsx experiments/qwen3_0.6b/EXP-0002F/run_master.ts --port 8080 --phases 2

# Terminal 2: ONNX Main (Phase A & B)
npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts --master ws://localhost:8080 \
  --node-id node-onnx --backend onnx --precision fp16

# Terminal 3: PyTorch Shadow (Phase A only)
python experiments/qwen3_0.6b/EXP-0002F.1/run_node_pytorch.py \
  --master ws://localhost:8080 --node-id node-torch

# Terminal 4: ONNX Shadow (Phase B only)
npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts --master ws://localhost:8080 \
  --node-id node-onnx2 --backend onnx --precision fp16
```

Depends on: EXP-0002F.1 (Cross-Backend Shadow)
