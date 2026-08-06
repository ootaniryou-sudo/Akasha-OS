"""
一筆（いっぴつ）TFLite超軽量モデル訓練スクリプト v2

使用方法:
  python ml/train.py --data ml/sample_data.csv --output assets/models/
"""

import argparse, os, sys, json, warnings, random
from pathlib import Path
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"
import tensorflow as tf
from tensorflow import keras
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from sklearn.metrics import classification_report, accuracy_score

LABELS = ["アイデア", "買い物", "日記", "仕事", "読書", "旅行", "健康", "財務", "人間関係", "メモ"]
MAX_NGRAM = 3

class CharNGramVectorizer:
    def __init__(self, max_ngram=MAX_NGRAM, max_features=3000):
        self.max_ngram = max_ngram
        self.max_features = max_features
        self.vocab = {}
        self.vocab_size = 0

    def _clean_text(self, text):
        return str(text).strip().replace(" ", "").replace("\u3000", "")

    def _extract_ngrams(self, text, n):
        cleaned = self._clean_text(text)
        return [cleaned[i:i+n] for i in range(len(cleaned)-n+1)]

    def fit(self, texts):
        ngram_counter = {}
        for text in texts:
            for n in range(1, self.max_ngram + 1):
                for ng in self._extract_ngrams(text, n):
                    ngram_counter[ng] = ngram_counter.get(ng, 0) + 1
        sorted_ngrams = sorted(ngram_counter.items(), key=lambda x: -x[1])
        selected = sorted_ngrams[:self.max_features]
        self.vocab = {ng: idx for idx, (ng, _) in enumerate(selected)}
        self.vocab_size = len(self.vocab)
        print(f"  抽出n-gram数: {len(ngram_counter)} \u2192 採用: {self.vocab_size}")

    def transform(self, texts):
        result = np.zeros((len(texts), self.vocab_size), dtype=np.float32)
        for i, text in enumerate(texts):
            seen = set()
            for n in range(1, self.max_ngram + 1):
                for ng in self._extract_ngrams(text, n):
                    if ng in self.vocab and ng not in seen:
                        result[i, self.vocab[ng]] = 1.0
                        seen.add(ng)
        return result

def augment_dataset(df):
    rows = []
    for _, row in df.iterrows():
        text = row["text"]
        label = row["label"]
        rows.append({"text": text, "label": label})
        # 句読点挿入バリエーション
        for c in ["、", "。"]:
            pos = random.randint(0, len(text))
            rows.append({"text": text[:pos] + c + text[pos:], "label": label})
        # 接頭辞追加
        rows.append({"text": "今日 " + text, "label": label})
        rows.append({"text": "「" + text + "」", "label": label})
        if "する" in text:
            rows.append({"text": text.replace("する", "しないと"), "label": label})
    print(f"  データ水増し: {len(df)} -> {len(rows)} サンプル")
    return pd.DataFrame(rows)

def build_model(vocab_size, num_classes):
    """前回98.2%達成モデル"""
    model = keras.Sequential([
        keras.layers.Input(shape=(vocab_size,), sparse=False),
        keras.layers.Dense(64, activation="relu",
                          kernel_regularizer=keras.regularizers.l2(0.001)),
        keras.layers.Dropout(0.3),
        keras.layers.Dense(32, activation="relu",
                          kernel_regularizer=keras.regularizers.l2(0.001)),
        keras.layers.Dropout(0.2),
        keras.layers.Dense(num_classes, activation="softmax"),
    ])
    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=0.005),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    return model

def convert_to_tflite(model, output_path):
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    def representative_dataset():
        for _ in range(100):
            data = np.random.rand(1, model.input_shape[1]).astype(np.float32)
            yield [data]
    converter.representative_dataset = representative_dataset
    converter.target_spec.supported_ops = [
        tf.lite.OpsSet.TFLITE_BUILTINS_INT8,
        tf.lite.OpsSet.TFLITE_BUILTINS,
    ]
    tflite_model = converter.convert()
    with open(output_path, "wb") as f:
        f.write(tflite_model)
    size_kb = len(tflite_model) / 1024
    print(f"  TFLiteモデル保存: {output_path}")
    print(f"  サイズ: {size_kb:.1f} KB ({size_kb/1024:.2f} MB)")
    return size_kb

def main():
    parser = argparse.ArgumentParser(description="一筆 TFLiteモデル訓練")
    parser.add_argument("--data", default="ml/sample_data.csv")
    parser.add_argument("--output", default="assets/models/")
    parser.add_argument("--epochs", type=int, default=300)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--no-augment", action="store_true")
    parser.add_argument("--max-features", type=int, default=3000)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    tf.random.set_seed(args.seed)

    print("=" * 60)
    print("一筆 TFLiteモデル訓練 v2")
    print("=" * 60)

    # データ読込
    print(f"\n📁 データ: {args.data}")
    df = pd.read_csv(args.data)
    df = df.dropna(subset=["text", "label"])
    df["text"] = df["text"].astype(str).str.strip()
    df = df[(df["text"] != "") & (df["label"].isin(LABELS))]
    df = df.drop_duplicates(subset=["text"])
    print(f"  有効: {len(df)} サンプル")

    for lbl in LABELS:
        n = len(df[df["label"] == lbl])
        print(f"   {'✓' if n>=3 else '⚠'} {lbl}: {n}")

    # ベクトル化（水増し前のオリジナルデータで語彙を構築 → 推論時の語彙と一致させる）
    print(f"\n🔤 ベクトル化 (max_features={args.max_features})...")
    vec = CharNGramVectorizer(max_features=args.max_features)
    vec.fit(df["text"].tolist())
    print(f"  オリジナル語彙: {vec.vocab_size} n-gram")

    # 水増し（語彙構築後に実行）
    if not args.no_augment:
        df = augment_dataset(df)

    # ラベルエンコード
    le = LabelEncoder()
    df["label_id"] = le.fit_transform(df["label"])
    num_classes = len(le.classes_)

    # ベクトル変換（水増しデータも同じ語彙で変換）
    X = vec.transform(df["text"].tolist())
    y = df["label_id"].values
    print(f"  入力形状: {X.shape}")

    # 分割
    test_size = min(0.15, 1.0 / max(num_classes, 2))
    if len(df) < 200:
        test_size = 0.1
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=args.seed, stratify=y)
    print(f"\n📊 訓練: {len(X_train)}, テスト: {len(X_test)}")

    # クラス重み（不均衡対策）
    class_counts = np.bincount(y_train)
    max_count = class_counts.max()
    class_weights = {
        i: min(max_count / count, 5.0)  # 最大5倍まで
        for i, count in enumerate(class_counts) if count > 0
    }
    print(f"  クラス重み: { {le.classes_[i]: f'{w:.2f}' for i, w in class_weights.items()} }")

    # モデル
    model = build_model(X.shape[1], num_classes)
    model.summary()

    callbacks = [
        keras.callbacks.EarlyStopping(monitor="val_loss", patience=50,
                                       restore_best_weights=True, verbose=1),
        keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5,
                                           patience=20, min_lr=1e-6, verbose=1),
    ]

    # 訓練
    print(f"\n🚀 訓練開始 ({args.epochs} epochs)...")
    model.fit(X_train, y_train, validation_data=(X_test, y_test),
              epochs=args.epochs, batch_size=args.batch_size,
              class_weight=class_weights,
              callbacks=callbacks, verbose=1)

    # 評価
    y_pred = model.predict(X_test, verbose=0)
    y_pred_c = np.argmax(y_pred, axis=1)
    unique_test = np.unique(y_test)
    accuracy = accuracy_score(y_test, y_pred_c) if len(unique_test) >= 2 else 0.0

    y_train_pred = model.predict(X_train, verbose=0)
    train_acc = accuracy_score(y_train, np.argmax(y_train_pred, axis=1))
    print(f"\n📈 訓練精度: {train_acc*100:.1f}%")
    print(f"   テスト精度: {accuracy*100:.1f}%")

    # TFLite変換
    Path(args.output).mkdir(parents=True, exist_ok=True)
    tflite_path = os.path.join(args.output, "model.tflite")
    size_kb = convert_to_tflite(model, tflite_path)

    # ラベル設定保存
    label_config = {"labels": le.classes_.tolist(), "version": "1.0"}
    vocab_path = os.path.join(args.output, "vocab.json")
    with open(vocab_path, "w", encoding="utf-8") as f:
        json.dump(label_config, f, ensure_ascii=False, indent=2)
    print(f"  ラベル設定保存: {vocab_path}")

    # 重みをJSONとしてエクスポート（Dart推論用）
    weights_export_path = os.path.join(args.output, "model_weights.json")
    weights_data = {}
    for i, layer in enumerate(model.layers):
        w = layer.get_weights()
        if w:
            weights_data[f"layer_{i}_{layer.name}"] = {
                "weights": w[0].tolist() if len(w) > 0 else [],
                "bias": w[1].tolist() if len(w) > 1 else [],
            }
    with open(weights_export_path, "w", encoding="utf-8") as f:
        json.dump(weights_data, f, ensure_ascii=False)
    print(f"  重みJSON保存: {weights_export_path}")

    # assetsにコピー
    assets_dir = Path("assets/models")
    assets_dir.mkdir(parents=True, exist_ok=True)
    import shutil
    # TFLiteはassetsに既にあるのでスキップ
    for fn in ["vocab.json", "model_weights.json"]:
        src = os.path.join(args.output, fn)
        dst = os.path.join(assets_dir, fn)
        if os.path.exists(src) and src != dst:
            shutil.copy(src, dst)
            print(f"  ✓ assets/models/{fn}")

    print("\n" + "=" * 60)
    print("✅ 訓練完了！")
    print(f"   サイズ: {size_kb:.1f} KB ({size_kb/1024:.2f} MB)")
    print(f"   訓練精度: {train_acc*100:.1f}%, テスト精度: {accuracy*100:.1f}%")
    if size_kb > 5120:
        print("\n⚠️ 5MB超過。--max-features を減らすか量子化を有効に。")
    else:
        print("\n✓ 5MB以下クリア！")

    # Dart推論用ファイル生成
    print("\n🔄 Dart推論用ファイルを生成中...")
    try:
        weights_json = os.path.join(args.output, "model_weights.json")
        if os.path.exists(weights_json):
            # データCSVのパスを解決
            data_csv = args.data if args.data and os.path.exists(args.data) else None
            # export_weightsをインポートして実行
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from export_weights import export_for_dart
            export_for_dart(weights_json, args.output, data_csv)
    except Exception as e:
        print(f"  ⚠️ Dartエクスポート中にエラー: {e}")
        print("  手動で python ml/export_weights.py を実行してください。")
    print()

if __name__ == "__main__":
    main()
