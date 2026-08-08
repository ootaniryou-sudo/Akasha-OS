# ArcAsha v1.0 — Quickstart

「OS が推論を管理する」を 5 分で体感できます。

## インストール

```bash
# ローカル（このリポジトリ）
npm install
npm run build

# または npm パッケージとして
npm install arcasha
```

## 実行

```bash
# 全ベンチマーク（Simulation）+ Decision Explanation + Real Device + reports/ 生成
npx arcasha benchmark        # または npm run benchmark

# OS ポリシー学習デモ（Decision Explanation を学習データにする）
npx arcasha policy           # または npm run arcasha -- policy

# クイックスタート（Thinking Mode / Decision Explanation / Executive / Policy Learning）
npx tsx examples/quickstart.ts
```

## 何ができるか

| コマンド | 内容 |
|----------|------|
| `arcasha benchmark` | GSM8K/MATH500/HumanEval/MBPP/MMLU/LiveCodeBench を Qwen1.5B（単体/Thinking/+Fast/+Auto/+Deep）で評価。`reports/benchmark/report.{json,csv,md}` を自動生成（kind=simulation） |
| `arcasha policy` | Decision Log → OS ポリシー学習 → 期待ゲインが実測で更新される |
| `examples/quickstart.ts` | Thinking Mode → Decision Explanation → Executive → Policy Learning の一連 |

## 論文用の 3 層

- **Layer 1: Fast Runtime** — リアルタイム実行（ロボット・エッジ AI）
- **Layer 2: Executive Runtime** — 戦略・予算・資源管理
- **Layer 3: Intelligence Attachments** — 高度推論・議論・創造（プラグイン）

詳細はリポジトリルートの仕様書（`AI_VALIDATION.md` / `AI_ATTACHMENTS.md` / `AI_REASONING.md`）を参照。

