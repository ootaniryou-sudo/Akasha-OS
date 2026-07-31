# Qwen3-0.6B — ArcAsha Experiment Log

> **Phase 1 complete (EXP-0000〜0001.9): LLM Numerical Characterization**  
> **Phase 2 in progress (EXP-0002A): Distributed Inference**

**[`CONCLUSIONS.md`](CONCLUSIONS.md)** — Formal conclusions + design principles.  
**[`NUMERICAL_STABILITY_PROFILE.md`](NUMERICAL_STABILITY_PROFILE.md)** — Multi-dimensional profile spec.

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
