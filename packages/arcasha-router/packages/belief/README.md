# @arcasha/belief

Bayesian 状態推定 — 依存なしで他研究にも再利用可能。

```ts
import { BayesianBelief } from '@arcasha/belief';

const b = new BayesianBelief();        // μ=0.5, n=0
b.update(0.9);                          // 観測でベイズ更新
b.snapshot();                           // { mu, n, confidence, effective }
const p = new BayesianBelief({ mu: 0.62, n: 3 }); // 事前分布シード (Closed Bayesian Loop)
```

- `confidence(n) = 1 - exp(-n/8)` — 知識の充足度
- `effective = μ × confidence` — 二段階信頼度加重
- `EmaLatency` (α=0.3) — レイテンシ平滑化

> MIT License — ArcAsha.
