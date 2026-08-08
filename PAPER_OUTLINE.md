# ArcAsha: An Explainable Runtime for AI Intelligence

> 論文アウトライン（v1.1 時点）。「AI Operating System」に加えて **Explainable Runtime** として位置付ける。

## 主張（Contributions）

ArcAsha は **LLM を改造しない**。LLM の外側に OS レイヤーを置いて、知能を**構成・制御・説明・学習**する。

1. **Explainable Reasoning** — なぜ Reflection / Planning / Debate を使ったのかを OS が説明（Decision Explanation）。Attention Weight より人間に理解しやすい。
2. **Explainable Scheduling** — どの Attachment を / いつ / どれだけの予算で実行するかを透明に説明（Intelligence Scheduler + Thinking Budget の可視化）。
3. **Explainable Policy Learning** — Decision Log を学習データにし、Meta Executive のポリシー（期待ゲイン）をオンライン学習（OS ポリシー学習 = Transformer の事前学習とは別軸）。

## 3 層アーキテクチャ

```
Layer 3  Intelligence Attachments（Reflection / Debate / Planning / Search / Creativity / Simulation / Coding）
Layer 2  Executive Runtime（戦略・予算・資源管理 / Meta Executive / Expert Evolution）
Layer 1  Fast Runtime（Kernel / AVM / Expert Runtime / ODAR / Device Tree — リアルタイム実行）
```

- **Fast と Deliberation の分離**: ロボット（30.3fps 維持）と研究（Deep 推論）を同一 OS で両立
- **OS の資源管理**: AVM（仮想メモリ）/ Kernel（プロセス）/ Intelligence Scheduler（知能スケジューラ）

## Validation

| 種別 | 内容 | kind |
|------|------|------|
| Simulation | 決定論評価モデル（設計上の評価） | `simulation` |
| Real Device | iPhone 15 Pro / iPad M4 / Mac 実機実測（v1.1） | `real-device` |

- 外部ベンチ: GSM8K / MATH500 / HumanEval / MBPP / MMLU / LiveCodeBench
- 同一 Qwen1.5B で OS 構成違い（単体/Thinking/+Fast/+Auto/+Deep）→ 正答率 27% → 95%
- OS Overhead: Kernel 2% / Scheduler 3-5% / AVM 5-8% / LLM 40-85%（OS を増やしても LLM が主体）

## 図表（予定）

- **Fig 1**: 3 層アーキテクチャ + OS ポリシー学習ループ（入力 → Executive → Decision → Attachment → Outcome → Policy Learning → 次回改善）
- **Fig 2**: Decision Replay（Round1 Planning → Round2 Debate → ... → Final をステップ再生）
- **Fig 3**: 実機ベンチ（Mac / iPhone 15 Pro / iPad M4 × HumanEval/MBPP/GSM8K/MATH500 × 6 指標）
- **Fig 4**: Long Context（Qwen vs AVM 4.10x）/ ロボット 30fps / OS Overhead
- **Table 1**: 外部ベンチ 5 構成
- **Table 2**: Ablation（Attachment ごとの効果 +76% / +80%）

## 再現性

- `npm install arcasha` → `arcasha benchmark` で全数値 + reports/（json/csv/md）を再生成
- 決定論コーパス・品質モデル・バージョン付き（kind=simulation と明示）

## 今後のセクション

- **v1.1**: Real Device 実測データ（6 指標）
- **v1.2**: Decision Log 大規模学習（100 万件規模の OS ポリシー学習）
- **v2.0**: 分散推論（iPhone + iPad + Mac 同時探索）

