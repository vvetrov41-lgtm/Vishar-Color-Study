# Stage 0: диагностический стенд движка

Минимальное PWA для проверки графического движка Vishar Color Study на iPhone. Это не интерфейс Color Study: стенд только меряет, что умеет Safari на конкретном устройстве.

Сценарий: открыть ссылку на iPhone, нажать **Run Tests**, нажать «Поделиться» или «Копировать JSON» и переслать отчёт в тред.

Стек: Svelte 5, TypeScript, Vite, модульный Web Worker, OffscreenCanvas + WebGL2, свой Service Worker.

## Что проверяется

| Группа | Проверки |
|---|---|
| Worker | запуск модульного Worker, OffscreenCanvas 2D и WebGL2 в Worker, `MAX_TEXTURE_SIZE` и другие лимиты, GPU-рендерер, WebGPU, загрузка тайла из ImageBitmap через `UNPACK_SKIP_*` |
| createImageBitmap | `resizeWidth/Height`, `resizeQuality`, `imageOrientation` (`flipY`, `from-image`, `none`), EXIF-поворот JPEG, `premultiplyAlpha`, `colorSpaceConversion` |
| Декодирование | JPEG, PNG, WebP, HEIC: в Worker, в главном потоке и через `<img>` |
| Canvas | лимит площади: 4096², 4100², 20 МП, 48 МП (OffscreenCanvas и `<canvas>`) |
| Производительность | 12 и 48 МП, JPEG и HEIC: полное декодирование, рабочая копия 1600 px (двумя способами), GPU-проход Values (холодный и тёплый), CPU-гистограмма + 1-D k-means, тайловый проход полного разрешения 2048 px с перекрытием 16 px, PNG-кодирование одного тайла, максимальная пауза главного потока |
| Хранилище | IndexedDB (Blob 1 МБ), OPFS из главного потока (`createWritable`) и из Worker (`SyncAccessHandle`), квота, `persisted` |
| Память | `performance.memory`, `deviceMemory`, `measureUserAgentSpecificMemory`. Safari ничего из этого не отдаёт, поэтому отчёт пишет расчётный объём битмапа |
| Офлайн | регистрация и управление SW, Cache Storage, ответ оболочки строго из кэша, флаг офлайн-запуска |
| Своё фото | тот же конвейер на выбранном снимке, плюс превью результата Values |

## Безопасные пределы памяти

- В обычном прогоне одновременно живёт не больше одного битмапа 48 МП (195 МБ RGBA). Холсты обнуляются сразу после замера.
- Полное разрешение обрабатывается только тайлами по 2048 px, без текстуры на весь кадр.
- Перед каждым шагом стенд пишет журнал в `localStorage`. Если iOS выгрузит вкладку, после перезагрузки стенд покажет, на каком шаге это случилось, добавит это в отчёт и в следующий раз пропустит этот шаг (флажок «Повторить шаги, на которых был сбой» отменяет пропуск).
- Тесты 48 МП отключаются флажком в «Параметрах».
- Стресс-тест памяти до выгрузки вкладки в Run Tests не входит. Он спрятан в отдельный блок и стартует только после флажка «Понимаю…» и системного подтверждения.

## Тестовые изображения

`public/samples/` генерирует `npm run samples` (Python 3, Pillow, numpy, pillow-heif). Это синтетические «фотоподобные» кадры 4032×3024 и 8064×6048 в JPEG и HEIC, маленькие пробы форматов и JPEG с EXIF Orientation=6. Файлы лежат в репозитории, чтобы сборка не зависела от HEIC-кодировщика.

## Команды

```bash
npm ci
npm run dev        # локально, без Service Worker
npm run build      # dist/
npm run check      # svelte-check + TypeScript
npm run smoke      # build нужен заранее; Run Tests в headless Chromium
```

`npm run smoke` проверяет, что стенд работает, а не то, как поведёт себя iPhone. Цифры Chromium не переносим на Safari.

## Размещение

Отдельный staging-проект Cloudflare Pages `vishar-color-study-bench` (адрес `https://vishar-color-study-bench.pages.dev`), прямая загрузка `dist/`. Существующие проекты не затрагиваются.

```bash
npm run build
npx wrangler pages deploy dist --project-name vishar-color-study-bench --branch main
```

Страницы помечены `noindex`. Фото пользователя никуда не отправляются: стенд не делает сетевых запросов, кроме загрузки своих файлов.

## Формат отчёта

JSON со схемой `vishar-stage0-report/1`: версия сборки, User-Agent, список проверок `{id, group, name, status, value, note, ms}`, история сбоев, результат своего фото и стресс-теста. Текстовая версия собирает те же проверки по строке на каждую.
