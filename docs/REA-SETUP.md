# REA (Reverse Engineer Anything) для Vishar Color Study

Исследовательская среда. Приложение здесь не разрабатывается.

- Пакет: `rea-agents` (npm), репозиторий https://github.com/morluto/rea
- Версия: **6.5.0** (latest на npm на 2026-10-18), integrity
  `sha512-C6BG7LyrAdR74mSjertM6PrxJkcNZ2bfQNOJornPo9erDEp2tyPRVYPnV5Yodr+1RqewCQla68WulXlVnveD+A==`
- Требования: Node `^22.19 || ^24.11 || >=26`, на Linux procps-совместимый `ps`.

## Что подключено

| Файл | Назначение |
| --- | --- |
| `.mcp.json` | MCP-сервер `rea`: `npx -y rea-agents@6.5.0 mcp` (версия зафиксирована) |
| `.claude/settings.json` | заранее одобряет только `rea` из `.mcp.json` + прогрев npx-кэша при старте сессии |
| `scripts/rea-warmup.sh` | прогрев кэша (версию менять вместе с `.mcp.json`) |
| `scripts/rea-chrome-cdp.sh` | headless Chromium с CDP на `127.0.0.1:9222` |

Облачные MCP (Cloudflare, GitHub, Supabase) не затронуты: они на уровне аккаунта.

## Диагностика

    npx -y rea-agents@6.5.0 doctor --json

В облаке ожидаемо красные пункты: `hopper`, `ghidra`, `ida`, `jadx` (нет нативных движков)
и `registration:claude_code` (doctor смотрит только `~/.claude.json`, а не проектный `.mcp.json`).
Node и host зелёные.

## Браузерный анализ через CDP

    scripts/rea-chrome-cdp.sh https://example.com &
    npx -y rea-agents@6.5.0 list-browser-targets http://127.0.0.1:9222 --format json
    npx -y rea-agents@6.5.0 inspect-web-page http://127.0.0.1:9222 <targetId> --format json
    npx -y rea-agents@6.5.0 capture-web-screenshot http://127.0.0.1:9222 <targetId>

REA подключается только к loopback-эндпоинту и работает пассивно.

## Обновление версии

Поменять версию в `.mcp.json` и `scripts/rea-warmup.sh`, проверить `npm view rea-agents dist-tags`.

## REA во всех репозиториях среды (Cloud Environment Setup Script)

`.mcp.json` работает только в этом репозитории. Чтобы REA был в любом репозитории среды,
вставь содержимое `scripts/rea-env-setup.sh` в настройки среды:
claude.ai/code → меню среды в заголовке сессии → Edit → Setup script → Save.

Скрипт:
- прогревает кэш `npx -y rea-agents@6.5.0`;
- добавляет `mcpServers.rea` в `~/.claude.json` (user scope), остальные записи не трогает;
- идемпотентен (повторный запуск ничего не меняет) и всегда завершается с кодом 0.

Сетевая политика среды должна пускать `registry.npmjs.org`.
Проверка в новой сессии: `claude mcp get rea` показывает `Scope: User config`.
Если у репозитория есть свой `.mcp.json` с `rea`, действует он (project scope важнее user); версии держать одинаковыми.
