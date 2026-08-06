#!/usr/bin/env bash
# ArcAsha iOS 実機セットアップ — iPad + iPhone へビルド＆インストール
#
# 前提:
#   1. Apple開発者アカウントの Program License Agreement (PLA) に同意済み
#      (Xcode → Settings → Accounts、または developer.apple.com/account)
#   2. 実機のロック解除 + 開発者モード有効化 + 再起動済み
#   3. 実機が USB で Mac に接続され、ペアリング済み (flutter devices で見える)
#
# 使い方:
#   ./build_install.sh                          # 既定の iPad + iPhone 15 Pro
#   ./build_install.sh <UDID1> <UDID2> ...      # 任意の端末
#
# UDID は `flutter devices` または `xcrun devicectl list devices` で確認できる。
set -euo pipefail
cd "$(dirname "$0")"

# 既定: iPad Pro 11" / iPhone 15 Pro (2026-08-03 時点の接続実機)
DEFAULT_DEVICES=(
  "00008112-000A058202D8A01E"   # 大谷涼のiPad (iPad Pro 11-inch)
  "00008130-00044CE82243001C"   # Ryo's IPhone 15 Pro
)

DEVICES=("${@:-${DEFAULT_DEVICES[@]}}")
SCHEME="Runner"
CONFIG="Release"
# 無料プロビジョニング用の個人チーム (PLA不要)。
# ※ 証明書表示名の "(4CH5Z8BKWC)" はチームIDではない。実際のチームID(OU)は MN79JBUP8P。
# 有料チーム (6T4LPZN5SW) に戻す場合は TEAM を変更する。
TEAM="${TEAM:-MN79JBUP8P}"

if [ "${#DEVICES[@]}" -eq 0 ]; then
  echo "❌ 端末UDIDを指定してください (flutter devices で確認)"
  exit 1
fi

for UDID in "${DEVICES[@]}"; do
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  📱 ビルド + インストール: $UDID (team=$TEAM)"
  echo "════════════════════════════════════════════════════════════"

  # 1) 端末をターゲットに署名付きビルド (プロビジョニングに自動登録)
  echo "  🔨 xcodebuild (destination=$UDID) ..."
  xcodebuild -workspace Runner.xcworkspace -scheme "$SCHEME" \
    -configuration "$CONFIG" \
    -destination "id=$UDID" \
    DEVELOPMENT_TEAM="$TEAM" \
    -allowProvisioningUpdates \
    -allowProvisioningDeviceRegistration \
    build

  # 2) ビルド成果物 (DerivedData から最新の Runner.app) を特定
  APP="$(xcodebuild -workspace Runner.xcworkspace -scheme "$SCHEME" \
    -configuration "$CONFIG" -destination "id=$UDID" DEVELOPMENT_TEAM="$TEAM" \
    -showBuildSettings 2>/dev/null | awk -F' = ' '/ TARGET_BUILD_DIR/{d=$2} /WRAPPER_NAME/{n=$2} END{print d "/" n}')"
  if [ -z "$APP" ] || [ ! -d "$APP" ]; then
    echo "❌ Runner.app が見つかりません"
    exit 1
  fi
  echo "  📦 $APP"

  # 3) 実機へインストール
  echo "  📲 devicectl install ..."
  xcrun devicectl device install app --device "$UDID" "$APP"

  echo "  ✅ $UDID にインストール完了"
done

echo ""
echo "🎉 全端末にインストール完了!"
echo "   端末でアプリを起動 → モデルをロード → ハブ URL (ws://<MacのLAN IP>:8080) を入力 → 接続"
echo "   ノードIDは端末ごとに変えること (例: node-ios-ipad / node-ios-iphone15)"
