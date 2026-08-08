/**
 * arcasha-router — Bayesian Belief (EXP-0002D.1 / 0003 系)
 *
 * 観測から信念を更新し、confidence (1-exp(-n/8)) と effective (μ×confidence) を提供。
 * Belief-Driven AI Orchestration の核心 (状態推定)。
 */

export interface BeliefSnapshot {
  mu: number;
  n: number;
  confidence: number;
  effective: number;
}

export interface BeliefSeed {
  mu: number;
  n: number;
}

export class BayesianBelief {
  private mu = 0.5;
  private n = 0;

  /**
   * 事前分布シード: Long-term Memory から集計した μ₀/n₀ で初期化
   * (Closed Bayesian Loop: Memory → Prior μ₀ → Observation → Posterior μ)
   */
  constructor(seed?: BeliefSeed) {
    if (seed && seed.n > 0) {
      this.mu = Math.max(0, Math.min(1, seed.mu));
      this.n = Math.floor(seed.n);
    }
  }

  /** 観測 x (0-1) でベイズ更新 (標本平均) */
  update(x: number): void {
    this.mu = (this.n * this.mu + x) / (this.n + 1);
    this.n += 1;
  }

  /** 信頼度: 観測数に応じて 0 → 1 */
  confidence(): number {
    return 1 - Math.exp(-this.n / 8);
  }

  /** 効果値: μ × confidence (二段階の信頼度加重) */
  effective(): number {
    return this.mu * this.confidence();
  }

  snapshot(): BeliefSnapshot {
    const mu = Math.round(this.mu * 1000) / 1000;
    const confidence = Math.round(this.confidence() * 1000) / 1000;
    const effective = Math.round(this.effective() * 1000) / 1000;
    return { mu, n: this.n, confidence, effective };
  }
}

/** EMA によるレイテンシ平滑化 */
export class EmaLatency {
  private ema = 0;
  private n = 0;

  observe(measured: number): number {
    const alpha = 0.3;
    this.ema = this.n === 0 ? measured : alpha * measured + (1 - alpha) * this.ema;
    this.n += 1;
    return Math.round(this.ema);
  }

  value(): number {
    return Math.round(this.ema);
  }
}

