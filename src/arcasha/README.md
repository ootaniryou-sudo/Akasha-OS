# ArcAsha v0.1 — Observation-Driven Controller

検証済み研究パイプライン (EXP-0003C.1 → 0003F) を **内部エンジン** として実装した
自律型マルチエキスパートコントローラ。論文 (Zenodo DOI 10.5281/zenodo.21755612) は
凍結済み。本モジュールはその検証結果を製品コードに落とし込む Phase 5 の実装。

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
  core/types.ts        基本型 (Task/Subtask/NodeState/StepContext)
  core/observation.ts  ルールベース評価 + 多目的報酬 (REWARD_W) + Oracle
  belief/bayesian.ts   BayesianBelief (μ,n,confidence) + EmaLatency
  router/linucb.ts     LinUCB (disjoint, Gauss-Jordan 逆行列)
  router/router.ts     Router インターフェース + LinUCB/UCB/Fixed 実装 + 特徴量構築
  shadow/shadow.ts     シャドウ評価 (フル情報フィードバック + 注入)
  planner/decomposer.ts タスク分解 (EXP-0005A)
  experts/registry.ts  WS サーバ (エキスパート登録/推論/決定論キャッシュ)
  verifier/verifier.ts 検証 + 統合 (EXP-0005D)
  memory/memory.ts     EpisodeMemory (EXP-0005E)
  controller/controller.ts Emergent Controller (EXP-0005F)
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
- [x] EXP-0005D Verifier (閾値 + 拒否語 + 統合)
- [x] EXP-0005E EpisodeMemory
- [x] EXP-0005F Emergent Controller (Task→Planner→Router→Verifier→Memory)
- [ ] EXP-0005B LLM Planner (llmDecomposePrompt/parseSubtasks は hook 済み)
- [ ] EXP-0005C Dynamic Expert Assignment (負荷/故障時の再割当)
- [ ] ベクトル化メモリ・圧縮エピソード
