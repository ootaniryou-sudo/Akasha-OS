# EXP-0003 — Heterogeneous Experts: Belief(Node, Task)

> **「本当に異質な Expert」で Belief・Weight・Composite の一般性を検証する。**
> **Phase 4 の閉ループ (Observation→Belief→Weight→Routing) を、単一モデル (Qwen) の
> バックエンド差ではなく、異なるモデル (Qwen/SmolLM/Gemma) の能力差に適用する。**

## 前回までの前提を壊す

Phase 1〜4 まで、`Node A` と `Node B` は**実質どちらも Qwen 系**だった。
差は backend (ONNX vs PyTorch) と capability (profile の数値) だけ。

EXP-0003 では「本当に異質な Expert」を使う:

| Model | サイズ | 想定される強み |
|-------|:---:|---------------|
| **Qwen3-0.6B** | 596M | General (平均高) |
| **SmolLM2-360M-Instruct** | 362M | Fast (軽量) |
| **Gemma-3-1B-it** | 1000M | Reasoning / 汎用 |

これらを **Capability だけではなく `Belief → Weight → Composite`** で選べるか。

## Key Extension: Belief(Node) → Belief(Node, Task)

Phase 4 までの Belief はノード単位だった:

```
Belief(node) = { stability, confidence }   # ノードに1つ
```

しかし実際には能力はタスク依存:

```
Belief(Qwen,  coding) = 0.85    Belief(Qwen,  math)  = 0.75
Belief(Gemma, coding) = 0.80    Belief(Gemma, math)  = 0.85
```

つまり Belief は 2 次元になる:

```
Belief(node, task)   # ノード × タスク
```

これができると:
- 同じノードでもタスクによって信頼度が違う
- ルーティングが「どのノードがこのタスクに強いか」を Belief から選べる
- Composite Score も `Score(node, task)` になる

## 異種モデルでは「トークン重複シャドウ」は使えない

F 系実験の shadow は「同一モデル・異バックエンド」のトークン重複でドリフトを検出した。
しかし異種モデルは**語彙が異なる** (GPT2Tokenizer / Qwen2Tokenizer / GemmaTokenizer)。

→ EXP-0003 では **タスク評価スコア (evaluateTask)** を観測として Belief を学習する:

```
Observation (evaluateTask score) → Belief(node, task) = {μ, confidence}
```

## Hypothesis (検証する仮説)

> **Belief を (Node, Task) の 2 次元に拡張すると、family の事前知識 (Fixed profile) が
> 不正確でも、観測からタスク別の信頼度を学習し、固定 profile ルーティングより
> 高い Routing Accuracy を達成できる。**

## Design

```
Phase 1 (Observation, 各タスク3回):
  各 (node, task) にプロンプト → evaluateTask スコア → ベイズ更新
  Belief(node, task) = { μ, n, confidence, effective=μ×confidence }

Phase 2 (Verification, 各タスク5回 — held-out):
  タスク提示 → 2つの Composite で argmax
    ① Fixed profile : family 事前知識 (qwen/smollm/gemma の一般特性)
    ② Belief learned: Phase 1 の観測から学習した Belief
  Oracle (ground truth): 実際に最も良い evaluateTask スコアを出したノード
```

| Policy | 事前知識 | 判定 |
|--------|---------|------|
| **Fixed** | family 一般特性 (qwen coding 0.85 等) | 静的 |
| **Belief** | なし — 観測のみ | ベイズ更新 |

## Results (2026-08-01)

```
Routing Accuracy (choice === oracle):
┌──────────────┬──────────────┬──────────────┐
│ Policy       │ Routing Acc  │ Avg Eval     │
├──────────────┼──────────────┼──────────────┤
│ Fixed        │    20% (2/10) │      0.475 │
│ Belief       │    60% (6/10) │      0.670 │
└──────────────┴──────────────┴──────────────┘

Per-task:
  coding: Fixed acc=1/5 avg=0.280 | Belief acc=4/5 avg=0.560
  math  : Fixed acc=1/5 avg=0.670 | Belief acc=2/5 avg=0.780
```

**学習された最終 Belief(node, task):**

| Node | coding μ | math μ |
|------|:---:|:---:|
| node-qwen | 0.300 | 0.525 |
| node-smollm | **0.525** | 0.750 |
| node-gemma | 0.300 | **0.812** |

## Interpretation

1. **仮説 SUPPORTED ✅**: Belief learned (60%) ≥ Fixed profile (20%)。観測だけで3倍の Routing Accuracy。
2. **Fixed family profile の失敗**: qwen coding=0.85 という事前知識は実測 (μ=0.30) と大きく乖離。family の一般特性は個体差を捉えられない。
3. **Belief(Node, Task) が機能**: gemma は coding μ=0.30 / math μ=0.81 と**タスク別に分離**。ノード単位 Belief では表現できない情報を獲得。
4. **SmolLM2-360M が coding 最強** (μ=0.525): 最小モデルが coding で最適 — サイズと能力は単純比例しないことを観測が捉えた。
5. **math の Belief は初期観測の影響**: gemma が最終的に最強 (0.812) だが、検証中は smollm を選びすぎた。観測回数 n=3 では Belief がまだ不安定 (V-math-7 で gemma 正解を逃す)。
6. **評価指標の注意**: evaluateTask はヒューリスティック (構造・数値・拒否)。絶対値ではなく**相対順位**が意味を持つ。

## Success Criteria

- [x] 異種モデル (Qwen3-0.6B / SmolLM2-360M / Gemma-3-1B) が Expert として参加
- [x] Belief が (Node, Task) の 2 次元に拡張されている
- [x] 観測だけで Belief(node, task) が学習される
- [x] タスク別 Routing Accuracy が Fixed profile より高い (60% > 20%)
- [x] 本当に異質な Expert でも Phase 4 の閉ループが機能する

## Research Value

> **「観測に応じて Belief を更新し、その Belief に応じて Weight を学習する」という
> Phase 4 の中心仮説は、モデルファミリーが異なっても成立する。**
>
> Belief が (Node) から (Node, Task) に拡張されることで、ArcAsha のルーティングは
> 「どのノードが良いか」から「**どのノードがこのタスクに良いか**」へ進化する。

## Model Notes

```
Qwen3-0.6B        : 既存 (HFキャッシュ済み)
SmolLM2-360M-Instruct : 新規DL (HuggingFaceTB, 362M params)
Gemma-3-1B-it     : 新規DL (unsloth ミラー, 1000M params — google版はgated)
```

- Gemma 公式 (google/gemma-3-1b-it) は gated (403) → **unsloth ミラー**を使用
- 全モデル PyTorch MPS fp16 で動作

## Running

```bash
# Terminal 1: Master
npx tsx experiments/qwen3_0.6b/EXP-0003/run_master.ts --port 8080

# Terminal 2-4: Heterogeneous experts
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-qwen \
  --model Qwen/Qwen3-0.6B --precision fp16

python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-smollm \
  --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16

python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-gemma \
  --model unsloth/gemma-3-1b-it --precision fp16
```

Depends on: EXP-0002E.3 (Adaptive Weight Learning), EXP-0002D.1 (Evaluator), EXP-0002F.1 (Belief Update)
