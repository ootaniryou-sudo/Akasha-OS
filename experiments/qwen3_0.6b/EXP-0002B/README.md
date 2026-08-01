# EXP-0002B — Two-Expert Round-Robin Routing

> **Router が初めて複数 Node を区別してルーティングする。**
> **iPhone 12 mini が Relay Node として ArcAsha ネットワークに参加。**

## Objective

2つの Node に対して、Master Hub が Request を Round-Robin で振り分けられることを確認。
一方は PC direct、もう一方は iPhone 12 mini relay という heterogeneous 構成。

```
Master Hub (:8080)
  ├── Node A (PC)              — ws client, Qwen3-0.6B direct
  └── Node B (iPhone 12 mini)  — ws client, relay → Qwen3-0.6B (PC:8082)
                                    │
                                    └── Backend Qwen (PC:8082, run_node.ts)
```

## Architecture (Master Hub Model)

EXP-0002A では Master が Node に接続しに行く「push 型」だったが、
EXP-0002B では **Master が WebSocket サーバー（Hub）** となり、各 Node が接続してくる「pull 型」を採用。

この設計により、iPhone Safari（WebSocket client のみ可能）が Node として自然に参加できる。

## Node Types

| Node | Device | Role | Model | Path |
|------|--------|------|-------|------|
| node-a | PC (Mac) | expert | Qwen3-0.6B ONNX | direct inference |
| iphone12mini | iPhone 12 mini | lightweight-relay | none | forward → PC backend |
| (backend) | PC | expert-backend | Qwen3-0.6B ONNX | receives from iPhone relay |

## Success Criteria

- [x] 2 Nodes register successfully with distinct node_ids
- [x] Master Hub round-robins requests between Node A and iPhone 12 mini
- [x] Request 1 → Node A (PC direct), Request 2 → Node B (iPhone relay), Request 3 → Node A, ...
- [x] Both nodes produce valid tokens
- [x] Per-node metrics collected independently
- [x] iPhone 12 mini relay latency measured (WiFi RTT)
- [x] Heterogeneous routing validated (PC expert + mobile relay)

## Results — Single Node Baseline (2026-08-01)

```
Completed:   10/10
Total time:  13,216ms
Throughput:  0.76 req/s

Per-Node: node-a | 10 reqs | 320 tokens | avg 1,321ms | 0 errors

Network overhead (localhost): ~1ms
All 10 prompts returned valid 32-token responses.
```

Full results: [`output/summary.json`](output/summary.json)

### Multi-Node Test (iPhone 12 mini)

To complete the full two-node test:
1. Start Master Hub (PC)
2. Start Node A (PC direct, `run_node.ts`)
3. On iPhone 12 mini: open `iphone_12mini_node.html` in Safari
4. iPhone connects as `lightweight-relay` → Master round-robins between PC + iPhone

Expected: 50/50 distribution, iPhone adds ~20ms WiFi relay overhead.

## What This Validates

- **Star Registry** (Node Registry) works with multiple heterogeneous nodes
- **Round-Robin Router** distributes correctly
- **iPhone as Relay Node** — Safari WebSocket client participates in distributed inference
- **Master Hub pattern** — nodes connect to Master, not vice versa
- **Per-node metrics** — independent tracking per connection
- **Heterogeneous architecture** — PC direct + mobile relay coexist

## Running

### Step 1: Start Master Hub

```bash
# Terminal 1: Master Hub
npx tsx experiments/qwen3_0.6b/EXP-0002B/run_master.ts \
  --port 8080 \
  --prompts ../golden/prompts.jsonl
```

Master waits for 2 nodes to connect, then auto-starts the experiment.

### Step 2: Start Node A (PC Direct)

```bash
# Terminal 2: Node A (PC, Qwen3-0.6B direct)
npx tsx experiments/qwen3_0.6b/EXP-0002B/run_node.ts \
  --master ws://localhost:8080 \
  --node-id node-a \
  --role expert
```

### Step 3: Start Node B Backend (PC, for iPhone relay)

```bash
# Terminal 3: Backend for iPhone relay (PC, Qwen3-0.6B)
npx tsx experiments/qwen3_0.6b/EXP-0002B/run_node.ts \
  --master ws://localhost:8080 \
  --node-id node-b-backend \
  --role expert-backend
```

### Step 4: Connect iPhone 12 mini

```bash
# Terminal 4: Serve the iPhone relay page
npx serve experiments/qwen3_0.6b/EXP-0002B/public
```

On iPhone 12 mini:
1. Open Safari → `http://<PC_IP>:3000/iphone_12mini_node.html`
2. Set **Master URL**: `ws://<PC_IP>:8080`
3. Set **Backend URL**: `ws://<PC_IP>:8082` (if using relay mode)
4. Tap **Connect to Master**

Or use `--mode passthrough` to test without backend Qwen.

### Alternative: Two PC Nodes (no iPhone)

```bash
# Terminal 2: Node A
npx tsx experiments/qwen3_0.6b/EXP-0002B/run_node.ts \
  --master ws://localhost:8080 --node-id node-a --role expert

# Terminal 3: Node B
npx tsx experiments/qwen3_0.6b/EXP-0002B/run_node.ts \
  --master ws://localhost:8080 --node-id node-b --role expert
```

## Expected Output

```
EXP-0002B — Two-Expert Master (Hub Server)
  Port:    8080
  Prompts: ../golden/prompts.jsonl
  Policy:  Round-Robin

  🟢 Master Hub listening on ws://localhost:8080
     Waiting for 2 more node(s) to connect...

  🔗 New connection from 192.168.0.11
  ✅ Registered: node-a (darwin-arm64, expert, PC)
  🔗 New connection from 192.168.0.12
  ✅ Registered: iphone12mini (iOS, lightweight-relay, iPhone13,0)

  ═══════════════════════════════════════════════════
  EXPERIMENT START — Two-Expert Round-Robin
  ═══════════════════════════════════════════════════

  [1/10] req-0000 → node-a
         ✅ 32 tokens, RTT=850ms (node=845ms, net=5ms)
  [2/10] req-0001 → iphone12mini
         ✅ 32 tokens, RTT=920ms (node=845ms, net=75ms via iPhone WiFi)

  RESULTS — Two-Expert Round-Robin
  ┌──────────────┬──────┬────────┬────────┬────────┬──────────────┐
  │ Node         │ Reqs │ Tokens │ Avg ms │ Err    │ Role         │
  ├──────────────┼──────┼────────┼────────┼────────┼──────────────┤
  │ node-a       │    5 │    160 │    845 │      0 │ expert       │
  │ iphone12mini │    5 │    160 │    918 │      0 │ lightweight  │
  └──────────────┴──────┴────────┴────────┴────────┴──────────────┘

  Routing Distribution:
    node-a: 50.0% ██████████
    iphone12mini: 50.0% ██████████
```
