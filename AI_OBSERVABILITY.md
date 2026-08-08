# AI Observability Specification

> **aiperf / AI Trace / AI Profiler / AI Benchmark — AI OS の計測器（CPU の perf / top / vmstat / htop 相当）**

| 項目 | 値 |
|------|-----|
| Status | **Spec v0.1（Phase 0.23 実装済み）** |
| Date | 2026-08-05 |
| 実装 | `src/arcasha/ailsm/perf.ts`, `trace.ts`, `profiler.ts`, `benchmark.ts`, `observability.ts` |
| 関連 | `ARCASHA_V2_SPEC.md`, `AI_VIRTUAL_MEMORY.md`, `AILSA_RUNTIME.md`, `AILSM_IR.md` |

---

## 0. 動機

「OS を増やすより計測器を増やす」。設計・実行に加えて **計測・評価まで一貫した AI システム基盤** にする。論文でも非常に強い武器になる 4 点。

## 1. AI Performance Monitor（aiperf）

`perf.ts` — `AiPerf`。CPU の perf / top / vmstat / htop に相当する標準メトリクス:

| メトリクス | 説明 |
|-----------|------|
| **Context Fault Rate** | ページ要求のうち Fault した割合（`faults / pageRequests`） |
| **TLB Hit Rate** | Context 翻訳キャッシュの効率（2回目以降は Fault しない） |
| **Memory Tier 使用率** | HOT / WARM / COLD のページ数 |
| **CALL 統計** | Expert ごとの呼び出し回数・時間 |
| **Expert 利用率** | 全 CALL 時間に占める割合（%） |

```
=== aiperf ===
Page Requests : 458
Context Faults: 108 (23.6%)
TLB Hit Rate  : 76.4%
Memory Tier   : HOT=108 WARM=0 COLD=0
CALL          :
  planning     3回    228ms   48%
  math         5回    134ms   28%
  search       3回  108.8ms   23%
```

## 2. AI Trace

`trace.ts` — `AiTrace`。**Chrome Trace 互換**（`{ traceEvents: [...] }` → chrome://tracing / Perfetto で可視化）。LLVM / TensorBoard に相当。

- **Runtime Timeline**: input → compile → process → thread → belief → capability → schedule → call → wait（1 ステップ = 1ms）
- **Scheduler Timeline**: SPAWN / CALL / RETURN / WAIT...（プロセス別）

```
Timeline
  0.0ms input (1.0ms)
  1.0ms compile (1.0ms)
  2.0ms process (1.0ms)
  7.0ms call (1.0ms)
```

## 3. AI Profiler

`profiler.ts` — `AiProfiler`。どこが一番時間を食っているか:

- **Hot Expert**（最も時間を消費した Expert）
- **Hot Context**（最もアクセスされた Context）
- **Hot Pages**（アクセス回数上位）
- **Fault Hotspot**（Fault が集中するページ）

## 4. AI Benchmark

`benchmark.ts` — Long Context 比較。

```
Qwen（全トークンを読む）  vs  ArcAsha（Page Fault で必要ページだけ読む）

baselineMs = 全トークン × PER_TOKEN_MS
arcashaMs  = ロードトークン × PER_TOKEN_MS + Fault 数 × FAULT_MS
```

**ベンチ結果（200 ページ × 10 質問）**:

| 指標 | 値 |
|------|-----|
| Token 削減率 | **77.1%** |
| ページロード率 | **22.9%** |
| Context Fault Rate | 23.6% |
| TLB Hit Rate | 76.4% |
| Speedup | **3.53x** |

## 5. Observability 統合デモ

`observability.ts` — `runObservabilityDemo()` で 4 つを一体化。

---

*計測器が揃うと、ArcAsha は「設計・実行・計測・評価まで一貫した AI システム基盤」として完成度が一段上がる。*

