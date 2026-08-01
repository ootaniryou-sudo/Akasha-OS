# EXP-0003 — Heterogeneous Experts: Belief(Node, Task)

> **「本当に異質な Expert」で Belief・Weight・Composite の一般性を検証する。**
> **Phase 4 の閉ループ (Observation→Belief→Weight→Routing) を、単一モデル (Qwen) の
> バックエンド差ではなく、異なるモデル (Phi/Gemma/SmolLM/Qwen) の能力差に適用する。**

## 前回までの前提を壊す

Phase 1〜4 まで、`Node A` と `Node B` は**実質どちらも Qwen 系**だった。
差は backend (ONNX vs PyTorch) と capability (profile の数値) だけ。

EXP-0003 では「本当に異質な Expert」を使う:

| Model | 想定される強み | 想定される弱み |
|-------|---------------|---------------|
| **Phi** | Coding | Math は中程度 |
| **Gemma** | Reasoning / 汎用 | Coding は中程度 |
| **SmolLM** | Fast (軽量) | 高難度は弱い |
| **Qwen** | General (平均高) | 特化なし |

これらを **Capability だけではなく `Belief → Weight → Composite`** で選べるか。

## Key Extension: Belief(Node) → Belief(Node, Task)

Phase 4 までの Belief はノード単位だった:

```
Belief(node) = { stability, confidence }   # ノードに1つ
```

しかし実際には能力はタスク依存:

```
Belief(Qwen,  coding) = 0.95    Belief(Qwen,  math)  = 0.72
Belief(Gemma, coding) = 0.65    Belief(Gemma, math)  = 0.94
```

つまり Belief は 2 次元になる:

```
Belief(node, task)   # ノード × タスク
```

これができると:
- 同じノードでもタスクによって信頼度が違う
- ルーティングが「どのノードがこのタスクに強いか」を Belief から選べる
- Composite Score も `Score(node, task)` になる

## Hypothesis (検証する仮説)

> **Belief を (Node, Task) の 2 次元に拡張すると、Capability profile の事前知識が
> 不正確でも、観測 (shadow overlap・タスク結果) からタスク別の信頼度を学習し、
> 固定 profile ルーティングより高い Routing Accuracy を達成できる。**

## Design: 2 Task × N Heterogeneous Experts

```
Tasks:      coding, math   (2 タスクで Belief(Node,Task) を検証)
Experts:    Phi (coding 強), Gemma (math 強), SmolLM (fast), Qwen (general)

Phase 1: 観測フェーズ
  各 (node, task) に shadow 検証 → Belief(node, task) を初期学習
  → 「Qwen は coding で 0.95, math で 0.72」を観測から推定

Phase 2: ルーティング
  タスクごとに argmax Composite(node, task) で選択
  → 正しい Expert (coding→Phi, math→Gemma) に Belief だけで到達できるか
```

## Metrics

```
Routing Accuracy per task:  % で正しい Expert を選べたか
Belief(node, task) 収束:   観測回数に対する Belief の収束 (μ, confidence)
Composite(node, task):     タスク別 composite の分離 (正解 Expert が top か)
Fixed profile vs Learned:  profile 事前知識 vs Belief 学習の比較
```

## Success Criteria

- [ ] 異種モデル (Phi/Gemma/SmolLM/Qwen) が Expert として参加
- [ ] Belief が (Node, Task) の 2 次元に拡張されている
- [ ] 観測だけで Belief(node, task) が学習される
- [ ] タスク別 Routing Accuracy が Fixed profile より高い
- [ ] 本当に異質な Expert でも Phase 4 の閉ループが機能する

## Note: モデル入手

```
現状キャッシュ: Qwen3-0.6B (PyTorch/ONNX), tinyllm (GGUF)
必要: Phi / Gemma / SmolLM の小規模版 (0.5-1B 級) を追加取得 or 既存 tinyllm で代替
```

## Depends on

- EXP-0002E.3 (Adaptive Weight Learning) — Belief から Weight を学習する枠組み
- EXP-0002F.1 (Cross-Backend Shadow) — Belief の観測機構
- EXP-0002C (Capability-Aware Routing) — タスク別ルーティングの基礎
