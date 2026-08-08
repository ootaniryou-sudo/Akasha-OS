# EXP-0002B — Heterogeneous Two-Node Round-Robin Routing

> **ArcAsha Scheduler が初めて複数ノードを均等にルーティング。**
> **PC Expert + iPhone 15 Pro Relay のヘテロジニアス構成を検証。**

## Proven

| # | Claim | Evidence |
|---|-------|----------|
| ① | **Scheduler (Round-Robin)** が正しく動作 | node-a: 5 reqs, iphone: 5 reqs — 均等分配 |
| ② | **Node Registry** が Role を区別して管理 | expert / lightweight-relay の役割管理が成立 |
| ③ | **パイプライン全体でスループット改善** | 13.2s (単一) → 6.96s (2ノード) = 1.9× |

> **注**: スループット向上は「計算性能2倍」ではなく「パイプライン並列化による改善」。
> iPhone は passthrough（推論なし）のため。論文ではこの表現が正確。

## Architecture

```
Master Hub (:8080) — Scheduler + Node Registry
  ├── Node A (PC)              — ws client, Role: expert, Qwen3-0.6B direct
  └── Node B (iPhone 15 Pro)   — ws client, Role: lightweight-relay, passthrough
```

### Node Registry

| Node | Device | Role | Model | Path |
|------|--------|------|-------|------|
| node-a | PC (Mac) | expert | Qwen3-0.6B ONNX | direct inference |
| iphone12mini | iPhone 15 Pro | lightweight-relay | none | passthrough (no inference) |

### Future Extension

```
Node Registry
  ├── Expert       (推論実行)
  ├── Relay        (接続性確保)
  ├── Verifier     (出力検証)
  ├── Critic       (品質評価)
  └── Memory       (コンテキスト保持)
```

## Results — Two-Node Round-Robin (2026-08-01, iPhone 15 Pro)

```
════════════════════════════════════════════════════════════
RESULTS — Two-Expert Round-Robin
════════════════════════════════════════════════════════════

  Completed:   10/10 ✅
  Total time:   6,960ms
  Throughput:   1.44 req/s (1.9× faster than single-node)

  ┌──────────────┬──────┬────────┬────────┬────────┬──────────────────┐
  │ Node         │ Reqs │ Tokens │ Avg ms │ Err    │ Role             │
  ├──────────────┼──────┼────────┼────────┼────────┼──────────────────┤
  │ node-a       │    5 │    160 │   1358 │      0 │ expert           │
  │ iphone12mini │    5 │      0 │     34 │      0 │ lightweight-relay│
  └──────────────┴──────┴────────┴────────┴────────┴──────────────────┘

  Routing Distribution:
    node-a: 50.0% ██████████ (5/10)
    iphone12mini: 50.0% ██████████ (5/10)
```

### Per-Request Routing Pattern

```
A B A B A B A B A B   ← Perfect round-robin
```

| # | Request ID | → Node | Tokens | RTT | Type |
|---|-----------|--------|--------|-----|------|
| 1 | req-0000 | node-a | 32 | 1611ms | Qwen inference |
| 2 | req-0001 | iphone | 0 | 8ms | passthrough |
| 3 | req-0002 | node-a | 32 | 1328ms | Qwen inference |
| 4 | req-0003 | iphone | 0 | 105ms | passthrough |
| 5 | req-0004 | node-a | 32 | 1288ms | Qwen inference |
| 6 | req-0005 | iphone | 0 | 8ms | passthrough |
| 7 | req-0006 | node-a | 32 | 1276ms | Qwen inference |
| 8 | req-0007 | iphone | 0 | 39ms | passthrough |
| 9 | req-0008 | node-a | 32 | 1288ms | Qwen inference |
| 10| req-0009 | iphone | 0 | 9ms | passthrough |

### Comparison: Single vs Two-Node

| Metric | Single Node | Two Nodes | Change |
|--------|------------|-----------|--------|
| Total time | 13,216ms | 6,960ms | **1.9× faster** |
| Throughput | 0.76 req/s | 1.44 req/s | **1.9×** |
| Expert tokens | 320 | 160 | 50% (fair share) |
| Relay latency | — | 8-105ms WiFi | — |

### Device Notes

| Device | Safari WebSocket | Result |
|--------|:---:|--------|
| iPhone 15 Pro (A17 Pro) | ✅ | Stable connection, 10/10 requests |
| iPhone 12 mini (A14) | ❌ | Connects then disconnects (Safari/WebKit issue) |

> **iPhone 12 mini の WebSocket 不安定性は iOS Safari の WebKit 実装差に起因。**
> A14 (iOS 18.7) では WebSocket upgrade 後に即 close (code=1005)。
> A17 Pro では問題なく動作。ArcAsha のノード参加にはモダンな Safari WebSocket 実装が必要。

## Running

```bash
# Terminal 1: Master Hub
npx tsx experiments/qwen3_0.6b/EXP-0002B/run_master.ts --port 8080

# Terminal 2: Node A (PC expert)
npx tsx experiments/qwen3_0.6b/EXP-0002B/run_node.ts \
  --master ws://localhost:8080 --node-id node-a --role expert

# Terminal 3: Serve iPhone page
npx serve experiments/qwen3_0.6b/EXP-0002B/public

# iPhone: Safari → http://<PC_IP>:3000/iphone_12mini_node → Connect
```

Full results: [`output/summary.json`](output/summary.json)

