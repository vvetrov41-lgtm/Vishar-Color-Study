<script lang="ts">
  // Stage 1 debug page: not the Color Study interface. It drives the engine, shows
  // the numbers behind each view and checks the stage acceptance targets on a device.
  import { onMount } from 'svelte';
  import { EngineClient } from '../src/client';
  import { DEFAULT_VIEW, type ViewState } from '../src/core/view';
  import type { OpenResult, ParityReport, ViewResult } from '../src/types';

  const VERSION = __ENGINE_VERSION__;
  const SAMPLES: Array<[string, string]> = [
    ['Натюрморт 1K', 'fixtures/stilllife_1k.png'],
    ['Пейзаж 1K', 'fixtures/landscape_1k.png'],
    ['Флэш 1K', 'fixtures/flash_1k.png'],
    ['Портрет 1K', 'fixtures/portrait_1k.png'],
    ['12 МП JPEG', 'samples/synth_12mp.jpg'],
    ['12 МП HEIC', 'samples/synth_12mp.heic'],
    ['48 МП JPEG', 'samples/synth_48mp.jpg'],
    ['48 МП HEIC', 'samples/synth_48mp.heic'],
  ];
  const FIXTURES = Object.fromEntries(['stilllife', 'landscape', 'flash', 'portrait'].map((n) => [n, new URL(`fixtures/${n}_1k.png`, location.href).href]));
  // Stage 1 targets from IMPLEMENTATION_PLAN, section 6.
  const TARGET = { previewMs: 1500, sliderMs: 50, stallMs: 100 };

  let canvas: HTMLCanvasElement;
  let box: HTMLDivElement;
  let hcanvas: HTMLCanvasElement | undefined = $state();
  let engine: EngineClient | null = $state(null);
  let error = $state('');
  let busy = $state('');
  let vs: ViewState = $state(structuredClone(DEFAULT_VIEW));
  let opened: (OpenResult & { label: string; bytes: number; firstFrameMs: number; stallMs: number }) | null = $state(null);
  let last: ViewResult | null = $state(null);
  let slider = $state({ n: 0, max: 0, sum: 0, samples: [] as number[] });
  let stall = $state({ max: 0 });
  let parity: ParityReport | null = $state(null);
  let lastBlob: { blob: Blob; label: string } | null = null;

  // Main-thread stall monitor: a 16 ms timer that measures its own lateness.
  function jank() {
    let prev = performance.now();
    setInterval(() => {
      const t = performance.now(), late = t - prev - 16;
      if (late > stall.max) stall.max = Math.round(late);
      prev = t;
    }, 16);
  }

  function bgColor(): [number, number, number] {
    return matchMedia('(prefers-color-scheme: dark)').matches ? [28, 28, 31] : [236, 236, 232];
  }

  onMount(() => {
    jank();
    EngineClient.create(canvas).then((c) => {
      engine = c;
      const ro = new ResizeObserver(() => {
        const r = box.getBoundingClientRect();
        void c.resize(r.width, r.height, devicePixelRatio, bgColor());
      });
      ro.observe(box);
      // Hooks for scripts/gpu-parity.mjs (headless Chromium).
      Object.assign(window, {
        __engineDev: {
          selftest: async () => { await runSelftest(); return $state.snapshot(parity); },
          open: async (url: string) => { await openSample(url, url); return report(); },
          set: async (patch: Partial<ViewState>) => { Object.assign(vs, patch); await new Promise((r) => setTimeout(r, 30)); return report(); },
          report,
        },
      });
    }).catch((e) => (error = String(e?.message ?? e)));
  });

  async function openBlob(blob: Blob, label: string) {
    if (!engine) return;
    error = '';
    busy = `Открываю ${label}…`;
    lastBlob = { blob, label };
    stall.max = 0;
    const t0 = performance.now();
    try {
      const r = await engine.open(blob);
      const v = await engine.setView($state.snapshot(vs));
      // Let the timer catch up so a stall during decode is counted.
      await new Promise((res) => setTimeout(res, 50));
      opened = { ...r, label, bytes: blob.size, firstFrameMs: Math.round(performance.now() - t0), stallMs: stall.max };
      last = v;
      slider = { n: 0, max: 0, sum: 0, samples: [] };
      drawHist();
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      busy = '';
    }
  }

  async function openSample(url: string, label: string) {
    busy = `Скачиваю ${label}…`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      await openBlob(await res.blob(), label);
    } catch (e) {
      error = `${label}: ${(e as Error).message}`;
      busy = '';
    }
  }

  function onFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void openBlob(f, f.name);
  }

  async function apply(fromSlider = false) {
    if (!engine || !opened) return;
    const r = await engine.setView($state.snapshot(vs));
    last = r;
    // Frames that had to re-run the analysis (new smoothing) are not slider frames.
    if (fromSlider && r.roundTripMs != null && r.timings.analyzeMs === 0) {
      const s = slider;
      s.samples.push(r.roundTripMs);
      if (s.samples.length > 200) s.samples.shift();
      slider = { n: s.n + 1, max: Math.max(s.max, r.roundTripMs), sum: s.sum + r.roundTripMs, samples: s.samples };
    }
    drawHist();
  }

  // Every state change re-renders; slider input counts towards the slider metric.
  $effect(() => {
    JSON.stringify(vs);
    void apply(true);
  });

  function setView(v: ViewState['view']) {
    vs.view = v;
  }

  function compat() {
    vs.values = { ...vs.values, scale: 'luma', method: 'kmeans', levels: 9, brightness: 0 };
  }

  async function tap(e: PointerEvent) {
    if (!engine || vs.view !== 'values') return;
    const r = canvas.getBoundingClientRect();
    const lev = await engine.pick(e.clientX - r.left, e.clientY - r.top);
    vs.values.highlight = lev === vs.values.highlight ? -1 : lev;
  }

  function p95(a: number[]) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  }

  function drawHist() {
    if (!hcanvas || !last) return;
    const dpr = devicePixelRatio, w = hcanvas.clientWidth, h = hcanvas.clientHeight;
    hcanvas.width = w * dpr;
    hcanvas.height = h * dpr;
    const ctx = hcanvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const hist = last.hist, max = Math.max(...hist.map((v) => Math.sqrt(v))) || 1;
    ctx.fillStyle = css.getPropertyValue('--muted');
    for (let v = 0; v < 256; v++) {
      const bh = (Math.sqrt(hist[v]) / max) * (h - 4);
      ctx.fillRect((v / 256) * w, h - bh, w / 256 + 0.5, bh);
    }
    const marks = last.stats.values?.thresholds ?? last.stats.notan?.thresholds
      ?? (last.stats.temperature ? [last.stats.temperature.neutral + 128] : []);
    ctx.fillStyle = css.getPropertyValue('--accent');
    for (const t of marks) ctx.fillRect(((t + 0.5) / 256) * w - 1, 0, 2, h);
  }

  async function runSelftest() {
    if (!engine) return;
    busy = 'Сверяю GPU с CPU-эталоном на 4 фото…';
    error = '';
    try {
      parity = await engine.selftest(FIXTURES);
      opened = null;
      last = null;
      if (lastBlob) await openBlob(lastBlob.blob, lastBlob.label);
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      busy = '';
    }
  }

  function report() {
    return {
      schema: 'vishar-stage1-report/1',
      build: VERSION,
      at: new Date().toISOString(),
      userAgent: navigator.userAgent,
      screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
      standalone: matchMedia('(display-mode: standalone)').matches,
      caps: engine?.caps,
      open: opened,
      view: $state.snapshot(vs),
      lastFrame: last ? { timings: last.timings, roundTripMs: last.roundTripMs, stats: last.stats } : null,
      slider: { frames: slider.n, maxMs: slider.max, p95Ms: p95(slider.samples), meanMs: slider.n ? Math.round((slider.sum / slider.n) * 10) / 10 : 0 },
      maxMainThreadStallMs: stall.max,
      parity,
    };
  }

  let copied = $state('');
  async function copyReport() {
    const text = JSON.stringify(report(), null, 1);
    try {
      await navigator.clipboard.writeText(text);
      copied = 'Скопировано';
    } catch {
      copied = 'Не удалось скопировать';
    }
    setTimeout(() => (copied = ''), 2000);
  }

  async function shareReport() {
    const text = JSON.stringify(report(), null, 1);
    const file = new File([text], `vishar-stage1-${Date.now()}.json`, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Vishar Stage 1' });
      else await navigator.share({ text });
    } catch {}
  }

  async function exportPng() {
    if (!engine) return;
    const blob = await engine.exportWork();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vishar-${vs.view}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const ok = (pass: boolean) => (pass ? 'pass' : 'fail');
</script>

<main>
  <header>
    <h1>Vishar Engine · Stage 1</h1>
    <p class="sub">Отладочная страница ядра, не интерфейс приложения · {VERSION}</p>
  </header>

  <section class="card">
    <label class="file">
      Открыть своё фото
      <input type="file" accept="image/*,.heic,.heif" onchange={onFile} />
    </label>
    <div class="chips">
      {#each SAMPLES as [label, url]}
        <button class="chip" onclick={() => openSample(url, label)} disabled={!engine || !!busy}>{label}</button>
      {/each}
    </div>
  </section>

  <div class="stage" bind:this={box}>
    <canvas bind:this={canvas} onpointerdown={tap}></canvas>
    {#if !opened && !busy}<p class="hint">Открой фото или образец</p>{/if}
    {#if busy}<p class="hint">{busy}</p>{/if}
  </div>
  {#if error}<p class="error">{error}</p>{/if}

  <nav class="tabs">
    {#each [['original', 'Оригинал'], ['values', 'Values'], ['notan', 'Notan'], ['temperature', 'Temperature']] as [v, label]}
      <button class:active={vs.view === v} onclick={() => setView(v as ViewState['view'])}>{label}</button>
    {/each}
  </nav>

  <section class="card controls">
    <div class="row">
      <span>Сглаживание</span>
      <div class="seg">
        {#each [[0, 'нет'], [1, 'слабое'], [2, 'сильное']] as [v, label]}
          <button class:active={vs.smoothing === v} onclick={() => (vs.smoothing = v as 0 | 1 | 2)}>{label}</button>
        {/each}
      </div>
    </div>

    {#if vs.view === 'values'}
      <label class="row">Уровни <b>{vs.values.levels}</b><input type="range" min="2" max="20" bind:value={vs.values.levels} /></label>
      <div class="row">
        <span>Шкала</span>
        <div class="seg">
          <button class:active={vs.values.scale === 'lstar'} onclick={() => (vs.values.scale = 'lstar')}>L*</button>
          <button class:active={vs.values.scale === 'luma'} onclick={() => (vs.values.scale = 'luma')}>luma</button>
        </div>
      </div>
      <div class="row">
        <span>Пороги</span>
        <div class="seg">
          <button class:active={vs.values.method === 'kmeans'} onclick={() => (vs.values.method = 'kmeans')}>k-means</button>
          <button class:active={vs.values.method === 'kmeans-sqrt'} onclick={() => (vs.values.method = 'kmeans-sqrt')}>√count</button>
          <button class:active={vs.values.method === 'even'} onclick={() => (vs.values.method = 'even')}>равные</button>
        </div>
      </div>
      <label class="row">Яркость <b>{vs.values.brightness}</b><input type="range" min="-50" max="50" bind:value={vs.values.brightness} /></label>
      <label class="row check"><input type="checkbox" bind:checked={vs.values.showHue} /> Show Hue</label>
      <div class="row">
        <button class="chip" onclick={compat}>Как в оригинале</button>
        <span class="muted">тап по фото подсвечивает уровень{vs.values.highlight >= 0 ? ` · уровень ${vs.values.highlight + 1}` : ''}</span>
      </div>
    {:else if vs.view === 'notan'}
      <div class="row">
        <span>Порог</span>
        <div class="seg">
          {#each [['otsu', 'Otsu'], ['median', 'медиана'], ['auto', 'авто']] as [v, label]}
            <button class:active={vs.notan.mode === v} onclick={() => (vs.notan.mode = v as 'otsu')}>{label}</button>
          {/each}
        </div>
      </div>
      <div class="row">
        <span>Уровни</span>
        <div class="seg">
          <button class:active={vs.notan.levels === 2} onclick={() => (vs.notan.levels = 2)}>2</button>
          <button class:active={vs.notan.levels === 3} onclick={() => (vs.notan.levels = 3)}>3</button>
        </div>
      </div>
      <div class="row">
        <span>Шкала</span>
        <div class="seg">
          <button class:active={vs.notan.scale === 'lstar'} onclick={() => (vs.notan.scale = 'lstar')}>L*</button>
          <button class:active={vs.notan.scale === 'luma'} onclick={() => (vs.notan.scale = 'luma')}>luma</button>
        </div>
      </div>
      <label class="row">Баланс <b>{vs.notan.balance}</b><input type="range" min="-50" max="50" bind:value={vs.notan.balance} /></label>
      <label class="row check"><input type="checkbox" bind:checked={vs.notan.invert} /> Инверсия</label>
    {:else if vs.view === 'temperature'}
      <div class="row">
        <span>Нейтраль</span>
        <div class="seg">
          <button class:active={vs.temperature.mode === 'relative'} onclick={() => (vs.temperature.mode = 'relative')}>по фото</button>
          <button class:active={vs.temperature.mode === 'absolute'} onclick={() => (vs.temperature.mode = 'absolute')}>абсолютная</button>
        </div>
      </div>
      <div class="row">
        <span>Вид</span>
        <div class="seg">
          {#each [['map', 'карта'], ['shaded', 'со светлотой'], ['two', '2 цвета']] as [v, label]}
            <button class:active={vs.temperature.style === v} onclick={() => (vs.temperature.style = v as 'map')}>{label}</button>
          {/each}
        </div>
      </div>
      <label class="row">Баланс <b>{vs.temperature.balance}</b><input type="range" min="-30" max="30" bind:value={vs.temperature.balance} /></label>
    {/if}

    {#if vs.view !== 'original'}<canvas class="hist" bind:this={hcanvas}></canvas>{/if}
    {#if last?.stats.values}
      <div class="levels">
        {#each last.stats.values.gray as g, i}
          <span style="background: rgb({g},{g},{g}); color: {g > 128 ? '#000' : '#fff'}">{Math.round(last.stats.values.share[i] * 100)}%</span>
        {/each}
      </div>
    {/if}
    {#if last?.stats.notan}
      <p class="muted">Порог: {last.stats.notan.modeUsed === 'otsu' ? 'Otsu' : 'медиана'} · тёмного {Math.round(last.stats.notan.share[0] * 100)}%</p>
    {/if}
    {#if last?.stats.temperature}
      <p class="muted">Тёплого {Math.round(last.stats.temperature.warmShare * 100)}% · нейтраль {last.stats.temperature.neutral.toFixed(1)} · разброс {last.stats.temperature.spread}</p>
    {/if}
  </section>

  <section class="card">
    <h2>Цели этапа 1</h2>
    {#if opened}
      <ul class="targets">
        {#if opened.info.width * opened.info.height > 20e6}
          <li class="pass">48 МП открыто без выгрузки вкладки за {opened.firstFrameMs} мс{opened.step ? `, ступень деградации ${opened.step}` : ''}</li>
        {:else}
          <li class={ok(opened.firstFrameMs <= TARGET.previewMs)}>Превью {opened.firstFrameMs} мс (цель ≤ {TARGET.previewMs} для 12 МП)</li>
        {/if}
        <li class={ok(slider.n === 0 || p95(slider.samples) <= TARGET.sliderMs)}>
          Слайдер: {slider.n ? `p95 ${p95(slider.samples)} мс, макс ${slider.max} мс, кадров ${slider.n}` : 'подвигай любой слайдер'} (цель ≤ {TARGET.sliderMs})
        </li>
        <li class={ok(stall.max <= TARGET.stallMs)}>Пауза главного потока: макс {stall.max} мс (цель ≤ {TARGET.stallMs})</li>
      </ul>
      <p class="muted">
        {opened.label}: {opened.info.format} {opened.info.width}×{opened.info.height} ({(opened.bytes / 1048576).toFixed(1)} МБ) →
        рабочая копия {opened.work.width}×{opened.work.height}, {opened.method}{opened.step ? `, ступень деградации ${opened.step}` : ''}.
        Заголовок {opened.timings.header} мс, декодирование {opened.timings.decode} мс, загрузка в GPU {opened.timings.upload} мс.
      </p>
      {#if last}
        <p class="muted">Кадр: анализ {last.timings.analyzeMs} мс, пороги {last.timings.planMs} мс, рендер {last.timings.renderMs} мс, туда-обратно {last.roundTripMs} мс.</p>
      {/if}
      {#each opened.warnings as w}<p class="error">{w}</p>{/each}
    {:else}
      <p class="muted">Открой фото: для цели «превью ≤ 1,5 с» нужен образец 12 МП.</p>
    {/if}
  </section>

  <section class="card">
    <h2>Сверка GPU и CPU</h2>
    <p class="muted">Рендерит 11 режимов на 4 эталонных фото на GPU и на CPU и сравнивает пиксели. Плюс режим «как в оригинале» против порогов Color Study.</p>
    <button class="primary" onclick={runSelftest} disabled={!engine || !!busy}>Запустить сверку</button>
    {#if parity}
      <p class={ok(parity.pass)}>{parity.pass ? 'Совпадает' : 'Есть расхождения'} · {parity.cases.filter((c) => c.pass).length}/{parity.cases.length} · {parity.ms} мс · гистограммы ±{(parity.histogramMaxShareDiff * 100).toFixed(2)}%</p>
      <ul class="compact">
        {#each parity.compat as c}
          <li class={ok(c.agreement >= 0.95)}>Как в оригинале, {c.fixture}: {(c.agreement * 100).toFixed(1)}% пикселей</li>
        {/each}
        {#each parity.cases.filter((c) => !c.pass) as c}
          <li class="fail">{c.fixture} · {c.name}: MSE L* {c.mseL}, расхождение {(c.mismatch * 100).toFixed(2)}%, макс {c.maxDiff}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="card actions">
    <button class="primary" onclick={shareReport}>Поделиться отчётом</button>
    <button onclick={copyReport}>{copied || 'Копировать JSON'}</button>
    <button onclick={exportPng} disabled={!opened}>PNG рабочей копии</button>
  </section>
  {#if engine}<p class="sub">GPU: {engine.caps.renderer} · MAX_TEXTURE_SIZE {engine.caps.maxTextureSize} · вывод: {engine.caps.present === 'canvas' ? 'canvas в Worker' : 'ImageBitmap'}</p>{/if}
</main>

<style>
  :global(:root) {
    --bg: #fafaf8;
    --fg: #1d1d1f;
    --muted: #6e6e73;
    --card: #ffffff;
    --line: #e3e3e0;
    --accent: #c2410c;
    --ok: #15803d;
    --bad: #b91c1c;
    --stage: #ececE8;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #111113;
      --fg: #f2f2f2;
      --muted: #9a9aa0;
      --card: #1c1c1f;
      --line: #2c2c30;
      --accent: #fb923c;
      --ok: #4ade80;
      --bad: #f87171;
      --stage: #1c1c1f;
    }
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: calc(12px + env(safe-area-inset-top)) 16px calc(32px + env(safe-area-inset-bottom));
  }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 16px; margin: 0 0 6px; }
  .sub, .muted { color: var(--muted); font-size: 13px; margin: 4px 0; }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 12px;
    margin: 12px 0;
  }
  .stage {
    position: relative;
    height: min(62vh, 560px);
    background: var(--stage);
    border-radius: 12px;
    overflow: hidden;
    touch-action: manipulation;
  }
  .stage canvas { width: 100%; height: 100%; display: block; }
  .hint { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--muted); pointer-events: none; }
  .file { display: inline-block; font-weight: 600; color: var(--accent); cursor: pointer; }
  .file input { display: block; margin-top: 6px; font-size: 13px; max-width: 100%; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  button {
    font: inherit;
    font-size: 14px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--fg);
    border-radius: 8px;
    padding: 6px 10px;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; }
  .chip { font-size: 13px; padding: 4px 9px; }
  .primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 10px; }
  .tabs button, .seg button { padding: 6px 4px; }
  .active { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  .controls .row { display: flex; align-items: center; gap: 10px; margin: 8px 0; flex-wrap: wrap; }
  .controls .row > span:first-child { min-width: 92px; color: var(--muted); font-size: 14px; }
  .controls label.row { color: var(--muted); font-size: 14px; }
  .controls label.row b { color: var(--fg); min-width: 26px; }
  .controls input[type='range'] { flex: 1; min-width: 160px; }
  .check { gap: 6px !important; color: var(--fg) !important; }
  .seg { display: flex; gap: 4px; flex-wrap: wrap; }
  .hist { width: 100%; height: 64px; display: block; margin-top: 8px; }
  .levels { display: flex; gap: 2px; margin-top: 6px; }
  .levels span { flex: 1; text-align: center; font-size: 11px; padding: 3px 0; border-radius: 4px; border: 1px solid var(--line); }
  .targets, .compact { list-style: none; padding: 0; margin: 6px 0; }
  .targets li, .compact li { padding: 3px 0 3px 22px; position: relative; font-size: 14px; }
  .targets li::before, .compact li::before { position: absolute; left: 0; }
  .pass { color: var(--ok); }
  .fail { color: var(--bad); }
  li.pass::before { content: '✓'; }
  li.fail::before { content: '✕'; }
  .error { color: var(--bad); font-size: 13px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
