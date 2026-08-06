# arcasha-router (Python)

**Observation-Driven Adaptive Routing (ODAR)** — belief-driven routing engine for
heterogeneous LLM pools. Python port of [`@arcasha/router`](../arcasha-router)
(ArcAsha のルーティングコア)。**依存なし** (pure Python) で、WebGPU アプリや
エッジ AI プロジェクトに埋め込めます。

## インストール

```bash
pip install -e .        # 開発 (このディレクトリから)
# または (公開後):  pip install arcasha-router
```

## 使い方 (フル情報 / シャドウループ)

```python
from arcasha_router import (
    BayesianBelief, LinUCBShadowRouter, compute_rewards, find_oracle,
)

experts = [
    {"nodeId": "node-a", "modelId": "M1", "family": "qwen", "paramsM": 596, "memoryGB": 1.2, "temperature": 0.6},
    # ...
]
router = LinUCBShadowRouter(experts)   # alpha=0.3, lambda=1.0

# 1 ステップ: 全エキスパート評価 (shadow) → 報酬 → 選択 → Full-Information 更新
ctx = {
    "task": {"id": "t1", "capability": "coding", "prompt": "..."},
    "states": states,     # nodeId -> {"capability": {...}, "latencyMs": int, "stability": float}
    "rewards": rewards,   # compute_rewards(experts, results, states, max_lat, max_params)
    "order": [e["nodeId"] for e in experts],
    "step": step,
}
chosen = router.select(ctx)
router.observe(ctx)       # 全アームの報酬で更新
```

## API

| シンボル | 内容 |
|---|---|
| `BayesianBelief` / `EmaLatency` | 状態推定 (μ, confidence=1-exp(-n/8), effective, 事前分布シード) |
| `LinUCBShadowRouter` | 提案手法 (disjoint LinUCB + シャドウ = フル情報) |
| `UCBShadowRouter` / `FixedRouter` / `RandomRouter` / `RoundRobinRouter` | ベースライン |
| `build_features` | 8 次元特徴量 |
| `compute_rewards` / `find_oracle` | 多目的報酬 (Q+L+C+S) と Oracle |
| `evaluate_all` / `evaluate_task` | ルールベース評価 + シャドウ実行 (async) |

## 検証

```bash
cd packages/arcasha-router-py
python demo.py
```

出力例 (合成プール): LinUCB-Shadow が 60 ステップで最良ノード (node-b) を即学習
し、regret=0。UCB-Shadow / Random は探索コストを払う。

> 研究: *Observation-Driven Routing for Distributed Heterogeneous Language Models*
> (Zenodo 10.5281/zenodo.21755612)。MIT License — ArcAsha (Akasha-OS).
