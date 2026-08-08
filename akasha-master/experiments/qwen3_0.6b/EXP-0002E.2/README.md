# EXP-0002E.2 — Pareto Routing

> **「Composite Score だけでは表現できない構造」が実験で確認された。**
> **Scalarization cannot preserve the full dominance structure of a multi-objective routing problem.**

## Proven

> **完全に支配されるノード（node-h）が、Weighted-Sum では候補として残る。**

```
node-h (cap=0.80, lat=70ms, stab=0.80)
  └── 完全支配 by node-b (cap=0.85, lat=40ms, stab=0.99)
      全軸で劣る → Pareto では存在価値なし

しかし Weighted-Sum では Rank #7 に残る
→ スカラー化はトレードオフを隠す
```

## Generalization

> **Scalarization cannot preserve the full dominance structure of a multi-objective routing problem.**
> **Therefore, Pareto filtering is introduced before scalarization to preserve the dominance structure while enabling policy-driven final selection.**

## Two-Stage Routing Design

```
All Nodes
    ↓
Step 1: Pareto Filter   ← 完全支配ノードを除外（探索空間の理論的削減）
    ↓
Pareto Frontier
    ↓
Step 2: Composite Score ← フロンティア内で運用ポリシー適用
    ↓
Best Node
```

> Pareto で候補集合を絞り、Composite Score で最終選択。
> node-h のような完全劣化ノードは最初から除外される。
> **Dominated Node は計算対象外 → 実装上も探索空間が削減される。**

## Weight Space vs Objective Space

```
0002E.1: Decision Boundary  ← 重み空間（1次元解析）
             └── weight を変えて相転移を測定

0002E.2: Pareto Frontier    ← 目的空間（多次元解析）
             └── 複数軸のまま支配関係を測定

補完関係: 異なる視点から同じルーティング問題を見ている
```

## Results (2026-08-01)

```
Frontier: 7/9 nodes
  Dominated: node-h (by node-b), node-i (by node-a)

Weighted-Sum ranking:
  node-c #1 (frontier ✅)
  ...
  node-h #7 (NOT on frontier ❌ ← スカラー化の問題点)
  ...
```

Full results: [`output/summary.json`](output/summary.json)

## Research Significance

> **Composite Score は Pareto 集合を完全には表現できない。**
> ルーティングは二段階（Pareto Filter → Composite Score）にすべき。

Depends on: EXP-0002E (Composite Score), EXP-0002E.1 (Decision Boundary)

