"""Observation — rule-based task evaluation + multi-objective reward."""

_REQ_STRUCT = ["def ", "return ", "import ", "class ", "print(", "for ", "if ", "else:", "while ", "len(", "range("]
_REQ_MATH = ["=", "+", "*", "/", "^", "result", "answer", "solution", "sum", "product", "integral", "derivative", "x ="]
_REQ_REASON = ["because", "therefore", "if ", "then", "since", "first", "second", "step", "thus", "answer", "reason", "so "]
_REQ_REFUSAL = ["sorry", "cannot", "unable", "as an ai", "i am"]


def _base_score(signals, text, hit_div):
    lower = text.lower()
    hits = sum(1 for k in signals if k in lower)
    score = min(1.0, hits / hit_div)
    refusal_hits = sum(1 for k in _REQ_REFUSAL if k in lower)
    return max(0.0, min(1.0, score - refusal_hits * 0.35))


def evaluate_coding(text: str) -> float:
    return _base_score(_REQ_STRUCT, text, 5)


def evaluate_math(text: str) -> float:
    s = _base_score(_REQ_MATH, text, 4)
    return max(0.0, min(1.0, s + (0.2 if any(ch.isdigit() for ch in text) else 0.0)))


def evaluate_reasoning(text: str) -> float:
    s = _base_score(_REQ_REASON, text, 4)
    return max(0.0, min(1.0, s + (0.2 if any(ch.isdigit() for ch in text) else 0.0)))


def evaluate_task(capability: str, text: str) -> float:
    if capability == "coding":
        return round(evaluate_coding(text), 3)
    if capability == "math":
        return round(evaluate_math(text), 3)
    return round(evaluate_reasoning(text), 3)


# ── multi-objective reward (EstimatedCost is params-proportional proxy) ──────

REWARD_W = {"q": 1.0, "lat": 0.10, "cost": 0.10, "stab": 0.10}


def reward_for(node, result, state, max_latency_ms, max_params_m) -> float:
    return (
        REWARD_W["q"] * result["score"]
        + REWARD_W["lat"] * (1 - result["latencyMs"] / max(1, max_latency_ms))
        + REWARD_W["cost"] * (1 - node["paramsM"] / max(1, max_params_m))
        + REWARD_W["stab"] * state["stability"]
    )


def compute_rewards(experts, results, states, max_latency_ms, max_params_m):
    return {
        n["nodeId"]: reward_for(n, results[n["nodeId"]], states[n["nodeId"]], max_latency_ms, max_params_m)
        for n in experts
    }


def find_oracle(results) -> str:
    best, best_score = "", -1.0
    for node_id, r in results.items():
        if r["score"] > best_score:
            best_score, best = r["score"], node_id
    return best
