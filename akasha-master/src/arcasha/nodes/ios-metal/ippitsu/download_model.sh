#!/usr/bin/env bash
# ArcAsha iOS Node — バンドル用 GGUF (Qwen2.5-1.5B-Instruct Q4_K_M) を assets/models/ に取得
# 使い方: ./download_model.sh   (日本語に強いモデル)
set -euo pipefail
cd "$(dirname "$0")"

URL="https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"
OUT="assets/models/qwen2.5-1.5b-instruct-q4_k_m.gguf"
EXPECTED="986048768"

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

