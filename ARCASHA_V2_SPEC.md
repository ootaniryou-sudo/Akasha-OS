# ArcAsha v2 Design Specification

> **ArcAsha Inter Language for Small AI models**
> 分散された小型AIが「どう考え、どう会話するか」を定義する設計仕様

| 項目 | 値 |
|------|-----|
| Status | **Draft v0.13** |
| Date | 2026-08-05 |
| Owner | ArcAsha Core Team |
| 関連文書 | `MASTER_SPEC.md`（v1 全体像）, `PROTOCOL.md`（バイナリ配線）, `NAMING.md`（世界観命名）, `AILSA_ISA.md`（命令セット仕様）, `AILSM_IR.md`（中間表現仕様）, `AILSM_COMPILER.md`（コンパイラ仕様）, `AILSA_RUNTIME.md`（実行基盤仕様） |

---

## 0. 思想の転換：v1 → v2

**v1 の問い**は

> 「LLMをどう繋ぐか」

でした。ノードの発見・接続・推論委譲が中心で、モデル間のやり取りは自然言語（人間言語）のまま渡されていました。

**v2 の問い**は

> 「AIがどう考え、どう会話するか」

に変わります。自然言語は**入口と出口だけ**。内部の協調はすべてAI専用の中間表現で行われます。

```
人間 ──自然言語──▶ [入口] ──AILSA──▶ ファブリック内部 ──AILSA──▶ [出口] ──自然言語──▶ 人間
```

これは既存研究（GPT / Qwen / Gemma / Llama の「自然言語をそのままやり取りする」前提）に対する差別化であり、**ArcAsha最大の特徴**になり得ます。

### v2 の3層構造

| 層 | 構成要素 | 問い |
|----|---------|------|
| **Layer 1: Communication（通信）** | AILSA / AILSM / Expert Message / Relay | 「何を伝えるか」 |
| **Layer 2: Reasoning（思考）** | Hierarchical Reasoning / Tree Search / Reflection | 「どう考えるか」 |
| **Layer 3: Execution（実行）** | ODAR / Expert Calling / Belief / Memory | 「誰に任せるか」 |

この3層は互いに補完し合い、それぞれが独立した研究テーマになり得ます。

### v2 の本質：AI Compiler

AILSAは「AI共通言語」ではなく、**AI専用中間表現（IR）**である。人間のコンパイラスタックに例えると：

| 人間のコンパイラ | ArcAsha v2 |
|----------------|-----------|
| ソースコード | 自然言語 |
| 高級IR（LLVM IR） | AILSM（意味グラフ） |
| 低級IR / アセンブリ | AILSA（Token ID列） |
| ターゲットバックエンド | 専門IR（AILSA-M / AILSA-C / AILSA-S ...） |
| 実行ユニット | 小型Expertモデル |

つまり ArcAsha v2 は **「AIのコンパイラ」** である。LLVMが様々なCPUアーキテクチャを対象にするように、様々な小型AIを対象にした中間表現と最適化基盤を提供する。これが「AIオーケストレーション」から「**AIコンピュータアーキテクチャ**」への進化の本質。

さらに **v2.1** では AILSA を「言語」ではなく**命令セット（ISA: Instruction Set Architecture）**として定義する。AI版RISC-Vとして、基本命令は少なく（CALL / RETURN / STORE / LOAD / FAIL / SUCCESS / PLAN / VERIFY ...）、その上に専門IR（Math IR / Code IR / Search IR）が載る。管理・バージョン・方言は **`AILSA_ISA.md`** に独立仕様として分離する。

| コンピュータ | ArcAsha |
|-------------|---------|
| 命令セット（ISA） | **AILSA ISA** |
| 高級IR（LLVM IR） | AILSM |
| コンパイラ | Codec |
| スケジューラ | ODAR |
| 実行ユニット | Expert |
| ベンダー仕様書 | **AILSA Registry** |

---

## 1. 全体アーキテクチャ

```mermaid
flowchart TB
    H[Human] --> NL1[Natural Language]
    NL1 --> AILSM[AILSM 意味グラフ]
    AILSM --> AILSA1[AILSA IR]
    AILSA1 --> HW[Heart of Wisdom<br/>Planner / AILSA Compiler / Tree Search / Memory / Reflection]
    HW --> AILSA2[AILSA IR]
    AILSA2 --> IRM[Math IR]
    AILSA2 --> IRC[Code IR]
    AILSA2 --> IRS[Search IR]
    IRM --> ME[Math Expert]
    IRC --> CE[Coding Expert]
    IRS --> SE[Search Expert]
    ME --> AILSAR[AILSA Result]
    CE --> AILSAR
    SE --> AILSAR
    AILSAR --> V[Verifier]
    V --> REF[Reflection]
    REF --> HW
    AILSAR --> NL2[Natural Language]
    NL2 --> H
```

**不変条件**: 内部の意味は一度も自然言語に戻らない。最終結果だけが出口で自然言語へ戻る。

### コンパイラ全体像（Front-End / Back-End）

```
Human → Natural Language
        │  ─────────── Front-End Compiler ───────────
        │  Lexer → Parser → Normalizer → Semantic Analyzer → Verifier
        ▼
      AILSM（ID付き意味グラフ = SSA風）
        │  Optimizer（AILSM最適化）
        ▼
      AILSA（命令セット）
        │  ─────────── Back-End Compiler ───────────
        │  Expert IR → Dispatch → ODAR → Scheduler
        ▼
      Experts
        │  Verifier → Reflection → Memory
        ▼
Natural Language → Human
```

**役割分担**（それぞれ独立した研究対象・公開可能なライブラリ単位）:

| コンポーネント | 研究対象 | コンピュータ相当 |
|---------------|---------|-----------------|
| **AILSM** | AI向け意味IR（SSA風・ID付きグラフ） | LLVM IR |
| **AILSA** | AI向け命令セット（ISA） | アセンブリ / RISC-V |
| **Codec** | AIコンパイラ（Front-End + Back-End） | コンパイラ |
| **ODAR** | AIスケジューラ | OSスケジューラ |

### AI Compiler Ecosystem（CompilerもExpertになる）

LLVMがClangと分離されているように、ArcAshaでは**Compilerは基盤と独立した部品**であり、それ自体がExpertになり得る。

```
日本語 → [Front-end Compiler: GPT / Gemini / Claude / Qwen どれでも] → AILSM
AILSM → [Back-end Compiler: Math / Code / Reasoning 別々] → AILSA → Expert
```

- **Front-end Compiler**（NL → AILSM）: 好きなモデルでよい。インターフェース（入力: 自然言語 / 出力: AILSM）が固定され、出力はValidatorで検証される
- **Back-end Compiler**（AILSM → AILSA）: Math Compiler / Code Compiler / Reasoning Compiler とドメイン別に分離可能
- **CompilerもExpertになる**: 既存9種の「Translation Expert」がFront-end相当。各ドメインExpertは自前のBack-end Compilerを持つ
- ODARは**どのCompilerを使うかもルーティング**する（能力・コスト・レイテンシで選択）

| LLVM | ArcAsha |
|------|---------|
| Clang | Front-end Compiler（GPT / Gemini / ...） |
| LLVM | AILSM |
| x86 Back-end | Math Compiler → AILSA → Math Expert |

---

## 2. Layer 1: Communication（通信）

### 2.1 AILSA — ArcAsha Inter Language for **Small AI models**

> AI同士だけが話す共通言語。人間は一切見ない。

#### 設計原則（最重要）

AILSAは**トークナイザーではない**。小型AI同士が意味をやり取りするための**中間表現（IR: Intermediate Representation）**である。

そして AILSA は次の2つで構成される：

1. **閉じた語彙（Closed Vocabulary）**: 約100〜300語のプリミティブトークン（enum として固定）
2. **開いたスロット（Open Slots）**: 値だけを入れる自由領域（数値・短い自然言語・数式文字列）

```
TASK {
  goal:     "solve for x",   ← 開いたスロット（内容は自由）
  domain:   math,            ← 閉じた語彙（enum）
  difficulty: 4,             ← 数値スロット
  input:    "x^2 - 4 = 0",   ← 開いたスロット
  dependency: none,          ← 閉じた語彙（enum）
}
```

**なぜ閉じた語彙+開いたスロットなのか**

- **検証可能**：閉じた語彙は厳密パーサーで検証でき、「生成→検証→修復」ループに載せられる
- **小型モデルでも学習・生成しやすい**：JSONツール呼び出し形式と同型であり、Qwen2.5-1.5B クラスでもプロンプトで出せ、ファインチューニングで完全固定できる
- **バイナリ化できる**：閉じた語彙は固定IDに写像でき、既存のバイナリ配線プロトコル（Knowledge Edict）と整合する
- **学習効率が激増**：同じ意味は常に同じ表現（正準化）になるため、「Solve x+2=5.」も「x+2=5を解け」も「Find x.」も全て `TASK_SOLVE EQ_LINEAR VAR_X` に写像され、多様な自然言語表現を個別に学習する必要がなくなる

#### 基本構造（入力側）

| フィールド | 種別 | 説明 |
|-----------|------|------|
| `TASK` | enum | タスク種別（SOLVE / PLAN / VERIFY / PATCH / SEARCH ...） |
| `GOAL` | 開いたスロット | 達成すべき目標 |
| `INPUT` | 開いたスロット | 入力（式・コード・参照ID） |
| `CONSTRAINT` | 開いたスロット | 制約条件 |
| `CONTEXT` | 開いたスロット | 参照コンテキスト |
| `DEPENDENCY` | enum/ID | 依存タスク（なし=none） |
| `OUTPUT` | スキーマ | 期待出力の形式 |
| `CONFIDENCE` | 数値 | 要求される最小確信度 |

#### 基本構造（出力側）

| フィールド | 種別 | 説明 |
|-----------|------|------|
| `RESULT` | 開いたスロット | 結果（例: `x=5`） |
| `CONF` | 数値 [0,1] | 確信度 |
| `TRACE` | 閉じた語彙列 | 推論トレース（STEP / ASSUME / VERIFY ...） |
| `NEXT` | enum/ID | 次にすべきこと（VERIFY / MERGE / CONCLUDE ...） |

#### AILSAトークン（共通）

```
TASK_SOLVE   TASK_VERIFY   TASK_PLAN   TASK_PATCH   TASK_SEARCH
CALL         RETURN        FAIL        PASS
STORE        LOAD          SEARCH      MERGE
```

#### 専門IRトークン（エキスパート方言）

| 方言 | 対象 | トークン例 |
|------|------|-----------|
| **AILSA-M** | Math Expert | `EQ` `DERIVE` `LIMIT` `MATRIX` `INTEGRAL` `ADD` `SUBTRACT` `MULTIPLY` `DIVIDE` `SQRT` `SQUARE` |
| **AILSA-C** | Coding Expert | `FUNCTION` `CLASS` `PATCH` `TEST` `REF` `BUG` |
| **AILSA-R** | Reasoning Expert | `CAUSE` `GOAL` `PLAN` `VERIFY` |
| **AILSA-S** | Search Expert | `QUERY` `RANK` `EXTRACT` |

**専門家ごとにIRが異なる**ことが設計の核心。共通AILSAは「翻訳・中継」のための言語であり、各エキスパートは自ドメインのIRで最も効率よく推論する。

#### Token ID 化（AI用アセンブリ言語）

最終形は人間可読な名前ではなく**固定Token ID**。閉じた語彙の各トークンに一意のIDを割り当て、AILSAそのものを**AI用アセンブリ言語**にする。

Token ID の割当は **AILSA Registry**（`AILSA_ISA.md` で仕様化）が唯一の権威を持つ。Registryは Heart of Wisdom（マスター）が管理し、バージョン付きで配布される。

| 範囲 | カテゴリ | 例 |
|------|---------|-----|
| `0x01–0x0F` | タスク動詞 | `TASK_SOLVE=0x04` `TASK_VERIFY=0x05` `TASK_PLAN=0x06` `TASK_SEARCH` `TASK_PATCH` `TASK_TRANSLATE` `TASK_SUMMARIZE=0x0A` |
| `0x10–0x1F` | ドメイン | `DOMAIN_MATH=0x12` `DOMAIN_CODE` `DOMAIN_SEARCH` |
| `0x20–0x2F` | スロット（フィールド） | `SLOT_GOAL` `SLOT_INPUT` `SLOT_OUTPUT` `SLOT_CONF` `SLOT_NEXT` `SLOT_CONSTRAINT` |
| `0x30–0x3F` | 制御 | `CALL` `RETURN` `FAIL` `PASS` `MERGE` `PARALLEL` |
| `0x40–0x4F` | AILSA-M（Math） | `EQ` `DERIVE` `LIMIT` `MATRIX` `INTEGRAL` `ADD` `SUBTRACT` `MULTIPLY` `DIVIDE` `SQRT` `SQUARE` |
| `0x50–0x5F` | AILSA-C（Code） | `FUNCTION` `CLASS` `PATCH` `BUILD` `TEST` |
| `0x60–0x6F` | AILSA-S（Search） | `QUERY` `FILTER` `RANK` `EXTRACT` |
| `0x70–0x7F` | AILSA-R（Reasoning） | `CAUSE` `PLAN` `VERIFY` |

開いたスロットの値は**長さ前置（varint + UTF-8）**で続く。

```
04 12 20 05 'x' 22 ...        TASK_SOLVE DOMAIN_MATH SLOT_GOAL len=1 "x" ...
```

- 意味がバイト列そのものになり、機械が直接処理できる
- 人間の可読性は不要（デバッグ用の逆引きテーブルを別途用意）
- エキスパートは自分が処理する**範囲のToken IDだけ**を理解すればよい（§4.2）

#### バイナリ写像（Knowledge Edict との関係）

AILSAは**意味層**であり、既存の `PROTOCOL.md`（Knowledge Edict）は**輸送層**である。両者は直交する。

```
AILSA（意味層）: 閉じた語彙トークン + 開いたスロット
    ↓ シリアライズ（語彙ID→u16、スロット→可変長）
Knowledge Edict（輸送層）: 既存の48バイトヘッダ + ペイロード
```

- 閉じた語彙 → 固定ID（u16）に写像
- 開いたスロット → 可変長（UTF-8）
- これによりデータプレーンでJSON禁止の原則を守りつつ、意味を運べる

### 2.2 AILSM — ArcAsha Inter Language **Semantic Model**

> AILSAは**言語**。AILSMは**意味モデル**。

自然言語を意味グラフ（Semantic Graph）に構造化したもの。

```
Question
 ├── Goal
 ├── Constraints
 ├── Entities
 ├── Operations
 └── Expected Output
```

AILSMは**SSA（Static Single Assignment）風のID付き意味グラフ**として設計する。LLVMでSSAがVerifier・最適化を劇的に簡単にしたのと同じ発想。

```
（素朴なグラフ）                 （SSA風）
Solve                           Task#1
 ├─ Math                         ├─ Domain=Math
 └─ Circle                      Object#1
      └─ Radius=5                ├─ Type=Circle
                                 └─ Value#1
                                      └─ Radius=5
                                Task#1 uses(Object#1)
                                Task#1 uses(Value#1)
```

- 全ノードに**一意ID**（Task#N / Object#N / Value#N）を付与
- 参照はIDで表現（`uses(Object#1)`）
- **Verifierが圧倒的に楽になる**: 同一ノードの同一性がIDで判定でき、文字列比較や言い換え耐性に依存しない

**CodecはCompilerそのものである**。Encoder/Decoderだけでなく、以下のパイプラインで実装する。

```
Lexer → Parser → Normalizer → Semantic Analyzer → Optimizer → AILSA Generator
```

- **Lexer / Parser**: 自然言語をトークン化し、構文構造（AST）へ
- **Normalizer**: 同義語を正準語へ畳み込む（足してください / 加えて / 和を求めよ → `ACTION_ADD`）
- **Semantic Analyzer**: 意味ノード（Task / Object / Value）を抽出しIDを付与
- **Optimizer**: AILSMレベルの最適化（§2.7）
- **AILSA Generator**: AILSM → AILSA命令列（Byte Codec へ）

#### 型システム（Typed AILSM）

SSAの次の進化として**型システム**を導入する。

```
Value#12 : Number
Object#3  : Circle
Task#1    : Solve
```

- **コンパイル時の型エラー検出**: 型が合わない演算・接続をAILSA生成前に検出
- **静的IR検査**: Expertが受け取れるIRを型で静的検査（Math Expert は Number のみ受領、等）
- **Verifierの事前排除**: 実行前に矛盾を排除（型安全性 = プログラミング言語の型安全性をAIシステムへ持ち込む）

AILSMは「人間の質問を意味として理解した状態」を保持し、AILSAへ落とすときの**正規化された中間体**。メモリには自然言語ではなくAILSMを保存する（§6）。

#### 精度保証：3段階 Codec（自然言語 ⇄ AILSM ⇄ AILSA）

AILSA（命令セット）は100%決定論で設計できるが、**入口（自然言語→AILSM）と出口（AILSM→自然言語）だけは解釈が必要**。ここがArcAsha v2で最も研究価値のある部分であり、精度を決めるのはCodecである。

```
Stage1: Deterministic Parser（辞書・規則。100%決定論）
Stage2: LLM残差（辞書で判定できない部分のみ。閉じた語彙に制約）
Stage3: Verifier（往復照合で意味一致率を測定）
```

**Stage 1 — Deterministic Parser**
- 「足し算」「平方根」「積分」等の閉じた語彙要素はLLMを使わず辞書/規則で変換（例: 足す/加える/たす → `ACTION_ADD`）
- 同義語は正準ノードへ折り畳む（Circle / 円 / circle / 円形 → 同一ノード）
- ここは100%決定論であり、golden testで完全に検証する

**Stage 2 — LLM残差（制約付き生成）**
- 辞書で判定できない部分だけをLLMへ投げる（例: 「この文章を要約して」→ `TASK_SUMMARIZE`）
- **閉じた語彙だからこそ**、LLMの出力空間が小さく、Phase 0 の Validator で検証可能
- 「生成→検証→修復」ループ: 不正なら再プロンプト

**Stage 3 — Verifier（往復照合）**
- 元の自然言語 → AILSM → 自然言語 へ戻し、意味一致率を測定
- 測定法: BLEU（参考）/ BERTScore / Sentence Transformer 埋め込みコサイン / **AILSMグラフ一致率**
- 例: 一致率 0.97 → 採用 / 0.55 → AILSM生成失敗として再エンコード
- **優雅な縮退**: Verifierが閾値を下回ったら、AILSA中継を諦めてNL中継へフォールバック（意味を黙って壊さない）

**AILSMグラフ比較の強み**: 文字列ではなく**意味ノード**で比較できる。自然言語へ戻した時に `Circle→円→circle→円形` が全て同一ノードになるため、言い換えに頑健。

**Neural Codec（研究フェーズ）**: 将来的には NL⇄AILSM ペアで専用の小規模モデル（数千万〜数億パラメータ）を学習し、巨大LLMなしで「意味コンパイラ」を動かす。これは巨大モデルを必要としないArcAsha独自のCompiler研究になる。

### 2.3 Expert Message（通信内容の固定）

ノード間・マスター経由のメッセージは固定スキーマ。

```
FROM      = 送信エキスパート（enum）
TO        = 宛先エキスパート（enum）
TASK_ID   = タスクID（u64）
INPUT     = AILSA（閉じた語彙+開いたスロット）
RESULT    = AILSA結果
CONF      = 確信度 [0,1]
TRACE     = 推論トレース
```

例：

```
FROM   = Math
TO     = Reasoning
TASK   = 35
RESULT = x=5
CONF   = 0.82
```

### 2.4 Relay（中継）

**直接通信は禁止。必ずMaster（Heart of Wisdom）経由。**

```
AILSA
 ↓
Relay（Master）
 ↓
Math AILSA → Math Expert
 ↓
Relay（Master）
 ↓
AILSA
```

理由：
- ルーティング判断（ODAR）を一箇所に集約
- セキュリティ・監査・トレースの一元化
- エッジノード（iPhone/iPad等）はサーバーソケットを開かない設計と整合

**中継コストの原則**: ホップごとに小型モデルの生成が入るため、
- スキーマ駆動の変換（フィールドマッピング）は**決定的**に
- 生成するのは**内容だけ**（開いたスロットのみ）
- ホップ数を最小化する（プランナーが最短経路を選ぶ）

### 2.5 AILSA Registry（誰が管理するか）

Token ID の割当は**一元管理**され、バージョン付きで配布される。

- **権威**: Heart of Wisdom（マスター）が唯一の権威。`src/arcasha/ailsa/registry.json` に同梱
- **形式**: `Version` + トークン（名前, ID, カテゴリ, 方言, 意味）
- **変更ポリシー（不変則）**:
  - 既存トークンのIDは**絶対に変更しない**（`TASK_SOLVE=0x04` が将来 `0x84` になる事故を防ぐ）
  - 新トークンは予約領域の空きIDへ追加
  - 廃止トークンはIDを再利用せず deprecated フラグで管理
- **配布**: マスター同梱 + ノードへ配布可能（アプリ同梱でオフラインでも参照可）

### 2.6 Dialect と Versioning

AILSA全部を全Expertが覚える必要はない。LLVM のターゲット（x86/ARM/RISC-V）と同様に、**Dialect**（方言）で分割する。

```
AILSA（Base ISA）
   ↓
Math Dialect / Code Dialect / Search Dialect / Reasoning Dialect
   ↓
各Expert
```

- **Base ISA**: CALL / RETURN / STORE / LOAD / FAIL / SUCCESS / PLAN / VERIFY ... （全Expert必須）
- **Dialect**: Math（EQ DERIVE LIMIT MATRIX）/ Code（FUNCTION CLASS PATCH BUILD）/ Search（QUERY FILTER RANK）...

**Versioning**:
- Registry は `MAJOR.MINOR`。MINOR=追加（後方互換）、MAJOR=原則禁止
- `AILSA 1.0 → 1.1` のとき **Codecだけ更新**。Expert は自分の Dialect のバージョン（例: math/v1）のまま動き続ける
- Expert が知るべきことは「Registry の Version」と「自分の Dialect」だけ

詳細は `AILSA_ISA.md`（命令セット仕様書）を参照。

### 2.7 AILSM Optimizer（AILSM最適化）

AILSMのまま最適化する（LLVM Passに相当）。

**命令の畳み込み（Batching）**:

```
CALL Math
CALL Math
CALL Math
```

→

```
CALL Math  Batch=3
```

**並べ替え（Reordering）**:

```
検索 → 翻訳 → 検索
```

→

```
検索 → 検索 → 翻訳      （翻訳は最後に1回で済む）
```

- 通信コスト・レイテンシを最小化する
- 決定論ルール（安全な変形のみ）から始め、学習ベースの最適化は研究フェーズ

**Pass Manager 実装（Phase 0.6）**:
- 最適化レベル `-O0..-O3`（LLVM の Optimization Level 相当）
- Pass: DeadNodeElimination（DCE）/ Dedup / ConstantFolding（`2+3 → 5`）/ BatchDetection
- 将来 Pass: DeadExpertElimination / Reordering / Cost-based 選択

---

## 3. Layer 2: Reasoning（思考）

**全サブシステムは同じAILSMグラフを見る（共有IR）**。SSA化により依存関係が全て見える（`Task#1 → Math#2 → Equation#5 → Result#9`）ため、Planner / Tree Search / Reflection / Memory / Verifier / ODAR は全て同じAILSMを読み書きする。これはCPUで「**全員が同じメモリを見る**」のに等しい。従来のように各コンポーネントが自然言語を個別に解釈する（「たぶんこういう意味」）曖昧さが消える。

さらに AILSM は **AI State IR** である — Task / Plan / Belief / Memory / Reflection / Result など**AIの内部状態全体をSSAノードとして管理する実行可能IR**（Phase 0.9）。LLVM IRがCPU状態しか持たないのに対し、AILSMはAIの状態全体を持つ。**AIの思考が全て可視化できる**。

さらに v0.12 では **Capability / Schedule もSSAノード**化し、`Belief → Capability → Schedule → CALL` のルーティングも同一グラフ上で表現する（**ODAR = SSA**）。AILSMはCPUだけでなく AI 自身の思考・状態・学習・記憶・計画・信念を管理する **AI Operating IR**（AI OS の Kernel Object 相当）として再定義される。**仕様は v1.0 で凍結**（`AILSM_IR.md` §8）。

v0.13 では **AIProcess / AIThread / ReasoningScheduler** を追加し、AILSM は **AI Kernel IR** になる。Process ライフサイクル（`created→ready→running→{waiting/finished/failed}`）・Thread（複数タスク同時進行）・優先度スケジューラ・Runtime Events（`SPAWN/CALL/RETURN/YIELD/WAIT/TIMEOUT/FAIL/FINISH`）で、**「AI を実行する OS」**として説明できる。**AI Runtime Model は v1.0 で凍結**（`AILSA_RUNTIME.md` §7）。

### 3.1 Hierarchical Reasoning（木構造による問題分解）

推論は**木**になる。

```mermaid
flowchart TB
    G[Goal] --> PA[Plan A]
    G --> PB[Plan B]
    PA --> T1[Task1]
    PA --> T2[Task2]
    PA --> T3[Task3]
    T2 --> T21[Task2-1]
    T2 --> T22[Task2-2]
    T2 --> T23[Task2-3]
```

**どこまで分解するか = Beliefが低いところまで。**

```
Confidence が低い
   ↓
さらに分解
```

確信度の低いタスクは、分解して各サブタスクを別エキスパートに任せ、確信度が上がったら統合する。

### 3.2 Reasoning Unit（木のノード）

各ノードはこれだけを持つ：

```
Reason ID   : ノード固有ID
Parent      : 親ノードID
Goal        : このノードの目標
Input       : AILSA入力
Output      : AILSA出力
Belief      : 達成確信度 [0,1]
Verifier    : 検証結果（PASS/FAIL）
Children    : 子ノード列
```

### 3.3 Tree Search（プラン探索）

Plannerはプラン空間を木探索で探索する。評価は Belief（+ 期待コスト）で行い、ベストプランを選択して Execute する。分解・並列化・統合は明示的に表現する：

```
DECOMPOSE   分解
DEPENDENCY  依存関係
PARALLEL    並列実行
MERGE       統合
```

### 3.4 Reflection（自己修正）

ReflectionもAILSAだけを使う。

```
FAILURE
 ↓
Diagnosis（原因診断）
 ↓
New Plan（新プラン）
 ↓
Execute
```

```
FAILURE { task: 35, cause: precision, conf: 0.3 }
DIAGNOSIS { cause: "numerical instability", fix: "switch backend" }
REPLAN { strategy: "shadow+verify", expert: math, backend: fp64 }
```

---

## 4. Layer 3: Execution（実行）

### 4.1 Expert Calling（ODAR）

**普通のMoEより賢い選択をする。**

MoE: `Gate → Top2` だけ。

ArcAsha v2 は**複数シグナル**で選択する：

```
Belief   （タスクを解ける確信度の推定）
Capability（能力ベクトル — coding/math/general）
Latency  （応答時間予測）
Cost     （計算・エネルギーコスト）
Memory   （利用可能メモリ）
Context  （コンテキスト適合度）
   ↓
LinUCB  （バンディットアルゴリズムで探索・活用の均衡）
   ↓
Expert
```

さらに実行時には：

```
Top1（主実行）
  + Shadow（独立バックエンドで複製実行）
  + Verifier（照合）
```

を回し、**Exact Shadow**（同一モデル+バックエンド+精度 → トークン一致検証）と**Independent Shadow**（異なるバックエンド → 意味検証）を使い分ける。

**Expert Calling もコンパイラ化する**。選択だけでなく、実行計画を最適化する。

```
ODAR → Candidate → Planner → Schedule Optimizer → Dispatch
```

- **Candidate**: Belief / Capability 等で候補エキスパートを列挙
- **Planner**: 実行順序を決定（依存関係を考慮）
- **Schedule Optimizer**: 通信コスト込みで配置を最適化（例: Math / Code / Translate → GPU1 / GPU2 / GPU3 へコスト最小で割当）
- **Dispatch**: 実行

### 4.2 Expert の種類（初期9種）

| # | Expert | 方言 | 役割 |
|---|--------|------|------|
| 1 | Planning Expert | AILSA | 分解・プラン生成 |
| 2 | Math Expert | AILSA-M | 数式・計算 |
| 3 | Coding Expert | AILSA-C | コード生成・パッチ |
| 4 | Search Expert | AILSA-S | 検索・抽出 |
| 5 | Memory Expert | — | 記憶の保存・想起 |
| 6 | Reasoning Expert | AILSA-R | 推論・因果 |
| 7 | Verification Expert | — | 結果検証（PASS/FAIL） |
| 8 | Translation Expert | — | 自然言語 ⇄ AILSM/AILSA |
| 9 | Vision Expert | AILSA-V | 画像入力（将来） |

> **CompilerもExpertである**: Translation Expert（#8）はFront-end Compiler、各ドメインExpertは自前のBack-end Compilerを持つ（§1 Compiler Ecosystem）。

#### エキスパートは自然言語を見ない

各エキスパートは自ドメインの**専門IRだけ**を処理する。自然言語能力は不要。

```
Math Expert が見るもの:
04 12 20 05 'x' 22 ...     TASK_SOLVE DOMAIN_MATH SLOT_GOAL len=1 "x" ...

（従来: 「x+2=5を解け」「Solve x+2=5.」「Find x.」を全て学習する必要があった）
```

- **語彙が激減** → トークナイザ・モデルサイズを縮小できる
- **学習データが激減** → 同じ意味は常に同じToken ID列（正準化）なので、学習効率が向上（§6 の H5）

### 4.3 Memory（記憶）

**保存するもの**（自然言語は保存しない）：

```
AILSM        意味グラフ
Reason Tree  推論木
Belief       確信度
Verifier     検証結果
Reward       報酬（学習用）
```

- 会話履歴もAILSMとして保存
- Memory Expert が `STORE` / `LOAD` で応答
- 経験はLinUCBの報酬学習に再利用

### 4.4 Verifier（5種類）

Verifierは単一ではなく、**5種類**を使い分ける。

| 種別 | 検査内容 | 例 |
|------|---------|-----|
| **Syntax** | 命令列の構造 | CALLが閉じているか（Phase 0 Validator） |
| **Semantic** | TaskとSlotの整合 | タスク種別とスロットの矛盾がないか |
| **Capability** | エキスパート能力との整合 | Math ExpertにCode Taskを投げていないか |
| **Consistency** | Belief / Memoryとの整合 | Beliefと保存済みMemoryが矛盾していないか |
| **Safety** | 危険命令の排除 | 禁止オペコード / 制約違反がないか |

- 各Verifierは決定論ルールで実装（AIを使わない）
- Phase 3（Benchmark）で5種類それぞれの有効性を評価

---

## 5. 設計原則（まとめ）

1. **意味が自然言語に戻らない** — 内部は常にAILSA/AILSM
2. **閉じた語彙 + 開いたスロット** — 検証可能・学習容易・バイナリ化可能
3. **決定的変換、生成の最小化** — Relayはスキーマ駆動で決定的に、生成は内容のみ
4. **Master経由の中継** — 直接通信禁止、ルーティングと監査を一元化
5. **Belief駆動の分解** — 確信度が低いところだけさらに分解
6. **検証の常設** — Top1 + Shadow + Verifier は常に回す
7. **記憶は意味で保存** — 自然言語は保存しない
8. **同一意味は同一表現（正準化）** — 多様な自然言語表現を一つのToken ID列に写像し、学習・検証・記憶を効率化
9. **エキスパートは専門IRのみ** — 自然言語能力を要求しない（小型化・省リソース）
10. **共有IR（全サブシステムが同じAILSMを見る）** — Planner / Memory / Verifier / Reflection / ODAR の個別解釈による曖昧さを排除
11. **Compilerは交換可能（Compiler Ecosystem）** — Front-end / Back-end Compilerはモデル・ドメインごとに差し替え可能
12. **型安全性** — Typed AILSM でコンパイル時検出・静的IR検査・実行前矛盾排除

---

## 6. 研究検証計画

### 6.1 検証すべき命題（研究仮説）

- **H1**: 小型モデル間の協調は、自然言語中継よりAILSA中継の方が**意味ドリフトが小さい**
- **H2**: 小型モデルはAILSA（閉じた語彙+開いたスロット）を生成・消費できる（プロンプト → ファインチューニングで固定）
- **H3**: Belief駆動の階層分解は、単一パス推論より複合タスクで精度が高い
- **H4**: LinUCBによるExpert選択は、固定ルーティングより累積報酬が高い
- **H5**: 専門IRのみを処理する小型モデルは、自然言語を処理する同規模モデルより**タスク精度/パラメータ比**で高効率である

### 6.2 セマンティックドリフト実験（最も説得力のある実験）

同じタスクを2つの経路で実行し、意味の劣化を比較する。

```
Case1（ベースライン = 伝言ゲーム）:
  日本語 → [モデルA] → 日本語 → [モデルB] → 日本語

Case2（AILSA）:
  日本語 → AILSM → AILSA → [モデルA] → AILSA → [モデルB] → AILSA → AILSM → 日本語
```

**測定指標（ホップ数ごと）**:

| 指標 | 測定法 |
|------|--------|
| Semantic Drift | 入力意味と出力意味の**埋め込みコサイン**（Sentence Transformer） |
| 精度 | **Intent F1 / Slot F1**（正解AILSMアノテーションとの一致率） |
| グラフ一致率 | 正解AILSMと生成AILSMのノード一致（SSA風ID付きグラフで比較） |
| Latency | エンドツーエンド応答時間 |
| Token数 | 消費トークン総数 |
| Memory | ピークメモリ |

- AILSA側が**ドリフト・Token数・Latencyで優位**であることを示す
- タスクスイート（math / code / search / summary / reasoning）ごとに正解AILSMを用意
- 既存の `experiments/EXP-XXXX` フレームワークにそのまま載せられる

### 6.3 関連研究（ポジショニング）

| 既存研究 | 関係 |
|---------|------|
| Tool / function calling（JSONスキーマ） | 近縁・実証済みの基盤 |
| PAL（Program-Aided LM） | 推論をプログラム言語に外注する前例 |
| CAMEL / AutoGen / ChatDev | エージェント間通信の前例 |
| LLM as Planner（PDDL出力） | 構造化プランニングの前例 |
| MoE（Gate+Top2） | Expert選択の比較対象 |

**差別化点**: 既存研究が「単一モデル内 or 少数エージェント」であるのに対し、AILSAは「**分散された小型モデル群が共通IRで協調する**」点で、規模と分散性で差が出せる。

さらにAILSAは単なる通信形式ではなく、**AIコンパイラの中間表現**として位置づけられる。LLVMがCPUアーキテクチャの差異を吸収するように、AILSA/AILSMはモデル・バックエンド・精度の差異を吸収し、「**専門IRを処理する小型モデル群**」という新しい学習・推論パラダイムへ接続する。これが「AI共通言語」ではなく「**AI専用IR**」としての本質であり、論文の中心命題になる。

### 6.4 論文構成（将来：独立テーマとしても成立）

1. **Paper 1: ODAR** — 分散環境での適応的ルーティング（誰に任せるか）
2. **Paper 2: AILSA** — AI向け命令セットアーキテクチャ（ISA）
3. **Paper 3: AILSM** — AI向け中間表現（IR）
   - 候補タイトル: "AILSM: A Stateful SSA Intermediate Representation for AI Systems" / "AI State IR: A Stateful SSA Representation for Distributed AI Runtime Systems"
   - 論文化の中心は **状態を持つSSA（AI Operating IR）** — AIの思考・計画・記憶・信念を統一表現（正準化・Verifier容易性・最適化可能性）
   - 発展: **共有IR**（全サブシステムが同一グラフを参照）・**型システム**（型安全性）・**ODAR=SSA**
4. **Paper 4: Compiler** — 自然言語からAILSM/AILSAへの変換（3段階精度保証）
5. **Paper 5: Native Expert** — AILSAネイティブ小型モデル
6. **Paper 6: ArcAsha Architecture** — 全体アーキテクチャと分散実行基盤

研究テーマの位置づけは「分散AI」から「**AIのためのコンパイラ・命令セット・実行基盤（AI Computer Architecture）**」へ引き上げられる。

---

## 7. 実装ロードマップ

| Phase | 内容 | 成果物 | 既存資産の活用 |
|-------|------|--------|---------------|
| **0** | ✅ **AILSA ISA 土台**（Registry v1.0 / Codec / Validator / Dialect） | `src/arcasha/ailsa/`（registry.json, vocab.ts, codec.ts, ...） | 完了（`npm run ailsa:selftest` 全合格） |
| **0.5** | ✅ **AILSM Compiler**（Lexer→Parser→Normalizer→Semantic Analyzer→Optimizer→AILSA Generator、3段階精度保証） | `src/arcasha/ailsm/`（ailsm.ts, types.ts, lexer.ts, parser.ts, normalizer.ts, semantic.ts, optimizer.ts, generator.ts, verifier.ts, compiler.ts）+ Registry **v1.1.0**（`TASK_SUMMARIZE` / `ADD`〜`SQUARE`） | 完了（`npm run ailsm:selftest` 全合格）。Stage 2（LLM残差）は委譲点を実装済み |
| **0.6** | ✅ **AILSM ABI 安定化**（Pass Manager / Typed AILSM拡張 / 定数畳み込み / Golden Test） | `src/arcasha/ailsm/`（optimizer.ts Pass化, types.ts Union/Optional/制約, capability.ts, golden.ts） | 完了（`npm run ailsm:golden` 30ケース全合格） |
| **0.7** | ✅ **AILSM Visualizer**（見えるIR: Mermaid / Graphviz DOT / ASCIIツリー） | `src/arcasha/ailsm/`（visualizer.ts, visualize.ts）+ `public/ailsm-viewer.html` | 完了（`npm run ailsm:visualize "…"` / ブラウザ描画確認済み） |
| **0.8** | ✅ **AILSM Executor**（IRをLLM無しで実行 — ExpertはCPU） | `src/arcasha/ailsm/executor.ts`（組み込み演算/Resultノード/resolved/needsExpert）+ `compileAndRun` | 完了（`2+3=5` / `20÷4=5` / `√9=3` / 積分はExpert委譲 を確認） |
| **0.9** | ✅ **AI State SSA**（Memory / Belief / Plan / Reflection を SSA ノード化） | `src/arcasha/ailsm/state.ts`（remember/believe/plan/reflect）+ `runtime.ts`（run: 状態遷移トレース）+ `toStateDiagram` | 完了（ローカル解決→Memory / Expert委譲→Belief→CALL を確認） |
| **0.10** | ✅ **Scheduler / Capability SSA + AILSM仕様凍結 v1.0**（ODAR = SSA） | `state.ts`（capability/schedule）, `runtime.ts`（Belief→Capability→Schedule→CALL） | 完了（全ノード・エッジ・型・状態遷移・ABIを v1.0 で凍結） |
| **0.11** | ✅ **AI Process / Thread / Reasoning Scheduler**（AI Kernel IR） | `state.ts`（createProcess/spawnThread/setProcessState）, `scheduler.ts`（pickNext/pickRoundRobin + RuntimeEvents）, `runtime.ts`（SPAWN→CALL→WAIT/FINISH） | 完了（AI Runtime Model を v1.0 で凍結） |
| **1** | **Expert間AILSA通信**（Math→Code→Math をAILSAだけでリレー） | 最小デモ（既存 `demo-web.ts` 拡張） | 既存ハブ+実機ノード |
| **2** | **Expert Calling + Relay + Shadow** | `src/arcasha/odar/` | 既存 `src/fault/fault-tolerance.ts` |
| **3** | **AILSA Benchmark + Semantic Drift実験** | `experiments/EXP-AILSA/` | 既存 `experiments/EXP-XXXX` フレームワーク |
| **4** | **専門AILSAモデルの蒸留**（LLM生成ペアで小モデルを学習） | `training/` 拡張 | 既存 `training/finetune.py` |
| **5** | **AILSAネイティブ小型モデル**（自然言語を一切知らない専門IRモデル） | 新規モデル | — |
| **6** | **分散MoEクラスタ** | エンドツーエンド | — |

> Hierarchical Reasoning / Memory / Reflection は Layer 2 の構成要素として、Phase 2 以降に随時統合する（優先は「有効性の証明」）。

---

## 8. 命名（NAMING.md への追加候補）

| 世界観名 | 正式名称 | 略称 |
|---------|---------|------|
| **Tongue of Wisdom / 知恵の舌** | ArcAsha Inter Language | **AILSA** |
| **Mirror of Meaning / 意味の鏡** | ArcAsha Inter Language Semantic Model | **AILSM** |
| **Tree of Thought / 思考の樹** | Hierarchical Reasoning | — |
| **Oracle of Choice / 選択の神託** | Expert Calling (ODAR) | — |

> 正式な採用時は `NAMING.md` に追記する。

---

## 9. 用語集

| 用語 | 定義 |
|------|------|
| **AILSA** | AI同士が意味をやり取りする共通中間表現（閉じた語彙+開いたスロット） |
| **AILSM** | 自然言語を意味グラフ化した意味モデル（AILSAの前段） |
| **AILSA-M/C/R/S/V** | 各エキスパート専用のIR方言 |
| **Codec** | AILSAとAILSM/自然言語を相互変換する双方向モジュール（Encoder + Decoder） |
| **Token ID** | 閉じた語彙に割り当てた固定ID（0x04=TASK_SOLVE 等）。AILSAをアセンブリ言語化する |
| **AILSA ISA** | AILSAを命令セットとして定義した仕様。AI版RISC-V（`AILSA_ISA.md`） |
| **AILSA Registry** | Token ID割当の権威・バージョン管理（マスターが管理） |
| **Dialect** | エキスパート固有の命令サブセット（Math/Code/Search/Reasoning） |
| **Reasoning Unit** | 推論木のノード（Goal/Input/Output/Belief/Verifier/Children） |
| **Belief** | タスク達成確信度 [0,1]。分解・ルーティング・検証の判断基準 |
| **ODAR** | Observation-Driven Adaptive Routing。Expert選択アルゴリズム |
| **LinUCB** | バンディットによる探索・活用の均衡アルゴリズム |
| **Shadow** | 検証用の複製実行（Exact / Independent の2種） |
| **Relay** | Master経由のAILSA中継。直接通信は禁止 |

---

## 10. 未来展望：ArcAsha v3（専門IRネイティブ）

```
Human → Natural Language → AILSM → AILSA → Math IR → Math Model
```

v2 では自然言語入力をAILSAへ変換し、既存の（自然言語を理解する）モデルへ渡す。**v3** では、各エキスパートが最初から**専門IRを直接処理する小型モデル**として生まれ変わる。

- Math: `EQ` `DERIVE` `LIMIT` `MATRIX` だけ
- Coding: `FUNCTION` `CLASS` `PATCH` `BUILD` だけ
- Search: `QUERY` `FILTER` `RANK` だけ
- **Tokenizer不要・語彙数百**: AILSAネイティブモデルは基本命令 + Dialect合わせて数百語彙しか見ない（Qwenの約15万語彙と対照的）。自然言語モデルではなく**DSL（Domain Specific Language）専用モデル**となり、学習量を激減させる

この段階で ArcAsha は「自然言語を理解するLLM」から「**専門IRを処理する小型モデル群**」の分散基盤へ完全移行する。

**ArcAsha v3 の3本柱**：

| 柱 | 役割 | 問い |
|----|------|------|
| **AILSA** | AI間通信プロトコル | 何を伝えるか |
| **ODAR** | 適応型ルーティング | 誰に任せるか |
| **専門IR + 小型Expert** | 高効率な分散推論 | 何を考えるか |

これはArcAshaの中で最も大きく発展する可能性を秘めた部分であり、研究としての独自性の核心。

---

*この仕様書が、今後の実装ロードマップと将来の論文の土台となる。*
