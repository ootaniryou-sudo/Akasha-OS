# EXP-0000 — Qwen3-0.6B Golden Reference

> **"Qwen3-0.6B そのものが正常に動作することを確定させる。"**

ArcAsha はまだ使わない。純粋に Python Transformers で Qwen3-0.6B を動かし、出力を記録する。

## Pipeline

```
Mac → Python Transformers → Qwen3-0.6B → Output
```

## Why EXP-0000 Exists

EXP-0001（Akasha Adapter テスト）の前に、**モデルそのものが正しい出力を出すこと**を確定させる。

- EXP-0000 が失敗 → Qwen3-0.6B のロード or 推論に問題がある
- EXP-0000 が成功、EXP-0001 が失敗 → Akasha Adapter に問題がある

原因の切り分けに必須。

## Requirements

```
transformers >= 4.51.0  （qwen3 は 4.51.0 未満では認識不可）
torch >= 2.0
```

## Fixed Parameters

```
thinking = false
temperature = 0
do_sample = false
max_new_tokens = 32
```

全プロンプトで共通。再現性のために greedy decoding。

## Golden Dataset (10 prompts)

1. `What is 2 + 2?` — 算数
2. `What is the capital of Japan?` — 地理知識
3. `Explain machine learning briefly.` — 概念説明（英）
4. `Write a Python factorial function.` — コード生成
5. `What is 12 * 7?` — 算数
6. `Explain what a neural network is.` — 概念説明（英）
7. `日本の首都はどこですか？` — 地理知識（日）
8. `機械学習とは何ですか？` — 概念説明（日）
9. `Pythonでフィボナッチ数列を書いてください。` — コード生成（日）
10. `1から100までの合計はいくつですか？` — 算数（日）

## Running

```bash
cd experiments/qwen3_0.6b

# Install requirements
pip install 'transformers>=4.51.0' torch

# Run golden reference
python golden/run_golden.py

# With custom device
python golden/run_golden.py --device mps     # Apple Silicon
python golden/run_golden.py --device cuda    # NVIDIA GPU
python golden/run_golden.py --device cpu     # CPU (slow)
```

## Output

```
golden/output/
├── 0000.json          # Prompt 0: full record
├── 0001.json          # Prompt 1
├── ...
├── 0009.json          # Prompt 9
└── manifest.json      # Summary + environment info
```

### Per-file schema

```json
{
  "index": 0,
  "prompt": "What is 2 + 2?",
  "input_token_ids": [...],
  "input_token_count": 5,
  "output_token_ids": [...],
  "output_token_count": 32,
  "decoded_text": "...",
  "timing_ms": { "tokenize": 1.2, "generate": 1234.5, "total": 1235.7 },
  "params": {
    "max_new_tokens": 32,
    "temperature": 0.0,
    "do_sample": false,
    "top_p": 1.0,
    "thinking": false
  }
}
```

### Manifest schema

```json
{
  "experiment": "EXP-0000",
  "environment": {
    "model_id": "Qwen/Qwen3-0.6B",
    "model_revision": "...",
    "transformers_version": "4.51.x",
    "torch_version": "2.x",
    "device": "mps"
  },
  "summary": {
    "total_prompts": 10,
    "total_output_tokens": ...,
    "avg_output_tokens": ...,
    "total_time_ms": ...,
    "avg_time_ms": ...
  }
}
```

## Success Criteria

- [ ] 全10プロンプトでエラーなく推論完了
- [ ] 出力が空文字列でない（全プロンプトで token が生成されている）
- [ ] `transformers >= 4.51.0` で Qwen3 が正しくロードされている
- [ ] 入力 token_ids がプロンプトと一致（tokenizer 正常）
- [ ] `manifest.json` にモデルの revision hash が記録されている

## Relation to Other Experiments

```
EXP-0000 (this)
  └── Golden Reference: pure Qwen3-0.6B
        │
        ├── EXP-0001: Akasha Adapter vs Golden 比較
        │     └── "Does the adapter produce identical tokens?"
        │
        └── EXP-0002+: Multi-node / distributed
```

**EXP-0000 の出力は全後続実験の比較基準（Golden Dataset）となる。**

