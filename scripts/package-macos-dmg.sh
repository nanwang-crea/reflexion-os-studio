#!/usr/bin/env bash
# macOS 专用 DMG 打包。Tauri 自带 create-dmg 会把临时镜像放进
# bundle/macos（源目录），大资源包会触发 hdiutil 自递归；这里把 staging
# 放在系统临时目录外部，直接用 hdiutil 生成拖拽安装布局。
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE_DIR="$ROOT/apps/desktop/src-tauri/target/release/bundle"
APP_DIR="$BUNDLE_DIR/macos"
DMG_DIR="$BUNDLE_DIR/dmg"
PRODUCT_NAME="ReflexionOS Studio"
VERSION="$(node -p "require('$ROOT/apps/desktop/package.json').version")"

case "$(uname -m)" in
  arm64) ARCH="aarch64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

APP_PATH="$APP_DIR/$PRODUCT_NAME.app"
DMG_PATH="$DMG_DIR/${PRODUCT_NAME}_${VERSION}_${ARCH}.dmg"
[[ -d "$APP_PATH" ]] || { echo "app bundle not found: $APP_PATH" >&2; exit 1; }

mkdir -p "$DMG_DIR"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/reflexion-dmg.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

cp -R "$APP_PATH" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG_PATH"
echo "Creating $DMG_PATH"
hdiutil create \
  -volname "$PRODUCT_NAME" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  -imagekey zlib-level=9 \
  "$DMG_PATH" >/dev/null

echo "DMG created: $DMG_PATH"
