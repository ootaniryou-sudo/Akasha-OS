"""Bayesian belief (state estimation) — ArcAsha ODAR core."""

import math


class BayesianBelief:
    """Running-mean Bayesian estimator for per-(node, capability) quality.

    confidence(n) = 1 - exp(-n/8), effective = mu * confidence.
    Optional prior seed (Closed Bayesian Loop: memory -> mu0 -> observation -> mu).
    """

    def __init__(self, mu: float = 0.5, n: int = 0, seed: dict | None = None):
        if seed is not None and seed.get("n", 0) > 0:
            self.mu = max(0.0, min(1.0, float(seed["mu"])))
            self.n = int(seed["n"])
        else:
            self.mu = float(mu)
            self.n = int(n)

    def update(self, x: float) -> None:
        """Bayesian update with observation x in [0, 1] (sample mean)."""
        self.mu = (self.n * self.mu + x) / (self.n + 1)
        self.n += 1

    def confidence(self) -> float:
        return 1.0 - math.exp(-self.n / 8.0)

    def effective(self) -> float:
        return self.mu * self.confidence()

    def snapshot(self) -> dict:
        return {
            "mu": round(self.mu, 3),
            "n": self.n,
            "confidence": round(self.confidence(), 3),
            "effective": round(self.effective(), 3),
        }


class EmaLatency:
    """Exponential moving average latency smoother (alpha=0.3)."""

    def __init__(self, alpha: float = 0.3):
        self.alpha = alpha
        self.ema = 0.0
        self.n = 0

    def observe(self, measured: float) -> int:
        self.ema = measured if self.n == 0 else self.alpha * measured + (1 - self.alpha) * self.ema
        self.n += 1
        return round(self.ema)

    def value(self) -> int:
        return round(self.ema)

