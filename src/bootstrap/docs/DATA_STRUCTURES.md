# Akasha Bootstrapper — データ構造解説

> `src/bootstrap/akasha-bootstrapper.ts` — 数万台の端末が同時起動しても自己DoS しないための
> ブート/自動検出エンジン。**登録ホットパスでヒープ割当・ソート・文字列整形を行わない**設計。

## 設計原則

- 全ての構造は **intrusive (侵入型) doubly-linked list** + **ObjectPool** で管理。
- 接続ハンドラは「プール済み ctx を FIFO 末尾へ splice」するだけ → O(1), 割当なし。
- スケジューラが毎秒 ≤ `maxPerSec` 件だけ BENCHMARK へ昇格 (トークンバケット)。
- ステータスは ctx 自体に載せる (phase / role / aps) — 並列ステータスオブジェクトなし。

## 主要データ構造 (5 + 2)

| # | 構造 | 型 | 用途 | 操作 |
|---|------|----|------|------|
| 1 | `unevaluatedQ` | `DoublyLinkedList<BootstrapCtx>` (intrusive) | 未評価接続の FIFO。接続ハンドラは tail へ splice | enqueue O(1) / スケジューラが head を pop |
| 2 | `inflightBench` | `Map<string, BootstrapCtx>` (nodeId → ctx) | BENCHMARK 送信中 (BENCHMARKING) のノード待機表 | RESULT 受信で O(1) 参照 |
| 3 | `topology[segment]` | `Map<number, DoublyLinkedList<BootstrapCtx>>` | 同じ物理ハブ (segment) に乗るノード群。IPv4 をビット演算で (rack, hub) に縮約 | attach/detach O(1) splice |
| 4 | `byRole[role]` | `Map<NodeRole, DoublyLinkedList<BootstrapCtx>>` | 任命済みアイドルノードの 3 本リスト (CORE_ROUTER / ACTIVE_COMPUTE / SHADOW_BACKUP) | ディスパッチ O(1) pop |
| 5 | `nodes` | `Map<string, BootstrapCtx>` (nodeId → ctx) | 生存レジストリ。ctx は切断までプールから checkout されたまま | get/bind/delete |
| 6 | `bySlot` | `Map<number, BootstrapCtx>` (socketSlot → ctx) | 接続ハンドラが O(1) で ctx を引くための逆引き | 接続/切断で set/delete |
| 7 | (プール) | `ctxPool` / `linkPool` / `bufPool` | BootstrapCtx / DLL ノード / 送信バッファの再利用 | acquire/release |

## BootstrapCtx (1 接続 = 1 プール済み ctx)

```
BootstrapCtx {
  socketSlot, nodeId, ipU32,
  rack, hub, host, packed, segment,   // トポロジ座標 (IPv4 由来)
  phase (QUEUED|BENCHMARKING|ASSIGNED|FAILED|DISCONNECTED),
  role, clusterId, layerBand, aps, gpuUs, rttUs, benchSentUs, enqueuedAtMs,
  qLink / topoLink / roleLink,          // 各侵入型リストへの DLL リンク (O(1) detach)
}
```

リンク (qLink / topoLink / roleLink) を ctx が保持することで、どのリストにも O(1) で
splice/remove でき、状態同期が不要になる。

## ステータスビットと失敗理由

- `BootstrapPhase`: QUEUED=0 / BENCHMARKING=1 / ASSIGNED=2 / FAILED=3 / DISCONNECTED=4
- 失敗理由 (onEvent `failed` の reason):
  | reason | 意味 |
  |---|---|
  | 1 | FAIL_TIMEOUT (キュー TTL 超過 / ベンチマーク応答タイムアウト) |
  | 2 | FAIL_BAD_RESULT (GPU µs が 0 または非現実的 / nodeId 不整合) |
  | 3 | FAIL_DISCONNECT (ソケット切断) |
  | 4 | FAIL_BAD_REGISTER (未登録ソケットからの REGISTER — 状態を作らない) |
  | 5 | FAIL_DUP_REGISTER (同一 nodeId の別ソケット重複登録 — 先の所有者を追い出す) |

## 堅牢性 (未登録ノード処理)

- 未登録 (nodeId=0n) のノードは `tick()` で **BENCHMARK に昇格させず末尾へ再エンキュー**。
  TTL 超過で FAIL_TIMEOUT。スキャン上限 (`perTick × 3 + 1`) で飢餓を防止。
- 未知ソケットからの REGISTER は **状態を作らず** `failed(FAIL_BAD_REGISTER)` を発火。
- 同一 nodeId の二重登録は **先行所有者を FAIL_DUP_REGISTER で追い出してから再束縛** —
  1 nodeId = 1 生存 ctx を保証 (inflightBench/byRole の汚染を防止)。
- 冪等な再 REGISTER (同一ソケット・同一 nodeId) は no-op。
