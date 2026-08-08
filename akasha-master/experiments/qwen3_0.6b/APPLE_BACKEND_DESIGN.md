# Apple/Metal Backend — ArcAsha Design Spec

> **ArcAsha に Apple/Metal 専用の推論バックエンドを実装する。**
> ArcAsha 自体は Apple 専用 OS にはならない。抽象化層の下にバックエンドとしてぶら下げる。

---

## Architecture

```
ArcAsha Runtime
      │
      ├── CUDA Backend       (NVIDIA GPU)
      ├── CPU Backend         (x86/ARM)
      ├── WebGPU Backend      (Browser)
      │
      └── Apple Backend       ← NEW
            │
            ├── Asha Metal          (Metal/MPS inference)
            ├── Asha Neural         (Core ML / Core AI)
            └── Asha Metal Kernel Lab (Custom Metal shaders)
```

---

## Three-Phase Apple Backend

### Phase 1: Asha Metal（Metal Inference Backend）

**目標**: Qwen3-0.6B の主要演算を Metal/MPS で動かす。

```
Qwen3-0.6B Operations:
  RMSNorm       → MPS normalization
  RoPE          → MPS rotary embedding
  GQA           → MPS attention
  MatMul        → MPS matrix multiply
  SwiGLU        → MPS activation
  Sampling      → MPS softmax + top-k
  KV Cache      → MPS buffer management
```

MPS（Metal Performance Shaders）には最適化済みカーネルがあるため、最初から自前 Metal shader を書く必要はない。

**対象**: iPhone 15 Pro (A17 Pro), Mac (M1+)

### Phase 2: Asha Neural（Core ML / Core AI Backend）

**目標**: Apple の Core ML / Core AI を利用したオンデバイス推論。

```
Core ML / Core AI:
  CPU            → 汎用推論
  GPU            → Metal アクセラレーション
  Neural Engine  → 低消費電力 AI 専用
```

ArcAsha の Execution Profile 研究と相性が良い：
- CPU/GPU/Neural Engine の使い分けによる電力・性能プロファイル
- デバイス温度・バッテリーに応じた動的バックエンド切り替え

### Phase 3: Asha Metal Kernel Lab（Custom Metal Shaders）

**目標**: 性能クリティカルな部分のみ自前 Metal kernel 化。

```
Custom Attention       → FlashAttention-like Metal implementation
Custom KV Cache        → Device-local optimized buffer
Custom Quantized MatMul → INT4/INT8 Metal shaders
Activation Compression  → Low-bit activation in Metal
```

Apple の GPU 世代ごとの Feature Set と Metal Shading Language 仕様に基づいて、世代別最適化を体系的に研究できる。

---

## Why Apple Backend Matters for ArcAsha

### 1. Execution Profile の実機検証

EXP-0001.7〜1.9 で測定した backend × precision × platform の関係を、実デバイスで検証できる：

```json
{
  "platform": "ios-arm64",
  "device": "Apple A17 Pro",
  "backend": "metal",
  "precision": "fp16",
  "model": "Qwen3-0.6B",
  "numerical_profile": {
    "top1_agreement": "?",
    "throughput_tok_s": "?",
    "memory_mb": "?",
    "battery_drain_pct": "?"
  }
}
```

### 2. Heterogeneous Node の完成

```
Mac (MPS/FP16)       → Expert Node, high throughput
iPhone 15 Pro (Metal) → Expert Node, mobile inference
iPhone 12 mini (Relay) → Relay Node, lightweight
```

同じ Qwen3-0.6B でも、プラットフォームによって Execution Profile が異なる。これが ArcAsha の Heterogeneous Node 思想の実証になる。

### 3. Apple Silicon 最適化の研究ライン

```
ArcAsha on Apple Silicon

  → Metal GPU世代別最適化 (A14〜A17 Pro, M1〜M3)
  → Neural Engine 推論パイプライン
  → 電力効率 vs 推論品質のトレードオフ
  → オンデバイス KV Cache 管理
```

これは CUDA/Android にも広げられる汎用的な研究ライン。

---

## Relation to Existing Experiments

```
EXP-0001.7〜1.9:  backend × precision × platform の数値特性
        ↓
EXP-0002A:        Mac Expert + iPhone Relay
        ↓
EXP-0002B/C:      Multi-Expert Routing
        ↓
EXP-0002D:        iPhone 12 mini Relay（常設）
        ↓
EXP-0002E:        iPhone 15 Pro Native Expert ← Asha Metal Phase 1
        ↓
EXP-0002F:        Metal vs Core ML/Core AI ← Asha Neural Phase 2
        ↓
EXP-0002G:        Metal Precision Matrix
        ↓
EXP-0003:         2〜4 Expert Collaboration
```

---

## Design Constraint

> **ArcAsha は Apple 専用 OS にならない。**

Apple Backend は ArcAsha Runtime の抽象化層の下に位置する。CUDA / CPU / WebGPU と同列のバックエンドであり、ArcAsha のコアロジック（Routing, Scheduling, Memory Fabric, Fault Tolerance）はバックエンド非依存のまま維持する。

