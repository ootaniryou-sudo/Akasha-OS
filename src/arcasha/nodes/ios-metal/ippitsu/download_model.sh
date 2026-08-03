#!/usr/bin/env bash
# ArcAsha iOS Node — バンドル用 GGUF (SmolLM2-135M-Instruct Q4_K_M) を assets/models/ に取得
# 使い方: ./download_model.sh   (GitHub の 100MB 制限のため git には含めない)
set -euo pipefail
cd "$(dirname "$0")"

URL="https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf"
OUT="assets/models/smollm2-135m-instruct-q4_k_m.gguf"
EXPECTED="105454432"

mkdir -p assets/models

if [ -f "$OUT" ] && [ "$(stat -f%z "$OUT" 2>/dev/null || echo 0)" = "$EXPECTED" ]; then
  echo "✅ モデル済み: $OUT"
  exit 0
fi

echo "📥 ダウンロード: $URL"
curl -L --retry 5 --retry-delay 2 -C - -o "$OUT" "$URL"

SIZE=$(stat -f%z "$OUT" 2>/dev/null || echo 0)
if [ "$SIZE" != "$EXPECTED" ]; then
  echo "⚠️  サイズ不一致 ($SIZE / $EXPECTED) — 再実行してください"
  exit 1
fi
echo "✅ 完了: $OUT ($(du -h "$OUT" | cut -f1))"
