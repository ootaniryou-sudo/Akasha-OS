# ArcAsha v0.1 — Observation-Driven Controller

検証済み研究パイプライン (EXP-0003C.1 → 0003F) を **内部エンジン** として実装した
自律型マルチエキスパートコントローラ。論文 (Zenodo DOI 10.5281/zenodo.21755612) は
凍結済み。本モジュールはその検証結果を製品コードに落とし込む Phase 5 の実装。

> 📐 **統一理論**: [`FRAMEWORK.md`](FRAMEWORK.md) — Observation→Belief→Confidence→Features→
> LinUCB-Shadow→Planner→Verifier→Memory を数式レベルで統合した ArcAsha Framework。
> 「なぜこの設計になるのか」の形式的根拠 (設計原理 P1-P5 + 命題 Prop.1-4)。

## アーキテクチャ

```
                 ┌────────────────────────────────────────────┐
   Task ───────► │ Planner (EXP-0005A)                         │
                 │   ルール/LLM でサブタスクに分解              │
                 └──────────────┬─────────────────────────────┘
                                ▼
   Subtasks ─────► Router (LinUCB-Shadow, EXP-0003C.4)
                 │   Belief(μ,n) → Confidence(1-exp(-n/8))
                 │   → 8次元特徴量 → θᵀx + α√(xᵀA⁻¹x)
                 └──────────────┬─────────────────────────────┘
                                ▼
                 ┌────────────────────────────────────────────┐
                 │ Shadow Evaluation (EXP-0002F/0003C.3)       │
                 │   全エキスパートを評価 → フル情報フィードバック│
                 └──────────────┬─────────────────────────────┘
                                ▼
                 ┌────────────────────────────────────────────┐
                 │ Verifier (EXP-0005D) → Integrator           │
                 │ Memory (EXP-0005E) → Episode 蓄積           │
                 └────────────────────────────────────────────┘
```

## ディレクトリ構成

```
src/arcasha/
  FRAMEWORK.md       統合理論 (設計原理 P1-P5 + 命題 Prop.1-4)
  core/types.ts        基本型 (Task/Subtask/NodeState/StepContext)
  core/observation.ts  ルールベース評価 + 多目的報酬 (REWARD_W) + Oracle
  belief/bayesian.ts   BayesianBelief (μ,n,confidence) + EmaLatency
  router/linucb.ts     LinUCB (disjoint, Gauss-Jordan 逆行列)
  router/router.ts     Router インターフェース (select/scores/observe) + LinUCB/UCB/Fixed
  shadow/shadow.ts     シャドウ評価 (フル情報フィードバック + 注入)
  planner/decomposer.ts タスク分解 (EXP-0005A) + 動的ポリシー (topK/parallel, EXP-0005C)
  planner/llm_planner.ts LLM Planner (EXP-0005B) — フォーマット不適合時はルールへフォールバック
  experts/registry.ts  WS サーバ (エキスパート登録/推論/決定論キャッシュ + generate)
  verifier/verifier.ts 検証 + 統合 (EXP-0005D)
  memory/memory.ts     EpisodeMemory (EXP-0005E) + Vector Memory + priorFor (事前信念 μ₀ 集計)
  search/tree.ts       Tree Search: PlanGenerator (複数バリアント) + 信念推定 Beam + 最弱サブタスク展開
  reflect/reflector.ts Self Reflection: 失敗を Belief (μ, n) から診断 → re-route/committee/re-decompose
  controller/controller.ts Emergent Controller — topK + 並列 + executePlan + executeReflective + seedBeliefsFromMemory
  index.ts             Demo CLI
```

## 検証済み設計の反映点

| 研究知見 (0003系) | ArcAsha 実装 |
|---|---|
| Shadow Feedback が制約 (C.3: 94% gap 解消) | 全アームを毎ステップ評価 (Full Information) |
| LinUCB 特徴学習で初めて Fixed に勝利 (C.4) | 8次元特徴量 + disjoint LinUCB (α=0.3, λ=1.0) |
| capability 推定が支配的 (F: +37.6% regret) | capability μ を第2特徴量に組み込み |
| cost は EstimatedCost (params 比例) | paramsM から proxy 計算 |
| 決定論出力 (T=0) のキャッシュ | (node,prompt) キャッシュで高速ウォームアップ |
| Fixed は手設計重み | FixedRouter (q:0.6, lat:0.2, cost:0.05, stab:0.15) |

## 実行方法

```bash
# 1) エキスパート 3 台を起動 (別ターミナル)
cd /Users/ooyaryou/my-AI-fac && source .venv/bin/activate
python Akasha-OS/akasha-master/experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:8080 --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16 --device mps
python ... --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct ...
python ... --node-id node-gemma --model unsloth/gemma-3-1b-it ...

# 2) コントローラ起動 (akasha-master ディレクトリから)
npx tsx src/arcasha/index.ts
```

## Phase 5 ロードマップ

- [x] EXP-0005A タスク分解 (RuleBasedPlanner)
- [x] **EXP-0005B LLM Planner** — エキスパートによる分解 (`llm_planner.ts`)。
      フォーマット不適合時は RuleBasedPlanner へフォールバック (実ノードで検証済み)
- [x] **EXP-0005C Dynamic Expert Assignment** — Planner が「何人 (topK) / 並列か逐次か」を決定。
      Router.scores() で上位 K をコミットし Verifier が仲裁 (実ノードで検証済み)
- [x] EXP-0005D Verifier (閾値 + 拒否語 + 統合)
- [x] EXP-0005E EpisodeMemory
- [x] **Vector Memory** — 文字 n-gram Embedding + cosine で類似エピソード検索 (実ノードで検証済み)
- [x] **Tree Search** — 複数プラン生成 → 信念推定で Beam 枝刈り → シャドウ実行 → Verifier 選抜 →
      最弱サブタスク展開 (accept-if-improved)。`search/tree.ts`
- [x] **Self Reflection** — 失敗サブタスクを Belief (μ, n) から診断 → re-route (force) /
      committee (topK) / re-decompose (分割) → 再実行 → 改善時のみ採用。`reflect/reflector.ts`
- [x] **Long-term Memory → Prior Belief μ₀** — 類似エピソードの決定を集計し、新タスクの
      信念を μ₀/n₀ で初期化 (Closed Bayesian Loop: μ₀ → Observation → μ → Memory → μ₀')。
      `memory.priorFor` + `controller.seedBeliefsFromMemory`
- [x] EXP-0005F Emergent Controller (Task→Planner→Router→Verifier→Memory)

## 実ノード検証結果 (2026-08-03, 3 エキスパート)

- ウォームアップ: **cache miss=72 / hit=144** (直列化で 3 コントローラ間の決定論出力を共有)
- demo-web (coding): `parallel=true`, code サブタスク `topK=2` (consulted: node-qwen)
- demo-train (math): solve サブタスク `topK=2` (consulted: node-gemma), 正解 80km/h
- demo-feather (reasoning): Tree Search — 3 プラン生成 (standard/committee/deep) → Beam=2 実行 →
  standard が最良 (score=0.250) → 最弱展開は改善なしで打ち切り
- demo-reflect (coding, palindrome): 初期 4/4 PASS → 反射ループは失敗なしのため即終了
  (診断ロジックはモックで 4 ケース検証: expert-capability→force / refusal→re-route /
  low-confidence→topK / task-hard→分割)
- demo-memory (coding, URL 抽出): 記憶から **μ₀ 初期化** — smollm coding μ₀=0.200 (n=1, demo-web 由来),
  reasoning n₀=6。実行後 posterior — qwen coding μ=0.800, smollm 0.200→0.300。episode #6 が次の μ₀'
- Vector Memory: 「python web scraper extract links」→ episode #0 (coding, sim=0.511) を最上位取得
- 学習重み: capability=0.585 支配 (EXP-0003F と整合)

## 手法比較ベンチマーク (2026-08-03, 3 エキスパート / 保持 9 タスク / 3 seeds)

> `npx tsx src/arcasha/benchmark/run_benchmark.ts --seeds 3` — レポート: `benchmark/reports/`

| 手法 | meanScore | passRate | cumRegret | lat(ms) |
|---|---|---|---|---|
| **LinUCB-Shadow (ArcAsha)** | **0.646** | 0.861 | **1.200** | 2138 |
| Fixed | 0.632 | 0.917 | 1.450 | 2018 |
| Random | 0.542 | 0.778 | 4.650 | 2190 |
| RoundRobin | 0.542 | 0.861 | 4.350 | 2353 |
| UCB-Shadow | 0.514 | 0.917 | 4.400 | 1835 |

- **LinUCB-Shadow が最高品質 + 最小リグレット** (論文 0003D/E と整合)
- UCB-Shadow (素朴な報酬最大化) が最低品質 — 0003E の「安くて弱いモデルに誘惑される」危険を再現
- 3 seeds で完全一致 = **決定論** (T=0 + キャッシュ) の実証
- 既存フレームワークとの位置づけ: [`docs/COMPARISON.md`](docs/COMPARISON.md)
