# Changelog — ArcAsha

## v1.0.0（2026-08-06）— AI OS 第一世代リリース 🎉

**「LLM を作った」ではなく「AI の知能を OS レベルで構成・制御・計測できる実験基盤」を実現。**

### アーキテクチャ（Phases 0-4）

```
Application
  ↓
Thinking Mode（Fast / Auto / Deep / Custom）
  ↓
Attachment Manager（プラグイン層: Reflection/Debate/Planning/Search/Creativity/Simulation/Coding）
  ↓
Executive / Meta Executive（戦略・予算・資源管理 / 自己改善）
  ↓
Reasoning Runtime（Hypothesis SSA / Reasoning Tree / Search Policy）
  ↓
Expert Runtime / Kernel / AVM / ODAR / Device Tree
```

| Phase | 成果 |
|-------|------|
| 0 | AI ISA（AILSA）/ IR（AILSM v1.8）/ Compiler / Kernel / AVM / Memory Hierarchy / Observability |
| 1 | 実機実行（iPhone/iPad に Qwen2.5-1.5B を委譲）/ Hub=AI OS / ODAR 学習 |
| 2 | Reasoning Runtime / Executive / Meta Executive / Expert Evolution（分裂・統合・引退） |
| 3 | Intelligence Attachments（プラグイン）/ Thinking Modes / Validation（Ablation・ロボット 30fps） |
| 4 | Scientific Validation（Simulation と Real Device の分離）/ Real Benchmark Suite / Decision Explanation |

### ハイライト

- **Decision Explanation**: 「なぜ Reflection/Planning/Debate を使ったのか」を OS が説明（Attention Weight より人間に理解しやすい）
- **OS ポリシー学習**: Decision を学習データにして Meta Executive のポリシーを更新
- **外部ベンチ**: GSM8K/MATH500/HumanEval/MBPP/MMLU/LiveCodeBench（Simulation 評価モデル 27%→95%）
- **実証**: Fast 30.3fps（ロボット）/ Long Context 4.10x / OS オーバーヘッドは LLM 中心
- **再現可能**: `npm run benchmark` 一発で reports/（json/csv/md）自動生成、kind=simulation と明示

### リリースノート

- `arcasha benchmark` / `arcasha policy` コマンド（`npm install arcasha` で利用可）
- selftest [1]-[70] 全パス / golden 30 / ailsa:selftest / build + dist

### ロードマップ

- **v1.1**: 実機ベンチ（iPhone/iPad/Mac 同一ベンチ実測）・追試環境の充実
- **v1.2**: ポリシー改善・最適化（Decision Log の大規模学習）
- **v2.0**: 新しい研究テーマ（分散推論 / 自己改善機構）
