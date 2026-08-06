"""LinUCB (disjoint) — ArcAsha ODAR core (EXP-0003C.4 verified)."""

import math

# ── linear algebra (dependency-free) ─────────────────────────────────────────


def mat_vec(A, v):
    return [sum(a * vj for a, vj in zip(row, v)) for row in A]


def mat_inv(A):
    """Gauss-Jordan inverse with partial pivoting."""
    n = len(A)
    M = [list(row) + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(A)]
    for col in range(n):
        piv = col
        for r in range(col + 1, n):
            if abs(M[r][col]) > abs(M[piv][col]):
                piv = r
        if abs(M[piv][col]) < 1e-12:
            continue
        if piv != col:
            M[col], M[piv] = M[piv], M[col]
        d = M[col][col]
        for j in range(2 * n):
            M[col][j] /= d
        for r in range(n):
            if r == col:
                continue
            f = M[r][col]
            if abs(f) < 1e-15:
                continue
            for j in range(2 * n):
                M[r][j] -= f * M[col][j]
    return [row[n:] for row in M]


class LinUCB:
    """Per-arm disjoint LinUCB: theta = A^-1 b, score = theta^T x + alpha*sqrt(x^T A^-1 x)."""

    def __init__(self, d: int, alpha: float, lam: float = 1.0):
        self.d = d
        self.alpha = alpha
        self.A = [[lam if i == j else 0.0 for j in range(d)] for i in range(d)]
        self.b = [0.0] * d
        self.theta = [0.0] * d

    def score(self, x):
        mu = sum(t * xi for t, xi in zip(self.theta, x))
        Ainv = mat_inv(self.A)
        xTAx = sum(x[i] * sum(Ainv[i][j] * x[j] for j in range(self.d)) for i in range(self.d))
        return mu + self.alpha * math.sqrt(max(0.0, xTAx))

    def update(self, x, r: float) -> None:
        for i in range(self.d):
            for j in range(self.d):
                self.A[i][j] += x[i] * x[j]
            self.b[i] += r * x[i]
        self.theta = mat_vec(mat_inv(self.A), self.b)

    def learned_theta(self):
        return list(self.theta)


FEATURE_NAMES = ["bias", "capability", "latency", "cost", "stability", "confidence", "memory", "temperature"]
