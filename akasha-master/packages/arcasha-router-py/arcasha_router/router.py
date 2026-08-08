"""Routers — LinUCB-Shadow / UCB-Shadow / Fixed / baselines (full-information)."""

import math

from .linucb import LinUCB

FEATURE_DIM = 8
FEATURE_NAMES = ["bias", "capability", "latency", "cost", "stability", "confidence", "memory", "temperature"]


def build_features(experts, ctx, node_id, remove_idx=-1):
    st = ctx["states"][node_id]
    node = next(e for e in experts if e["nodeId"] == node_id)
    max_lat = max((ctx["states"][e["nodeId"]]["latencyMs"] for e in experts), default=1) or 1
    max_params = max((e["paramsM"] for e in experts), default=1) or 1
    cap = st["capability"][ctx["task"]["capability"]]
    full = [
        1.0,
        cap["mu"],
        1 - st["latencyMs"] / max_lat,
        1 - node["paramsM"] / max_params,  # EstimatedCost
        st["stability"],
        cap["confidence"],
        1 - node["memoryGB"] / 2.0,
        1 - node["temperature"] / 1.0,
    ]
    if remove_idx < 0:
        return full
    return [x for i, x in enumerate(full) if i != remove_idx]


class LinUCBShadowRouter:
    """Proposed method — disjoint LinUCB + full-information (shadow) feedback."""

    name = "LinUCB-Shadow"

    def __init__(self, experts, alpha=0.3, lam=1.0, remove_idx=-1):
        self.experts = experts
        dim = FEATURE_DIM - (1 if remove_idx >= 0 else 0)
        self._lin = {e["nodeId"]: LinUCB(dim, alpha, lam) for e in experts}
        self.remove_idx = remove_idx

    def scores(self, ctx):
        return {
            e["nodeId"]: self._lin[e["nodeId"]].score(build_features(self.experts, ctx, e["nodeId"], self.remove_idx))
            for e in self.experts
        }

    def select(self, ctx):
        sc = self.scores(ctx)
        return max(ctx["order"], key=lambda nid: sc[nid])

    def observe(self, ctx):
        for e in self.experts:
            self._lin[e["nodeId"]].update(
                build_features(self.experts, ctx, e["nodeId"], self.remove_idx), ctx["rewards"][e["nodeId"]]
            )

    def learned_weights(self):
        return {nid: lin.learned_theta() for nid, lin in self._lin.items()}


class UCBShadowRouter:
    """Reference — naive reward maximization with full information (EXP-0003C.3)."""

    name = "UCB-Shadow"

    def __init__(self, experts, c=2.0):
        self.experts = experts
        self.c = c
        self.q = {e["nodeId"]: 0.0 for e in experts}
        self.n = {e["nodeId"]: 0 for e in experts}

    def scores(self, ctx):
        t = ctx["step"]
        out = {}
        for e in self.experts:
            nid = e["nodeId"]
            out[nid] = float("inf") if self.n[nid] == 0 else self.q[nid] + math.sqrt(self.c * math.log(t + 1) / self.n[nid])
        return out

    def select(self, ctx):
        sc = self.scores(ctx)
        return max(ctx["order"], key=lambda nid: sc[nid])

    def observe(self, ctx):
        for e in self.experts:
            nid = e["nodeId"]
            self.q[nid] = (self.q[nid] * self.n[nid] + ctx["rewards"][nid]) / (self.n[nid] + 1)
            self.n[nid] += 1

    def learned_weights(self):
        return None


class FixedRouter:
    """Hand-designed composite baseline (EXP-0002E)."""

    name = "Fixed"
    W = {"q": 0.60, "lat": 0.20, "cost": 0.05, "stab": 0.15}

    def __init__(self, experts):
        self.experts = experts

    def scores(self, ctx):
        cap = ctx["task"]["capability"]
        max_lat = max((ctx["states"][e["nodeId"]]["latencyMs"] for e in self.experts), default=1) or 1
        max_params = max((e["paramsM"] for e in self.experts), default=1) or 1
        out = {}
        for e in self.experts:
            st = ctx["states"][e["nodeId"]]
            eff = st["capability"][cap].get("effective") or 0.5
            out[e["nodeId"]] = (
                self.W["q"] * eff
                + self.W["lat"] * (1 - st["latencyMs"] / max_lat)
                + self.W["cost"] * (1 - e["paramsM"] / max_params)
                + self.W["stab"] * st["stability"]
            )
        return out

    def select(self, ctx):
        sc = self.scores(ctx)
        return max(ctx["order"], key=lambda nid: sc[nid])

    def observe(self, ctx):
        pass

    def learned_weights(self):
        return None


class RandomRouter:
    """Random baseline (no learning)."""

    name = "Random"

    def __init__(self, experts, seed=42):
        self.experts = experts
        self.seed = seed

    def _rand(self, seed):
        x = math.sin(seed * 12.9898) * 43758.5453
        return x - math.floor(x)

    def scores(self, ctx):
        return {e["nodeId"]: self._rand(ctx["step"] + self.seed + len(e["nodeId"])) for e in self.experts}

    def select(self, ctx):
        i = int(self._rand(ctx["step"] + self.seed) * len(ctx["order"]))
        return ctx["order"][min(i, len(ctx["order"]) - 1)]

    def observe(self, ctx):
        pass

    def learned_weights(self):
        return None


class RoundRobinRouter:
    """Round-robin baseline (no learning)."""

    name = "RoundRobin"

    def __init__(self, experts):
        self.experts = experts

    def scores(self, ctx):
        pick = ctx["order"][ctx["step"] % len(ctx["order"])]
        return {e["nodeId"]: (1.0 if e["nodeId"] == pick else 0.0) for e in self.experts}

    def select(self, ctx):
        return ctx["order"][ctx["step"] % len(ctx["order"])]

    def observe(self, ctx):
        pass

    def learned_weights(self):
        return None

