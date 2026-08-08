# AI_IR_MODEL.md — IR とモデルの関係（ArcAsha の実行モデルの真実）

> **「IR はモデル同士の言語」ではなく「OS の内部バス」である。**
> モデルは IR を理解していない。OS のドライバ（RemoteDriver）が IR とモデルを橋渡しする。

| 項目 | 値 |
|------|-----|
| Status | **Spec v1.0（実装に基づく概念整理）** |
| Date | 2026-08-07 |
| 実装 | `src/arcasha/ailsm/remote-driver.ts`, `driver.ts`, `aios.ts`, `normalizer.ts`, `generator.ts`, `compiler.ts` |
| 関連 | `ARCASHA_V2_SPEC.md`, `AILSA_ISA.md`, `AILSM_IR.md`, `AILSA_RUNTIME.md`, `AI_ABI.md` |

---

## 1. なぜこの文書が必要か

ArcAsha の宣伝文句は「自然言語は入口と出口だけ。内部は全て AILSA / AILSM」だが、
**これは「OS 内部の配線が IR である」ことを意味し、「モデル自身が IR を話す」ことを意味しない**。

誤解の典型:

> ❌ 「モデル同士が AILSA で会話している」
> ✅ 「OS のドライバが AILSA を読み、モデルへは自然言語プロンプトを渡す」

この文書は、実際の実装がどう動くかを正確に説明し、
「IR ネイティブモデル」や「NL を覚えない AI」の最終形を正しく位置付ける。

---

## 2. 中心的な事実：モデルは IR を「理解していない」

### 2.1 実際のデータフロー

```
① OS が AILSA 命令列を作る:
   CALL  SLOT_EXPERT=general  SLOT_INPUT="鎌倉幕府はいつ？"

② RemoteDriver.buildLlmPrompt() が「INPUT スロットの値だけ」を取り出す:
   → "鎌倉幕府はいつ？"        ← モデルには NL だけ渡る

③ 実機 LLM（Qwen 等）が NL で回答:
   → "1192年です"             ← モデルは IR の存在すら知らない

④ OS が回答を RESULT スロットに載せて IR に戻す:
   RETURN  SLOT_RESULT="1192年です"
```

### 2.2 USB デバイスの比喩

| コンピュータ | ArcAsha |
|-------------|---------|
| USB コントローラ | RemoteDriver（IR ⇔ NL 変換） |
| USB バス | AILSA（IR） |
| プリンタ / マウス | LLM（Qwen 等、NL だけ知っている） |

USB プロトコルを理解しているのはコントローラ（OS）であり、
プリンタは「自分の電気信号」を出すだけ。ArcAsha も同じで、
**IR を読んで解釈するのは OS 側（ドライバ）であり、モデルではない**。

### 2.3 実装の根拠

`remote-driver.ts`:

```typescript
/** AILSA 命令列 → LLM プロンプト（INPUT スロットを結合） */
export function buildLlmPrompt(program: Instruction[]): string {
  const parts: string[] = [];
  for (const instr of program) {
    const input = instr.slots?.find((s) => s.slot === Slot.INPUT)?.value;
    if (input !== undefined) parts.push(String(input));
  }
  return parts.join(' / ') || '...';
}
```

`RemoteDriver.invoke()` はこのプロンプトを実機の LLM に渡し、
生成結果を `result` として返す。**モデルは常に自然言語で入出力**する。

---

## 3. IR の本当の役割：制御プレーンとデータプレーン

AILSA は「閉じた語彙（命令）+ 開いたスロット（値）」の 2 層構造。

| レイヤ | 何が IR になるのか | 実体 |
|--------|------------------|------|
| **制御プレーン** | 誰に・何を・どうする（CALL / RETURN / ドメイン / 検証） | **閉じた語彙**（Opcode 0x30-0x3E 等） |
| **データプレーン** | コード・テキスト・数式（成果物そのもの） | **開いたスロット**（`SLOT_INPUT` / `SLOT_RESULT` の値） |

- **IR が「翻訳」しているのは制御構造**（どの Expert に、どのドメインで、どう検証するか）
- **成果物のコンテンツは IR のスロットに文字列としてそのまま載って運ばれる**
- モデルは自然言語を理解できるので、スロットの値を取り出して渡せば良い

つまり「IR が生成する」のではなく、**「IR が運ぶ器（コンテナ）になり、中身は実モデルが生成する」**。

---

## 4. タスクの 3 層仕分け（OS のルーティング判断）

「全部を IR に載せる」のではなく、タスクを 3 層に仕分けるのが OS の仕事。

| 層 | タスク例 | 経路 | 実装 |
|----|---------|------|------|
| **1. 決定論で解ける** | 2+3、√9、積分 | コンパイラ → Executor（LLM 不要） | `executor.ts` |
| **2. 専門 IR に載る** | コード生成、検索、要約 | コンパイラ → 専門 Expert | `normalizer.ts` / `generator.ts` |
| **3. どちらでもない**（歴史・会話・世界知識） | 「鎌倉幕府はいつ成立した？」 | **Stage-2 フォールバック → 実機 LLM** | `aios.ts` の `fallbackExecute` |

### 4.1 歴史の質問の流れ

```
「鎌倉幕府はいつ成立した？」
  → Normalizer: intent = 'unknown'（どの専門語彙にも当てはまらない）
  → コンパイラ: AilsmError（解釈不能）
  → fallbackExecute:
      { opcode: CALL, slots: [EXPERT=general, INPUT="鎌倉幕府はいつ成立した？"] }
  → 実機 LLM（Qwen 等）が普通に回答
```

### 4.2 設計判断

- **専門 IR に載せる意味がない** — 数学やコードと違い、構造化して検証する利点が薄い
- **専門 IR に載せると劣化する** — 汎用 LLM に任せた方が正しい答えが出る
- **ルーティングの判断自体が OS の仕事** — これが「OS」たる所以

---

## 5. モデルの種類（現在と将来）

### 5.1 現在（ハイブリッド）

| モデル | IR を知っている？ | 役割 | 例 |
|--------|-----------------|------|-----|
| **汎用 NL モデル** | 知らない（OS が橋渡し） | 歴史・会話・世界知識・コードも生成 | Qwen2.5-1.5B（iPad/iPhone） |
| **Mock 専門ドライバ** | IR を直接実行（決定論） | 数学・検索・計画のスタブ | `MockExpertDriver` |

- **すべての実モデルは NL だけを理解**し、OS のドライバが IR と NL の橋渡しをする
- `MockExpertDriver` だけが「IR を直接実行する」特殊な存在（LLM なしの決定論エキスパート）

### 5.2 将来（Phase 5 蒸留後）

| モデル | IR を知っている？ | 役割 |
|--------|-----------------|------|
| **IR ネイティブ専門モデル** | ✅ 知っている（AILSA を直接話す） | Math / Code / Search 専用 |
| **汎用 NL モデル（General）** | 知らない（OS が橋渡し） | 歴史・会話・世界知識 |

将来も「IR を話す専門モデル」と「NL を話す汎用モデル」を**使い分けて同居**させる。
General は永遠に IR を学ぶ必要がない — OS のドライバが橋渡しするから。

---

## 6. IR ネイティブモデルへの道（Phase 4 → 5 → 6）

| Phase | 内容 | 基盤 |
|-------|------|------|
| **4** | 専門 AILSA モデルの蒸留（LLM 生成ペアで小モデルを学習） | `training/` 拡張（既存 `finetune.py`） |
| **5** | **AILSA ネイティブ小型モデル**（自然言語を一切知らない専門 IR モデル） | 新規モデル |
| **6** | 分散 MoE クラスタ | エンドツーエンド |

### 6.1 蒸留の仕組み（Phase 4）

現行のハイブリッド経路を「教師」にして、`(自然言語, AILSA命令列+結果)` のペアを収集し、
小型モデルを QLoRA ファインチューニングする。**閉じた語彙が蒸留に効く理由**:

1. **出力空間が極端に小さい** — 制御語彙は約 100〜300 トークン
2. **正準化で学習データが激減** — 同じ意味 = 常に同じ Token ID 列（`TASK_SOLVE EQ_LINEAR VAR_X`）
3. **生成→検証→修復ループ** — 閉じた語彙は厳密パーサーで検証でき、不正なら再プロンプト
4. **小型モデルでも出せる** — JSON ツール呼び出し形式と同型（Qwen2.5-1.5B クラスでも可能）

### 6.2 文法制約付き生成（Constrained Decoding）

閉じた語彙はさらに強力なことに使える。**生成の各ステップで「次に来てよいトークン」を文法で制約**する。

```
CALL の後は SLOT_* か RETURN しか来てはいけない
SLOT_DOMAIN の後は code | math | search | reasoning しか来てはいけない
```

これならモデルが NL を生成する「隙」が構造的に存在しない。

---

## 7. 「NL を覚えない AI」の正しい定義

「NL を覚えない」には 2 つの意味があり、1 つは完全に可能、もう 1 つは意味の取り違え。

| 意味 | 内容 | 可能？ |
|------|------|--------|
| A. **人間の散文（日本語・英語の会話）を生成しない** | モデルが出力するのは AILSA トークン + コード・数式だけ | ✅ **可能** |
| B. **文字列（コード・数式）も生成しない** | 「NL を一切知らない = 何も文字を出さない」 | ❌ それは AI ではない |

**コードは自然言語ではない**。数式も、楽譜も、化学式も — どれも「言語」だが「自然言語」ではない。
コードを生成する能力と、日本語の散文を生成する能力は別物。

### 7.1 実現の 3 技術

1. **出力語彙の制限** — AILSA トークン + スロット値（コード・数式）だけに限定
2. **文法制約付き生成** — 次トークンを文法で制約（NL を生成する隙がない）
3. **OS が NL を担当** — 人間との対話は Front-end / Back-end Compiler の仕事

### 7.2 正直な限界

- **コードには NL が滲む** — コメント・変数名・識別子は自然言語由来。ただし「理解」の話であって「散文を生成する」こととは違う。コメント禁止・識別子規約でほぼ回避可能
- **蒸留の教師は NL を読む** — しかし学習後の生徒モデルは NL を知らないまま専門 IR だけを話せる
- **内部表現は共有されうる** — しかし観測可能な出力（生成トークン列）を制約できれば、「NL を生成しない AI」はシステムとして成立

---

## 8. IR の定義：知識の言語ではなく実行言語

> **IR is not a representation of knowledge. IR is a representation of reasoning control and execution flow.**
> （IR は知識を表現するものではない。推論の制御と実行フローを表現するものである。）

**これは ArcAsha 全体を貫く最重要の定義**。これを間違えると「歴史や文学は全部 IR で書けるの？」という誤った問いになる。

### 8.1 人間の会社で例えると

社長が「来月までに新製品を作って」と言い、社員（設計・営業・製造・品質管理）は会話する。
しかし彼らは毎回「こんにちは。今日は…」と自然言語だけで仕事はしない。

```
Task #145
Owner    : Design
Deadline : 8/20
Status   : Running
Dependency: Task#143
```

これは知識ではなく**仕事を進めるための状態**。ArcAsha も同じで、IR はこの管理情報に相当する。

### 8.2 ArcAsha で言うと

```
「PythonでWebサーバーを書いて」
  → Master が TASK を作る
  → PLAN → CODE → BUILD → TEST → REVIEW（全部 IR）
```

Coding Expert は自然言語を理解している必要はない。必要なのは `PLAN` を理解できること。

```
「織田信長について教えて」
  → IR: SEARCH / DOMAIN=history / ENTITY=織田信長 / GOAL=summary まで
  → その後は History Expert が知識を持つ
```

**IR は「織田信長とは○○」を保存しない。**

### 8.3 IR が保存するもの vs 知識を持つもの

| IR が保存するもの | 知識を持つもの |
|-------------------|----------------|
| `SEARCH` `SUMMARY` `COMPARE` `VERIFY` | History Expert |
| `PLAN` `RETRY` `MERGE` `REFLECT` | General Model |
| — 思考や実行の流れ | Vision Model / Memory |

**IR が持つのは「誰が・何を・いつ・どの順番で・どこへ渡すか」だけ。**

### 8.4 Linux の比喩

`read()` / `write()` / `fork()` / `exec()` は本も動画も保存していない。
ただ「どう扱うか」を決めているだけ。**ArcAsha の IR も同じ**。

### 8.5 だから IR は永遠に小さい

10 年後、知識が 1000 倍になっても、IR は `SEARCH` / `PLAN` / `VERIFY` / `MERGE` / `EXECUTE`
くらいしか増えない。**IR の大きさは知識量と無関係**。

この定義にすると、History / Coding / Math / Vision Expert がどれだけ増えても、
**全員が同じ IR で会話できる理由**が明確になる。

---

## 9. 段階的 IR ネイティブ化ロードマップ（レベル 0 → 3）

「全部 IR 化する」のではなく**「IR 化できるものから IR 化する」**。
これは既存の Phase 4 → 5 → 6（蒸留 → ネイティブ → 分散）を領域別に具体化したもの。

| レベル | 内容 | 対象 | 理由 |
|--------|------|------|------|
| **Lv0（現在）** | 全部 General LLM が担当 | 全タスク | — |
| **Lv1** | まず IR ネイティブ化しやすい専門 2 種 | **Math, Coding** | 入力が構造化しやすい / 正解がある / 蒸留しやすい |
| **Lv2** | OS そのもの | **Search, Planning, Tool Calling, Scheduling** | OS 自身なので自然言語がほぼ不要 |
| **Lv3** | 構造化しやすい感覚系 | **Vision, Robot, Navigation** | `DETECT_OBJECT class=person x=...` の世界 |
| **最後** | 自然言語そのものが知識 | **歴史・哲学・文学・雑談・感情・創作** | 完全 IR 化はかなり難しい |

### 9.1 Lv1 の例（Math）

```
IR: SOLVE equation=x^2-9 goal=find_roots
  → Math Expert
  → ROOTS=[3,-3]
```

### 9.2 最後の層が難しい理由

「なぜ本能寺の変が起きたの？」の答えには政治・経済・人間関係・仮説が全部混ざる。
`PERSON#18273` だけでは説明できない。**自然言語そのものが知識**だから。

### 9.3 二層構造（IR Native + General LLM の同居）

```
                Master
                   │
                  IR
                   │
        ┌──────────────┐
        │              │
 IR Native        General LLM
 Experts
```

| 依頼 | 担当 |
|------|------|
| Math | Math Expert（IR Native） |
| Python を書く | Coding Expert（IR Native） |
| 画像認識 | Vision Expert（IR Native） |
| 歴史を説明 | General History LLM |
| 雑談 | General Chat LLM |

**IR ネイティブな Expert がどんどん増えていく世界。**

### 9.4 5 年後の姿

Math / Coding / Planning / Vision / Robot / Navigation / Tool / Memory が全部 IR ネイティブになったとき、
**General LLM が担当するのは歴史・哲学・小説・会話だけ** — General LLM は「最後の知識辞典」になる。

### 9.5 論文での書き方

> 「最初からすべてを IR ネイティブ化する」ではなく、
> **「IR ネイティブ化しやすい専門領域（Math・Coding・Planning など）から段階的に置き換え、
> 自然言語依存の強い領域は General モデルに委譲するハイブリッド構成を採用する」**

この書き方は実現可能性が高く、査読者にも受け入れられやすい。

---

## 10. Control IR / Domain IR の二層構造

### 10.1 提案

IR 自体を二層構造に発展させる可能性:

| 層 | 内容 | 例 |
|----|------|-----|
| **Control IR** | OS 全体で共通の実行命令 | `PLAN` `SEARCH` `MERGE` `VERIFY` |
| **Domain IR** | 各分野に最適化された構造表現 | Math なら数式木 / Coding なら AST / Vision なら物体・座標・関係グラフ |

- 制御は共通 IR、専門知識は各分野に最適化された IR で扱う
- **OS としての統一性を保ちながら**、専門分野は自然言語より効率的に処理できる

### 10.2 これは実は既に仕様に存在する（重要）

この二層構造は **設計当初からのビジョン** であり、`ARCASHA_V2_SPEC.md` に明記されている:

> 「**専門家ごとに IR が異なる**ことが設計の核心。共通 AILSA は『**翻訳・中継**』のための言語であり、
> 各エキスパートは自ドメインの IR で最も効率よく推論する」

| 層 | 既存仕様での対応 | Token 範囲 |
|----|------------------|-----------|
| **Control IR** | 共通 AILSA（基本命令） | `CALL` `RETURN` `STORE` `LOAD` ...（0x30-0x3E） |
| **Domain IR: Math** | **AILSA-M** | `EQ` `DERIVE` `MATRIX` `INTEGRAL` ...（0x40-0x4F） |
| **Domain IR: Code** | **AILSA-C** | `FUNCTION` `CLASS` `PATCH` `TEST` ...（0x50-0x5F） |
| **Domain IR: Search** | **AILSA-S** | `QUERY` `FILTER` `RANK` ...（0x60-0x6F） |
| **Domain IR: Reasoning** | **AILSA-R** | `CAUSE` `PLAN` `VERIFY` ...（0x70-0x7F） |
| **Domain IR: Vision** | **AILSA-V**（将来） | 画像入力 |

つまり「Control IR + Domain IR の二層構造」は新しい提案ではなく、
**ArcAsha が最初から持っていた設計を、あなたの言葉で再定義したもの**。
この §3（制御プレーン / データプレーン）と §10（Control / Domain IR）は同じ構造を
「閉じた語彙 vs 開いたスロット」と「共通 IR vs 専門 IR」の 2 つの視点で見たもの。

---

## 11. まとめ

1. **IR はモデル同士の言語ではなく、OS の内部バス** — モデルは IR を知らなくても動く
2. **モデルを IR に接続するのはドライバ（RemoteDriver）** — モデルは常に NL で入出力
3. **タスクは 3 層に仕分け** — 決定論 / 専門 IR / General 委譲（歴史・会話は General）
4. **IR ネイティブ化は Phase 4-6** — 蒸留で「制御プレーンを話せる専門モデル」を作る。コンテンツ（コード）は常にスロット値として運ばれる
5. **「NL を覚えない AI」は可能** — 「散文を生成しない」という意味で。OS の構造（閉じた語彙 + 文法制約 + Front-end/Back-end 分離）がそれを技術的に保証する
6. **モデルが IR を「話す」かどうかはモデルごとに違ってよく、それを吸収するのが OS の仕事**
7. **IR は知識の言語ではなく、推論の制御と実行フローの言語** — 知識は各 Expert / Memory が持ち、IR は「誰が・何を・いつ・どの順番で・どこへ渡すか」だけを持つ。だから IR は知識量と無関係に永遠に小さい
8. **IR ネイティブ化は「全部」ではなく「できるものから」** — Math・Coding（Lv1）→ Search・Planning・Tool・Scheduling（Lv2）→ Vision・Robot・Navigation（Lv3）と段階的に置き換え、歴史・哲学・文学・雑談など自然言語依存の強い領域は General LLM（「最後の知識辞典」）に委譲するハイブリッド構成
9. **Control IR / Domain IR の二層構造** — 制御は共通 IR（CALL / RETURN / PLAN...）、専門知識は各分野に最適化された IR（AILSA-M / C / S / R / V）で扱う。これは既に仕様（`ARCASHA_V2_SPEC.md`）に存在する設計の再確認であり、統一性と専門効率を両立する

---

*この文書は ArcAsha の実行モデルを正確に理解するための概念仕様である。*

