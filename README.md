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

## 🔬 7.5 Phase 1 Experiments — Complete (Jul 2026)

> Full details: [`experiments/qwen3_0.6b/README.md`](akasha-master/experiments/qwen3_0.6b/README.md) | Conclusions: [`CONCLUSIONS.md`](akasha-master/experiments/qwen3_0.6b/CONCLUSIONS.md)

### Phase 1: LLM Numerical Characterization (EXP-0000〜0001.9)

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

### Phase 2: Distributed Inference (EXP-0002A)

| # | Experiment | Result | Key Finding |
|---|-----------|:---:|------|
| 0002A | Remote Single Expert | ✅ | Mac Node: Qwen3-0.6B via WebSocket. Network overhead 2ms (localhost) |
| 0002A-iPhone | iPhone 12 mini Relay | ✅ | **iPhone joins ArcAsha network.** WiFi 20ms RTT. Lightweight relay — no model needed |

**Node Type Architecture:**

| Type | Has Model? | Example | Role |
|------|:---:|------|------|
| **Expert Node** | ✅ | Mac + Qwen3-0.6B | Inference execution |
| **Relay Node** | ❌ | iPhone 12 mini | Connectivity, forwarding, health |
| **Hybrid Node** | ✅ | Future iPhone 15 Pro | Expert + Relay combined |

### Phase 2-4: Planned

| # | Experiment | Target |
|---|-----------|--------|
| 0002B | Two Expert Routing | 2 Mac Nodes, request distribution |
| 0002C | Capability-Aware Routing | Math→Math Expert, Code→Code Expert |
| 0002D | iPhone 12 mini Relay | Low-power relay, health monitoring |
| 0002E | iPhone 15 Pro Native Expert | Asha Metal Phase 1 — iPhone GPU inference |
| 0002F | Metal vs Core ML/Core AI | Asha Neural Phase 2 — Apple backend comparison |
| 0002G | Metal Precision Matrix | backend × precision on Apple Silicon |
| 0003 | Cooperative Inference | 2 Experts → Synthesis |
| 0004 | Active Expert Scaling | 1→2→4→8→16 Experts |

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

See [`APPLE_BACKEND_DESIGN.md`](akasha-master/experiments/qwen3_0.6b/APPLE_BACKEND_DESIGN.md).

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
