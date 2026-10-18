<script lang="ts">
  // Debug page for stages 1 and 2: not the Color Study interface. It drives the engine,
  // shows the numbers behind each view and checks the stage acceptance targets on a device.
  import { onMount } from 'svelte';
  import { EngineClient } from '../src/client';
  import { labToSrgb } from '../src/core/color';
  import { colorInfo, compareColors, deltaE2000, hex, type ColorInfo } from '../src/core/colorinfo';
  import { DEFAULT_PALETTE, type Swatch } from '../src/core/palette';
  import { DEFAULT_VIEW, type ViewState } from '../src/core/view';
  import type { OpenResult, PaletteResult, ParityReport, PickResult, ViewResult } from '../src/types';

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
  // Stage 2 targets: palette ≤ 500 ms, Highlight slider ≤ 50 ms, marker = where the colour is.
  const TARGET2 = { paletteMs: 500, highlightMs: 50, markerDE: 2 };
  const SIZES = [1, 3, 5, 11];
  const KINDS = [['dominant', 'Dominant'], ['range', 'Range'], ['accents', 'Accents']] as const;
  type Kind = (typeof KINDS)[number][0];

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

  // Stage 2: pipette, palette, colour card, compare, Highlight.
  let stageW = $state(0);
  let stageH = $state(0);
  let tool: 'pipette' | 'level' = $state('pipette');
  let sampleSize = $state(5);
  let picked: PickResult | null = $state(null);
  let loupeAt: { x: number; y: number } | null = $state(null);
  let lcanvas: HTMLCanvasElement | undefined = $state();
  let current: { info: ColorInfo; from: string } | null = $state(null);
  let compareA: ColorInfo | null = $state(null);
  let palette: PaletteResult | null = $state(null);
  let pparams = $state({ ...DEFAULT_PALETTE });
  let pkind: Kind = $state('dominant');
  let showMarkers = $state(true);
  let markerCheck: { maxDE: number; n: number } | null = $state(null);
  let hlSlider = $state({ n: 0, max: 0, samples: [] as number[] });
  let pickMs = $state([] as number[]);
  let copiedCode = $state('');

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
          set: async (patch: Partial<ViewState>) => { Object.assign(vs, patch); await apply(); return report(); },
          palette: async () => { await runPalette(); return { palette: $state.snapshot(palette), markers: $state.snapshot(markerCheck) }; },
          pick: (u: number, v: number, size: number) => engine?.pickColor(u, v, size),
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
      hlSlider = { n: 0, max: 0, samples: [] };
      palette = null;
      markerCheck = null;
      picked = null;
      pickMs = [];
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
    if (vs.view === 'highlight') {
      // A new target builds its ΔE histogram once; only tolerance/mode frames are slider frames.
      if (!fromSlider || r.roundTripMs == null || r.timings.histMs > 0.5 || r.timings.analyzeMs > 0) { drawHist(); return; }
      const s = hlSlider;
      s.samples.push(r.roundTripMs);
      if (s.samples.length > 200) s.samples.shift();
      hlSlider = { n: s.n + 1, max: Math.max(s.max, r.roundTripMs), samples: s.samples };
    } else if (fromSlider && r.roundTripMs != null && r.timings.analyzeMs === 0) {
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
    if (!engine) return;
    if (tool === 'pipette') {
      canvas.setPointerCapture(e.pointerId);
      pressed = true;
      void pipette(e);
      return;
    }
    if (vs.view !== 'values') return;
    const r = canvas.getBoundingClientRect();
    const lev = await engine.pick(e.clientX - r.left, e.clientY - r.top);
    vs.values.highlight = lev === vs.values.highlight ? -1 : lev;
  }

  // Pipette: one request in flight, the latest pointer position wins.
  let picking = false;
  // A pick can come back after the finger is lifted: it updates the card, not the loupe.
  let pressed = false;
  let nextPick: PointerEvent | null = null;
  async function pipette(e: PointerEvent) {
    if (!engine || !last) return;
    if (picking) { nextPick = e; return; }
    picking = true;
    const r = canvas.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
    const u = (cx / r.width - last.rect.x) / last.rect.w, v = (cy / r.height - last.rect.y) / last.rect.h;
    const t0 = performance.now();
    try {
      const p = await engine.pickColor(u, v, sampleSize);
      if (p) {
        picked = p;
        current = { info: p.info, from: `пипетка ${p.size}×${p.size} в (${p.x}, ${p.y})` };
        if (pressed) loupeAt = { x: cx, y: cy };
        pickMs = [...pickMs.slice(-199), Math.round((performance.now() - t0) * 10) / 10];
      }
    } finally {
      picking = false;
      const n = nextPick;
      nextPick = null;
      if (n) void pipette(n);
    }
  }

  function move(e: PointerEvent) {
    if (tool === 'pipette' && e.buttons) void pipette(e);
  }

  function release() {
    pressed = false;
    loupeAt = null;
  }

  // The loupe canvas mounts after loupeAt is set, so draw once it is bound.
  $effect(() => {
    if (lcanvas && picked && loupeAt) drawLoupe();
  });

  function drawLoupe() {
    if (!lcanvas || !picked) return;
    const n = Math.round(Math.sqrt(picked.patch.length / 4)), dpr = devicePixelRatio, css = 120;
    lcanvas.width = css * dpr;
    lcanvas.height = css * dpr;
    const ctx = lcanvas.getContext('2d')!, tmp = new OffscreenCanvas(n, n);
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(picked.patch), n, n), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, lcanvas.width, lcanvas.height);
    // The sample square, centred on the middle pixel.
    const cell = lcanvas.width / n, o = (n >> 1) - (picked.size >> 1);
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = '#000';
    ctx.strokeRect(o * cell, o * cell, picked.size * cell, picked.size * cell);
    ctx.lineWidth = dpr;
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(o * cell + dpr, o * cell + dpr, picked.size * cell - 2 * dpr, picked.size * cell - 2 * dpr);
  }

  async function runPalette() {
    if (!engine || !opened) return;
    busy = 'Извлекаю палитру…';
    try {
      palette = await engine.palette($state.snapshot(pparams));
      // Marker check: tap every marker with its pipette size, compare with the swatch.
      let maxDE = 0, n = 0;
      for (const s of [...palette.dominant, ...palette.range, ...palette.accents]) {
        const p = await engine.pickColor(s.marker.x, s.marker.y, s.marker.size);
        if (!p) continue;
        maxDE = Math.max(maxDE, deltaE2000(p.info.lab, s.lab));
        n++;
      }
      markerCheck = { maxDE: Math.round(maxDE * 100) / 100, n };
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      busy = '';
    }
  }

  function selectSwatch(s: Swatch, label: string) {
    current = { info: colorInfo(s.rgb), from: `${label}, доля ${(s.share * 100).toFixed(1)}%, маркер ${s.marker.size} px` };
  }

  function findOnPhoto(info: ColorInfo) {
    vs.highlight = { ...vs.highlight, target: [...info.lab] as [number, number, number] };
    vs.view = 'highlight';
  }

  async function copyCode(k: string, v: string) {
    try {
      await navigator.clipboard.writeText(v);
      copiedCode = k;
      setTimeout(() => (copiedCode = ''), 1200);
    } catch {}
  }

  const swatches: Swatch[] = $derived(palette ? palette[pkind] : []);
  /** Marker and strip positions in stage CSS px. */
  const overlay = $derived.by(() => {
    if (!last || !palette || !showMarkers || !swatches.length) return [];
    const r = last.rect, n = swatches.length, sw = Math.min(40, (stageW - 16) / n), x0 = (stageW - sw * n) / 2;
    return swatches.map((s, i) => ({
      s, i,
      mx: (r.x + s.marker.x * r.w) * stageW, my: (r.y + s.marker.y * r.h) * stageH,
      sx: x0 + i * sw, sw, sy: stageH - sw - 8,
    }));
  });

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
    const hist = last.hist, nb = hist.length || 1, max = Math.max(...hist.map((v) => Math.sqrt(v))) || 1;
    ctx.fillStyle = css.getPropertyValue('--muted');
    for (let v = 0; v < nb; v++) {
      const bh = (Math.sqrt(hist[v]) / max) * (h - 4);
      ctx.fillRect((v / nb) * w, h - bh, w / nb + 0.5, bh);
    }
    // Marks as fractions of the axis: tone thresholds, neutral warmth, or the ΔE tolerance.
    const marks = last.stats.highlight ? [vs.highlight.tolerance / nb]
      : (last.stats.values?.thresholds ?? last.stats.notan?.thresholds
        ?? (last.stats.temperature ? [last.stats.temperature.neutral + 128] : [])).map((t) => (t + 0.5) / 256);
    ctx.fillStyle = css.getPropertyValue('--accent');
    for (const t of marks) ctx.fillRect(t * w - 1, 0, 2, h);
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
      schema: 'vishar-stage2-report/1',
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
      stage2: {
        palette: palette ? {
          totalMs: palette.totalMs, readMs: palette.readMs, gridMs: palette.gridMs, extractMs: palette.ms, params: $state.snapshot(pparams),
          counts: { dominant: palette.dominant.length, range: palette.range.length, accents: palette.accents.length },
          dominant: palette.dominant.map((s) => ({ hex: s.hex, share: s.share, markerDE: s.markerDE, size: s.marker.size })),
          accents: palette.accents.map((s) => s.hex),
        } : null,
        markers: markerCheck,
        highlightSlider: { frames: hlSlider.n, maxMs: hlSlider.max, p95Ms: p95(hlSlider.samples) },
        highlightShare: last?.stats.highlight?.share ?? null,
        pipette: { picks: pickMs.length, p95Ms: p95(pickMs), lastMs: picked?.ms ?? null },
      },
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
    const file = new File([text], `vishar-stage2-${Date.now()}.json`, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Vishar Stage 2' });
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
    <h1>Vishar Engine · Stage 2</h1>
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

  <div class="stage" bind:this={box} bind:clientWidth={stageW} bind:clientHeight={stageH}>
    <canvas bind:this={canvas} onpointerdown={tap} onpointermove={move} onpointerup={release} onpointercancel={release}></canvas>
    {#if overlay.length}
      <svg class="overlay" width={stageW} height={stageH}>
        {#each overlay as m}
          <line x1={m.mx} y1={m.my} x2={m.sx + m.sw / 2} y2={m.sy} />
        {/each}
        {#each overlay as m}
          <circle cx={m.mx} cy={m.my} r="9" fill={m.s.hex} />
          <text x={m.mx} y={m.my + 4} fill={m.s.lab[0] > 55 ? '#000' : '#fff'}>{m.i + 1}</text>
          <rect class="sw" x={m.sx} y={m.sy} width={m.sw} height={m.sw} fill={m.s.hex}
            role="button" tabindex="-1" onpointerdown={(e) => { e.stopPropagation(); selectSwatch(m.s, `${pkind} ${m.i + 1}`); }} />
        {/each}
      </svg>
    {/if}
    {#if loupeAt && picked}
      <div class="loupe" style="left: {loupeAt.x - 60}px; top: {Math.max(4, loupeAt.y - 150)}px">
        <canvas bind:this={lcanvas}></canvas>
        <span style="background: {picked.info.codes.HEX}"></span>
      </div>
    {/if}
    {#if !opened && !busy}<p class="hint">Открой фото или образец</p>{/if}
    {#if busy}<p class="hint">{busy}</p>{/if}
  </div>
  {#if error}<p class="error">{error}</p>{/if}

  <nav class="tabs">
    {#each [['original', 'Оригинал'], ['values', 'Values'], ['notan', 'Notan'], ['temperature', 'Temp'], ['highlight', 'Highlight']] as [v, label]}
      <button class:active={vs.view === v} onclick={() => setView(v as ViewState['view'])}>{label}</button>
    {/each}
  </nav>

  <section class="card controls">
    <div class="row">
      <span>Тап по фото</span>
      <div class="seg">
        <button class:active={tool === 'pipette'} onclick={() => (tool = 'pipette')}>пипетка</button>
        <button class:active={tool === 'level'} onclick={() => (tool = 'level')}>уровень Values</button>
      </div>
    </div>
    {#if tool === 'pipette'}
      <div class="row">
        <span>Размер пробы</span>
        <div class="seg">
          {#each SIZES as n}<button class:active={sampleSize === n} onclick={() => (sampleSize = n)}>{n === 1 ? '1 px' : `${n}×${n}`}</button>{/each}
        </div>
      </div>
    {/if}
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
    {:else if vs.view === 'highlight'}
      {#if vs.highlight.target}
        <div class="row">
          <span>Цвет</span>
          <span class="dot" style="background: {hex(labToSrgb(...vs.highlight.target))}"></span>
          <span class="muted">L* {vs.highlight.target[0].toFixed(1)}, a* {vs.highlight.target[1].toFixed(1)}, b* {vs.highlight.target[2].toFixed(1)}</span>
        </div>
      {:else}
        <p class="muted">Выбери цвет пипеткой или в палитре и нажми «Найти на фото».</p>
      {/if}
      <label class="row">Допуск ΔE2000 <b>{vs.highlight.tolerance}</b><input type="range" min="0" max="50" step="0.5" bind:value={vs.highlight.tolerance} /></label>
      <div class="row">
        <span>Вид</span>
        <div class="seg">
          <button class:active={vs.highlight.mode === 'highlight'} onclick={() => (vs.highlight.mode = 'highlight')}>подсветка</button>
          <button class:active={vs.highlight.mode === 'outline'} onclick={() => (vs.highlight.mode = 'outline')}>контур</button>
        </div>
      </div>
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
    {#if last?.stats.highlight && vs.highlight.target}
      <p class="muted">В допуске {(last.stats.highlight.share * 100).toFixed(1)}% фото · гистограмма ΔE до цвета 0…100</p>
    {/if}
    {#if last?.stats.temperature}
      <p class="muted">Тёплого {Math.round(last.stats.temperature.warmShare * 100)}% · нейтраль {last.stats.temperature.neutral.toFixed(1)} · разброс {last.stats.temperature.spread}</p>
    {/if}
  </section>

  <section class="card controls">
    <h2>Палитра</h2>
    <label class="row">Dominant <b>{pparams.dominant}</b><input type="range" min="3" max="12" bind:value={pparams.dominant} /></label>
    <label class="row">Range <b>{pparams.range}</b><input type="range" min="3" max="12" bind:value={pparams.range} /></label>
    <label class="row">Accents <b>{pparams.accents}</b><input type="range" min="0" max="12" bind:value={pparams.accents} /></label>
    <label class="row">Слияние ΔE <b>{pparams.mergeDE}</b><input type="range" min="0" max="20" bind:value={pparams.mergeDE} /></label>
    <div class="row">
      <button class="primary" onclick={runPalette} disabled={!opened || !!busy}>Извлечь палитру</button>
      <label class="check"><input type="checkbox" bind:checked={showMarkers} /> маркеры на фото</label>
    </div>
    {#if palette}
      <div class="seg">
        {#each KINDS as [k, label]}<button class:active={pkind === k} onclick={() => (pkind = k)}>{label} · {palette[k].length}</button>{/each}
      </div>
      <div class="swatches">
        {#each swatches as s, i}
          <button style="background: {s.hex}; color: {s.lab[0] > 55 ? '#000' : '#fff'}" onclick={() => selectSwatch(s, `${pkind} ${i + 1}`)}>
            {i + 1}<small>{pkind === 'range' ? `L* ${Math.round(s.lab[0])}` : `${(s.share * 100).toFixed(1)}%`}</small>
          </button>
        {/each}
      </div>
      {#if !swatches.length}<p class="muted">Акцентов нет: насыщенных цветов вдали от основных не нашлось.</p>{/if}
      <p class="muted">Всего {palette.totalMs} мс: чтение пикселей {palette.readMs}, сетка {palette.gridMs}, извлечение {palette.ms}. Тап по образцу открывает карточку цвета.</p>
    {/if}
  </section>

  {#if current}
    {@const c = current.info}
    <section class="card">
      <h2>Цвет</h2>
      <div class="colorhead">
        <span class="big" style="background: {c.codes.HEX}"></span>
        <div>
          <b>{c.name}</b> · {c.temperature.label}
          <p class="muted">{current.from}</p>
          <p class="muted">Value (L*) {c.value} · тон {c.hue}° · хрома {c.chroma} · насыщенность {c.saturation}% · тепло {c.temperature.warmth}</p>
        </div>
      </div>
      <div class="codes">
        {#each Object.entries(c.codes) as [k, v]}
          <button onclick={() => copyCode(k, v)}><span>{k}</span>{copiedCode === k ? 'скопировано' : v}</button>
        {/each}
      </div>
      <div class="row">
        <span class="dot" style="background: {hex(c.complementary)}"></span>
        <span class="muted">Дополнительный {hex(c.complementary)}</span>
      </div>
      <div class="row">
        <button onclick={() => (compareA = c)}>Запомнить как A</button>
        <button class="primary" onclick={() => findOnPhoto(c)}>Найти на фото</button>
      </div>
      {#if compareA}
        {@const d = compareColors(compareA.rgb, c.rgb)}
        <div class="row">
          <span class="dot" style="background: {compareA.codes.HEX}"></span> A → B <span class="dot" style="background: {c.codes.HEX}"></span>
          <span class="muted">ΔE2000 {d.dE2000} · Value {d.dValue > 0 ? '+' : ''}{d.dValue} · тепло {d.dWarmth > 0 ? '+' : ''}{d.dWarmth} · тон {d.dHue > 0 ? '+' : ''}{d.dHue}° · хрома {d.dChroma > 0 ? '+' : ''}{d.dChroma}</span>
        </div>
      {/if}
    </section>
  {/if}

  <section class="card">
    <h2>Цели этапа 2</h2>
    {#if opened}
      <ul class="targets">
        <li class={ok(!!palette && palette.totalMs <= TARGET2.paletteMs)}>
          Палитра: {palette ? `${palette.totalMs} мс (Dominant ${palette.dominant.length}, Range ${palette.range.length}, Accents ${palette.accents.length})` : 'нажми «Извлечь палитру»'} (цель ≤ {TARGET2.paletteMs})
        </li>
        <li class={ok(!!markerCheck && markerCheck.maxDE <= TARGET2.markerDE)}>
          Маркеры: {markerCheck ? `пипетка в ${markerCheck.n} маркерах даёт цвет образца, макс ΔE ${markerCheck.maxDE}` : 'проверка идёт после извлечения палитры'} (цель ≤ {TARGET2.markerDE})
        </li>
        <li class={ok(hlSlider.n > 0 && p95(hlSlider.samples) <= TARGET2.highlightMs)}>
          Highlight: {hlSlider.n ? `p95 ${p95(hlSlider.samples)} мс, макс ${hlSlider.max} мс, кадров ${hlSlider.n}` : 'выбери цвет, «Найти на фото» и подвигай допуск'} (цель ≤ {TARGET2.highlightMs})
        </li>
      </ul>
      {#if pickMs.length}<p class="muted">Пипетка: {pickMs.length} проб, p95 {p95(pickMs)} мс туда-обратно.</p>{/if}
    {:else}
      <p class="muted">Открой фото.</p>
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
    <p class="muted">Рендерит 15 режимов на 4 эталонных фото на GPU и на CPU и сравнивает пиксели. Плюс режим «как в оригинале» против порогов Color Study.</p>
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
  .tabs { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin-top: 10px; }
  .tabs button { font-size: 13px; }
  .overlay { position: absolute; inset: 0; pointer-events: none; }
  .overlay line { stroke: #fff; stroke-width: 1.5; opacity: 0.85; filter: drop-shadow(0 0 1px #000); }
  .overlay circle { stroke: #fff; stroke-width: 2; filter: drop-shadow(0 0 1px #000); }
  .overlay text { font-size: 11px; font-weight: 700; text-anchor: middle; }
  .overlay .sw { pointer-events: auto; stroke: #fff; stroke-width: 1.5; cursor: pointer; }
  .loupe { position: absolute; width: 120px; height: 120px; border-radius: 50%; overflow: hidden; border: 3px solid #fff; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5); pointer-events: none; }
  .loupe canvas { width: 120px; height: 120px; display: block; }
  .loupe span { position: absolute; left: 0; right: 0; bottom: 0; height: 16px; }
  .swatches { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .swatches button { width: 54px; height: 54px; padding: 2px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; font-weight: 700; }
  .swatches small { font-weight: 400; font-size: 10px; }
  .colorhead { display: flex; gap: 12px; align-items: flex-start; }
  .big { width: 64px; height: 64px; border-radius: 10px; border: 1px solid var(--line); flex: none; }
  .dot { width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--line); display: inline-block; flex: none; }
  .codes { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px; margin: 8px 0; }
  .codes button { text-align: left; font-size: 12px; font-family: ui-monospace, Menlo, monospace; }
  .codes span { display: block; color: var(--muted); font-family: -apple-system, sans-serif; font-size: 11px; }
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
