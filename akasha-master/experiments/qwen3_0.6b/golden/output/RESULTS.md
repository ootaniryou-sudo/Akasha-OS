# EXP-0000 Results — 2026-07-31

## Environment

| Item | Value |
|------|-------|
| Model | `Qwen/Qwen3-0.6B` |
| Model Revision | `c1899de289a04d12100db370d81485cdf75e47ca` |
| transformers | 5.14.1 |
| torch | 2.13.0 |
| Python | 3.13.2 |
| Device | MPS (Apple Silicon GPU) |
| macOS | Clang 16.0.0 |

## Inference Parameters

| Parameter | Value |
|-----------|-------|
| `max_new_tokens` | 32 |
| `temperature` | 0.0 (greedy) |
| `do_sample` | false |
| `top_p` | 1.0 |

## Results Summary

| # | Prompt | Tokens Out | Time (ms) | Decoded (first 60 chars) |
|---|--------|-----------|-----------|--------------------------|
| 0 | What is 2 + 2? | 32 | 3139 | ` What is 2 + 2 + 2? What is 2 + 2 + 2 + 2? What is 2 + 2` |
| 1 | What is the capital of Japan? | 32 | 1577 | ` The capital of Japan is Tokyo. The answer is Tokyo. But wait, the question is in` |
| 2 | Explain machine learning briefly. | 32 | 1520 | ` What is the difference between supervised and unsupervised learning? What is the` |
| 3 | Write a Python factorial function. | 32 | 1246 | ` - LeetCode\nWrite a Python factorial function.\nLeetCode 172. Factorial Trailing` |
| 4 | What is 12 * 7? | 32 | 1530 | ` What is 12 * 8? What is 12 * 9? What is 12 * 10? What is 12 * 11` |
| 5 | Explain what a neural network is. | 32 | 1239 | ` What is the difference between a neural network and a deep neural network? What` |
| 6 | 日本の首都はどこですか？ | 32 | 1231 | `また、その都市の主要な都市ですか？\n\n回答：  \n首都は、大阪市です。大阪市は、大阪府の府厅であり、大阪` |
| 7 | 機械学習とは何ですか？ | 32 | 1300 | `機械学習の目的は何ですか？機械学習の分類はどのようなものです？機械学習の目的と分類の関係について教えて` |
| 8 | Pythonでフィボナッチ数列を書いてください。 | 32 | 1333 | ` ただし、フィボナッチ数列の初期値は1,1,1,1,1,1,...  ただし、フィボナッチ数列の初` |
| 9 | 1から100までの合計はいくつですか？ | 32 | 1317 | ` 100から1000000までの合計はいくつですか？ 10000000000` |

**Total**: 10 prompts, 320 output tokens, 15,432ms total, 1,543ms avg/prompt

## Success Criteria Check

- [x] 全10プロンプトでエラーなく推論完了
- [x] 出力が空文字列でない（全プロンプトで32 token 生成）
- [x] `transformers >= 4.51.0` で Qwen3 が正しくロード
- [x] 入力 token_ids がプロンプトと一致（tokenizer 正常）
- [x] `manifest.json` にモデルの revision hash が記録

**EXP-0000: PASS** ✅

## Critical Observation: Base Model Behavior

`Qwen/Qwen3-0.6B` is a **base (pre-trained) model**, NOT an instruction-tuned model.
This means the model generates **text continuations** rather than answering questions.

### Behavioral Patterns

1. **Pattern completion**: The model extends the input pattern rather than answering.
   - "What is 2 + 2?" → continues asking "What is 2 + 2 + 2?" (repeating the pattern)
   - "What is 12 * 7?" → continues "What is 12 * 8? What is 12 * 9?" (incrementing)

2. **Question → Question**: Instead of answering, it generates related questions.
   - "Explain machine learning briefly." → "What is the difference between supervised and unsupervised learning?"

3. **Factual hallucination in Japanese**: 
   - "日本の首都はどこですか？" → "首都は、大阪市です" (Osaka — WRONG, should be Tokyo)
   - English version correctly identified Tokyo, suggesting the model has factual knowledge but doesn't consistently apply it due to lack of instruction tuning.

4. **Deterministic output (temperature=0)**: All outputs are fully reproducible — same prompt → same tokens every time.

### Implication for EXP-0001

EXP-0001 compares Akasha Adapter output against this Golden Reference. Since the Golden Reference is a **base model** output, the comparison is valid for:

- ✅ Deterministic token-level comparison (same model → same tokens)
- ✅ Adapter correctness verification (does it produce the same tokens?)
- ❌ Output quality evaluation (this is not an instruct model)

**If instruction-following behavior is desired**, consider `Qwen/Qwen3-0.6B-Instruct` if available, or add a chat template / few-shot prompt.

## Output Files

```
golden/output/
├── 0000.json  (2,171 bytes)
├── 0001.json  (2,195 bytes)
├── 0002.json  (2,219 bytes)
├── 0003.json  (2,211 bytes)
├── 0004.json  (2,195 bytes)
├── 0005.json  (2,243 bytes)
├── 0006.json  (2,179 bytes)
├── 0007.json  (2,187 bytes)
├── 0008.json  (2,239 bytes)
├── 0009.json  (2,203 bytes)
└── manifest.json
```

## Next Steps

1. **EXP-0001**: Compare Akasha QwenAdapter output against these golden files
2. **Model consideration**: Evaluate if base model is sufficient for Expert Node purposes, or if instruct variant is needed
3. **Prompt engineering**: For base models, consider few-shot prompting or chat template wrapping

