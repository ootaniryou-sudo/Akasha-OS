# ArcAsha vs 既存 AI Orchestration Frameworks — 比較と位置づけ

> 論文 (Zenodo 10.5281/zenodo.21755612) の Discussion 向けに、ArcAsha を既存フレームワークと
> 比較し、独自性を明確にする。評価は 2026-08 時点の公開情報に基づく概念比較。

## 1. 比較サマリ

| 側面 | **ArcAsha** | LangGraph | DSPy | AutoGen | CrewAI | OpenAI Agents SDK |
|------|------------|-----------|------|---------|--------|-------------------|
| **コア抽象** | Belief (状態推定) が全判断を駆動 | 状態機械 (グラフ) | プロンプト/オプティマイザ | マルチエージェント会話 | 役割ベース Crew | ハンドオフ/ツール |
| **ルーティング** | **学習** (LinUCB-Shadow, フル情報フィードバック) | 手書きエッジ条件 | コンパイラが決定 | 会話ベース | タスク委譲規則 | ハンドオフ関数 |
| **異種 LLM プール** | **第一級** (専門エキスパート群を状態推定で統合) | ノード単位で可能 (手動) | モデル選択は optimizer | 部分的 | 部分的 | 部分的 |
| **エキスパート能力推定** | **Bayesian Belief (μ, n, confidence)** | なし | なし | なし | なし | なし |
| **フィードバック構造** | **Shadow (Full-Information)** + 検証スコア | なし | メトリック | 会話報酬 | なし | なし |
| **自己改善** | **Belief-driven Reflection** (原因診断 → re-route/分割) | 手書き再試行 | 最適化ループ | エージェント間訂正 | なし | なし |
| **記憶** | **Closed Bayesian Loop (μ₀→μ→μ₀')** | チェックポインター/永続化 | 例の蓄積 | 会話履歴 | 知識ベース | なし |
| **探索** | **Belief-guided Tree Search (Beam)** | なし | 検索 (一部) | なし | なし | なし |
| **統計検証** | 30-seed 対応 Wilcoxon / Cohen's d | なし | 一部 | なし | なし | なし |
| **再現性** | T=0 決定論 + (node,prompt) キャッシュ | 実行依存 | 最適化依存 | 会話依存 | 実行依存 | 実行依存 |
| **実装規模** | 自己完結 (TypeScript, 依存最小) | 中 | 中 | 大 | 中 | 中 |

## 2. 各フレームワークとの関係

### LangGraph (LangChain)
- **設計**: ノード/エッジの明示的グラフ (状態機械)。制御フローは開発者が手で記述。
- **ArcAsha との差**: LangGraph は**構造を宣言**する; ArcAsha は**信念から構造を生成**する
  (Emergent Policy)。LangGraph のエッジ条件は手書きだが、ArcAsha のルーティングは
  シャドウフィードバックから学習される。**補完関係** — ArcAsha の Router/Planner を
  LangGraph のノードとして埋め込むことも可能。

### DSPy
- **設計**: モジュール (LM 呼び出し) を「コンパイル」し、プロンプト/デモをメトリックで最適化。
- **ArcAsha との差**: DSPy は**プロンプトレベル**の最適化; ArcAsha は**エキスパート選択と
  実行ポリシー**の最適化。DSPy は単一/少数モデルを前提、ArcAsha は異種プールを前提。
  シャドウ評価 (フル情報) という情報構造の理論が ArcAsha の独自点。

### AutoGen / CrewAI
- **設計**: マルチエージェント会話 (AutoGen) / 役割ベース Crew とタスク委譲 (CrewAI)。
- **ArcAsha との差**: 両者は**エージェント間のやり取り**で問題を解く; ArcAsha は
  **信念ベースの実行系**がルーティングを学習し、検証・反射で品質を担保する。
  会話のコスト/非決定的さに対し、ArcAsha は決定論的で再現可能。

### OpenAI Agents SDK
- **設計**: エージェント + ツール + ハンドオフ (関数型制御フロー)。
- **ArcAsha との差**: 制御フローは明示的; 学習・状態推定・フル情報フィードバックは不在。

## 3. ArcAsha の独自性 (主張)

> **Belief を唯一の共有状態とし、Routing / Planning / Memory / Reflection のすべてが
> その信念から導かれる** — これが ArcAsha を既存フレームワークから分ける中心原理。

1. **Observation → Belief が第一級市民**: エキスパートの能力を観測から推定し、未知環境でも
   適応する (EXP-0003A: Regret −75.7%, F: capability +37.6%)。
2. **Full-Information (Shadow) フィードバック**: 情報構造を理論の中心に据え、
   部分情報の不利を排除 (C.2→C.3: 94% gap 解消, D: p<0.001)。
3. **Closed Bayesian Loop**: Memory が事前分布 μ₀ を生成し、観測が事後 μ へ更新、
   エピソードが次の μ₀' になる — ベイズ更新そのものとして記憶が機能。
4. **Belief-driven Reflection / Tree Search**: 探索と自己改善にも信念を利用 (Beam 枝刈り、
   失敗原因診断)。LLM を探索に連続呼び出ししないため探索コストが低い。
5. **統計的に検証済み**: 30-seed 対応 Wilcoxon / Cohen's d / Cliff's delta、2 モデルセット
   一般化 (D, E)、アブレーション (F)。

## 4. 限界と今後の比較実験

- **限界**: ルールベース評価器 (evaluateTask) に依存; 大規模ベンチマーク (HumanEval/GSM8K) では
  LLM-as-judge や実行ベース評価に置き換えが必要。計算予算はローカル 3 モデル。
- **今後**: (a) 同一タスクセットで LangGraph/DSPy 等を実行しスループット/品質を比較、
  (b) モデルセット拡張 (Llama/Phi/Mistral/DeepSeek)、(c) HumanEval/GSM8K/MBPP での評価。

---

*ArcAsha — Belief-Driven AI Orchestration. Paper: 10.5281/zenodo.21755612*

