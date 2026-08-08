# AI Evaluation — 方式比較 / Fault スケーリング / ODAR 強化 / AI OS Monitor

> **「ArcAsha が他方式より優れていることを証明する」フェーズ（Phase 2.0 / 2.1 / 2.2 / 3.0）**

| 項目 | 値 |
|------|-----|
| Status | **Phase 2.0（比較・実験）✅ / 2.1（Monitor）✅ / 2.2（ODAR強化）✅ / 3.0（Expert 10種）✅** |
| Date | 2026-08-05 |
| 実装 | `src/arcasha/ailsm/comparison.ts`, `experiment.ts`, `learning.ts`（強化）, `driver.ts`（10種）, `public/aios-monitor.html` |
| 関連 | `ARCASHA_V2_SPEC.md`, `AI_RUNTIME_PHASE1.md`, `AI_OBSERVABILITY.md`, `AI_VIRTUAL_MEMORY.md` |

---

## Phase 2.0 — 方式比較（論文 Table 1 相当）

`comparison.ts` — ArcAsha AVM を既存 6 方式と比較（context = 1M tokens）。ArcAsha の比率は実ベンチ（200p × 10問）から推定。

| 方式 | 読むトークン | 読む割合 | Latency(ms) | Cost | Accuracy | 備考 |
|------|-------------|---------|-------------|------|----------|------|
| RAG (Top-k) | 80,000 | 8% | 4,040 | 0.02 | 0.85 | 検索 + 上位チャンクだけ |
| MoE (Top-2) | 200,000 | 20% | 10,015 | 0.08 | 0.92 | 専門ルーターで 2/10 だけ |
| **ArcAsha AVM (Ours)** | **229,000** | **23%** | **12,187** | 0.10 | **0.90** | **必要ページだけ読む** |
| KV Cache | 300,000 | 30% | 15,020 | 0.15 | 0.90 | キャッシュ + 差分だけ |
| Qwen Long Context | 1,000,000 | 100% | 50,000 | 1.00 | 1.00 | 全トークンを読む |
| MCP (全ツール) | 1,000,000 | 100% | 50,050 | 1.20 | 0.88 | 全ツール接続 |
| Agent (全ツール) | 1,200,000 | 120% | 60,060 | 1.80 | 0.88 | ループで何度も読む |

- **全読方式（Qwen / MCP / Agent）と比べて 4 倍以上高速**
- RAG より少ないトークンではないが **精度が高い（0.90 vs 0.85）** — 「読む量 × 精度」のトレードオフが本質
- 論文化: この表 + 実機レイテンシ（iPhone/iPad）で一本の論文になる

## Phase 2.0 — Fault スケーリング実験（論文 Figure 相当）

`experiment.ts` — 100 → 5000 ページで Fault / TLB / Tier / Latency を測定。

| Pages | Tokens | Loaded | Token削減 | ページロード率 | Fault率 | TLB Hit | Speedup |
|------:|-------:|-------:|----------:|---------------:|--------:|--------:|--------:|
| 100 | 16,000 | 3,744 | 76.6% | 23.4% | 23.5% | 76.5% | 3.46x |
| 500 | 80,000 | 18,288 | 77.1% | 22.9% | 23.7% | 76.3% | 3.54x |
| 1000 | 160,000 | 36,608 | 77.1% | 22.9% | 23.7% | 76.3% | 3.53x |
| 5000 | 800,000 | 182,896 | 77.1% | 22.9% | 23.7% | 76.3% | 3.53x |

**重要な発見**: Token削減 77%・Speedup 3.5x が **100 ページから 5000 ページまで完全に安定**。
→ コンテキストが大きくなるほど有利（メモリ階層の設計がスケールする）ことを示す。

## Phase 2.1 — AI OS Monitor

`public/aios-monitor.html` + `demo-web.ts`（`/api/monitor`・`/monitor`）

Linux の top / htop / perf / systemd-analyze 全部入り:

- **Live Pipeline**: Task → Compiler → AILSM → Kernel → Scheduler → CALL → iPhone → RETURN → Memory をリアルタイムでアニメーション
- **Device Tree**: 接続実機（Mac / iPhone / iPad）を表示
- **ODAR Capability Learner**: 精度・レイテンシ・成功率のバー表示
- **Recent Executions**: 実行履歴
- **Benchmark**: 方式比較 + Fault スケーリング表

`http://localhost:4173/monitor` で閲覧（コンソールからリンクあり）。

## Phase 2.2 — ODAR マルチシグナル学習

`learning.ts` — EMA で学ぶシグナルを拡張:

| シグナル | 意味 |
|---------|------|
| accuracy | 正解率・成功確率 |
| latencyMs | レイテンシ |
| cost | コスト |
| success | 実行成功 / 失敗 |
| battery | デバイス残量 |
| gpu | GPU 使用率 |

`score()` は「精度 × 成功率 × 残量 × GPU空き」/「レイテンシ + コスト」で計算。
ODAR が「今日は iPad の方が速い」「この Expert は最近失敗が多い」を学習する。

## Phase 3.0 — 専門 Expert 10 種

`driver.ts` / `expert-runtime.ts` — MockExpertDriver を 10 種に拡張:

```
math / search / programming / vision / planning / translate / summarizer / retriever / reasoning / memory
```

10 Expert リレー（Planner→Search→Math→Reasoning→Programming→Translate→Planner）が全ホップ成功。

---

*次のステップ: 実機データの蓄積（ODAR が実測で学習）→ 論文の Table/Figure 完成*
