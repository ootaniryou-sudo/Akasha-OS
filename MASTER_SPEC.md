# ArcAsha — An AI Operating System for Modular Reasoning and Runtime Intelligence

**Master Specification v1.1**

| | |
|---|---|
| **Project** | ArcAsha (Akasha-OS / アーカーシャ) |
| **Positioning** | An AI Operating System — not a model. It runs *above* the model. |
| **Status** | v1.0 released / v1.1 (Decision Replay) |
| **License** | MIT |

---

## 1. Vision

ArcAsha is **not** "a bigger model". It is an **operating system for AI intelligence**.

> **Do not put the intelligence inside a bigger model.**
>
> **Manage reasoning, memory, planning, belief, and learning at the OS level — so that even a small model (Qwen1.5B) can be composed, controlled, and measured reproducibly.**

The OS treats reasoning as a schedulable resource (like a CPU does with processes), treats context as virtual memory (like an OS does with RAM), and treats intelligence as optional loadable modules (like Linux does with kernel modules).

The historical v1 vision — a distributed fabric of thousands of smartphones forming a ~6.7T-parameter "Expert Fabric" — is preserved as the **research roots** (see [§11 History](#11-history)). The implemented architecture focuses on the OS layer that makes such coordination *explainable and learnable*.

---

## 2. Core Research Question

> **Can an OS-level runtime make reasoning composable, controllable, and measurable — reproducibly — so that even a small model can explain *why* it chose a configuration, replay the decision step-by-step, and *learn from its own decisions*?**

Three axes make this concrete:

1. **Explain** — "Why did the AI use Reflection / Planning / Debate?" (Decision Explanation)
2. **Replay** — "Show me the decision process step by step." (Decision Replay)
3. **Learn** — "Turn decisions into training data for the Meta Executive." (OS Policy Learning)

These are training axes **orthogonal to Transformer pretraining**.

---

## 3. Architecture (3 Layers)

```
Layer 3  Intelligence Attachments
         Reflection / Debate / Planning / Search / Creativity / Simulation / Coding
Layer 2  Executive Runtime
         Executive / Meta Executive / Expert Evolution / Intelligence Scheduler
Layer 1  Fast Runtime
         Kernel / AVM / Expert Runtime / ODAR / Device Tree   ← realtime, always fast
```

- **Fast vs Deliberation**: Layer 1 keeps realtime control (robot: **30.3 fps**). Layers 2–3 load only when needed (research / long reasoning).
- **Kernel minimalism**: the OS core stays small and stable; advanced intelligence is an **Attachment** (optional kernel module), loaded on demand.

---

## 4. Design Principles

1. **Kernel minimal, intelligence as Attachment** — the core never grows by adding intelligence; it grows by adding *interfaces*.
2. **Deterministic and reproducible** — selftest [1]–[72], golden 30 cases, fixed corpora, fixed model parameters.
3. **Explainable by construction** — every decision is logged and explainable (Decision Explanation / Replay / Policy Learning).
4. **Simulation vs Real Device separated** — numbers are labeled `kind: 'simulation'`; real-device harness returns `not-connected` rather than fabricating values.
5. **OS-level learning** — the training axis of the OS (Policy Learning) is distinct from and orthogonal to model pretraining.

---

## 5. Component Specifications

### 5.1 AILSA — Instruction Set Architecture

- Registry: `registry.json` **v1.2.0** (66+ instructions).
- Binary format: **Opcode + Slot + varint + UTF-8**.
- Deterministic, verifiable ISA for AI kernels.

### 5.2 AILSM — Semantic Intermediate Representation (SSA)

- A graph IR where **tasks, objects, values, memory, beliefs, plans, reflections, capabilities, schedules, processes, threads, namespaces, contexts, pages, slices, caches, executions, chunks, spans, frames, hypotheses, executives, meta-executives, and experts** are all first-class nodes.
- Edges include `hypothesizes / expands / manages / specializes / mergesInto`.
- Version: **v1.8**. All graph transforms rebuild via `AilsmBuilder` (node IDs stable).

### 5.3 Kernel / AVM — AI Virtual Memory

- Context is treated as **demand-paged virtual memory** instead of "a bigger context window".
- Layers: Context SSA / Page Manager / Slice Loader / Context Cache / Long Context ABI (`ContextRef` = file descriptor).
- Execution Context / Context Switch / Context Fault / Prefetcher; Hot / Warm / Cold tiers.
- Measured: **4.10× speedup, −77% tokens** vs full-context (kind=simulation).

### 5.4 Executive Runtime

- **Executive** commands the search: READY → EXPAND → EVALUATE → REFLECT → **EXECUTIVE (strategy switch)** → next round. It can change strategy *mid-search* (stagnation → explore; success+pruning → exploit).
- **Meta Executive** manages executives; estimates budgets; learns from observed outcomes.
- OS mapping: Expert = execution resource / Hypothesis = process / Reflection = scheduler feedback / Reasoning Graph = execution graph / Kernel = owner of the whole search.

### 5.5 Expert Evolution

- Experts **split / merge / retire** by objective criteria (health, overlap, utilization).
- The evolution loop skips unobserved experts; merges are idempotent.

### 5.6 Thinking Modes

- **Fast / Auto / Deep / Custom** — the same OS, different pipeline.
- **Intelligence Scheduler** allocates a **Thinking Budget** (`usedMs ≤ budgetMs`), visible as `Reflection 150ms / Debate 400ms / TOTAL 550ms`.

### 5.7 Attachments

- `Attachment` interface: `id / name / version / enabled / supports / run` + Thinking Budget (`estimatedCost / Latency / Accuracy`).
- `AttachmentManager`: register / unregister / enable / disable / lazy `load` / unload / execute / executeParallel / executeMerged.
- Built-ins (7): **Reflection, Debate, Planning, Search, Creativity, Simulation, Coding**.
- Attachments never touch kernel state directly; all communication goes through the Executive via `AttachmentContext`.

### 5.8 Explainable

- **Decision Explanation** — why this mode / attachment set (expected gain: Planning +31% / Debate +22% / Creativity +28% / Reflection +19%; total ≈ +34%).
- **Decision Replay** — step-by-step replay of the decision process (`arcasha replay`).
- **OS Policy Learning** — a Decision Log feeds EMA-based gains (α=0.3) into the Meta Executive's policy (`arcasha policy`).

### 5.9 Validation

- **Simulation** (deterministic, `kind: 'simulation'`): Long Context 4.10× / Reasoning 57→93% / Robot Fast 30.3fps vs Deep 1.2fps / Executive 0.50→0.71 / Flagship (same Qwen1.5B: 0.57→0.79).
- **Real Benchmark Suite**: GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench — Qwen1.5B (single / Thinking / +Fast / +Auto / +Deep): overall **27% → 95%**.
- **Real Device**: Mac / iPhone 15 Pro / iPad M4 harness — returns `not-connected` when no device is attached.
- Reports auto-generated: `reports/benchmark/report.{json,csv,md}`.

---

## 6. Implementation Status

### v1.0 — Released
AI OS first generation (Phases 0–4):
- ISA / IR / Kernel / AVM → realtime devices → Reasoning Search → Executive / Meta Executive → Expert Evolution → Attachments / Thinking Modes → Scientific Validation / Real Benchmark Suite.

### v1.1
- **Decision Replay**, Real Device benchmark plan (Mac / iPhone 15 Pro / iPad M4).

### Verification
- `npm run ailsm:selftest` [1]–[72] / `npm run ailsm:golden` (30) / `npm run ailsa:selftest` / `npm run build` + dist checks — all green. CI runs these on every push / PR.

---

## 7. Repository Layout

```
akasha-master/        Core implementation (TypeScript / AILSA / AILSM / Kernel / AVM / Executive / Attachments)
akasha-client-web/    Web client (WebGPU inference)
akasha-kernel-native/ Native kernel prototype (Rust)
examples/             Attachment examples (code / math)
.github/              Issue templates + CI workflow
AI_*.md               Specifications (see below)
```

---

## 8. Documentation Index

| Doc | Contents |
|-----|----------|
| `ARCASHA_V2_SPEC.md` | v2 design spec (v0.36) — full phase history |
| `AILSA_ISA.md` | Instruction Set Architecture |
| `AILSA_RUNTIME.md` | Runtime / execution model |
| `AILSM_IR.md` | Semantic IR (SSA) v1.8 |
| `AILSM_COMPILER.md` | IR compiler |
| `AI_ABI.md` | ABI / Driver / DeviceTree |
| `AI_IR_MODEL.md` | IR とモデルの関係（IR は OS の内部バス / モデルは IR を知らない / 蒸留・IR ネイティブ化） |
| `AI_VIRTUAL_MEMORY.md` | AVM |
| `AI_OBSERVABILITY.md` | AI Monitor / instrumentation |
| `AI_RUNTIME_PHASE1.md` | Realtime device runtime |
| `AI_TOOLCHAIN.md` | Toolchain |
| `AI_REASONING.md` | Hypothesis SSA / Reasoning Graph / Executive / Meta Executive / Expert Evolution |
| `AI_ATTACHMENTS.md` | Attachment layer / Thinking Modes / Validation |
| `AI_VALIDATION.md` | Scientific validation (Simulation vs Real Device) / Decision Explanation / Replay / Policy Learning |
| `AI_EVALUATION.md` | Evaluation |
| `PROTOCOL.md` | Binary protocol |
| `NAMING.md` | Naming system |
| `PAPER_OUTLINE.md` | Paper: "ArcAsha: An Explainable Runtime for AI Intelligence" |
| `CHANGELOG.md` | Release history (v1.0 / v1.1) |

---

## 9. Research Positioning

ArcAsha is an **experimental platform to compose, control, and measure AI intelligence at the OS level — reproducibly**.

The most novel point: the OS can
- **explain why** Reflection / Planning / Debate were used (**Decision Explanation**),
- **replay** the whole decision process (**Decision Replay**),
- **learn from its own decisions** (**OS Policy Learning**).

This is a training axis orthogonal to Transformer pretraining — the OS-level analog of "experience replay" for reasoning control.

---

## 10. Roadmap

1. **Real Device validation** — connect Mac / iPhone 15 Pro / iPad M4 via the Hub and replace simulation numbers with measured latency / power / temperature / accuracy.
2. **Model integration** — broader small-model support (Qwen family, etc.) on the Fast Runtime.
3. **Policy scaling** — deepen OS Policy Learning (multi-objective, cross-session transfer).
4. **Tool calling** — attachments gain real tool / compiler / search access (Coding `COMPILE` becomes a real compile).

---

## 11. History (Research Roots)

The project began as a **distributed expert intelligence fabric** vision (v1):

> Many independent ~0.6B models coordinated by an intelligent runtime into a ~6.7T aggregate-parameter system — "Expert Fabric", "Heart of Wisdom", "Eye of Wisdom".

That vision remains the long-term *scale* ambition, but the implemented architecture (v1.0+) deliberately focuses on the **OS layer**: how to manage, explain, and learn reasoning on small models. The naming system retains the v1 world-view names as lore (see `NAMING.md`), while the formal names reflect the implemented runtime.
