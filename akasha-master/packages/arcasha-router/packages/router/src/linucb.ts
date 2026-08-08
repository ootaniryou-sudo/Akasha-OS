/**
 * arcasha-router — LinUCB (EXP-0003C.4 で検証済みの実装)
 *
 * Disjoint LinUCB (Li et al. 2010): θ_a = A_a^{-1} b_a,
 * 選択: argmax_a θ_a^T x_{t,a} + α√(x^T A_a^{-1} x)。
 * 逆行列は Gauss-Jordan (部分ピボット) で計算。依存なし。
 */

// ── 線形代数 ────────────────────────────────────────────────

function matVec(A: number[][], v: number[]): number[] {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
}

function matInv(A: number[][]): number[][] {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) continue;
    if (piv !== col) { const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp; }
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (Math.abs(f) < 1e-15) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row.slice(n));
}

// ── LinUCB (disjoint, アーム毎) ─────────────────────────────

export class LinUCB {
  private A: number[][];
  private b: number[];
  private theta: number[];

  constructor(
    private readonly d: number,
    private readonly alpha: number,
    lambda = 1.0,
  ) {
    this.A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? lambda : 0)));
    this.b = Array(d).fill(0);
    this.theta = Array(d).fill(0);
  }

  score(x: number[]): number {
    const mu = this.theta.reduce((s, t, i) => s + t * x[i], 0);
    const Ainv = matInv(this.A);
    const xTAx = x.reduce((s, xi, i) => s + xi * Ainv[i].reduce((ss, aij, j) => ss + aij * x[j], 0), 0);
    return mu + this.alpha * Math.sqrt(Math.max(0, xTAx));
  }

  update(x: number[], r: number): void {
    for (let i = 0; i < this.d; i++) {
      for (let j = 0; j < this.d; j++) this.A[i][j] += x[i] * x[j];
      this.b[i] += r * x[i];
    }
    this.theta = matVec(matInv(this.A), this.b);
  }

  learnedTheta(): number[] {
    return [...this.theta];
  }
}

/** 学習済み重みの可視化 (論文用) */
export const FEATURE_NAMES = ['bias', 'capability', 'latency', 'cost', 'stability', 'confidence', 'memory', 'temperature'];

