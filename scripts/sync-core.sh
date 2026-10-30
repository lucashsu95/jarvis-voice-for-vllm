#!/usr/bin/env bash
# 把核心（core/）同步一份到別的專案（CubeLV、平行沙盒）：
#   ./scripts/sync-core.sh <目標資料夾>
# 每個檔案開頭寫上來源 commit；目標資料夾另外有 CORE_COMMIT。要改核心一律回 jarvis-voice/core 改，再跑一次這個。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:?用法：scripts/sync-core.sh <目標資料夾>}"
SHA="$(git -C "$DIR" rev-parse --short HEAD)"
if [[ -n "$(git -C "$DIR" status --porcelain -- core)" ]]; then
  echo "core/ 有還沒 commit 的改動，先 commit 再同步（同步出去的版本要對得上 commit）" >&2
  exit 1
fi
mkdir -p "$DEST"
for f in "$DIR"/core/*.mjs "$DIR"/core/index.d.mts; do
  name="$(basename "$f")"
  {
    echo "// 從 jarvis-voice core@$SHA 同步（https://github.com/urusaqqrun/jarvis-voice/tree/main/core）。不要在這裡改：改 jarvis-voice/core 再跑 scripts/sync-core.sh"
    cat "$f"
  } > "$DEST/$name"
done
echo "$SHA" > "$DEST/CORE_COMMIT"
echo "已同步 core@$SHA → ${DEST}（$(ls "$DIR"/core | wc -l | tr -d ' ') 個檔案）"
