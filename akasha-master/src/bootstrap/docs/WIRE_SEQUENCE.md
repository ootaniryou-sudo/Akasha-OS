# Akasha Wire Protocol — 通信シーケンス解説

> `src/binary/protocol.ts` (48 バイト固定ヘッダ, バイナリ) と
> `src/bootstrap/akasha-bootstrapper.ts` (ブート/役割任命) のやり取りを図解。

## ヘッダ (48B)

```
┌────────┬──────┬──────────────────────────────────────┐
│ Offset │ Size │ Field                                │
├────────┼──────┼──────────────────────────────────────┤
│ 0      │ 4    │ MAGIC          u32 BE  0x414B5348    │
│ 4      │ 1    │ VERSION        u8                    │
│ 5      │ 1    │ COMMAND        u8      Cmd           │
│ 6      │ 2    │ FLAGS          u16 LE                │
│ 8      │ 8    │ TX_ID          u64 LE                │
│ 16     │ 8    │ NODE_ID        u64 LE                │
│ 24     │ 4    │ CLUSTER_ID     u32 LE                │
│ 28     │ 4    │ PAYLOAD_LEN    u32 LE                │
│ 32     │ 8    │ TIMESTAMP_US   u64 LE                │
│ 40     │ 4    │ EXPECTED_US    u32 LE  timeout/GPU µs │
│ 44     │ 4    │ SEQ            u32 LE                │
│ 48     │ N    │ PAYLOAD        Float32Array          │
└────────┴──────┴──────────────────────────────────────┘
```

## ブートシーケンス (Bootstrap)

```
 Edge                          Master (AkashaBootstrapper)
 ────                          ────────────────────────────
 WS connect ────────────────► enqueueConnection()
                                - ctx をプールから checkout, トポロジ座標算出
                                - unevaluatedQ tail へ splice (O(1), ベンチなし)
 REGISTER (Cmd=0x01) ──────► bindRegister(slot, nodeId)
        ◄────────────────────── BENCHMARK (Cmd=0x08)   [スロットル ≤ maxPerSec/s]
                                payload = f32 probe tensor (256)
                                TIMESTAMP_US = 送信時刻
 RESULT (Cmd=0x04) ────────► onBenchmarkResult(nodeId, gpuUs)
   expectedUs = GPU µs           APS = 1000 / (gpuMs + RTT/2)
        ◄────────────────────── ASSIGN (Cmd=0x09)
                                clusterId + role(seq) + layerBand(flags)
 ACK (optional) ────────────► ASSIGNED → runtime IdleClusterPool へ
```

- **未登録ノード** (REGISTER 未着) は BENCHMARK へ昇格しない (末尾へ再エンキュー)。
- 失敗経路: キュー TTL 超過 / ベンチ応答タイムアウト → `failed(FAIL_TIMEOUT)`
  GPU µs 不正 / nodeId 不整合 → `failed(FAIL_BAD_RESULT)`

## 実行時シーケンス (Inference)

```
 Edge A (head)                   Master                 Edge B (tail)
 ──────────                      ──────                 ──────────
 COMPUTE_TASK (0x03) ─────────►
        ◄──────────────────────── RELAY (0x0a) ────────►
                                 (inter-band 活性中継, P2P or master-proxied)
                                        ◄─────────────── TOKEN_OUT (0x0b)
                                                          (tail band → トークン出力)
```

- `Flag.SHADOW` (1<<0): シャドウ/フェイルオーバーレプリカ
- `Flag.FINAL` (1<<1): パイプライン最終ホップ
- `Flag.URGENT` (1<<2): 緊急 (高優先)

## ライフサイクル

```
 connect → QUEUED → REGISTER → BENCHMARKING → ASSIGNED → (実行時) → DEREGISTER / 切断
                     ↑             │              │
                     └── 再 REGISTER (冪等)        └── シャドウ移行 (FAILOVER 0x05) 等
```

- HEARTBEAT (0x02): 生存確認
- DEREGISTER (0x07): 正常離脱 (ctx をプールへ release)
- FAILOVER (0x05): 障害時にシャドウノードへ引き継ぎ

## 堅牢性ルール

1. REGISTER は必ず BENCHMARK より先。未知ソケットからの REGISTER は拒否 (FAIL_BAD_REGISTER)。
2. 1 nodeId = 1 生存ソケット。重複 REGISTER は先行所有者を追い出す (FAIL_DUP_REGISTER)。
3. RESULT の EXPECTED_US はエッジ報告の GPU µs。RTT は TIMESTAMP_US エコーからマスター側で算出。
4. データプレーンはバイナリ固定ヘッダ (JSON 禁止)。48B ヘッダ + f32 ペイロードは
   WebGPU アップロード用にゼロコピー可能。
