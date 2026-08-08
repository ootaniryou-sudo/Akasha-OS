# examples/python-sample.py
# arcasha-router (PyPI: arcasha-router) — ODAR ルーティングコアの Python サンプル。
# 依存なし。インストール:
#   pip install arcasha-router
# 実行:
#   python examples/python-sample.py

from arcasha_router import (
    LinUCBShadowRouter,
    BayesianBelief,
    compute_rewards,
    find_oracle,
)

EXPERTS = [
    {"nodeId": "node-a", "modelId": "M1", "family": "qwen", "paramsM": 596, "memoryGB": 1.2, "temperature": 0.6},
    {"nodeId": "node-b", "modelId": "M2", "family": "smollm", "paramsM": 360, "memoryGB": 1.0, "temperature": 0.6},
    {"nodeId": "node-c", "modelId": "M3", "family": "gemma", "paramsM": 1000, "memoryGB": 2.0, "temperature": 0.6},
]
CAPS = ["coding", "math", "reasoning"]

# 信念 (node × capability) と状態
beliefs = {e["nodeId"]: {c: BayesianBelief() for c in CAPS} for e in EXPERTS}
states = {
    e["nodeId"]: {
        "capability": {c: beliefs[e["nodeId"]][c].snapshot() for c in CAPS},
        "latencyMs": 200,
        "stability": 1.0,
    }
    for e in EXPERTS
}

router = LinUCBShadowRouter(EXPERTS)  # alpha=0.3, lam=1.0


def compute(node, task):
    """実ノード実行の代わり (実際は LLM 呼び出し)。node-b が coding 最強。"""
    score = {"node-a": 0.35, "node-b": 0.85, "node-c": 0.55}[node["nodeId"]]
    return {"score": score, "latency_ms": 200}


def route_once(task):
    # 1) シャドウ実行 (フル情報)
    results = {}
    for e in EXPERTS:
        r = compute(e, task)
        results[e["nodeId"]] = {"nodeId": e["nodeId"], "text": "x", "score": r["score"], "latencyMs": r["latency_ms"]}
    # 2) 信念更新 → 状態 → 報酬
    for e in EXPERTS:
        beliefs[e["nodeId"]][task["capability"]].update(results[e["nodeId"]]["score"])
        states[e["nodeId"]]["capability"][task["capability"]] = beliefs[e["nodeId"]][task["capability"]].snapshot()
    max_lat = max(states[e["nodeId"]]["latencyMs"] for e in EXPERTS) or 1
    max_params = max(e["paramsM"] for e in EXPERTS) or 1
    rewards = compute_rewards(EXPERTS, results, states, max_lat, max_params)
    # 3) 選択 & フル情報更新
    ctx = {"task": task, "states": states, "rewards": rewards, "order": [e["nodeId"] for e in EXPERTS], "step": 0}
    chosen = router.select(ctx)
    router.observe(ctx)
    oracle = find_oracle(results)
    regret = results[oracle]["score"] - results[chosen]["score"]
    return chosen, oracle, regret


if __name__ == "__main__":
    total = 0.0
    for i in range(60):
        task = {"id": f"t{i}", "capability": "coding", "prompt": f"write code {i}"}
        chosen, oracle, regret = route_once(task)
        total += regret
    print(f"LinUCB-Shadow cumulative regret @60 = {total:.3f}  (期待値: 0.000)")
    assert total < 1.0, "TS 版と同じく LinUCB-S は最良 Oracle を選択するはず"
    print("PASS ✅ (TS とクロス言語再現)")

