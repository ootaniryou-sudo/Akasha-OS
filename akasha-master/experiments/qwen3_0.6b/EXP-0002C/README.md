# EXP-0002C — Capability-Aware Routing

> **Phase 3: Intelligent Routing の最初の実験。**
> **事前定義された Capability Profile に基づき、Router が期待どおりのノード選択を 100% の精度で行えることを確認。**

## Proven

| # | Claim | Evidence |
|---|-------|----------|
| ① | **Routing Accuracy = 100%** | 8/8 non-general prompts routed to correct capability node |
| ② | **Capability-aware selection** | coding → node-coding (0.95), math → node-math (0.94) |
| ③ | **Tie-break fallback** | general prompts (both score=0.8) → round-robin |
| ④ | **知的ルーティングの骨格が成立** | Prompt → Classify → Select → Execute の全段が動作 |

## Terminology (重要)

| Term | Definition | This Experiment |
|------|-----------|:---:|
| **Routing Accuracy** | Router が事前定義 Profile に従って正しいノードを選べた割合 | **100%** |
| **Task Classification Accuracy** | LLM 自身の能力を正確に分類できた割合 | **未検証** |

> **今回の 100% は「Router の分類精度」であり、「LLM 自身の能力を 100% 分類した」という意味ではない。**
> Capability は固定の事前設定値。論文ではこの2つを明確に区別する必要がある。

## Results (2026-08-01)

```
Routing Accuracy: 100.0% (8/8 non-general)

  coding  : 100% ███████████████ (4/4 → node-coding)
  math    : 100% ███████████████ (4/4 → node-math)
  general : tie-break round-robin (2/2, both score=0.8)

  ┌──────────────┬──────┬────────┬──────────────────────┐
  │ node-coding  │    5 │    160 │ coding:4 general:1   │
  │ node-math    │    5 │    160 │ math:4 general:1     │
  └──────────────┴──────┴────────┴──────────────────────┘

  Routing Methods: 8 capability-match + 2 tie-break (RR)
  Total: 15,007ms, 0.67 req/s (sequential, single-model per node)
```

## Architecture

```
Prompt
  │
Capability Detection (keyword classifier MVP)
  │
CapabilityScheduler (selectBestNode by score)
  │
Node Selection
  │
Expert (Qwen3-0.6B)
```

### Components

| Component | Role | Implementation |
|-----------|------|---------------|
| CapabilityRegistry | ノードの能力スコアを保持 | Map<nodeId, capabilities> |
| PromptClassifier | プロンプトを capability domain に分類 | Keyword match (MVP) |
| CapabilityScheduler | 最適ノードを選択 | Max capability score |
| Tie-break | 同点時のフォールバック | Round-Robin |

## Current Limitation → Next

| Limitation | Next Experiment |
|-----------|----------------|
| Capability が固定の事前設定値 | **EXP-0002D**: Measured → Adaptive Profile |
| キーワード分類のみ | 今後: LLM-based classifier, embedding similarity |
| Capability のみの単一軸 | **EXP-0002E**: Latency + Stability + Cost の複合スコア |
| 単一 Expert の出力をそのまま使用 | **EXP-0002F**: Shadow Expert による検証 |

## Running

```bash
# Terminal 1: Master Hub
npx tsx experiments/qwen3_0.6b/EXP-0002C/run_master.ts --port 8080

# Terminal 2: Coding Expert
npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts \
  --master ws://localhost:8080 --node-id node-coding \
  --capability '{"coding":0.95,"math":0.65,"general":0.80}'

# Terminal 3: Math Expert
npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts \
  --master ws://localhost:8080 --node-id node-math \
  --capability '{"coding":0.62,"math":0.94,"general":0.80}'
```

Full results: [`output/summary.json`](output/summary.json)
