#!/bin/bash
# Cloud Environment Setup Script: регистрирует REA как user-level MCP-сервер Claude Code,
# чтобы он был доступен в любом репозитории этой среды. Идемпотентен, не роняет запуск сессии.
# Меняя версию, обновляйте REA_VERSION здесь и в .mcp.json репозитория.
REA_VERSION="6.5.0"

echo "[rea-setup] rea-agents@${REA_VERSION}"
# Прогрев кэша npx (сеть до registry.npmjs.org должна быть разрешена).
npx -y "rea-agents@${REA_VERSION}" --version || echo "[rea-setup] WARN: npx warmup failed"

REA_VERSION="$REA_VERSION" node - <<'JS' || echo "[rea-setup] WARN: registration failed"
const fs = require('fs'), os = require('os'), path = require('path');
const dir = process.env.CLAUDE_CONFIG_DIR || os.homedir();
const file = path.join(dir, '.claude.json');
const want = { type: 'stdio', command: 'npx', args: ['-y', `rea-agents@${process.env.REA_VERSION}`, 'mcp'], env: {} };
let cfg = {};
if (fs.existsSync(file)) {
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.log('[rea-setup] WARN: ~/.claude.json is not valid JSON, skipped'); process.exit(0); }
}
cfg.mcpServers = cfg.mcpServers || {};
if (JSON.stringify(cfg.mcpServers.rea) === JSON.stringify(want)) { console.log('[rea-setup] already registered'); process.exit(0); }
cfg.mcpServers.rea = want;
fs.mkdirSync(dir, { recursive: true });
const tmp = file + '.rea-tmp';
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
fs.renameSync(tmp, file);
console.log('[rea-setup] registered user-level MCP server "rea"');
JS
exit 0
