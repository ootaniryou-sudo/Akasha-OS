# EXP-0002F.2 — Recovery Dynamics & Hysteresis

> **Drift Detection だけでなく Recovery Detection まで扱う。**
> **「劣化を検出できる」だけでなく「いつ、どの程度の証拠で信頼を回復させるべきか」を実証する。**
> **Adaptive State Routing の中核実験。**

## Core Concept: Hysteresis

> **Adaptive System の性質は「落ちる速さ」と「戻る速さ」の差に現れる。**

```
劣化速度:  1.000 → 0.743  (何リクエストで落ちる?)
回復速度:  0.743 → 0.970  (何リクエストで戻る?)

  落ちるのが速く、戻るのが遅い → Router は簡単には信用を戻さない
  すぐ戻る                  → Router は柔軟
```

この差が **ヒステリシス**。Adaptive State Routing の性質を一つの数値で表せる。

## Asymmetric Update Rule

```
Belief(t+1) = α × Belief(t) + (1−α) × Observation(t)

ただし劣化と回復で α を変える:

  α_degrade  (小):  劣化を素早く反映（異常を即座に検知）
  α_recover  (大):  回復を慎重に反映（十分な証拠が集まるまで待つ）

→ 3 つの設計を比較:
  ① 対称 (α_degrade = α_recover)
  ② 非対称 (α_degrade < α_recover)  ← 推奨
  ③ 非対称逆 (α_degrade > α_recover) ← 過敏
```

## Evaluation Metrics

| Metric | Meaning | Measure |
|--------|---------|---------|
| **Recovery Half-life** | Stability が半分回復するまでのリクエスト数 | N リクエスト |
| **Recovery Time** | 元の 95% まで戻る時間 | N リクエスト |
| **Hysteresis Ratio** | 回復速度 ÷ 劣化速度 | ≥1 = 慎重, <1 = 柔軟 |
| **False Recovery Rate** | 一時的な一致で過大評価しないか | % |
| **Routing Recovery Delay** | ルーティングが元に戻るまでの遅延 | N リクエスト |

> **Hysteresis Ratio は Adaptive State Routing の性質を一つの数値で表す。論文でも比較しやすい指標。**

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

Stability(t) を全ステップ記録 → 上記 5 指標を計算
```

## Success Criteria

- [ ] Phase A: Stability declines (drift detected)
- [ ] Phase B: Stability recovers (recovery detected)
- [ ] Recovery Half-life measured
- [ ] Recovery Time to 95% measured
- [ ] **Hysteresis Ratio** computed (recovery ÷ degradation)
- [ ] False Recovery Rate quantified
- [ ] Asymmetric α (degrade < recover) vs symmetric compared
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

Metrics:
  Degradation rate:  ~0.25/req (fast)
  Recovery rate:     ~0.06/req (slow)
  Hysteresis Ratio:  ~4.2  → Router is conservative
```

## Phase 4 Thread

```
0002F   Shadow Loop
  ↓
0002F.1 Belief Update (drift: 0.992→0.743) ✅
  ↓
0002F.2 Recovery Dynamics + Hysteresis ← 現在地
  ↓
0002E.3 Adaptive Weight Learning
  → Belief が変わるから Weight も変わる（二重適応）
```

## Research Value

> **Adaptive State Routing は「劣化を検出できる」だけでなく、**
> **「いつ、どの程度の証拠で信頼を回復させるべきか」を設計できる。**
> これはロボティクス・センサフュージョン・自律システムと共通の原理。

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
