# Akasha-Master — Orchestrator Core

> TypeScript マスターオーケストレーター。アーカーシャOSの脳。

This is the **Layer 3** component of [Akasha-OS](../README.md).  
See the [root README](../README.md) for the full project vision and architecture.

## Quick Start

```bash
npm install
npm run build
npm run dev        # Start on :8080
npm run sim        # Run demo simulation
npm run selftest   # Self-diagnostic test
```

## Module Map

| Module | Path | Purpose |
|--------|------|---------|
| Bootstrapper | `src/bootstrap/` | Connection throttling, IP topology, APS benchmark, auto role assignment |
| Orchestrator | `src/core/orchestrator.ts` | Worker lifecycle, prompt submission |
| Inference Loop | `src/core/inference-loop.ts` | Token pipeline, P2P relay, shadow racing |
| Fault Tolerance | `src/fault/` | Deadline monitoring, automatic failover, semantic routing |
| Plugin System | `src/plugin/` | `AkashaExpertPlugin` interface, hot-plug registry |
| Idle Pool | `src/structures/` | O(1) node acquisition, intrusive DLL |
| Ring Buffer | `src/ipc/` | Lock-free SPSC IPC over SharedArrayBuffer |
| Binary Codec | `src/binary/` | 48-byte header + Float32Array codec |
| Network Worker | `src/workers/network-worker.ts` | WebSocket I/O |
| Router Worker | `src/workers/router-worker.ts` | Semantic dispatch + fault tolerance loop |

## Protocol

See [`PROTOCOL.md`](PROTOCOL.md) for the binary wire format specification.

---

