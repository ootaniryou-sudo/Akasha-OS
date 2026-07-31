# Akasha-OS（アーカーシャ OS）

> **「ビッグテックのデータセンターを、個人の部屋に民主化する」**
>
> 数万台の型落ちスマートフォンと安価な有線ネットワークを結集し、1つの超巨大な仮想 **6.7T（6.7兆）パラメータ級** の群知能（Collective Intelligence）を創発させる、超分散型エッジAIオーケストレーションオペレーティングシステム。
>
> **🎯 ロードマップ目標**: 現行のフロンティア級LLM（DeepSeek-V3: 671B MoE / GPT-4: ~1.8T 推定）と同等以上のパラメータ規模を、家庭用コンセントと中古スマホの山だけで実現する。最終的には **10Tパラメータ超** の完全分散推論を目指す。
>
> **🎯 Roadmap target**: Match or exceed current frontier-class LLM parameter counts (DeepSeek-V3: 671B MoE / GPT-4: ~1.8T estimated) using nothing but household power outlets and a pile of used smartphones — ultimately aiming for **10T+ parameters** in fully distributed inference.

---

## 🌌 1. プロジェクトの背景とビジョン

現在のAI業界は、数千億円〜数兆円規模の巨大なデータセンターを構築し、最先端GPU（NVIDIA H100等）を独占、膨大な電力を爆食いさせるビッグテックの資本力に支配されています。

**Akasha-OS** は、この中央集権的な構造に対する**技術的アンチテーゼ（反逆）**です。

着想の源のひとつは、ゲーム『原神』のスメール地方に登場する統合演算基盤 **「アーカーシャシステム」** —— スメール国民全員が装着する「アーカーシャ端末」を通じて、人々の知識・思考・経験をリアルタイムに収集・統合し、巨大な集団知性として機能させる架空のネットワークです。この「端末1台1台は非力でも、無数に繋がれば神の知性に迫る」という思想に深く共鳴し、現実世界のエッジデバイスでそれを実装することを目指しています。

世界中で毎年数億台廃棄される「まだ動く型落ちスマートフォン（エッジ資源）」を回収し、部屋の中に敷き詰めた有線LAN網で数珠繋ぎ（クラスター化）にします。1台1台には0.1B〜1Bクラスの極小専門家AIモデルをブラウザ上で実行させ、独自の超低遅延ルーティングによってそれらを調和。トータルで**フロンティア級の知能を、数十分の一のコストと電力で実現**します。

> 📖 **ArcAsha Naming System**: Akasha-OS の全コンポーネントには、世界観に根ざした名称（Lore Name）が与えられています。詳細は [`NAMING.md`](NAMING.md) を参照。中核となる構成要素は **Heart of Wisdom (Core Orchestrator)**、**Eye of Wisdom (Intelligent Router)**、**Shadow of Wisdom (Shadow Execution)**、**Realm of Knowledge (Memory Fabric)**、**Echo (Runtime KV Cache)** の12コンポーネントです。

---

## 🛠️ 2. コアアーキテクチャ（4層構造）

Akasha-OSは、以下の4つのレイヤーが完全に非同期で連携することで、ミリ秒単位のトークンリレーを実現します。

```
+-----------------------------------------------------------------------+
| 【第4層：アプリケーション UI】 ユーザーUI / トークンストリーミング     |
+-----------------------------------------------------------------------+
                              │ (プロンプト入力)
                              ▼
+-----------------------------------------------------------------------+
| 【第3層：マスターオーケストレーター】 Akasha-Core (TypeScript)         |
|  - 意味解析ルーティング / O(1)ノードプール管理 / 投機的シャドウレース |
+-----------------------------------------------------------------------+
                              │ (バイナリテンソル配信)
                              ▼
+-----------------------------------------------------------------------+
| 【第2層：自律分散エッジクラスター】 Specialized Node Swarm             |
|  - スマホWebWorker + WebGPUによる0.1B~1Bモデルの超高速部分計算        |
+-----------------------------------------------------------------------+
                              │ (物理インフラ)
                              ▼
+-----------------------------------------------------------------------+
| 【第1層：物理トポロジー】 ファットツリー型有線LAN & 異回路分散給電   |
|  - 10口USB-LANハブ ──► 24ポートL2スイッチ ──► 部屋のコンセント分散   |
+-----------------------------------------------------------------------+
```

### 2.1 第1層：物理トポロジー

| 機器 | 役割 | 接続数 | 目安単価 |
|------|------|--------|---------|
| USB-LANハブ（10ポート） | スマホ10台を有線LAN化＋給電 | 10台/ハブ | ¥2,000 |
| L2ギガビットスイッチ（24ポート） | ハブ間のバックボーン中継 | 24ハブ/スイッチ | ¥4,000 |
| 家庭用コンセント（異系統ブレーカー分散） | ハブ単位で別回路給電 | 1回路あたり最大100台 | — |

**給電設計**: 1台あたり約5W × 1,000台 = 5kW → 一般家庭の3〜4系統のコンセントに分散すればブレーカー落ちなし。

### 2.2 第2層：自律分散エッジクラスター

各スマホはブラウザ上の WebWorker + WebGPU で動作：
- WebSocket 経由でマスターと永続接続
- 48バイト固定ヘッダのバイナリプロトコルで通信（JSON不使用）
- Float32Array の生テンソルを WebGPU バッファに zero-copy アップロード
- 自分の担当レイヤーだけを計算し、結果を次のノードへ P2P リレー

### 2.3 第3層：マスターオーケストレーター

`Akasha-Core` — Node.js (TypeScript) で動作する中核制御システム：

| モジュール | ファイル | 役割 |
|-----------|---------|------|
| **Bootstrapper** | `src/bootstrap/akasha-bootstrapper.ts` | 接続スロットリング、IPサブネット解析、APSベンチマーク、役割自動任命 |
| **Orchestrator** | `src/core/orchestrator.ts` | ネットワーク/ルーターワーカーの起動・管理、プロンプト投入 |
| **Inference Loop** | `src/core/inference-loop.ts` | トークン単位の推論パイプライン、P2Pリレー制御、シャドウレース調整 |
| **Fault Tolerance** | `src/fault/fault-tolerance.ts` | スライディングウィンドウ型デッドライン監視、自動フェイルオーバー |
| **Idle Pool** | `src/structures/idle-cluster-pool.ts` | O(1) アイドルノード取得／解放（侵入的双方向リンクドリスト） |
| **Ring Buffer** | `src/ipc/ring-buffer.ts` | ロックフリー SPSC リングバッファ（SharedArrayBuffer + Atomics） |
| **Binary Codec** | `src/binary/codec.ts` | 48バイト固定ヘッダのエンコード／デコード（ゼロアロケーション） |

### 2.4 第4層：アプリケーションUI

- ユーザーがプロンプトを入力
- トークンが生成されるたびにリアルタイムストリーミング表示
- 内部統計（ノード数、レイテンシ、消費電力推定）を可視化

---

## 🧬 2.5 パラメータ・スケーリング・ロードマップ / Parameter Scaling Roadmap

Akasha-OS はノード数とモデルサイズの線形スケーリングを理論的基盤としています。
Akasha-OS is built on the theoretical foundation of linear scaling between node count and model size.

| フェーズ / Phase | ノード数 / Nodes | 総VRAM / Total VRAM | 目標パラメータ / Target Params | 比較対象 / Comparable to |
|---|---|---|---|---|
| **Phase 1: 実証** | 100台 | ~200 GB | **10B** (FP16) | GPT-2 (1.5B) を超える / Surpasses GPT-2 |
| **Phase 2: 小規模** | 1,000台 | ~2 TB | **100B** (FP16) | Llama-2-70B 級 / Llama-2-70B class |
| **Phase 3: 中規模** | 5,000台 | ~10 TB | **671B** (FP16) | DeepSeek-V3 (MoE) 級 / DeepSeek-V3 class |
| **Phase 4: 大規模** | 10,000台 | ~20 TB | **1.8T** (FP16) | GPT-4 推定規模 / GPT-4 estimated scale |
| **Phase 5: フロンティア** | 50,000台 | ~100 TB | **6.7T** (FP8/FP4混合) | **フロンティア級 / Frontier-class** |
| **Phase X: 超越** | 100,000台 | ~200 TB | **10T+** (FP4/2bit混合) | **全既存モデル超え / Beyond all existing models** |

> 50,000台のスマホを調達するコストは約2億円（@4,000円換算）。これはH100 1台（約500万円）の40倍だが、H100 1台では6.7Tモデルは絶対に動かない。Akasha-OSだけが到達可能な領域。

> 50,000 used smartphones cost approximately ¥200M (@¥4,000 each). That's 40× the price of a single H100 GPU (~¥5M) — but a single H100 cannot run a 6.7T model. Only Akasha-OS can reach this scale.

---

## ⚡ 3. ビッグテックに対する圧倒的な優位性

### ① コストの民主化（破格のイニシャル・ランニングコスト）

| | 従来型データセンター | Akasha-OS |
|---|---|---|
| **イニシャルコスト** | 数億〜数十億円 | 〜500万円（中古スマホ1,000台＋ネットワーク機器） |
| **電気代（月間）** | 数千万〜数億円 | 約15〜20万円（1,000台フル稼働時） |
| **冷却設備** | 液冷/空調専用設備必須 | 自然空冷（スマホの放熱で十分） |
| **調達方法** | ベンダー契約、数ヶ月のリードタイム | ヤフオク・メルカリで即日購入可能 |
| **廃棄コスト** | 産業廃棄物処理 | そもそも廃棄物を資源にアップサイクル |

### ② ゼロコピー・バイナリリレーによる「通信の壁」の突破

1文字（トークン）ごとに数万台と通信すると、通常はネットワーク遅延でシステムが崩壊します。Akasha-OSは：

- **JSON文字列を完全に排除** — 全通信は48バイト固定ヘッダ + Float32Array の生バイナリ
- **WebGPUへ zero-copy** — 受信した ArrayBuffer をコピーせずにそのままGPUバッファへ
- **P2Pダイレクトリレー** — 中間レイヤーの計算結果はマスターを経由せず、次のノードへ直接転送
- **バッファプール** — 全パケット用 ArrayBuffer を使い回し、V8 GC を完全に抑制

これにより、ローカル有線LAN（1Gbps × 複数スイッチ）の帯域限界まで速度を引き上げます。

### ③ 投機的シャドウ・レーシング（超高耐久フォールトトレランス）

中古スマホの熱ダレや瞬断に備え、OSは常に同じ計算を「本尊」と「影武者」の2台に同時送信します。

```
Primary Node (Snapdragon 8 Gen 3)        Shadow Node (Dimensity 9300)
─────────────────────────────────        ──────────────────────────────
COMPUTE_TASK受信                         COMPUTE_TASK受信 (Flag.SHADOW)
                                         │
サーマルスロットリング発生！               │ 順調に計算継続
                                         ├─ 計算完了 t=7.2ms
                                         ├─ RELAY送信 → 先着！採用！
                                         │
計算完了 t=12.8ms                         │
RELAY送信 → 遅刻！O(1)で破棄              │
```

- 1マイクロ秒でも早く計算を終えた方の勝ち（レース形式）
- 遅かったデータは `Map.delete()` により O(1) で自動破棄
- システムを1秒も止めずに、常に最速の実行経路（Execution Lane）を維持

---

## � 4. アーカーシャ・プラグイン・アーキテクチャ（高い拡張性の担保）

## 🔌 4. Akasha Plugin Architecture (Open Extension)

世界中の開発者が自由に参入できるよう、Akasha-OSは厳格な「プラグイン・インターフェース」を提供します。
To enable developers worldwide to contribute freely, Akasha-OS provides a strict plugin interface standard.

### ① 専門家ノードのオープン・プラグイン規格 / Open Expert Plugin Standard

任意のLLM（Llama、Gemma、Phi、または自作の極小モデル）をアーカーシャのネットワークに接続するための、標準ラッパー仕様です。
A standard wrapper spec for connecting any LLM (Llama, Gemma, Phi, or custom tiny models) to the Akasha network.

開発者は、自分のモデルを `AkashaExpertPlugin` インターフェースに従って **1つ関数を書くだけ** で、数万台のマトリックスに「1ノード」として即座に組み込めます。
Developers can plug their model into the swarm of tens of thousands of nodes by writing **a single function** behind the `AkashaExpertPlugin` interface.

```typescript
// 誰でも作れるアーカーシャ専門家プラグインの標準規格
// Standard Akasha expert plugin — only ONE function required
export interface AkashaExpertPlugin {
    metadata: {
        id: string;              // プラグインの一意のID / Unique plugin ID
        name: string;            // 表示名 / Display name
        version: string;         // セマンティックバージョン
        expertDomain: string;    // 専門分野 / Expert domain (e.g. "math", "code", "medical")
        parameterSize: string;   // モデルサイズ / Model size (e.g. "0.1B", "3.8B")
        description: string;     // 一言説明 / One-line description
        author: string;          // 作者名 / Author
        keywords: string[];      // ルーティング用キーワード / Routing trigger keywords
        expectedInputDim: number;  // 入力次元数 / Input hidden size
        expectedOutputDim: number; // 出力次元数 / Output hidden size
        estimatedLatencyUs: number;// 推論時間の目安(μs) / Estimated latency
        preferredClusterId: number;// 希望クラスタID (0=自動) / Preferred cluster (0=auto)
    };
    // マスターOSからバイナリテンソルを受け取って推論を返すコア関数
    // Core function: receives Float32Array → returns Float32Array
    execute(inputTensor: Float32Array): Promise<Float32Array>;
}
```

**最小実装例 / Minimal working example（数学特化プラグイン / math expert）:**

```typescript
import type { AkashaExpertPlugin } from 'akasha-os';

const myMathPlugin: AkashaExpertPlugin = {
  metadata: {
    id: 'com.example.phi3-math',
    name: 'Phi-3 Math Expert',
    version: '1.0.0',
    expertDomain: 'math',
    parameterSize: '3.8B',
    description: 'Fine-tuned Phi-3-mini for mathematical reasoning.',
    author: 'example-dev',
    keywords: ['math', 'arithmetic', 'algebra', 'calculus'],
    expectedInputDim: 3072,
    expectedOutputDim: 3072,
    estimatedLatencyUs: 8_000,
    preferredClusterId: 0,
  },
  execute: async (inputTensor: Float32Array): Promise<Float32Array> => {
    // あなたのモデルで推論 / Run your model inference here
    const output = await myModel.forward(inputTensor);
    return output;
  },
};
```

**ライフサイクル対応プラグイン / Lifecycle-aware plugin（オプション / optional）:**

```typescript
import type { AkashaLifecyclePlugin } from 'akasha-os';

const advancedPlugin: AkashaLifecyclePlugin = {
  metadata: { /* ...同上 / same as above... */ },
  execute: async (input) => { /* ... */ },
  // プラグイン登録時に一度だけ呼ばれる（モデルのロード等）
  // Called once on registration (model loading, GPU warm-up)
  onRegister: async () => { await loadModelWeights(); },
  // プラグイン解除時に呼ばれる（GPUメモリ解放等）
  // Called on unregistration (GPU memory cleanup)
  onUnregister: async () => { await releaseGPU(); },
  // 30秒毎に呼ばれるヘルスチェック
  // Called every 30s for health reporting
  onHealthCheck: async () => ({
    healthy: true,
    uptimeSeconds: process.uptime(),
    totalInferences: 1500,
    averageLatencyUs: 7_200,
  }),
};
```

### ② セマンティック・ルーティングの動的拡張 / Dynamic Semantic Routing Extension

「どのようなプロンプトが来たら、どの専門家クラスターに処理を投げるか」というOSのルーター判定基準を、プラグイン形式で後からいくらでも追加・学習できます。
The OS router's decision criteria — "which expert cluster should handle this prompt?" — can be extended indefinitely via plugins.

新しい専門家プラグインがネットワークに参加すると、マスターOSは自動的にその専門分野のキーワードやベクトル領域をルーターの判定マップに動的登録（**ホットプラグ**）します。
When a new expert plugin joins the network, the master OS automatically registers its keywords into the router's decision map — **hot-plug, no restart required**.

```typescript
import { PluginRegistry } from 'akasha-os';

const registry = new PluginRegistry();

// ホットプラグ: サーバー再起動不要で即座にルーティングに反映
// Hot-plug: immediately reflected in routing, no server restart
await registry.install(myMathPlugin);

// プロンプトが "solve 2x + 5 = 15" なら myMathPlugin のクラスタに自動ルーティング
// Prompt "solve 2x + 5 = 15" → auto-routed to myMathPlugin's cluster
const clusterId = registry.route("solve 2x + 5 = 15");
```

**内部データ構造 / Internal data structure — O(1) keyword lookup:**

```
keywordIndex: Map<"math",     Set<"com.example.phi3-math", "com.example.gemma-math">>
              Map<"medical",  Set<"com.example.med-llama">>
              Map<"code",     Set<"com.example.copilot-mini">>

domainIndex:  Map<"math",     Set<pluginIds...>>
              Map<"medical",  Set<pluginIds...>>
              Map<"code",     Set<pluginIds...>>
```

### ③ コミュニティ駆動型 DePIN マーケットプレイス / Community-Driven DePIN Marketplace

将来的には、GitHub上の開発者がコードを寄与するだけでなく、**「自分のスマホのブラウザで、誰かが作った数学プラグインを動かしてネットワークに貢献する」**という、インフラレベルでのオープンコミュニティ形成を目指します。
The vision extends beyond code contributions on GitHub: **anyone can open their phone's browser, run a math plugin someone else wrote, and contribute compute to the network** — an open community at the infrastructure level (DePIN: Decentralised Physical Infrastructure Network).

```mermaid
graph LR
    A[🔧 Developer<br/>writes plugin] --> B[📦 GitHub<br/>publishes plugin]
    B --> C[🔍 Akasha Registry<br/>auto-discovers]
    C --> D[📱 Phone owner<br/>opens browser]
    D --> E[⚡ Contributes<br/>compute to swarm]
    E --> F[💰 Optional:<br/>token rewards]
```

---

## 🚀 5. クイックスタート / Quick Start

- Node.js >= 20.0.0
- npm >= 10

### インストール

```bash
cd akasha
npm install
npm run build
```

### 起動

```bash
# マスターサーバー起動（デフォルト port 8080）
npm run dev

# エッジシミュレーター起動（ブラウザで http://localhost:4173 を開く）
npm run edge

# デモシミュレーション
npm run sim

# 自己診断テスト
npm run selftest
```

### 設定

環境変数でマスターポートを変更可能：
```bash
AKASHA_PORT=9090 npm run dev
```

---

## 🧪 5.5. PoC 実機検証ガイド / Proof-of-Concept Guide

2〜4台の実機スマホ + ギガビットスイッチでエンドツーエンド検証を行う手順です。

### 必要機材 / Required Hardware

| 機材 | 推奨 | 数量 |
|------|------|------|
| ギガビット L2 スイッチ | セルフパワード（PoE不要） | 1 |
| USB-C → Ethernet アダプタ | ASIX AX88179 / Realtek RTL8153 チップ | スマホの数 |
| Android スマホ | Android 12+, Chrome 120+ | 2台以上 |
| マスター PC | Linux / macOS, Node.js 20+ | 1 |

### 手順 / Steps

```bash
# ── 1. エッジ端末セットアップ（各スマホで実行） ──
# Termux をインストール後:
pkg install iperf3 curl
bash poc/edge-setup.sh

# ── 2. マスター起動 ──
cd akasha-master
npm install && npm run build
npm run dev

# ── 3. 計測実行（マスター PC で） ──
chmod +x poc/measure.sh
./poc/measure.sh <edge-ip-1> <edge-ip-2>

# ── 4. WebTransport RTT 単体テスト ──
node poc/wt-rtt-measure.mjs <master-ip> 8080

# ── 5. メトリクス確認 ──
curl http://localhost:9090/metrics
```

### 成功基準 / Success Criteria

| 指標 | 目標 | 測定方法 |
|------|------|---------|
| **ICMP RTT（中央値）** | < 2ms | `ping -c 20 <edge-ip>` |
| **TCP スループット** | > 800 Mbps | `iperf3 -c <edge-ip> -t 10` |
| **WebTransport datagram RTT（中央値）** | < 5ms | `node poc/wt-rtt-measure.mjs` |
| **E2E 推論レイテンシ（中央値/トークン）** | < 30ms | Prometheus `/metrics` の `akasha_latency_us` |
| **パケットロス率** | < 0.1% | datagram echo テスト |

### トラブルシューティング / Troubleshooting

| 症状 | 原因 | 対処 |
|------|------|------|
| WebTransport 接続不可 | Chrome フラグ未有効 | `chrome://flags/#enable-webtransport` を Enabled に |
| Ethernet 認識せず | アダプタ非対応 | ASIX AX88179 チップのアダプタに交換 |
| iOS Safari で WebTransport 不可 | Safari 未対応 | Chrome for iOS を使用（制限あり）/ Android を主戦場に |
| パケットロス多発 | MTU 不整合 | `ip link set eth0 mtu 1500` でMTU統一 |

---

## 📡 6. バイナリプロトコル仕様 / Binary Protocol

全通信は48バイト固定ヘッダ + Float32Arrayペイロードのバイナリフレームです。詳細は [`PROTOCOL.md`](PROTOCOL.md) を参照。

| コマンド | 値 | 方向 | 用途 |
|---------|-----|------|------|
| `REGISTER` | 0x01 | Edge → Master | ノード登録 |
| `HEARTBEAT` | 0x02 | Edge → Master | 生存確認 |
| `COMPUTE_TASK` | 0x03 | Master → Edge | 計算タスク配信 |
| `RESULT` | 0x04 | Edge → Master | 計算結果返送 |
| `FAILOVER` | 0x05 | Master → Shadow | シャドウへのフェイルオーバー |
| `ACK` | 0x06 | 双方向 | 確認応答 |
| `BENCHMARK` | 0x08 | Master → Edge | 性能測定プローブ |
| `ASSIGN` | 0x09 | Master → Edge | 役割・クラスタ任命 |
| `RELAY` | 0x0A | Edge → Edge† | バンド間活性化リレー |
| `TOKEN_OUT` | 0x0B | Edge → Master | 最終トークン出力 |

† RELAY はエッジがサーバーソケットを持てない場合、マスターが透過プロキシする。

---

## 🧪 7. APS（アーカーシャ・パフォーマンス・スコア） / Akasha Performance Score

接続時に各ノードの性能を自動測定し、役割を割り振ります。

$$APS = \frac{1000}{\text{GPU}_\text{ms} + \frac{\text{RTT}_\text{ms}}{2}}$$

| APS範囲 | 役割 | 担当 |
|---------|------|------|
| APS ≥ 80 | `CORE_ROUTER` | LLMのHeadレイヤー（重要度の高いコンテキスト処理層） |
| 25 ≤ APS < 80 | `ACTIVE_COMPUTE` | 通常の中間計算レイヤー |
| APS < 25 | `SHADOW_BACKUP` | 冗長化のための影武者バックアップ |

---

## 📂 8. プロジェクト構造 / Project Structure

```
Akasha-OS/
├── README.md                   # プロジェクト仕様書 / Project specification
├── LICENSE                     # MIT License
├── CONTRIBUTING.md             # コミュニティ参加ガイド / Contribution guide
├── .gitignore
├── .github/
│   └── ISSUE_TEMPLATE/         # Bug報告 / プラグイン提案 / 機能リクエスト
│
├── akasha-master/              # 【第3層】マスターオーケストレーター (TypeScript)
│   ├── package.json
│   ├── tsconfig.json
│   ├── PROTOCOL.md
│   └── src/
│       ├── index.ts            # OS起動エントリポイント
│       ├── binary/             # 48バイト固定ヘッダ バイナリコーデック
│       ├── bootstrap/          # 起動・自動認識エンジン（DoS防止）
│       ├── client/             # Node.js エッジクライアント
│       ├── core/               # マスターオーケストレーター & 推論ループ
│       ├── edge/               # ブラウザWebWorker推論
│       ├── fault/              # フォールトトレランス & 動的ルーティング
│       ├── ipc/                # ロックフリー SPSC リングバッファ
│       ├── plugin/             # プラグインインターフェース & レジストリ
│       ├── pool/               # オブジェクトプール / バッファプール
│       ├── sim/                # デモ & 自己診断
│       ├── structures/         # O(1) データ構造（DLL / アイドルプール）
│       └── workers/            # ネットワーク & ルーターワーカー
│
├── akasha-client-web/          # 【第2層】ブラウザ版エッジノード
│   ├── index.html              # VRAM/レイテンシ ダッシュボード
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts             # メインUIスレッド（OSタスクキル防止）
│       ├── worker.ts           # WebWorker ゼロコピーバイナリ通信
│       └── webgpu-core.ts      # WebGPU テンソル直接バインド
│
├── akasha-kernel-native/       # 【プランB】独自ネイティブカーネル (Rust)
│   ├── Cargo.toml
│   ├── BUILD.md                # クロスコンパイル完全ガイド
│   └── src/
│       ├── main.rs             # スタンドアロン起動 (Android/iOS/PC)
│       ├── lib.rs              # JNI / C FFI エクスポート
│       ├── kernel.rs           # 統合カーネル
│       ├── protocol.rs         # バイナリプロトコル (Rust実装)
│       ├── memory/pool.rs      # 静的テンソルプール (ゼロアロケーション)
│       ├── gpu/                # wgpu 計算エンジン + WGSLシェーダー
│       ├── net/                # QUIC / TCP P2Pトランスポート
│       └── platform/           # Android (Foreground) / iOS (BGTask) / Desktop
│
└── examples/                   # コミュニティプラグインサンプル
    ├── plugin-math/            # 数学専門LLMプラグインのテンプレート
    └── plugin-code/            # コード生成LLMプラグインのテンプレート
```

---

## 🌍 9. コミュニティ / Community

Akasha-OS は完全にオープンなコミュニティプロジェクトです。
Akasha-OS is a fully open community project.

- **プラグインを投稿 / Submit a plugin**: [`examples/`](examples/) のテンプレートをコピーして PR を送ってください / Copy a template from `examples/` and open a PR.
- **バグ報告 / Report a bug**: [Issue Templates](.github/ISSUE_TEMPLATE/bug_report.md)
- **機能提案 / Propose a feature**: [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md)
- **新規プラグイン提案 / Propose a new expert**: [Plugin Proposal](.github/ISSUE_TEMPLATE/plugin_proposal.md)
- **開発参加 / Contribute code**: [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照 / See `CONTRIBUTING.md`

---

## 📝 10. ライセンス / License

MIT License — [`LICENSE`](LICENSE)

---

> *「知識は、たとえそれが砂粒のように小さくとも、繋がれば砂漠となり、やがて全世界を覆う。」*
> —— スメール・アーカーシャシステム運用理念（『原神』世界設定より）
>
> *"Knowledge, however small each grain may be, when connected becomes a desert that eventually covers the entire world."*
> —— Sumeru Akasha System operational philosophy (from the world of *Genshin Impact*)
