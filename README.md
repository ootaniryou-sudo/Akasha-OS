# Akasha-OS (ArcAsha)

> **"Democratising Big Tech's data centers — from your own room."**
>
> A hyper-distributed edge AI orchestration operating system that unites tens of thousands of used smartphones and cheap wired networks into a single massive virtual **6.7-trillion-parameter class** collective intelligence.
>
> **🎯 Roadmap target**: Match or exceed current frontier-class LLM parameter counts (DeepSeek-V3: 671B MoE / GPT-4: ~1.8T estimated) using nothing but household power outlets and a pile of used smartphones — ultimately aiming for **10T+ parameters** in fully distributed inference.

---

## 🌌 1. Project Background & Vision

The AI industry today is dominated by Big Tech's capital — trillion-yen data centers, exclusive access to cutting-edge GPUs (NVIDIA H100, etc.), and enormous power consumption.

**Akasha-OS** is the **technical antithesis** to this centralized structure.

One source of inspiration is the **Akasha System** from the Sumeru region in *Genshin Impact* — a fictional network where all citizens wear "Akasha Terminals" that collect and integrate knowledge, thoughts, and experiences in real-time, functioning as a massive collective intelligence. "Each terminal is weak alone, but countless connected terminals approach divine intelligence" — we aim to realize this with real-world edge devices.

Every year, hundreds of millions of still-working used smartphones are discarded. We collect them, chain them with wired LAN, and run 0.1B–1B specialized AI models on each via the browser. Our ultra-low-latency routing harmonizes them into **frontier-class intelligence at a fraction of the cost and power**.

> 📖 **ArcAsha Naming System**: All components have lore names. See [`NAMING.md`](NAMING.md). Core: **Heart of Wisdom (Orchestrator)**, **Eye of Wisdom (Router)**, **Shadow of Wisdom (Shadow Execution)**, **Realm of Knowledge (Memory Fabric)**, **Echo (KV Cache)** — 12 components total.

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

| Phase | Nodes | Target Params | Comparable to |
|---|---|---|---|
| Phase 1: Proof | 100 | **10B** | GPT-2 |
| Phase 2: Small | 1,000 | **100B** | Llama-2-70B |
| Phase 3: Medium | 5,000 | **671B** | DeepSeek-V3 |
| Phase 4: Large | 10,000 | **1.8T** | GPT-4 estimated |
| Phase 5: Frontier | 50,000 | **6.7T** | **Frontier-class** |
| Phase X: Beyond | 100,000 | **10T+** | **Beyond all existing** |

> 50,000 used phones ≈ $1.3M. A single H100 GPU (~$33K) cannot run a 6.7T model. Only Akasha-OS can reach this scale.

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

## 🧪 7. APS (Akasha Performance Score)

$$APS = \frac{1000}{\text{GPU}_\text{ms} + \frac{\text{RTT}_\text{ms}}{2}}$$

APS ≥ 80 → HEAD layers | 25–80 → MID layers | < 25 → SHADOW backup.

---

## 📂 8. Project Structure

```
Akasha-OS/
├── README.md, NAMING.md, LICENSE, CONTRIBUTING.md
├── akasha-master/          # TypeScript orchestrator
├── akasha-client-web/      # Browser edge node
├── akasha-kernel-native/   # Rust native kernel
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
