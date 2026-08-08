"""
訓練済みモデル（model_weights.json）からDart推論用の重みバイナリを生成する

使用方法:
  python ml/export_weights.py                    # assets/models/ を更新
  python ml/export_weights.py --weights path/to/model_weights.json --data path/to/combined_data.csv
"""
import json, sys, os
import numpy as np
import pandas as pd

def build_vocab_from_csv(csv_path: str, max_features: int = 5000, max_ngram: int = 3):
    """訓練データからn-gram語彙を再構築"""
    from collections import Counter
    df = pd.read_csv(csv_path)
    texts = df['text'].astype(str).tolist()

    ngram_counter = Counter()
    for text in texts:
        cleaned = str(text).strip().replace(" ", "").replace("\u3000", "")
        for n in range(1, max_ngram + 1):
            for i in range(len(cleaned) - n + 1):
                ng = cleaned[i:i+n]
                ngram_counter[ng] += 1

    sorted_ngrams = sorted(ngram_counter.items(), key=lambda x: -x[1])
    selected = sorted_ngrams[:max_features]
    vocab = [ng for ng, _ in selected]
    return vocab


def export_for_dart(weights_json_path: str, output_dir: str, data_csv: str = None):
    """model_weights.jsonからDart推論用のバイナリ+設定を生成"""
    print(f"📁 重みJSON: {weights_json_path}")

    with open(weights_json_path, "r", encoding="utf-8") as f:
        weights_data = json.load(f)

    # レイヤー情報を抽出
    binary_data = bytearray()
    config_layers = []

    for key in sorted(weights_data.keys()):
        layer = weights_data[key]
        w = np.array(layer["weights"], dtype=np.float32)
        b = np.array(layer["bias"], dtype=np.float32)

        config_layers.append({
            "name": key,
            "weights_shape": list(w.shape),
            "bias_shape": list(b.shape),
        })
        binary_data.extend(w.tobytes())
        binary_data.extend(b.tobytes())
        print(f"  層: {key}  重み {list(w.shape)} + バイアス {list(b.shape)}")

    # labelsをvocab.jsonから読み込み
    labels = []
    vocab_path = os.path.join(output_dir, "vocab.json")
    if os.path.exists(vocab_path):
        with open(vocab_path, "r", encoding="utf-8") as f:
            v = json.load(f)
            labels = v.get("labels", [])
    else:
        labels = ["アイデア", "メモ", "人間関係", "仕事", "健康", "旅行", "日記", "読書", "財務", "買い物"]

    # n-gram語彙を構築
    if data_csv and os.path.exists(data_csv):
        vocab = build_vocab_from_csv(data_csv)
        print(f"  語彙: {len(vocab)} n-gram (データから再構築)")
    else:
        # 既存のmodel_config.jsonから語彙をコピー
        config_path = os.path.join(output_dir, "model_config.json")
        if os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as f:
                old_config = json.load(f)
            vocab = old_config.get("vocab", [])
            print(f"  語彙: {len(vocab)} n-gram (既存設定からコピー)")
        else:
            vocab = []
            print("  ⚠️ 語彙が空です。--data でCSVを指定してください。")

    # 設定JSONを生成
    config = {
        "layers": config_layers,
        "labels": labels,
        "vocab": vocab,
        "max_ngram": 3,
    }

    # バイナリファイル保存
    bin_path = os.path.join(output_dir, "model_weights.bin")
    with open(bin_path, "wb") as f:
        f.write(binary_data)

    # 設定ファイル保存
    config_path = os.path.join(output_dir, "model_config.json")
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)

    bin_size_kb = len(binary_data) / 1024
    print(f"\n✅ Dart推論用ファイル生成完了!")
    print(f"  重みバイナリ: {bin_path} ({bin_size_kb:.1f} KB)")
    print(f"  設定JSON: {config_path}")
    print(f"  レイヤー数: {len(config_layers)}")
    print(f"  語彙サイズ: {len(vocab)}")
    print(f"  ラベル数: {len(labels)}")
    return bin_size_kb


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Dart推論用モデル変換")
    parser.add_argument("--weights", default=None,
                        help="model_weights.jsonのパス")
    parser.add_argument("--output", default="assets/models/",
                        help="出力ディレクトリ")
    parser.add_argument("--data", default=None,
                        help="combined_data.csvのパス（語彙再構築用）")
    args = parser.parse_args()

    # weights.jsonのパスを解決
    if args.weights:
        weights_path = args.weights
    else:
        weights_path = os.path.join(args.output, "model_weights.json")

    # data.csvのパスを解決
    data_csv = args.data
    if data_csv is None:
        candidate = os.path.join(os.path.dirname(args.output), "../ml/combined_data.csv")
        if os.path.exists(candidate):
            data_csv = os.path.abspath(candidate)

    if not os.path.exists(weights_path):
        print(f"❌ 重みJSONが見つかりません: {weights_path}")
        print("  先に train.py で学習を実行してください。")
        sys.exit(1)

    export_for_dart(weights_path, args.output, data_csv)

