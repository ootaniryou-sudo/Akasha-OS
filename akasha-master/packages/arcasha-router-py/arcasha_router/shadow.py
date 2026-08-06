"""Shadow evaluation — full-information feedback (EXP-0002F / 0003C.3)."""

import asyncio

from .observation import evaluate_task


async def evaluate_all(experts, task, compute, inject=None):
    """Evaluate all experts; ``compute`` is injected by the caller (WS/WebGPU/any)."""
    out = {}
    for n in experts:
        raw = await compute(n, task)
        score, latency = raw["score"], raw["latencyMs"]
        if inject and inject.get("type") == "capability" and inject.get("node") == n["nodeId"]:
            score = round(score * inject["factor"], 3)
        if inject and inject.get("type") == "latency" and inject.get("node") == n["nodeId"]:
            latency = round(latency * inject["factor"])
        out[n["nodeId"]] = {"nodeId": n["nodeId"], "text": raw.get("text", ""), "score": score, "latencyMs": latency}
    return out


def evaluate_with(node, task, text, latency_ms):
    return {"nodeId": node["nodeId"], "text": text, "score": evaluate_task(task["capability"], text), "latencyMs": latency_ms}


def run_async(coro):
    """Small helper to run the async shadow loop from sync code."""
    return asyncio.run(coro)
