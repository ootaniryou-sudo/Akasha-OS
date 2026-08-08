# Changelog — ArcAsha

## v1.2（2026-08-07）— Hierarchy / Cognitive Graph / Caravan スケーラビリティ

- **Cognitive Graph Runtime（Composable Intelligence Runtime）**: `src/arcasha/cognitive/`
  - **「モデルを選ぶ」のではなく「タスクごとに知能の配線を動的生成する」**（Task-Specific Dynamic Cognitive Graph）
  - AI Pool（未所属 Expert）→ Capability Graph（凸凹=データ型）→ 動的チーム編成
  - **共有タスクメモリ + AILSM IR で会話**（自然言語不要）: vision が object-list を書き、physics が読んで trajectory を書く
  - **Team Learning**: 成功率でチーム編成を学習（vision>physics>coding 95% を優先）
  - **Knowledge Oasis**: Task/Reasoning/Team/Policy/Lesson の長期記憶 + 権限（Need-to-know）+ Runtime Knowledge Base 検索
  - `npx arcasha cognitive` / 仕様 `AI_COGNITIVE.md` / selftest [75]
- **Hierarchy Runtime**: 階層型知能ランタイム `src/arcasha/hierarchy/`
  - 階層: **Master → Caravan（Role 付き）→ Device → Expert**（最終形は Human → Executive → Cluster → Computer → LLM → Reasoning の 6 階層）
  - 各階層が **Decision / Policy / Budget / Memory** を持ち「**考える → 判断する → 命令する → 学習する**」を自律的に行う
  - Caravan は Role 付き（Vision / Language / Math / Planning / Search）— 脳の領域のような役割分担
  - **階層間は「情報要約」でやり取り**（下位の詳細をそのまま上位へ送らない）
  - 各階層が独立に学習（Memory に outcome を記録、EMA でポリシー更新）
  - `npx arcasha hierarchy` でデモ実行
- **Validation F: Caravan スケーラビリティ**（v2 優先順位 2）— キャラバン分割がスケールすることを定量実証
  - フラット vs キャラバン比較: 10,000 台でも Master は 1,000 キャラバンを管理するだけ（**9.99x 削減**）
  - 探索コスト 10,000 → 1,010 に圧縮 / 2 ホップルーティング
  - `npm run benchmark` に統合（report.json の `caravanScaling` / report.md の Caravan セクション）
- **Validation G: Lesson Memory / Team Learning の効果** — 「モデルを再学習しなくても OS が賢くなる」ことを定量実証
  - 1000 タスクで Naive vs Learned: 成功率 67% → 93%（+26pt）・遅延 714→637ms・品質 +28pt
  - 学習が進むほど改善（warmup 75% → late 93%）— ε-greedy 探索→活用で最適チームに収束
  - `npm run benchmark` に統合（report.json の `oasisLearning` / report.md の Lesson Memory セクション）
- selftest [73] / [74] / [76]

> **v2 研究テーマ**: Intelligence is not a monolithic model, but a hierarchical runtime
> composed of autonomous decision layers.（知能は単一モデルではなく、自律的な意思決定層から構成される階層的ランタイム）

## v1.1（2026-08-06）— Decision Replay / 実機プラン

- **Decision Replay**: 「なぜこの回答になったのか」を Round1-4 のステップ再生（理由・ゲイン・出力つき）。`npx arcasha replay`
- **Real Device プラン**: Mac / iPhone 15 Pro / iPad M4 × HumanEval/MBPP/GSM8K/MATH500 × 6 指標（未接続時は not-connected）
- **PAPER_OUTLINE.md**: 「ArcAsha: An Explainable Runtime for AI Intelligence」
- selftest [72]

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

