# ArcAsha — iPad + iPhone でモデル実行デモ

iPhone / iPad を **ArcAsha の実行ノード**にして、実際にモデル推論を行うデモの手順。

```
┌─────────────┐   ws://<Mac-LAN-IP>:8080   ┌─────────────────┐
│  Mac (ハブ) │ ◄───────────────────────── │  iPhone 15 Pro  │
│  demo-hub   │                            │  (SmolLM2-135M) │
└──────┬──────┘                            └─────────────────┘
       │   ws://<Mac-LAN-IP>:8080
       └──────────────────────────► ┌─────────────────┐
                                    │  iPad Pro        │
                                    │  (SmolLM2-135M)  │
                                    └─────────────────┘
```

各端末は **llama.cpp + ggml-metal** で `Qwen2.5-1.5B-Instruct` (Q4_K_M, 約940MB) を
**ローカルの Apple GPU (Metal)** で実行する。ハブはプロンプトを全ノードへ並列配信し、
各ノードが生成結果とレイテンシを返す。

---

## 0. 必要なもの

| 項目 | 内容 |
|---|---|
| Mac | Xcode 26.x + Flutter 3.x（本リポジトリで確認済み） |
| iPhone / iPad | iOS 16.4+ / iPadOS 16.4+、**実機**（arm64） |
| Wi-Fi | Mac と端末が**同じネットワーク**（ハブへの接続に使用） |
| モデル | `assets/models/qwen2.5-1.5b-instruct-q4_k_m.gguf`（約940MB、`download_model.sh` で取得） |

> **開発者モード（重要）**: Xcode から実機にインストールするには、端末側で
> **設定 → プライバシーとセキュリティ → 開発者モード → オン → 再起動** が必要。
> 初回ビルド時に Xcode が案内する場合もある。

---

## 1. インストール方法を選ぶ（2通り）

### ルートA: 無料プロビジョニング（即時・PLA不要・推奨）⭐

有料PLAに同意しなくても、**個人のApple ID（無料）で実機3台まで開発インストール**可能。

**前提（済み）**: 以下の対応は実施済み・検証済み
- バンドルIDを `com.otani.arcasha-node` に変更
  （`com.otani.ippitsu` は有料チームに登録済みのため無料プロビジョニングと衝突する）
- App Groups / Side Button の entitlements を削除（有料メンバーシップ必須のため）
- `build_install.sh` を個人チーム向けに更新
  ※ チームIDは証明書の **OU = `MN79JBUP8P`**（表示名の `(4CH5Z8BKWC)` はチームIDではない）
- llama.cpp 新API対応のバグ修正（下記「修正済みバグ」参照）

**やること**:
1. **Apple ID を Xcode に追加**（必須・1回だけ）:
   Xcode → Settings → Accounts → **「+」** → Apple ID（`ot2ryotani@gmail.com`）でサインイン
   ※ パスワード + 2FA認証が必要（本人操作のため実施してください）
2. 端末の準備: iPad / iPhone 15 Pro とも **設定 → プライバシーとセキュリティ →
   開発者モード → オン → 再起動**。iPhone 15 Pro はロックを解除した状態にする
3. 初回インストール後に **設定 → 一般 → VPNとデバイス管理 → 「Apple Development: ...」→ 信頼**
   （無料プロビジョニングでは必須）
4. 一括インストール:
   ```bash
   cd akasha-master/src/arcasha/nodes/ios-metal/ippitsu/ios
   ./build_install.sh    # iPad + iPhone 15 Pro を自動ビルド&インストール
   ```
   （または Xcode で `open ios/Runner.xcworkspace` → Signing で個人チームを選択 → 端末選択 → ⌘R）

### ルートB: TestFlight（App Store Connect 経由・UDID登録不要）※要PLA

一筆 (ippitsu) を既に App Store Connect に登録済みなので、`com.otani.ippitsu` の
アプリレコードが存在する。**TestFlight なら端末のUDID登録が不要**で、どの端末にも
インストールできる。※ 配布署名作成には PLA 同意が必要（今回はスキップ）。

> 注意: 本リポジトリのアプリは無料プロビジョニング対応のためバンドルIDを
> `com.otani.arcasha-node` に変更済み。TestFlightで元の `com.otani.ippitsu` を
> 使う場合はバンドルIDを戻し、PLA同意後に配布してください。

1. **PLA同意**（上記ルートAと同じ。配布証明書の作成がブロックされるため必須）
2. App Store Connect で **バージョン 2.0.0 を新規作成**（本アプリは version 2.0.0+2 に更新済み）
3. Xcode で **Product → Archive** → Organizer で **Distribute → App Store Connect**
   （「iOS Distribution」証明書は自動で作成される）
4. TestFlight でビルドを公開 → iPad / iPhone 15 Pro の **TestFlight アプリからインストール**
5. アプリ起動 → モデルロード → ハブ接続

> 配布前の準備（実施済み）:
> - バージョン `2.0.0+2` に更新（旧一筆とのビルド番号衝突を回避）
> - Widget 拡張のバージョンをアプリと同期（`$(FLUTTER_BUILD_NAME)` / `$(FLUTTER_BUILD_NUMBER)`）
> - 一筆から引き継いだ不要なプライバシーキー（Face ID / 写真ライブラリ）を削除
>   ※ ArcAsha はこれらの機能を使わないため、App Review での指摘を防止

---

## 2. Mac でハブを起動

```bash
cd /Users/ooyaryou/my-AI-fac/Akasha-OS/akasha-master
npm run demo:hub -- --port 8080
```

```
  🟢 ArcAsha ExpertHub on ws://localhost:8080 (need 1 experts)
  🟢 Hub listening ws://0.0.0.0:8080
```

- Mac の LAN IP を確認: `ipconfig getifaddr en0`（例: `192.168.0.17`）
- 端末からは `ws://<MacのLAN IP>:8080` で接続する
- ファイアウォールで 8080 が許可されていること（macOS 設定 → ネットワーク → ファイアウォール）

> **実機なしで試す場合**: 別ターミナルで
> `npm run demo:mock-node -- --node-id mock-ios-a` を2回（異なる node-id で）起動すると
> ハブの動作を疑似ノードで確認できる。

### 接続方法（重要）

端末がMacと同じWi-Fiにいない場合でも、**USB接続経由で接続可能**（検証済み）。

| 接続経路 | ハブURL |
|---|---|
| 同じWi-Fi | `ws://<MacのLAN IP>:8080`（例 `ws://192.168.0.17:8080`） |
| USB（iPad） | `ws://169.254.238.70:8080`（Macのen10） |
| USB（iPhone 15 Pro） | `ws://169.254.172.114:8080`（Macのen11） |

※ USBのIPは `ifconfig en10/en11 | grep inet` で確認（リンクローカル 169.254.x.x）。
※ アプリ初回接続時に「ローカルネットワーク」許可ダイアログが出たら許可。

### 修正済みバグ（llama.cpp 新API対応・2026-08-04）

1. **llama_tokenize クエリパターン** — 新llama.cpp(commit 0b14b87)では
   `llama_tokenize(..., NULL, 0, ...)` は負数(-必要トークン数)を返す。
   旧判定 `<=0 → 失敗` だと常に失敗していた。`abs()` で必要サイズを取得するよう修正。
2. **KVキャッシュ未クリア** — 2回目以降のgenerateで `prefill decode failed`。
   `llama_kv_cache_clear` は新APIで **`llama_memory_clear(llama_get_memory(ctx), true)`** に改名。
   generate冒頭でクリアするよう修正。
3. **ハブのエラー非表示** — ExpertHubが `error` メッセージを無視し120秒タイムアウトしていた。
   エラーで即 reject するよう改善。
4. **アプリの接続失敗で切断ボタンが固まる** — `start()` を `Future<bool>` にし、失敗時に
   `_running`/`_connecting` をリセットするよう修正。

---

## 2. アプリをビルドして実機にインストール

```bash
cd /Users/ooyaryou/my-AI-fac/Akasha-OS/akasha-master/src/arcasha/nodes/ios-metal/ippitsu
open ios/Runner.xcworkspace
```

1. Xcode で **Runner** スキームを選択
2. 上部のデバイス選択で **大谷涼のiPhone12mini / 大谷涼のiPad** を選択
3. **Signing & Capabilities** → Team に自分の Apple ID を選択（未登録なら
   Xcode → Settings → Accounts に Apple ID を追加）
   - 初回は「デバイスを登録」の確認ダイアログが出るので許可
4. **⌘R で Run**（iPad → iPhone の順に各端末へ）

> コマンドラインで一括インストールする場合:
> ```bash
> # 署名付きビルド（iPad をプロビジョニングに自動登録）
> cd ios
> xcodebuild -workspace Runner.xcworkspace -scheme Runner -configuration Release \
>   -destination 'id=<iPadのUDID>' -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
> # インストール
> xcrun devicectl device install app --device <iPadのUDID> <Runner.app のパス>
> ```
> ※ 端末の UDID は `flutter devices` で確認できる。

---

## 3. 両端末でノードを起動

**バージョン2.x以降は完全自律ノード**です：起動時に端末（iPad/iPhone）を自動判別し、
**モデルロード → ハブ自動接続**まで手入力なしで実行します。

| 端末 | 自動設定されるハブURL | 自動設定されるノードID |
|---|---|---|
| iPhone 15 Pro | `ws://169.254.172.114:8080` | `node-ios-iphone15` |
| iPad Pro | `ws://169.254.238.70:8080` | `node-ios-ipad` |

- アプリを開いて放置すれば、ログに「🔄 自律ノード: モデルロード → 自動接続」→
  「✅ モデルロード完了 (Qwen2.5-1.5B-Instruct / Metal)」→ ハブ接続、と進みます
- 設定を変更した場合は接続時に自動保存され、次回起動からその設定で自動接続します
- 初回のみ「ローカルネットワークへのアクセス」許可が必要

1. **モデルをロード**（初回は約105MBのGGUFをアプリ内へ展開、数秒〜数十秒）
2. ハブURLを入力（`ws://<MacのLAN IP>:8080`）
3. **ハブに接続** → ステータスが「登録済み」になればOK
4. （オプション）自己テストでオフライン生成を確認

初回接続時に「ローカルネットワークへのアクセス」許可ダイアログが出るので**許可**する。

---

## 4. モデル実行

ハブのターミナルにプロンプトを入力して Enter を押すと、**全ノードに並列配信**され、
各端末が Metal で生成して結果を返す。

```
⌨️  What is 15% of 340? Answer with a number.

  🚀 [13:05:12] "What is 15% of 340? Answer with a number."
      → 2 ノードに並列 dispatch ...

  ── node-ios-ipad (HuggingFaceTB/SmolLM2-135M-Instruct, 135M) — 243ms
       51

  ── node-ios-iphone (HuggingFaceTB/SmolLM2-135M-Instruct, 135M) — 387ms
       51

  ⏱  全体 387ms
```

- 各ノードの応答には `(node,prompt)` の決定論キャッシュが効く（同じプロンプトは即時応答）
- ノードIDの重複があるとハブが警告する
- 終了は `Ctrl+C`

---

## 5. トラブルシューティング

| 症状 | 対処 |
|---|---|
| 「PLA Update available」 | developer.apple.com/account で最新の Program License Agreement に同意（配布証明書作成も解除される） |
| 「No Account for Team」 | Xcode → Settings → Accounts に Apple ID を追加 |
| 「Developer Mode disabled」 | 端末の 設定 → プライバシーとセキュリティ → 開発者モード → オン → 再起動 |
| 「may need to be unlocked」 | 端末の画面ロックを解除した状態で再試行 |
| 接続できない（WS） | ① 同じWi-Fi ② MacのIPが正しい ③ ファイアウォールで8080許可 ④ ローカルネットワーク許可ダイアログ |
| モデルロード失敗 | アプリ再起動。`assets/models/` のGGUFサイズが105,454,432バイトか確認 |
| ノードが2台登録されない | 両端末でノードIDを別々にする（`node-ios-ipad` / `node-ios-iphone15`） |
| TestFlightでインストールできない | App Store Connectでバージョン2.0.0を作成しているか確認。ビルド番号は2以上 |

---

## 6. 次のステップ（本格的な ArcAsha コントローラ）

デモハブは「全ノードへブロードキャスト」するだけ。本来の ArcAsha は
**LinUCB-Shadow ルーティング**で「タスクに最適なノード」を選んで実行する。

```bash
# Mac 側に Python ノードも追加（Qwen3-0.6B など）
cd /Users/ooyaryou/my-AI-fac && source .venv/bin/activate
python Akasha-OS/akasha-master/experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16 --device mps

# ArcAsha コントローラ起動（3エキスパート必要）
cd Akasha-OS/akasha-master
npx tsx src/arcasha/index.ts
```

詳細は `src/arcasha/README.md` と `nodes/ios-metal/README.md` を参照。
