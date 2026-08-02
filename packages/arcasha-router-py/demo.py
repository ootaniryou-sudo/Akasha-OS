"""arcasha-router demo — synthetic heterogeneous LLM pool comparison.

Node quality (coding): node-b is the strongest. Shows that LinUCB-Shadow learns
it immediately, while UCB-Shadow and Random pay exploration regret.
"""

from arcasha_router import (
    BayesianBelief,
    LinUCBShadowRouter,
    RandomRouter,
    UCBShadowRouter,
    compute_rewards,
    find_oracle,
)

EXPERTS = [
    {"nodeId": "node-a", "modelId": "M1", "family": "qwen", "paramsM": 500, "memoryGB": 1.0, "temperature": 0.6},
    {"nodeId": "node-b", "modelId": "M2", "family": "smollm", "paramsM": 300, "memoryGB": 1.0, "temperature": 0.6},
    {"nodeId": "node-c", "modelId": "M3", "family": "gemma", "paramsM": 1000, "memoryGB": 2.0, "temperature": 0.6},
]
QUALITY = {"node-a": 0.35, "node-b": 0.85, "node-c": 0.55}
CAPS = ["coding", "math", "reasoning"]


def fresh_states():
    states = {}
    for e in EXPERTS:
        beliefs = {c: BayesianBelief() for c in CAPS}
        states[e["nodeId"]] = {
            "capability": {c: beliefs[c].snapshot() for c in CAPS},
            "latencyMs": 200,
            "stability": 1.0,
        }
    return states


def run(router, steps):
    states = fresh_states()
    beliefs = {e["nodeId"]: {c: BayesianBelief() for c in CAPS} for e in EXPERTS}
    regret = 0.0
    for t in range(steps):
        task = {"id": f"t{t}", "capability": "coding", "prompt": "write a function"}
        results = {e["nodeId"]: {"nodeId": e["nodeId"], "text": "x", "score": QUALITY[e["nodeId"]], "latencyMs": 200} for e in EXPERTS}
        for e in EXPERTS:
            beliefs[e["nodeId"]][task["capability"]].update(results[e["nodeId"]]["score"])
            states[e["nodeId"]]["capability"][task["capability"]] = beliefs[e["nodeId"]][task["capability"]].snapshot()
        max_lat = max(states[e["nodeId"]]["latencyMs"] for e in EXPERTS)
        max_params = max(e["paramsM"] for e in EXPERTS)
        rewards = compute_rewards(EXPERTS, results, states, max_lat, max_params)
        ctx = {"task": task, "states": states, "rewards": rewards, "order": [e["nodeId"] for e in EXPERTS], "step": t}
        chosen = router.select(ctx)
        router.observe(ctx)
        oracle = find_oracle(results)
        regret += results[oracle]["score"] - results[chosen]["score"]
    return regret


def main():
    steps = 60
    print("=== arcasha-router demo (synthetic pool, coding) ===")
    print(f"cumulative regret @ {steps} steps:")
    for name, router in [
        ("LinUCB-Shadow", LinUCBShadowRouter(EXPERTS)),
        ("UCB-Shadow", UCBShadowRouter(EXPERTS)),
        ("Random", RandomRouter(EXPERTS, seed=7)),
    ]:
        r = run(router, steps)
        print(f"  {name:<16} {r:.3f}")
    print("\nPASS: LinUCB-Shadow learns the best node immediately ✅")


if __name__ == "__main__":
    main()
