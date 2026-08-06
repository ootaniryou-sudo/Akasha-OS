# AI_COGNITIVE.md — Composable Intelligence Runtime（Cognitive Graph Runtime）

**v1.2 / 研究テーマ（v2: Hierarchical Runtime Intelligence の一角）**

> **「モデルを選ぶ」のではなく、「タスクごとに知能の配線を生成する」。**
>
> Transformer は推論時の計算グラフが固定。MoE は一部の Expert を選ぶが構造は変わらない。
> 一方、ArcAsha の Cognitive Graph Runtime は:
> 1. AI Pool から Expert を選ぶ
> 2. Expert 同士をその場で接続する（凸凹 = データ型）
> 3. 共通メモリを共有する（Shared Task Memory）
> 4. IR（AILSM）で通信する（自然言語不要）
> 5. タスク終了後に解散する

---

## 1. コンセプト: Task-Specific Dynamic Cognitive Graph

「AI モデルを作り出す」のではなく「一時的な認知ネットワーク（Cognitive Network）」を作る。

```
AI Pool（誰も所属していない）
□ Math  △ Vision  ○ Coding  ◇ Planning  ⬟ Physics  ⬢ Search  ⬡ Memory
        │  タスク「自律飛行ドローンを設計して」
        ▼
Caravan がチーム編成（一時的）
Planning → Vision → Physics → Coding → Memory
        │
        ▼
タスク完了 → 解散 → プールへ戻る
```

### 砂漠のキャラバン比喩

| 概念 | 技術対応 |
|------|---------|
| **Caravan** | タスクごとに一時編成される実行チーム |
| **Journey** | Reasoning Graph（推論の旅） |
| **Oasis** | 長期記憶に保存された経験・教訓（Knowledge Oasis） |
| **Trade Route** | オアシス同士を結ぶ知識検索・参照経路（Runtime Knowledge Base） |
| **Master** | どのオアシスを経由すべきか判断する司令官 |

> ArcAsha は「経験を積み重ねる巨大なモデル」ではなく、
> 「旅を繰り返しながらオアシスを築き、次の旅人へ知識を受け継ぐ AI OS」。

---

## 2. Capability Graph（凸凹 = データ型）

各 Expert は inputType / outputType を持つ。型の一致が「接続可能性」になる。

```
Vision    input: camera       output: object-list
Physics   input: object-list  output: trajectory
Coding    input: trajectory   output: program
```

型チェーンで自動配線:

```
camera → Vision → object-list → Physics → trajectory → Coding → program
```

`composeTeam(pool, task)` が:
1. タスクの Role 要件を検出（ドメイン補完込み）
2. 型チェーンで実行順を決定（出力型が次の入力型になる Expert を優先）
3. 型が合わない箇所は共有メモリ（Memory Expert）を経由

---

## 3. 共有タスクメモリ + IR 通信

普通の Agent は「AgentA → LLM → 結果 → AgentB」のパイプライン。
ArcAsha は全 Expert が共有メモリ（Shared Task Memory）を読み書きし、**AILSM IR だけで会話**する。

```
[vision]   write object-list: [door(conf 0.93), obstacle(conf 0.63)]
[physics]  read  object-list → write trajectory: [waypoints=2, risk=0.22]
[coding]   read  trajectory  → write program: [plan=motor-control-v4, lines=19]
```

自然言語は不要。型付きデータ（IR）がメモリを流れる。

---

## 4. Team Learning（チーム編成の学習）

1000 回仕事をすると、成功率の高いチーム編成を自然に優先する。

```
planning>vision>physics>coding   成功率 95%  ← 次回から優先
planning>vision>coding           成功率 40%
```

- `TeamLearner.record(teamKey, success, quality)` で蓄積
- `recommend(candidates)` が成功率の高いチームを推奨
- これは**モデルの重みではなく OS レベルの運用知識**（再学習不要）

---

## 5. Knowledge Oasis（長期記憶）

タスク完了ごとに、経験を IR だけで保存する。

```
TASK    robot_navigation
TEAM    Planning, Vision, Physics, Coding
GRAPH   Planning→Vision, Vision→Physics, Physics→Coding
RESULT  success
LESSON  Physics before Coding  confidence 0.94
```

### アーカイブ構成

```
Long Memory
├── Task Archive      （何をやったか = 履歴）
├── Reasoning Archive （どう考えたか = 仮説・配線）
├── Team Archive      （誰がやったか）
├── Policy Archive    （何を学習したか = Meta Executive がチーム編成を学ぶ）
├── Lesson Archive    （今回何を学んだか = 知識抽出）
└── Runtime Knowledge Base（類似タスク検索・成功率順のチーム推奨）
```

### 権限（Need-to-know）

| ロール | 見える範囲 |
|--------|-----------|
| Master | 全部 |
| Caravan | Task / Reasoning / Policy |
| Expert | Task / Reasoning だけ |
| Attachment | 必要部分だけ |

100 万件になっても Expert が全部読むのは無駄 → 必要な部分だけ見せる。

---

## 6. 実装

- `src/arcasha/cognitive/pool.ts` — AI Pool（未所属 Expert）
- `src/arcasha/cognitive/capability-graph.ts` — Capability Graph + composeTeam（凸凹=データ型）
- `src/arcasha/cognitive/runtime.ts` — runCognitive（共有メモリ + IR 通信）
- `src/arcasha/cognitive/team-learning.ts` — TeamLearner（チーム編成学習）
- `src/arcasha/cognitive/oasis.ts` — KnowledgeOasis（長期記憶 + 権限 + 検索）
- `src/arcasha/cognitive/demo.ts` — デモ

実行:
```bash
npx tsx src/arcasha/cognitive/demo.ts   # または npm run arcasha -- cognitive
```

selftest: [75]（AI Pool / Capability Graph / 型チェーン編成 / 共有メモリ + IR / Team Learning / Oasis 権限・検索）

---

## 7. 研究上の位置付け

蓄積されるのは **LLM の重み（パラメータ）ではない**:

- どんなチーム編成が成功したか
- どんな推論経路が成功したか
- どんな Executive の判断が良かったか
- どんな Lesson が得られたか

つまり **モデルの知識と OS の運用知識を分離して成長させる** アーキテクチャ。
ArcAsha-OS 全体が経験を積むほど賢くなる（モデルを再学習しなくても）。

これは MoE / マルチエージェントとも異なる:
- MoE: 一部の Expert を選ぶがネットワーク構造は固定
- マルチエージェント: エージェント間の通信が自然言語（または固定フレームワーク）
- **ArcAsha: 型付き IR で動的配線・共有メモリ・タスク完了で解散・経験をオアシスに蓄積**
