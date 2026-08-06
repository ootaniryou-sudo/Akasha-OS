"""arcasha-router — Observation-Driven Adaptive Routing (ODAR).

Belief-driven routing engine for heterogeneous LLM pools. Python port of the
TypeScript package ``@arcasha/router`` (standalone core of ArcAsha).

No runtime dependencies (pure Python).

Typical usage (full-information / shadow loop)::

    from arcasha_router import (
        BayesianBelief, LinUCBShadowRouter, compute_rewards, find_oracle,
    )

    experts = [{"nodeId": "node-a", "modelId": "M1", "family": "qwen",
                "paramsM": 596, "memoryGB": 1.2, "temperature": 0.6}, ...]
    router = LinUCBShadowRouter(experts)   # alpha=0.3, lambda=1.0

    ctx = {
        "task": {"id": "t", "capability": "coding", "prompt": "..."},
        "states": states,      # nodeId -> NodeState
        "rewards": rewards,    # nodeId -> float (from compute_rewards)
        "order": [e["nodeId"] for e in experts],
        "step": step,
    }
    chosen = router.select(ctx)
    router.observe(ctx)        # full-information update on all arms
"""

from .bayesian import BayesianBelief, EmaLatency
from .linucb import LinUCB, FEATURE_NAMES
from .observation import (
    REWARD_W,
    compute_rewards,
    evaluate_coding,
    evaluate_math,
    evaluate_reasoning,
    evaluate_task,
    find_oracle,
    reward_for,
)
from .router import (
    FEATURE_DIM,
    build_features,
    LinUCBShadowRouter,
    UCBShadowRouter,
    FixedRouter,
    RandomRouter,
    RoundRobinRouter,
)
from .shadow import evaluate_all, evaluate_with

__version__ = "0.1.0"
__all__ = [
    "BayesianBelief",
    "EmaLatency",
    "LinUCB",
    "FEATURE_NAMES",
    "FEATURE_DIM",
    "REWARD_W",
    "compute_rewards",
    "evaluate_coding",
    "evaluate_math",
    "evaluate_reasoning",
    "evaluate_task",
    "find_oracle",
    "reward_for",
    "build_features",
    "LinUCBShadowRouter",
    "UCBShadowRouter",
    "FixedRouter",
    "RandomRouter",
    "RoundRobinRouter",
    "evaluate_all",
    "evaluate_with",
]
