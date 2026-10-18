#!/usr/bin/env bash
# Прогревает npx-кэш для REA, чтобы MCP-сервер стартовал без задержки.
# Версия должна совпадать с .mcp.json.
set -u
REA_VERSION="6.5.0"
npx -y "rea-agents@${REA_VERSION}" --version >/dev/null 2>&1 || true
exit 0
