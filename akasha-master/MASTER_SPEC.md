# ArcAsha — Distributed Expert Intelligence Architecture

## Master Specification for Coding / Research AI

**Project name**: ArcAsha  
**Pronunciation**: Akasha / アーカーシャ

ArcAsha is a distributed AI operating system designed to transform a heterogeneous collection of small AI models running on independent edge devices into a coordinated large-scale intelligence fabric.

The core idea is:

> **Do not place one gigantic model on one machine.**
>
> **Distribute many specialized small models across many devices and let ArcAsha dynamically coordinate them as one intelligent system.**

The ultimate research target is a system with approximately:

**~6.7 trillion total parameters**

while individual models may remain relatively small, for example:

**~0.6B parameters per edge model**

and the number of active models / active parameters changes dynamically according to task difficulty.

---

## Table of Contents

1. [Core Vision](#1-core-vision)
2. [Most Important Concept](#2-most-important-concept)
3. [Total Parameters vs Active Parameters](#3-total-parameters-vs-active-parameters)
4. [Parameter Scaling Target](#4-parameter-scaling-target)
5. [Existing Model Strategy](#5-existing-model-strategy)
6. [Expert Specialization](#6-expert-specialization)
7. [Capability Evaluation](#7-capability-evaluation)
8. [Task Capability Vector](#8-task-capability-vector)
9. [Routing](#9-routing)
10. [Master Node](#10-master-node)
11. [ArcAsha Naming](#11-arcasha-naming)
12. [Distributed Expert Model](#12-distributed-expert-model)
13. [Collaboration Instead of Simple Routing](#13-collaboration-instead-of-simple-routing)
14. [Active Expert Scaling](#14-active-expert-scaling)
15. [Adaptive Computation](#15-adaptive-computation)
16. [Memory Architecture](#16-memory-architecture)
17. [Long Context](#17-long-context)
18. [Prefix / KV Reuse](#18-prefix--kv-reuse)
19. [Model Specialization](#19-model-specialization)
20. [Important Distinction](#20-important-distinction)
21. [Research Baselines](#21-research-baselines)
22. [Scaling Experiments](#22-scaling-experiments)
23. [Fault Tolerance](#23-fault-tolerance)
24. [Smartphone Deployment](#24-smartphone-deployment)
25. [Model Registry vs Node Registry](#25-model-registry-vs-node-registry)
26. [Future ArcAsha-native Model](#26-future-arcasha-native-model)
27. [Ultimate Architecture](#27-ultimate-architecture)
28. [Ultimate Parameter Target](#28-ultimate-parameter-target)
29. [Critical Research Question](#29-critical-research-question)
30. [Implementation Strategy](#30-implementation-strategy)
31. [What NOT to Do](#31-what-not-to-do)
32. [Required Engineering Principle](#32-required-engineering-principle)
33. [Required Research Record](#33-required-research-record)
34. [Final Goal](#34-final-goal)

---

## 1. Core Vision

The intended architecture is NOT:

```
One 6.7T model
↓
Split across smartphones
```

The intended architecture is:

```
Many independent ~0.6B models
+
Specialized training
+
Capability-aware routing
+
Master orchestration
+
Distributed memory
+
Fault tolerance
+
Expert collaboration
=
Large distributed intelligence fabric
```

Example:

```
                     USER
                       │
                       ▼
              Heart of Wisdom
               (Master PC)
                       │
                Eye of Wisdom
              (Intelligent Router)
                       │
                  Task Planner
                       │
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
      Math           Coding        General
     Expert           Expert         Expert
        │              │              │
    Smartphone      Smartphone     Smartphone
      Node A          Node B         Node C
        │              │              │
        └──────────────┼──────────────┘
                       ↓
                  Critic Experts
                       ↓
                  Verification
                       ↓
                    Synthesis
                       ↓
                     USER
```

---

## 2. Most Important Concept

Each edge device should not simply be viewed as:

> "a GPU worker"

Instead, treat it as:

> **an independent Expert Node**

An Expert Node contains:

```
Model
+
Capability Profile
+
Hardware Profile
+
Runtime
+
Local KV Cache
+
Health State
+
Network State
```

For example:

```
Node 001
Qwen 0.6B
Role: Mathematics Expert

Node 002
Qwen 0.6B
Role: Coding Expert

Node 003
Qwen 0.6B
Role: Japanese Language Expert

Node 004
Qwen 0.6B
Role: Security Expert
```

The model family may be identical while the specialization differs through fine-tuning, distillation, data selection, or other training methods.

---

## 3. Total Parameters vs Active Parameters

This distinction is fundamental.

Do NOT equate:

```
Total Parameters = Active Parameters
```

The target is:

```
Total Parameters ≈ 6.7T
```

while:

```
Active Parameters = dynamic
```

depending on the request.

Example:

```
Simple question
→ 4–8 Expert Models
→ ~2.4–4.8B active parameters

Moderate task
→ 16–64 Experts
→ ~9.6–38.4B active parameters

Very difficult task
→ 128–512 Experts
→ ~76.8–307.2B active parameters
```

These numbers are illustrative and must be experimentally validated.

Do not assume that more active experts automatically produces better intelligence.

The routing policy must learn when additional computation is useful.

---

## 4. Parameter Scaling Target

A conceptual target:

```
~0.6B parameters × ~11,167 models ≈ 6.7T total parameters
```

This is only a parameter accounting target.

It does NOT mean that 11,167 independent models automatically behave like one 6.7T dense model.

The research problem is precisely:

> Can a large population of specialized small models, when coordinated by ArcAsha, produce capabilities that approach or outperform much larger monolithic models at comparable active compute?

This must be evaluated experimentally.

---

## 5. Existing Model Strategy

Use existing models first.

Do NOT begin by training a 6.7T model from scratch.

The first practical implementation should use small existing models, especially models around:

```
~0.3B
~0.6B
~1B
```

Candidate families may include Qwen-class small models and other permissively licensed models appropriate for research and redistribution.

The first baseline should use a model around:

**~0.6B parameters**

because the main purpose is to verify:

```
Edge device
→ Model
→ ArcAsha Node
→ Master
→ Routing
→ Expert collaboration
```

---

## 6. Expert Specialization

Do not manually assign simplistic labels such as:

```
Model A = Math
Model B = Code
```

and stop there.

Every model must have a **Capability Profile**.

Example:

```json
{
  "model_id": "expert-001",
  "capabilities": {
    "general": 0.86,
    "reasoning": 0.82,
    "mathematics": 0.94,
    "coding": 0.61,
    "japanese": 0.88,
    "english": 0.89,
    "science": 0.79,
    "security": 0.44,
    "creative": 0.71
  }
}
```

Another:

```json
{
  "model_id": "expert-002",
  "capabilities": {
    "general": 0.67,
    "reasoning": 0.80,
    "mathematics": 0.65,
    "coding": 0.97,
    "japanese": 0.60,
    "security": 0.84
  }
}
```

The exact values must eventually come from benchmark measurements rather than arbitrary manual assignment.

---

## 7. Capability Evaluation

Build a Capability Evaluation subsystem.

At model registration time, optionally run:

```
Mathematics Benchmark
Coding Benchmark
Reasoning Benchmark
Japanese Benchmark
English Benchmark
Science Benchmark
Security Benchmark
Long Context Benchmark
Tool-use Benchmark
```

The results become the model's capability profile.

Conceptually:

```
Model
 ↓
Benchmark Suite
 ↓
Capability Evaluation
 ↓
Capability Profile
 ↓
Model Registry
 ↓
Eye of Wisdom
```

This allows new models to be added without manually designing every routing rule.

---

## 8. Task Capability Vector

Every request must be analyzed into a task capability profile.

Example:

User:

> "Implement this algorithm in Rust and prove its complexity."

Task vector:

```json
{
  "coding": 0.91,
  "rust": 0.96,
  "reasoning": 0.84,
  "mathematics": 0.58,
  "general": 0.32
}
```

Another:

> "Analyze this cryptographic implementation for weaknesses."

Task vector:

```json
{
  "security": 0.94,
  "cryptography": 0.91,
  "reasoning": 0.87,
  "coding": 0.70
}
```

The routing system compares task requirements against Expert capabilities.

---

## 9. Routing

The router is not merely a load balancer.

It must consider:

```
Capability Match
+
Model Quality
+
Node Performance
+
Network Latency
+
Bandwidth
+
Node Availability
+
Thermal State
+
Battery State
+
Memory Availability
+
Context Compatibility
+
Cost / Energy
+
Failure Probability
+
Numerical Stability  ← backend + precision divergence risk
```

Conceptual score:

```
RoutingScore =
CapabilityMatch
× ModelQuality
× NodeAvailability
× HardwareFit
× NetworkQuality
× Reliability
× NumericalStability
÷ Cost
```

Where **NumericalStability** is derived from:
- Backend (PyTorch / ONNX / WebGPU)
- Precision (FP32 / BF16 / FP16 / INT8 / INT4)
- Measured divergence rate vs baseline (see EXP-0001.5/1.6/1.7)
- Runtime logit_margin distribution

This enables ArcAsha to distinguish:
- **"Fast but numerically unstable"** nodes → high-throughput, low-precision tasks
- **"Slow but exactly reproducible"** nodes → critical verification, Exact Shadow

See experiments: [`EXP-0001.5`](akasha-master/experiments/qwen3_0.6b/EXP-0001.5/), [`EXP-0001.6`](akasha-master/experiments/qwen3_0.6b/EXP-0001.6/), [`EXP-0001.7`](akasha-master/experiments/qwen3_0.6b/EXP-0001.7/).

The exact formula must be treated as a research variable.

Do not hard-code arbitrary coefficients without experiments.

---

## 10. Master Node

The Master PC is not the primary model.

It is the **brain of the distributed fabric**.

The Master should perform:

```
Task analysis
Expert selection
Node selection
Scheduling
Memory coordination
Context management
Failure management
Result aggregation
Verification
Final synthesis
```

Primary component:

**Heart of Wisdom (Core Orchestrator)**

This is the central control plane.

---

## 11. ArcAsha Naming

Use the following terminology consistently.

```
Heart of Wisdom        (Core Orchestrator)
Eye of Wisdom          (Intelligent Router)
Mandate Weaver         (Task Scheduler)
Star Registry          (Node Registry)
Knowledge Edict        (Binary Wire Protocol)
Realm of Knowledge     (Memory Fabric)
Endless Knowledge      (Long-Context Engine)
Echo                   (Runtime KV Cache)
Shadow of Wisdom       (Shadow Execution)
Divine Safeguard       (Fault Protection)
Wisdom Engine          (LLM Runtime)
Invocation Forge       (Model Loader)
Constellation Mind     (Distributed Mixture-of-Experts)
Future Sight           (Speculative Decoding)
```

The first occurrence in documentation should always include the formal technical name in parentheses.

All source-code identifiers must remain English.

---

## 12. Distributed Expert Model

The system should conceptually support:

```
Expert Pool
├── Mathematics Experts
├── Coding Experts
├── Reasoning Experts
├── Language Experts
├── Science Experts
├── Security Experts
├── Planning Experts
├── Critic Experts
├── Verification Experts
└── General Experts
```

The Expert Pool must be dynamic.

Nodes can:

```
join
leave
become unavailable
change capability
change hardware state
change network state
change model
```

without requiring a complete system restart.

---

## 13. Collaboration Instead of Simple Routing

Do not limit the system to:

```
Prompt → One Model
```

Support:

```
Prompt
 ↓
Planner
 ↓
Expert Selection
 ↓
Parallel Expert Execution
 ↓
Critic
 ↓
Verification
 ↓
Synthesis
 ↓
Final Answer
```

Example:

```
"Create a secure Rust implementation of algorithm X."

Coding Expert
+
Security Expert
+
Algorithm Expert
+
Critic Expert
+
Verifier
+
Final Synthesizer
```

This is a fundamental capability of the long-term architecture.

---

## 14. Active Expert Scaling

The number of participating experts should be dynamically adjustable.

Example:

```
Easy:      2–8 Experts
Moderate:  8–32 Experts
Complex:   32–128 Experts
Extreme:   128–512+ Experts
```

These values are examples only.

The scheduler must eventually learn or infer the appropriate compute budget.

Potential future policy:

```
Task Difficulty
+
Expected Benefit of More Compute
+
Latency Budget
+
Energy Budget
=
Active Expert Count
```

The system should eventually be able to answer:

> "How much distributed computation should this task receive?"

---

## 15. Adaptive Computation

ArcAsha should support a variable-compute model.

For example:

```
Simple prompt
→ small expert subset

Hard reasoning problem
→ larger expert subset

Critical answer
→ expert generation + critic + verification

Agentic task
→ iterative expert execution
```

Do not assume a constant number of experts.

---

## 16. Memory Architecture

Separate these systems completely.

```
Conversation Store
Semantic Memory
Context Pages
Runtime KV Cache
```

Recommended architecture:

```
Realm of Knowledge
(Memory Fabric)
        │
        ├── Chronicle
        │   (Conversation Store)
        │
        ├── Recall Engine
        │   (Semantic Memory)
        │
        ├── Memory Passage
        │   (Context Paging)
        │
        └── Echo
            (Runtime KV Cache)
```

Conversation history must not be stored directly as runtime KV cache.

---

## 17. Long Context

Long-term goal:

**~1M input tokens**

Do NOT implement 1M context by simply forcing every token into permanent GPU KV cache.

Use hierarchical memory:

```
Hot Context
→ active GPU/RAM KV

Warm Context
→ compressed/selected context

Cold Context
→ SSD / object storage / remote memory
```

Support future context paging:

```
GPU
→ Hot pages

RAM
→ Warm pages

SSD
→ Cold pages

Remote ArcAsha Nodes
→ Distributed context pages
```

This should be treated as a future research target, not as an assumed completed feature.

---

## 18. Prefix / KV Reuse

Implement the ability to reuse repeated prefixes.

Conceptually:

```
Prefix Tokens
 ↓
Hash
 ↓
Cache Key
 ↓
Echo Prime
(Prefix KV Cache)
```

Repeated system prompts, documents, or long prefixes should not need to be recomputed unnecessarily.

---

## 19. Model Specialization

Start from existing general-purpose models.

Then create specialized variants through:

```
Fine-tuning
LoRA / QLoRA
Knowledge Distillation
Synthetic Data
Domain Data
Verifier-generated Data
```

Potential specialization categories:

```
Mathematics
Coding
Cybersecurity
Science
Japanese
English
Reasoning
Planning
Verification
Critique
```

The specialization process should be reproducible.

---

## 20. Important Distinction

Do NOT claim:

```
0.6B model × 11,000 = one 6.7T model
```

as a scientific fact.

Instead describe the system as:

> **A distributed expert intelligence fabric with approximately 6.7T aggregate parameters.**

The research challenge is determining how closely its behavior approaches a monolithic model with similar total parameter capacity.

This distinction must be explicit in all documentation.

---

## 21. Research Baselines

The system must eventually compare:

```
Single small model
vs
Multiple identical models
vs
Specialized Expert Pool
vs
Capability-aware Expert Pool
vs
Capability-aware + Node-aware routing
vs
Capability-aware + Node-aware + Fault-aware routing
```

Measure:

```
Accuracy
Reasoning quality
Coding quality
Math quality
Latency
Throughput
p50
p95
p99
Energy
Cost
Network traffic
Failure recovery
Scaling efficiency
```

---

## 22. Scaling Experiments

Build experiments around:

```
1 Expert
4 Experts
16 Experts
64 Experts
256 Experts
1,024 Experts
10,000+ Experts
```

where infrastructure allows.

The goal is to determine:

> Does intelligence improve as the Expert population grows?

And:

> Does the benefit continue after accounting for active compute, communication, and latency?

---

## 23. Fault Tolerance

Edge devices are unreliable.

Assume:

```
Node failure
Network loss
High latency
Battery depletion
Thermal throttling
Background OS load
Temporary unavailability
```

ArcAsha should therefore use:

```
Shadow of Wisdom
Divine Safeguard
Retry
Failover
Health monitoring
Adaptive routing
```

A model should never be selected purely because it is the most capable if its node is unstable.

---

## 24. Smartphone Deployment

A long-term target is:

```
Smartphone A → Expert Model A
Smartphone B → Expert Model B
Smartphone C → Expert Model C
```

with the Master PC controlling them.

The smartphone should act as a genuine ArcAsha Node.

It should expose:

```
Model capability
Available memory
Compute capability
Network state
Battery
Thermal state
Current workload
Latency
```

to the Master.

Privacy and user consent must be explicit for any real-device deployment.

---

## 25. Model Registry vs Node Registry

Keep these separate.

### Model Registry

Describes:

```
Model identity
Architecture
Parameters
Capabilities
Context length
Quantization
License
Performance
Specialization
```

### Star Registry (Node Registry)

Describes:

```
Node identity
Hardware
Location class
Network
Thermal state
Battery
Availability
Loaded model
Current workload
```

The Eye of Wisdom combines both.

---

## 26. Future ArcAsha-native Model

Only after the existing-model Expert Fabric works should an ArcAsha-native model be developed.

Initial target:

```
~160M
```

then:

```
~320M
~1B
larger sparse models
```

The native model should use:

```
Decoder-only Transformer
RMSNorm
RoPE
SwiGLU
GQA
Weight Tying
KV Cache
Quantization support
```

and eventually explore:

```
Activation Compression
Adaptive Precision
Long Context
Hybrid Attention
MoE
Speculative Decoding
```

The native model should be designed specifically for distributed execution.

---

## 27. Ultimate Architecture

The long-term target is:

```
                              USER
                                │
                                ▼
                        Heart of Wisdom
                         (Master PC)
                                │
                         Eye of Wisdom
                        (AI Router)
                                │
                         Task Planner
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
            ▼                   ▼                   ▼
       Realm of Knowledge   Expert Registry     Node Registry
          (Memory)                               (Star Registry)
            │                   │                   │
            └───────────────────┼───────────────────┘
                                │
                         Expert Selection
                                │
       ┌────────────────────────┼────────────────────────┐
       │                        │                        │
       ▼                        ▼                        ▼
  Mathematics              Coding                  Reasoning
   Experts                  Experts                 Experts
       │                        │                        │
   Smartphones              Smartphones              Smartphones
       │                        │                        │
       └────────────────────────┼────────────────────────┘
                                │
                         Critic / Verifier
                                │
                           Synthesis
                                │
                         Wisdom Engine
                                │
                              USER
```

---

## 28. Ultimate Parameter Target

Target aggregate capacity:

**~6.7T parameters**

Potential realization:

```
~0.6B × ~11,167 Experts
```

The exact architecture is not fixed.

The number of experts may differ.

The total may include:

```
General Experts
Reasoning Experts
Coding Experts
Mathematics Experts
Science Experts
Language Experts
Security Experts
Planner Models
Critic Models
Verifier Models
Specialist Models
```

The important property is:

> **The aggregate intelligence capacity is enormous while each individual edge device only needs to host a small model.**

---

## 29. Critical Research Question

The entire project should eventually answer this question:

> **Can a large population of specialized small language models, coordinated by an intelligent distributed runtime, achieve useful frontier-level capabilities without requiring any individual node to host a frontier-scale model?**

Secondary questions:

```
How many experts are needed?
How should experts specialize?
How should experts communicate?
How should active expert count scale?
How much does specialization improve quality?
How much communication overhead is acceptable?
How resilient is the system to node failure?
Does aggregate parameter count correlate with intelligence?
When does adding experts stop being useful?
Can expert diversity outperform simply scaling one model?
```

These questions should drive the experiments.

---

## 30. Implementation Strategy

Do not implement the final 6.7T architecture immediately.

Use progressive milestones.

### Stage 1
One existing ~0.6B model

```
Master + One Node + LLM
```

### Stage 2
Multiple Nodes

```
4–16 Nodes
```

### Stage 3
Multiple specialized models

```
General, Math, Coding, Reasoning
```

### Stage 4
Capability-aware routing

```
Task Vector + Capability Profile + Node State
```

### Stage 5
Expert collaboration

```
Parallel Experts + Critic + Verifier + Synthesis
```

### Stage 6
Dynamic active-compute scaling

```
Easy → few Experts
Hard → many Experts
```

### Stage 7
Hundreds / thousands of Experts

### Stage 8
Long-context / Memory Fabric

### Stage 9
ArcAsha-native Models

### Stage 10
Large-scale distributed intelligence

---

## 31. What NOT to Do

Do not:

```
Assume many models automatically become one model.
Assume parameter count alone determines intelligence.
Treat all models as equally capable.
Treat all Nodes as equally reliable.
Use only round-robin routing.
Store Conversation History as KV Cache.
Force all 1M tokens into GPU memory.
Start by training a massive model.
Hide communication overhead.
Ignore failed experiments.
Claim frontier-level performance without benchmark evidence.
```

---

## 32. Required Engineering Principle

Always separate:

```
Model
Runtime
Node
Network
Memory
Scheduler
Router
Evaluation
```

Do not create a monolithic implementation.

Every component must be independently testable.

---

## 33. Required Research Record

Every experiment must record:

```
experiment_id
git_commit
model_id
model_revision
model_parameters
capability_profile
node_count
active_expert_count
hardware
network
latency
throughput
p50
p95
p99
prompt
input_tokens
output_tokens
network_bytes
memory_usage
energy
failure_events
final_result
```

Experiments must be reproducible.

---

## 34. Final Goal

ArcAsha should ultimately become:

> **An operating system and distributed runtime for assembling many small, specialized, heterogeneous AI models into a single adaptive intelligence fabric.**

The vision is not:

> "Put one huge LLM on every device."

The vision is:

> **"Put a small piece of intelligence on every device, and let ArcAsha turn the collective into something much larger."**

The long-term target is an aggregate intelligence fabric approaching:

**~6.7T total parameters**

while keeping:

**individual edge models small**

and:

**active compute dynamically adjustable.**

The system should be controllable from a Master PC while individual Expert Models run on smartphones, PCs, GPUs, browsers, and other heterogeneous devices.

The ultimate research objective is to determine whether this architecture can produce meaningful advantages in:

```
Capability
Efficiency
Scalability
Fault tolerance
Cost
Energy
Availability
Long-context reasoning
```

without requiring a single machine to possess the entire model.

Do not assume the hypothesis is true.

**Build the system, instrument it, benchmark it, and let the measurements determine whether the hypothesis holds.**
