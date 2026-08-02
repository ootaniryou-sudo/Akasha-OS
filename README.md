# Akasha-OS (ArcAsha)

> **📜 Master Specification**: [`MASTER_SPEC.md`](MASTER_SPEC.md) — the authoritative architecture, research roadmap, and design principles.
> This README is the implementation-facing overview. For the full vision, read the master spec.

> **"Democratising Big Tech's data centers — from your own room."**
>
> ArcAsha is a **distributed expert intelligence fabric** — not one model split across phones, but many specialized small models (~0.6B each) dynamically coordinated by an intelligent runtime into a single adaptive intelligence system with **~6.7T aggregate parameters**.
>
> **🎯 Core research question**: Can a large population of specialized small language models, coordinated by an intelligent distributed runtime, achieve useful frontier-level capabilities without requiring any individual node to host a frontier-scale model?

---

## 🌌 1. Core Concept: Expert Fabric, Not Model Sharding

**What ArcAsha is NOT**: One 6.7T model split across smartphones.

**What ArcAsha IS**: Many independent ~0.6B models, each an **Expert Node** with its own capability profile, dynamically coordinated by the **Heart of Wisdom (Core Orchestrator)** and **Eye of Wisdom (Intelligent Router)** into a collective intelligence fabric.

```
Many independent ~0.6B models
+ Specialized training (fine-tuning, distillation)
+ Capability-aware routing (task vector × expert profile)
+ Master orchestration (Heart of Wisdom)
+ Distributed memory (Realm of Knowledge)
+ Fault tolerance (Shadow of Wisdom, Divine Safeguard)
+ Expert collaboration (parallel → critic → verify → synthesize)
= Large distributed intelligence fabric (~6.7T aggregate params)
```

Each smartphone is not a "GPU worker" — it is an **independent Expert Node** containing: Model + Capability Profile + Hardware Profile + Runtime + Local KV Cache + Health State + Network State.

The AI industry today is dominated by Big Tech's capital. **ArcAsha** is the **technical antithesis** — inspired by the **Akasha System** from Sumeru (*Genshin Impact*), where countless connected terminals approach divine intelligence.

> 📖 **ArcAsha Naming System**: All components have lore names. See [`NAMING.md`](NAMING.md) and [`MASTER_SPEC.md` §11`](MASTER_SPEC.md#11-arcasha-naming).

---

## 🛠️ 2. Core Architecture (4-Layer Stack)

```
[Layer 4: Application UI]     User Interface / Token Streaming
[Layer 3: Master Orchestrator] Akasha-Core (TypeScript)
[Layer 2: Autonomous Edge Cluster] Phone WebWorker + WebGPU
[Layer 1: Physical Topology]  Fat-tree wired LAN & distributed power
```

### 2.1 Layer 1: Physical Topology

| Equipment | Role | Capacity | Est. Price |
|-----------|------|----------|------------|
| USB-LAN Hub (10-port) | Wire + power 10 phones | 10/hub | ~$15 |
| L2 Gigabit Switch (24-port) | Backbone | 24 hubs/switch | ~$30 |
| Household outlets (separate breakers) | Power isolation | ≤100 phones/circuit | — |

### 2.2 Layer 2: Autonomous Edge Cluster

Phones run in-browser via WebWorker + WebGPU:
- Persistent WebSocket → 48-byte binary protocol (zero JSON)
- Float32Array zero-copy → WebGPU buffer
- Computes assigned layer range → P2P relay to next node

### 2.3 Layer 3: Master Orchestrator (Heart of Wisdom)

`Akasha-Core` — Node.js (TypeScript):

| Module | Purpose |
|--------|---------|
| **Bootstrapper** | Connection throttling, IP analysis, APS benchmark, role assignment |
| **Inference Loop** | Per-token pipeline, P2P relay, shadow race coordination |
| **Fault Tolerance** | Deadline monitoring, automatic failover (Shadow of Wisdom) |
| **Idle Pool** | O(1) node acquire/release (intrusive DLL) |
| **Ring Buffer** | Lock-free SPSC IPC (SharedArrayBuffer + Atomics) |
| **Binary Codec** | 48-byte fixed header encode/decode (zero allocation) |
| **LLM Adapter** | LLM abstraction (Qwen, Llama, custom) |
| **Memory Fabric** | Conversation store, semantic memory, KV cache (Echo) |
| **Context Manager** | HOT/WARM/COLD tiered context paging |

---

## 🧬 2.5 Parameter Scaling Roadmap

**Key distinction**: Aggregate Parameters ≠ Active Parameters ≠ Active Expert Count. See [`MASTER_SPEC.md §3`](MASTER_SPEC.md#3-total-parameters-vs-active-parameters).

| Phase | Expert Nodes | Aggregate Params | Active Experts (typical) | Active Params (typical) | Comparable to |
|---|---|---|---|---|---|
| Phase 1: Proof | 100 | **60B** | 4–8 | **2.4–4.8B** | GPT-2 |
| Phase 2: Small | 1,000 | **600B** | 8–32 | **4.8–19.2B** | Llama-2-70B* |
| Phase 3: Medium | 5,000 | **3T** | 32–128 | **19.2–76.8B** | DeepSeek-V3* |
| Phase 4: Large | 10,000 | **6T** | 64–256 | **38.4–153.6B** | GPT-4 estimated* |
| Phase 5: Frontier | 50,000 | **30T** | 128–512 | **76.8–307.2B** | Frontier-class |
| Phase X: Beyond | 100,000 | **60T** | 256–1024 | **153.6–614.4B** | Research target |

> \* Comparable in active parameter scale only. Does not imply equivalent capability.
> Aggregate capacity grows with node count; active compute is dynamically adjusted to task difficulty.
> See [`MASTER_SPEC.md §20`](MASTER_SPEC.md#20-important-distinction) for the critical distinction.
> ArcAsha explores whether distributed expert coordination can approach the capabilities
> of much larger monolithic models at a fraction of the hardware cost. This is a research
> hypothesis — not a proven claim. See [`MASTER_SPEC.md §29`](MASTER_SPEC.md#29-critical-research-question).

---

## ⚡ 3. Advantages Over Big Tech

### ① Cost Democratization

| | Traditional DC | Akasha-OS |
|---|---|---|
| Initial Cost | $100M–$1B+ | ~$1.3M |
| Monthly Power | $100K–$1M+ | ~$1,200 |
| Cooling | Liquid/AC | Natural air |
| Procurement | Months lead time | Same-day eBay |

### ② Zero-Copy Binary Relay

- Zero JSON — 48-byte header + raw Float32Array
- WebGPU zero-copy upload
- P2P direct relay (bypasses master)
- Buffer pool suppresses V8 GC

### ③ Speculative Shadow Racing

Primary + Shadow nodes compute simultaneously. Whichever finishes first wins; late result is discarded O(1). The system never stops.

---

## 🔌 4. Plugin Architecture

### Open Expert Plugin Standard

```typescript
export interface AkashaExpertPlugin {
    metadata: { id, name, version, expertDomain, parameterSize, keywords, ... };
    execute(inputTensor: Float32Array): Promise<Float32Array>;
}
```

One function. Plug into the swarm instantly.

### Dynamic Semantic Routing

New plugins are hot-plugged — registered at runtime without restart. Keywords are indexed O(1).

### Community DePIN Marketplace

Anyone can open their phone's browser, run a plugin, and contribute compute. Open infrastructure.

---

## 🚀 5. Quick Start

```bash
cd akasha-master
npm install && npm run build
npm run dev          # Master on :8080
npm run sim          # Demo
npm run selftest     # Self-test
```

---

## 🧪 5.5 PoC Guide

```bash
./poc/measure.sh <edge-ip-1> <edge-ip-2>
node poc/wt-rtt-measure.mjs <master-ip> 8080
curl http://localhost:9090/metrics
```

---

## 📡 6. Binary Protocol

48-byte fixed header + Float32Array. See [`PROTOCOL.md`](PROTOCOL.md). Commands: REGISTER, COMPUTE_TASK, RESULT, RELAY, TOKEN_OUT.

---

## 🔬 7.5 Research Progress — Phase 1〜4 (Jul 2026)

> Full details: [`experiments/qwen3_0.6b/README.md`](experiments/qwen3_0.6b/README.md) | Conclusions: [`CONCLUSIONS.md`](experiments/qwen3_0.6b/CONCLUSIONS.md) | Framework: [`RESEARCH_FRAMEWORK.md`](experiments/qwen3_0.6b/RESEARCH_FRAMEWORK.md)

ArcAsha は「分散LLMを動かす」だけのプロジェクトではない。
**「分散LLMにおけるルーティング戦略を、多目的最適化・数値安定性・信頼度推定を用いて体系化する」**
ことを研究テーマとし、`理論 → 実装 → 実データ検証 → システム状態変化` のサイクルで段階的に検証している。

### Phase 1 ✅ — LLM Numerical Characterization (EXP-0000〜0001.9)

| # | Experiment | Result | Key Finding |
|---|-----------|:---:|------|
| 0000 | Golden Reference | ✅ | Qwen3-0.6B base model, 10 prompts, T=0 deterministic, MPS |
| 0001 | Python vs JS/ONNX | ✅ | Tokenizer 10/10 match. Output 15-44% (ONNX fp16 ≠ PyTorch fp32) |
| 0001.5 | Logit-Level Analysis | ✅ | FP32→FP16: 93.75% top-1 match. Divergence at logit_margin < 0.02 |
| 0001.6 | Divergence Prediction | ⚠️ | Per-step prediction NOT viable (AUC=0.57). Backend-level characterization is the right abstraction |
| 0001.7 | Precision Ladder | ✅ | FP16: 99.2% stable, 1.42× faster. BF16 on MPS: 20.9% divergence |
| 0001.8 | Replication | ✅ | σ=0.0000 — BF16 20.88% perfectly reproducible |
| 0001.9 | Platform Matrix | ✅ | macOS MPS completed (fp32/fp16/bf16). CUDA/CPU pending |

**Three-line conclusion:**
1. Cross-runtime inference is functional, but token-level reproducibility is backend-sensitive.
2. Divergence is triggered by numerical ambiguity (logit_margin < 0.02) and amplified by backend/kernel differences.
3. Exact replication, approximate redundancy, and independent verification should be distinct execution modes.

**Design principle:** *Numerical Stability is a property of an execution configuration (platform + backend + precision), not of a model alone.*

### Phase 2 ✅ — Distributed Runtime (EXP-0002A/B)

| # | Experiment | Result | Key Finding |
|---|-----------|:---:|------|
| 0002A | Remote Single Expert | ✅ | Mac Node: Qwen3-0.6B via WebSocket. Network overhead 2ms (localhost) |
| 0002A-iPhone | iPhone 12 mini Relay | ✅ | **iPhone joins ArcAsha network.** WiFi 20ms RTT. Lightweight relay — no model needed |
| 0002B | Heterogeneous Two-Node Routing | ✅ | **Round-Robin PC Expert + iPhone 15 Pro Relay. 50/50. 1.9× throughput** (13.2s→6.96s) |

**Node Type Architecture:**

| Type | Has Model? | Example | Role |
|------|:---:|------|------|
| **Expert Node** | ✅ | Mac + Qwen3-0.6B | Inference execution |
| **Relay Node** | ❌ | iPhone 12 mini | Connectivity, forwarding, health |
| **Hybrid Node** | ✅ | Future iPhone 15 Pro | Expert + Relay combined |

### Phase 3 ✅ — Intelligent Routing (EXP-0002C〜0002E.3)

| # | Experiment | Result | Key Finding |
|---|-----------|:---:|------|
| 0002C | Capability-Aware Routing | ✅ | **Routing Accuracy 100%.** coding→coding expert, math→math expert |
| 0002D | Adaptive Capability (SMA) | ✅ | **Score Inversion 発見** → Evaluation fidelity bounds routing quality |
| 0002D.1 | Confidence-Aware Routing | ✅ | Two-stage eval (μ × confidence). **Inversion 7回避・0発生** |
| 0002E | Composite Score Routing | ✅ | Under equal capability, **Stability dominates** (FP16 10/10, BF16 0/10) |
| 0002E.1 | Decision Boundary | ✅ | **critical w_stab = 0.0 / 0.185 / 0.351.** Stability = secondary objective |
| 0002E.2 | Pareto Routing | ✅ | Scalarization hides dominance. **Two-stage: Pareto Filter → Composite Score** |
| 0002E.3 | **Adaptive Weight Learning** | ✅ | **3-way比較: Fixed 86% vs Manual 96% vs Adaptive 96%.** w_stab 0.30→0.70 を Belief から学習. ドリフト 8/8・Recovery 8/8 |

### Phase 4 ✅ — Adaptive State Routing (EXP-0002F〜0002E.3)

| # | Experiment | Result | Key Finding |
|---|-----------|:---:|------|
| 0002F | Shadow Expert Feedback | ✅ | 閉ループ実装. Same-runtime 100% agree (EXP-0001.8 と整合) |
| 0002F.1 | **Cross-Backend Shadow** | ✅ | **ONNX vs PyTorch MPS: 88.6% overlap, FLAG=1 (45%). Stability 0.992→0.743** — Belief Update 実証 |
| 0002F.2 | **Recovery Dynamics & Hysteresis** | ✅ | **非対称α (deg=0.3/recover=0.9). Drift 1.0→0.91 → Recovery 0.91→0.961. Hysteresis 0.567 (保守的). Half-life 7reqs. Time-to-95% 未到達. FalseRecovery 0%.** |
| 0002E.3 | **Adaptive Weight Learning** | ✅ | **3-way比較: Adaptive 96% ≥ Fixed 86%.** w_stab 0.30→0.70 が Belief に追従. ドリフト/Recovery 8/8. **事前知識ゼロで Manual と同等** — 二重適応の実証 |
| 0003 | **Heterogeneous Experts** | ✅ | **Qwen3-0.6B / SmolLM2-360M / Gemma-3-1B.** Belief(Node)→Belief(Node,Task) 拡張. **Belief 60% > Fixed 20%.** SmolLM coding最強, Gemma math最強 |
| 0003B | **Cost-Aware Routing** | ✅ | **Quality+Latency+Cost の総合ルーティング. QPC (Quality-per-Cost) 1.91x. コスト -43% で Accuracy 50%→60%.** 「安くて十分良い」を選ぶ |
| 0003A | **Dynamic Node State Estimation** | ✅ | **State(t)={Cap,Lat,Cost,Stab}. Router は状態推定器. Regret を導入し Adaptive vs Static で -75.7%.** Capability jump (モデル更新) 追従を実証 |
| 0003C | **Policy Learning** | ⚠️ | **Q[state][node] を報酬から学習 (State→Policy→Action). 負の結果: 少サンプルでは Fixed 優位 (1.6 vs 4.2).** **Learning Depth Hypothesis を提案** — 学習対象が深いほど Sample Complexity が急増 |
| 0003C.1 | **Contextual Bandit (UCB)** | ✅ | **UCB/Thompson は Q-Learning より2-3倍サンプル効率 (16.5 vs 7.2/5.4).** Contextual Bandit 定式化の妥当性を確認. ただし60サンプルでは Fixed 未達 → **Empirical Observation 1 (学習深度) 支持** |
| 0003C.2 | **Sample Complexity Estimation** | ✅ | **実測 (N=5..120) を冪則フィット: Fixed b=0.75 < 全学習器 (0.83〜0.94) → N* = NEVER (漸近).** **フィードバック非対称性を発見: Fixed=フル情報 (オラクル) vs バンディット=部分情報.** Shadow (0002F) との統合が次の動機 |
| 0003C.3 | **Shadow Feedback (Full-Info Bandit)** | ✅ | **2×2 (UCB/Thompson × partial/shadow). シャドウ実行で UCB のギャップ 94% 解消 (9.58→0.60), Thompson の N* が 6.2倍高速化 (5,456→885). フィードバック構造が支配要因と実証. 残差は重みキャリブレーション → LinUCB** |
| 0003C.4 | **LinUCB (7-dim features)** | ✅ | **LinUCB-Shadow が初めて Fixed を上回る (gap=-0.40, regret 6.5%減).** **学習重みがメカニズムを実証: gemma latency=0.379 (>Fixed 0.20). 0003C.3 の残差 0.60 を解消し逆転.** Observation→State→Belief→Confidence→Features→Routing パイプライン完成 |
| 0003D | **Statistical Validation** | ✅ | **30 seeds: LinUCB-S vs Fixed 有意 (p=0.020, d=-0.49, 平均11%低). 部分FB 有意に悪い (p<0.001). UCB-S は同等 (p=0.41). LinUCB-S vs UCB-S p<0.001 (d=-1.10). 10→30 seed で p 0.77→0.02 = 検出力の実証.** |
| 0003E | **Benchmark Expansion** | ✅ | **Set B (Qwen2.5-Coder-0.5B/SmolLM2-135M/Llama-3.2-1B) + reasoning で LinUCB-S > Fixed が再現 (p<0.001, d=-0.88, 効果量増大). Set B では UCB-S は有意に悪い (p<0.001) → 素朴な報酬最大化は品質分散下で危険、特徴量学習が必須. モデル・タスク一般化を確立.** |
| 0003F | **Feature Ablation** | ✅ | **LinUCB の capability (信念からの能力推定) を除去すると Regret +37.6% 悪化 (p<0.001). 他の特徴はほぼ無影響. → LinUCB 優位のメカニズムは「観測→信念→能力推定」にあり、Observation-Driven Routing の本質を解明.** |

> **Phase 4 完了**: `Static Knowledge → Observed Evidence → Belief Update → Weight Learning → Routing` の閉ループが実データで成立。
> 「観測に応じて Belief を更新し、その Belief に応じて Weight を学習することで、未知の環境変化にも適応できる」— 中心仮説に実験的裏付け。
> **EXP-0003 で異種モデルでも成立** — 単一モデル向けの工夫ではなく、一般的な分散LLMルーティングの枠組みとして機能。

### Roadmap

```
📜 論文凍結 ✅ Zenodo DOI 10.5281/zenodo.21755612 (Observation-Driven Routing)
ArcAsha v0.1 ✅ src/arcasha/ — 検証済みパイプラインを内部エンジンとして製品化
Phase 5 🚧 Emergent Controller (Task → Planner → Router → Verifier → Memory) ← 進行中
EXP-0005A ✅ Task Decomposition (RuleBasedPlanner)
EXP-0005B 📐 LLM Planner
EXP-0005C 📐 Dynamic Expert Assignment
EXP-0005D ✅ Verifier (閾値 + 拒否語 + 統合)
EXP-0005E ✅ EpisodeMemory
EXP-0005F ✅ Emergent Controller (End-to-End デモ実証)
EXP-0003C.5 📐 Neural Bandit
Phase 6 📐 Distributed Frontier AI
```

> **ArcAsha v0.1**: 研究で検証した Observation→Belief→Confidence→Features→LinUCB-Shadow→Routing の
> パイプラインを `src/arcasha/` に実装。実ノード 3 台 (Qwen3-0.6B / SmolLM2-360M / Gemma-3-1B) で
> エンドツーエンド動作を確認。詳細: [`src/arcasha/README.md`](src/arcasha/README.md)

### Apple Backend Architecture

```
ArcAsha Runtime
  ├── CUDA Backend
  ├── CPU Backend
  ├── WebGPU Backend
  └── Apple Backend ← NEW
        ├── Asha Metal (Metal/MPS)
        ├── Asha Neural (Core ML/Core AI)
        └── Asha Metal Kernel Lab (Custom Shaders)
```

See [`APPLE_BACKEND_DESIGN.md`](experiments/qwen3_0.6b/APPLE_BACKEND_DESIGN.md).

---

## 🧪 7. APS (Akasha Performance Score)

$$APS = \frac{1000}{\text{GPU}_\text{ms} + \frac{\text{RTT}_\text{ms}}{2}}$$

APS ≥ 80 → HEAD layers | 25–80 → MID layers | < 25 → SHADOW backup.

---

## 📂 8. Project Structure

```
Akasha-OS/
├── MASTER_SPEC.md          # Authoritative architecture & research spec
├── README.md, NAMING.md, LICENSE, CONTRIBUTING.md
├── akasha-master/          # TypeScript orchestrator (Heart of Wisdom)
├── akasha-client-web/      # Browser edge node (Akasha Terminal)
├── akasha-kernel-native/   # Rust native kernel (Core Terminal)
└── examples/               # Plugin templates
```

---

## 🌍 9. Community

- Submit plugins via [`examples/`](examples/)
- Report bugs: [Issue Templates](.github/ISSUE_TEMPLATE/)
- Contribute: [`CONTRIBUTING.md`](CONTRIBUTING.md)

---

## 📝 10. License

MIT — [`LICENSE`](LICENSE)

---

> *"Knowledge, however small each grain may be, when connected becomes a desert that eventually covers the entire world."*
> —— Sumeru Akasha System philosophy (*Genshin Impact*)
