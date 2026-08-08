# 一筆（いっぴつ）MLモデル訓練パイプライン

超軽量テキスト分類モデル（TFLite）を訓練し、アプリに組み込むためのツールです。

## クイックスタート

### 1. TensorFlowのインストール

```bash
# Python 3.12以下推奨（3.13非対応）
pip install -r ml/requirements.txt
```

Python 3.13 で動かない場合:

```bash
# pyenv で 3.11 をインストールして使用
brew install pyenv
pyenv install 3.11.11
pyenv local 3.11.11
pip install -r ml/requirements.txt
```

### 2. 訓練データの準備

`ml/sample_data.csv` を編集するか、新規CSVを作成します。

**CSV形式:**
```csv
text,label
"牛乳とパンを買ってきて",買い物
"来週の会議資料を作成する",仕事
```

**ラベル一覧（10クラス）:**
`アイデア`, `買い物`, `日記`, `仕事`, `読書`, `旅行`, `健康`, `財務`, `人間関係`, `メモ`

### 3. 訓練の実行

```bash
# サンプルデータで訓練
python ml/train.py

# 自分のデータで訓練
python ml/train.py --data あなたのデータ.csv --epochs 100
```

### 4. モデルの出力

訓練が完了すると以下が生成されます:

```
assets/models/
├── model.tflite    # 超軽量AIモデル（数十KB〜数百KB）
└── vocab.json      # 語彙データ
```

## コマンドラインオプション

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `--data` | `ml/sample_data.csv` | 訓練データCSVのパス |
| `--output` | `assets/models/` | モデル出力先 |
| `--epochs` | 50 | 訓練エポック数（多いほど学習が進む） |
| `--batch-size` | 16 | バッチサイズ |
| `--max-features` | 5000 | 最大特徴量数（減らすと軽量化） |
| `--no-quantize` | (オフ) | INT8量子化を無効化（精度優先） |
| `--test-size` | 0.2 | テストデータ割合 |

## データ追加のコツ

- **各ラベル最低30件**以上あると精度が出やすい
- **バランスの良いデータ**（各ラベル同数程度）が理想
- 学習済みモデルで精度が低いラベルがあったら、**そのラベルのデータを追加**すると改善します
- データを追加したら再訓練 → `flutter run` でアプリに反映

## モデル構造

```
Input (n-gram binary vector, max 5000 features)
  → Dense(128, ReLU) + BatchNorm + Dropout(0.3)
    → Dense(64, ReLU) + BatchNorm + Dropout(0.2)
      → Dense(10, Softmax) → クラス確率
```

- パラメータ数: 約65万（超軽量）
- 推論速度: iPhone で 1ms 未満
- モデルサイズ: 量子化後 数十KB 〜 数百KB（5MB以下）

