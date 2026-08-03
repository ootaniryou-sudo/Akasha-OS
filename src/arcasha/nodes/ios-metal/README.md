# ArcAsha iOS Node — Metal (iPhone / iPad 実行ノード)

iPhone / iPad を **ArcAsha の実行ノード**にする iOS アプリ。
WebGPU が使えない iOS のため、推論は **Metal** (llama.cpp + ggml-metal、metallib 埋め込み) で実行します。

> 旧「一筆 (ippitsu)」メモアプリの Xcode プロジェクト (bundle ID `com.otani.ippitsu`) を
> 流用し、中身を ArcAsha ノードに全面変更。Xcode プロジェクトファイルは変更していません
> (CocoaPods と Dart コードのみ変更)。

## アーキテクチャ

```
ArcAsha Hub (WS :8080)
      ↑ register / compute / result (JSON over WebSocket)
Flutter (Dart)
   ├── lib/main.dart             — ステータス UI (ロード/接続/統計/ログ/自己テスト)
   ├── lib/arcasha/node_client.dart — WS プロトコル (register・ping/pong・compute→result)
   └── lib/arcasha/metal_engine.dart — MethodChannel 'arcasha/metal' ラッパー
          ↑
Native (iOS Runner)
   ├── AppDelegate.swift         — MethodChannel ハンドラ
   └── ios/arcasha_llama/        — ローカル Pod 'ArcAshaLlama'
        ├── Sources/ArcAshaMetalNode.swift — llama.cpp C API ラッパー (Metal 全層オフロード)
        ├── lib/*.a              — llama.cpp + ggml-metal 静的ライブラリ (arm64, metallib 埋め込み)
        └── include/*.h          — llama.h / ggml 系ヘッダ
```

## モデル

- **SmolLM2-135M-Instruct** (Q4_K_M, 約 105MB) をバンドル
- ハブの `KNOWN_PARAMS` に `HuggingFaceTB/SmolLM2-135M-Instruct: 135` が登録済み
- 変更方法: `assets/models/` の GGUF を差し替え + `lib/arcasha/metal_engine.dart` の
  `modelAsset` / `modelId` / `modelFileName` を更新

## ビルド (macOS + Xcode 26.x + Flutter)

```bash
cd ippitsu

# 0. バンドル用モデルを取得 (git には含めない。GitHub 100MB 制限のため)
./download_model.sh

# 1. 依存解決
flutter pub get
cd ios && pod install && cd ..

# 2. 実機 (iPhone/iPad) 向けビルド (署名なしでコンパイル検証)
flutter build ios --no-codesign

# 3. 実機へインストール (Xcode で Runner.xcworkspace を開いて Run、または)
open ios/Runner.xcworkspace
#   → 署名チームを選択して実機に Run
```

> **モデル**: 105MB の GGUF は GitHub の 100MB 制限を超えるため git 管理外。
> `./download_model.sh` で取得してください (README と `.gitignore` に記載)。
> llama.cpp のクローン (227MB) も git 管理外。プリビルド静的ライブラリのみ同梱。

### 注意点

- **iOS 16.4+ / arm64 実機のみ** (llama.cpp 公式と同じ。シミュレータは要別途ビルド)
- 初回起動時にアセットの GGUF を Application Support へ展開 (約 105MB、1 回のみ)
- 実機の設定 → プライバシー → ローカルネットワーク で許可が必要
  (Info.plist に `NSLocalNetworkUsageDescription` 追加済み)

## 使い方 (ハブと接続)

```bash
# 1. Mac で ArcAsha ハブを起動 (例: EXP-0003 マスター)
(cd /Users/ooyaryou/my-AI-fac && source .venv/bin/activate && python Akasha-OS/akasha-master/experiments/qwen3_0.6b/EXP-0003/run_master.py --port 8080)

# 2. iPhone のアプリで「モデルをロード」→ ハブ URL (Mac の LAN IP) を入力 → 接続
#    ノード ID: node-ios-metal (family=metal → chat=true)

# 3. Mac 側から他のノード (Qwen/SmolLM/Gemma) と同様に推論を依頼できる
```

## WS プロトコル (ハブ ExpertHub と 1:1)

```
→ {"type":"register","node":{"id":"node-ios-metal","platform":"ios-metal","device":"Apple GPU (Metal)",
   "role":"expert","backend":"llama.cpp-metal","precision":"q4_k_m",
   "model_id":"HuggingFaceTB/SmolLM2-135M-Instruct","capabilities":{"coding":0.4,"math":0.4,"general":0.5}}}
← {"type":"register_ack","node_id":...,"master":"ArcAsha"}
← {"type":"compute","request_id":...,"prompt":...,"max_new_tokens":...,"temperature":0,"top_p":1,"chat":true}
→ {"type":"result","request_id":...,"tokens":[...],"text":"...","timing":{"tokenize_ms":..,"prefill_ms":..,"decode_ms":..,"total_ms":..},
   "metadata":{"node_id":...,"model_id":...,"backend":"llama.cpp-metal",...}}
→ {"type":"error","request_id":...,"error":"..."}   // 失敗時
```

## llama.cpp の再ビルド (Metal ライブラリ更新時)

```bash
cd ios/arcasha_llama/llama.cpp
cmake -B build-ios-device -G Xcode \
  -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=16.4 -DBUILD_SHARED_LIBS=OFF \
  -DLLAMA_BUILD_APP=OFF -DLLAMA_BUILD_COMMON=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_TOOLS=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_SERVER=OFF \
  -DLLAMA_BUILD_MTMD=OFF -DLLAMA_OPENSSL=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_METAL_USE_BF16=ON \
  -DGGML_BLAS_DEFAULT=ON -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -S .
cmake --build build-ios-device --config Release --target llama -j 8
# 生成物を pod にコピー
cp build-ios-device/src/Release-iphoneos/libllama.a ../lib/
cp build-ios-device/ggml/src/Release-iphoneos/libggml*.a ../lib/
cp build-ios-device/ggml/src/ggml-metal/Release-iphoneos/libggml-metal.a ../lib/
```

## ライセンス

- アプリ: MIT (ArcAsha / Akasha-OS)
- llama.cpp / ggml: MIT (ベンダード静的ビルドとして同梱)
