#!/usr/bin/env bash
# Запускает headless Chromium с CDP на 127.0.0.1:9222 для REA (list-browser-targets, inspect-web-page и др.).
# Использование: scripts/rea-chrome-cdp.sh [URL]   (остановка: pkill -f remote-debugging-port=9222)
set -eu
URL="${1:-about:blank}"
CHROME="${CHROME_BIN:-$(find "${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" -maxdepth 3 -name chrome -type f | head -1)}"
PROFILE="$(mktemp -d)"
exec "$CHROME" --headless=new --no-sandbox --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 --user-data-dir="$PROFILE" "$URL"
