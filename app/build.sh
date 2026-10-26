#!/usr/bin/env bash
# 把 app/main.js 包成選單列小程式（osacompile，macOS 內建，不用 Xcode）。
# 用法：app/build.sh <輸出的 .app 路徑> <repo 路徑> <node 路徑> <狀態資料夾>
set -euo pipefail

APP="$1"
REPO="$2"
NODE="$3"
STATE="$4"
BUNDLE_ID="com.urusa.voice-dictation"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 路徑用 JSON 填進去，空白、引號都不會壞
node -e '
const fs = require("fs");
const [src, out, node, repo, state] = process.argv.slice(1);
const build = JSON.stringify({ node, repo, state });
fs.writeFileSync(out, fs.readFileSync(src, "utf8").replace("__BUILD__", build));
' "$REPO/app/main.js" "$TMP/main.js" "$NODE" "$REPO" "$STATE"

rm -rf "$APP"
mkdir -p "$(dirname "$APP")"
osacompile -l JavaScript -s -o "$APP" "$TMP/main.js"

PLIST="$APP/Contents/Info.plist"
set_key() {
  /usr/libexec/PlistBuddy -c "Set :$1 $3" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$PLIST"
}
set_key CFBundleIdentifier string "$BUNDLE_ID"
set_key CFBundleName string "JarvisVoice"
set_key CFBundleDisplayName string "JarvisVoice"
set_key LSUIElement bool true
set_key NSMicrophoneUsageDescription string "JarvisVoice 要用麥克風聽你講話，轉成文字寫進輸入框，或照你講的操作 app。"
set_key NSAppleEventsUsageDescription string "JarvisVoice 要送出貼上（Cmd+V），把字放進輸入框。"

# install.sh 給的版本戳記要在簽名前寫進去，簽完 .app 裡就不能再動
if [[ -n "${BUILD_STAMP:-}" ]]; then
  echo "$BUILD_STAMP" > "$APP/Contents/Resources/build-stamp"
fi

# 簽名：鑰匙圈有開發者憑證就用它簽，系統認的是 bundle id＋憑證，之後重包麥克風、輔助使用權限都不用重給。
# 沒有憑證才用本機簽名，系統只認這一版，重包就得重給。要指定憑證就設 JARVIS_SIGN_IDENTITY。
IDENTITY="${JARVIS_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  # 同名憑證可能有好幾張，用 SHA-1 指定才不會被當成不明確
  IDENTITY="$(grep -m1 '"Developer ID Application: ' <<<"$IDENTITIES" | awk '{print $2}' || true)"
  [[ -n "$IDENTITY" ]] || IDENTITY="$(grep -m1 '"Apple Development: ' <<<"$IDENTITIES" | awk '{print $2}' || true)"
fi
if [[ -n "$IDENTITY" ]] && codesign --force --deep --sign "$IDENTITY" "$APP" >/dev/null 2>&1; then
  :
else
  [[ -z "$IDENTITY" ]] || echo "用憑證簽名失敗，改用本機簽名：這次重包後權限要重給" >&2
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1
fi
