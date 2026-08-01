# Qwen3-0.6B — ArcAsha Experiment Log

> **Phase 1 ✅ Numerical Characterization | Phase 2 ✅ Distributed Runtime**  
> **Phase 3 ⏳ Intelligent Routing — Capability-Aware → Adaptive → Evaluator → Composite → Shadow**

**[`CONCLUSIONS.md`](CONCLUSIONS.md)** — Formal conclusions + design principles.  
**[`NUMERICAL_STABILITY_PROFILE.md`](NUMERICAL_STABILITY_PROFILE.md)** — Multi-dimensional profile spec.

---

## ArcAsha 5-Layer Architecture

```
Task
  ↓
Capability Model      ← ノードの能力をどう表現するか
  ↓
Evaluation Function   ← タスク成功/失敗をどう判定するか（← 0002D.1）
  ↓
Capability Estimation ← 測定値から能力をどう推定するか（Bayesian, Confidence）
  ↓
Routing Policy        ← どのノードを選ぶか（Capability, Latency, Stability）
  ↓
Execution Backend     ← 実際にどこで実行するか（MPS, ONNX, Metal, CPU）
```

> **各層が独立して拡張可能。Latency / Cost / Numerical Stability を追加しても自然に統合できる。**

---

## Experiment Status

| # | Experiment | Status | Key Finding |
|---|-----------|:---:|------|
| 0000 | Golden Reference | ✅ | Qwen3-0.6B base model, 10 prompts, T=0, deterministic |
| 0001 | Python vs JS/ONNX | ✅ | Tokenizer IDENTICAL. Output: 15-44% match (cross-runtime) |
| 0001.5 | Logit-Level Analysis | ✅ | FP32→FP16: 93.75% match. Divergence at logit_margin < 0.02 |
| 0001.6 | Divergence Prediction | ✅ | Per-step NOT viable (AUC=0.57). Backend-level characterization is right |
| 0001.7 | Precision Ladder | ✅ | FP16: 99.2%, 1.42× faster. BF16 on MPS: 20.9% divergence |
| 0001.8 | Replication | ✅ | σ=0.0000 — BF16 20.88% perfectly reproducible |
| 0001.9 | Platform Matrix | ✅ | macOS MPS completed. CUDA/CPU pending |
| 0002A | Remote Expert | ✅ | Mac Node: Qwen3-0.6B via WebSocket. Network overhead 2ms |
| 0002A-iPhone | iPhone 12 mini Relay | ✅ | **iPhone joins ArcAsha network.** WiFi 20ms. Lightweight relay |
| 0002B | Heterogeneous Two-Node Routing | ✅ | **Round-Robin PC+iPhone 15 Pro. 50/50. 1.9× throughput.** |
| 0002C | Capability-Aware Routing | ✅ | **Routing Accuracy 100%. coding→coding, math→math.** |
| 0002D | Adaptive Capability Profile | ✅ | **Score Inversion detected. Evaluation fidelity = routing limit.** |
| 0002D.1 | Confidence-Aware Adaptive Routing | ✅ | **Two-stage eval. Score Inversion → 0. 7 avoided.** |
| 0002E | Composite Score Routing | ✅ | **Stability dominates. FP16 10/10, BF16 0/10. 0001+0002 connected.** |

---

## Terminology Notes

| Term | Definition |
|------|-----------|
| **Routing Accuracy** | Router が事前定義 Profile に従って正しいノードを選べた割合 |
| **Task Classification Accuracy** | LLM 自身の能力を正確に分類できた割合（未検証） |

> EXP-0002C の 100% は **Routing Accuracy**。Capability は固定の事前設定値。
> 論文ではこの2つを明確に区別する必要がある。

---

## Node Type Architecture (EXP-0002A)

> **"Node = 必ずモデルを持つ"ではない。** ArcAsha には3種類の Node が存在する。

| Type | Has Model? | Inference? | Example | Role |
|------|:---:|:---:|------|------|
| **Expert Node** | ✅ | ✅ | Mac + Qwen3-0.6B | LLM inference execution |
| **Relay Node** | ❌ | ❌ | iPhone 12 mini | Connectivity, forwarding, health, metadata |
| **Hybrid Node** | ✅ | ✅ | Future iPhone 15 Pro | Expert + Relay combined |

### EXP-0002A Architecture

```
                Master Mac
            Heart of Wisdom
                    │
              Wi-Fi / LAN
                    │
          ┌─────────┴─────────┐
          │                   │
      Mac Expert          iPhone 12 mini
      Qwen3-0.6B          Lightweight Relay
      772ms/10tokens       20ms RTT WiFi
          │                   │
          └─────────┬─────────┘
                    ↓
               ArcAsha Network
```

### iPhone 12 mini — Connection Log

```
Device:     iPhone 12 mini, iOS 18, 4 cores
Connection: WebSocket via WiFi (192.168.0.11 → 192.168.0.17:8081)
Latency:    20ms RTT (3 pings)
WebGPU:     ❌ iOS Safari API not exposed
WASM Model: ❌ 200MB CDN download impractical on mobile
Node Type:  Lightweight Relay (no model)
```

**Key finding**: Low-performance devices CAN join ArcAsha as relay nodes. Not every edge device needs to run the full model — this is core to the heterogeneous architecture.

---

## Key Results

### EXP-0000: Golden Reference
- Model: `Qwen/Qwen3-0.6B` @ `c1899de`
- Platform: macOS MPS, transformers 5.14.1, torch 2.13.0
- 10 prompts, 320 tokens, 1,543ms avg
- ⚠️ Base model (not instruct) — outputs are text continuations, not answers

### EXP-0001: Python vs JavaScript/ONNX
- **Input tokenizer**: 10/10 FULL MATCH ✅
- **Output**: 15-44% token match (ONNX fp16 ≠ PyTorch fp32)
- Root cause: different matmul kernels (same model, different runtime)

### EXP-0001.5: Logit-Level Precision
- FP32 vs FP16 (same PyTorch): 93.75% top-1 match, KL≈0, corr≈1.0
- Divergence mechanism: logit_margin < 0.02 → top-1 flips
- After divergence: top-5 overlap drops to 0/5, KL explodes

### EXP-0001.6: Divergence Prediction
- **Hypothesis NOT SUPPORTED**: per-step margin prediction (AUC=0.57)
- 3,200 positions, only 44 divergences (1.5%) — too rare for statistical prediction
- **New direction**: backend-level characterization, not per-step prediction

### EXP-0001.7: Precision Ladder (MPS)

| Precision | Top-1 Agree | Speed | Div Rate | Precision Eff. |
|:---|:---:|:---:|:---:|:---:|
| fp32 | 1.000 | 1.00× | baseline | 1.00 |
| **fp16** | **0.992** | **1.42×** | **0.8%** | **1.41** ✨ |
| bf16 | 0.791 | 1.30× | 20.9% ⚠️ | 1.03 |

- **FP16 recommended**: 42% faster, 99.2% stable, best efficiency
- **BF16 on MPS**: high divergence — likely no native MPS kernel
- **Design principle**: Numerical Stability = f(platform, backend, precision), not universal

### EXP-0001.8: Replication
- 5 runs, σ=0.0000 — deterministic with T=0
- BF16 20.88%: stable, reproducible measurement
- Platform profiles reliable for Router integration

### EXP-0001.9: Platform Matrix
- macOS MPS: completed ✅
- NVIDIA CUDA, x86 CPU, WebGPU/ONNX: pending

---

## Three-Line Conclusion

1. **Cross-runtime inference** is functional, but token-level reproducibility is backend-sensitive.
2. **Observed divergence** is triggered by numerical ambiguity (logit_margin < 0.02) and amplified by backend/kernel differences.
3. **ArcAsha**: Exact replication, approximate redundancy, and independent verification should be distinct execution modes.

---

## Design Principle

> **Numerical Stability is a property of an execution configuration, not of a model alone.**

```
StabilityScore = f(platform, backend, kernel, precision, device, model)
```

See [`NUMERICAL_STABILITY_PROFILE.md`](NUMERICAL_STABILITY_PROFILE.md).

---

## Research Roadmap

### Phase 1 ✅ — Numerical Characterization
```
✅ EXP-0000〜0001.9   LLM Numerical Stability Profile
```
→ [`NUMERICAL_STABILITY_PROFILE.md`](NUMERICAL_STABILITY_PROFILE.md)

### Phase 2 ✅ — Distributed Runtime
```
✅ EXP-0002A          Remote Single Expert
✅ EXP-0002B          Heterogeneous Two-Node Round-Robin
```
→ Scheduler, Node Registry, Master Hub が成立

### Phase 3 ⏳ — Intelligent Routing

> **Phase 3 スレッド: Capability → Adaptive → Confidence → Composite → Decision Boundary**
> **EXP-0001 + EXP-0002 が一本に。分析可能な Router へ。**

```
✅ EXP-0002C          Static Capability
✅ EXP-0002D          Adaptive (SMA) → Evaluator limit 発見
✅ EXP-0002D.1        Confidence-Aware (two-stage: μ × confidence)
✅ EXP-0002E          Composite Score (C + Conf + L + S)
✅ EXP-0002E.1        Decision Boundary（重み感度解析）
                       Stability acts as secondary objective;
                       influence decreases as capability gap grows.
                       (lexicographic-like behavior)

📐 EXP-0002E.2        Pareto Routing（複数軸フロンティア）
📐 EXP-0002E.3        Adaptive Weight Learning（Router が重みを学習）
📐 EXP-0002F          Shadow Expert Verification
                       Dynamic stability → Composite Score update
```

### Phase 4 ⏳ — Multi-Expert Collaboration
```
📐 EXP-0003           Planner + Coder + Math + Critic + Synthesizer
```

### Phase 5 ⏳ — Dynamic Active Compute
```
📐 EXP-0004           Active Expert Scaling (1→2→4→8→16)
```
> **「多数の小型モデルを必要に応じて起動し、全体としてフロンティア級の能力を目指す」**

### Apple Backend Phases

| Phase | Name | Target |
|-------|------|--------|
| 1 | **Asha Metal** | Qwen3-0.6B on iPhone GPU via Metal/MPS |
| 2 | **Asha Neural** | Core ML / Core AI — CPU+GPU+Neural Engine |
| 3 | **Asha Metal Kernel Lab** | Custom Metal shaders for attention, KV cache, quantized matmul |

See [`APPLE_BACKEND_DESIGN.md`](APPLE_BACKEND_DESIGN.md).

---

## iOS Metal Backend (`--backend metal_ios`)

> **Bypasses Safari WebGPU limitations on iPhone by using native Metal Performance Shaders.**

### Why

iOS Safari does not expose the WebGPU API (`navigator.gpu`), even on iPhone 15 Pro with experimental flags enabled. WASM-based model loading from CDN is impractical on mobile (~200MB download).

The Metal backend provides a hardware-direct alternative for iOS devices.

### Architecture

```
ArcAsha Runtime
  └── ExecutionBackend (src/llm/backend.ts)
        └── MetalBackend (src/native/ios/metal/)
              ├── Metal Device (MTLDevice)
              ├── MPS Graph (MPSGraph)
              └── MPS Kernels (matmul, attention, etc.)
```

### Backend Selection

| Flag | Behavior |
|------|----------|
| `--backend auto` | Auto-detect: Metal on iOS, WebGPU on desktop |
| `--backend metal_ios` | Force Metal (iOS only) |
| `--backend webgpu` | Force WebGPU |
| `--backend cpu_fallback` | Force CPU |

### Fallback Policy

```
1. Try metal_ios (if on iOS + native bridge wired)
2. Fallback to webgpu (if available)
3. Fallback to cpu_fallback
```

### Constraints

- **Native bridge required**: Metal backend needs an iOS native app with `WKScriptMessageHandler` or `JSContext` to bridge TypeScript ↔ Metal.
- **Scaffold mode**: Without native bridge, `MetalBackend.capabilities().available` returns `false`, and the system falls back gracefully.
- **Not for non-iOS**: Metal backend throws `DeviceUnavailable` on desktop platforms.

### Example

```bash
# With Metal backend (on iOS)
npx tsx experiments/qwen3_0.6b/run_single_node.ts \
  --backend metal_ios \
  --model onnx-community/Qwen3-0.6B-ONNX

# Auto-detect (prefers Metal on iOS)
npx tsx experiments/qwen3_0.6b/run_single_node.ts \
  --backend auto
```

### Status: IMPLEMENTED (TypeScript + Swift)

> **⚠️ Requires iOS native target to run. On non-iOS, falls back gracefully.**

| Layer | Status |
|-------|:---:|
| TypeScript `ExecutionBackend` interface | ✅ |
| TypeScript `MetalBackend` (bridge stub) | ✅ |
| **Swift `Package.swift` + SPM target** | **✅** |
| **Swift `MetalBridge` (main entry + JSON bridge)** | **✅** |
| **Swift `MPSInference` (MPSGraph + matmul + sampling)** | **✅** |
| **Swift `MetalKernels` (custom shader wrappers)** | **✅** |
| **Metal shaders `qwen_ops.metal` (RMSNorm, RoPE, SwiGLU, KV)** | **✅** |
| **Swift `NumericTypes` (FP16/FP32 conversion)** | **✅** |
| iOS on-device inference test | ⚠️ Pending |

### Native Target Requirements

Real Metal inference requires:

```
ArcAsha TypeScript (this repo)
      ↓
Backend Interface (src/llm/backend.ts)
      ↓
MetalBackend STUB (src/native/ios/metal/)  ← TypeScript side DONE
      ↓
═══════════════════════════════════════
      ↓
iOS Native Target (NEEDS CREATION)
      ↓
  ├── *.xcodeproj / *.xcworkspace
  ├── Swift / Obj-C++ bridge
  ├── Metal shaders (.metal)
  ├── MPSGraph integration
  └── Core ML / Core AI (optional)
      ↓
iPhone GPU / Neural Engine
```

---

## Running

```bash
# EXP-0000: Golden Reference
cd experiments/qwen3_0.6b
pip install 'transformers>=4.51.0' torch
python golden/run_golden.py

# EXP-0001: JS/ONNX Adapter
npx tsx experiments/qwen3_0.6b/run_single_node.ts \
  --model onnx-community/Qwen3-0.6B-ONNX \
  --golden-dir experiments/qwen3_0.6b/golden/output

# EXP-0001.5: Logit comparison
python EXP-0001.5/run_logit_compare.py

# EXP-0001.6: Divergence prediction
python EXP-0001.6/run_divergence_predict.py

# EXP-0001.7: Precision ladder
python EXP-0001.7/run_precision_ladder.py

# EXP-0001.8: Replication
python EXP-0001.8/run_replication.py --runs 5
```
