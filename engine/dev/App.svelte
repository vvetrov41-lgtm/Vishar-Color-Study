<script lang="ts">
  // Debug page for stages 1–4: not the Color Study interface. It drives the engine,
  // shows the numbers behind each view and checks the stage acceptance targets on a device.
  import { onMount } from 'svelte';
  import { EngineClient } from '../src/client';
  import { labToSrgb } from '../src/core/color';
  import { colorInfo, compareColors, deltaE2000, hex, type ColorInfo } from '../src/core/colorinfo';
  import { DEFAULT_PALETTE, type Swatch } from '../src/core/palette';
  import { DEFAULT_VIEW, type ViewState } from '../src/core/view';
  import { DEFAULT_TATTOO, SKIN_TONES, type TattooTool } from '../src/core/tattoo';
  import { evenTones, GREY_SERIES, INK_BRANDS } from '../src/core/pigments';
  import { HINTS } from './hints';
  import type { OpenResult, PaletteResult, ParityReport, PickResult, SvgExport, ViewResult } from '../src/types';

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
  // Stage 3 targets: Clustering ≤ 1 s on the working copy, Graph ≤ 3 s with a progress indicator.
  const TARGET3 = { clusteringMs: 1000, graphMs: 3000, drawSliderMs: 50 };
  const TABS = [['original', 'Оригинал'], ['palette', 'Палитра'], ['values', 'Values'], ['notan', 'Notan'], ['temperature', 'Temp'], ['highlight', 'Highlight'], ['simplify', 'Simplify'], ['drawing', 'Drawing'], ['tattoo', 'Тату']] as const;
  const TOOLS: Array<[TattooTool, string]> = [['contrast', 'Контраст'], ['pigments', 'Пигменты'], ['lines', 'Линии'], ['distance', 'Расстояние'], ['spread', 'Расплывание'], ['skin', 'Кожа']];
  const SKIN_NAMES = ['I', 'II', 'III', 'IV', 'V', 'VI'];
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
  // Page section: a view of the engine, or the palette (shown over the original).
  type Section = (typeof TABS)[number][0];
  let section = $state<Section>('original');
  // A tap on the photo: picks the level in Values, the target in Highlight, a colour elsewhere.
  const tool: 'pipette' | 'level' = $derived(section === 'values' ? 'level' : 'pipette');
  // Explanation sheet opened by an «i» next to a control.
  let hint: string | null = $state(null);
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

  // Stage 3: Simplify / Drawing timings per mode, progress of long computations, SVG export.
  let computeLog = $state({} as Record<string, { ms: number; algoMs?: number; work: string; regions?: number; colors?: number }>);
  let progress = $state(0);
  let progressEvents = $state(0);
  let drawSlider = $state({ n: 0, max: 0, samples: [] as number[] });
  let lastDraw = { base: '', line: -1 };
  let svgInfo: (Omit<SvgExport, 'svg'> & { bytes: number }) | null = $state(null);
  // Stage 4: time of the first computation of each tattoo tool on this photo, stencil export.
  let tattooLog = $state({} as Record<string, { ms: number; work: string }>);
  let stencilInfo: { pageMm: [number, number]; designMm: [number, number]; ms: number; bytes: number } | null = $state(null);

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
      void c.onProgress((share) => { progress = share < 1 ? share : 0; progressEvents++; });
      // Hooks for scripts/gpu-parity.mjs (headless Chromium).
      Object.assign(window, {
        __engineDev: {
          selftest: async () => { await runSelftest(); return $state.snapshot(parity); },
          open: async (url: string) => { await openSample(url, url); return report(); },
          set: async (patch: Partial<ViewState>) => { Object.assign(vs, patch); await apply(); return report(); },
          palette: async () => { await runPalette(); return { palette: $state.snapshot(palette), markers: $state.snapshot(markerCheck) }; },
          pick: (u: number, v: number, size: number) => engine?.pickColor(u, v, size),
          tattoo: async (tool: TattooTool) => { vs.view = 'tattoo'; vs.tattoo = { ...vs.tattoo, tool }; await apply(); return report(); },
          stencil: async () => { const r = await engine!.exportStencil(); return { pageMm: r.pageMm, designMm: r.designMm, ms: r.ms, bytes: r.pdf.length, head: new TextDecoder().decode(r.pdf.subarray(0, 8)) }; },
          svg: async () => { const s = await engine!.exportSvg(); return { loops: s.loops, points: s.points, ms: s.ms, bytes: s.svg.length, head: s.svg.slice(0, 200) }; },
          report,
        },
      });
    }).catch((e) => (error = String(e?.message ?? e)));
  });

  /** keep: re-open of the same photo after the selftest, measurements made on it stay. */
  async function openBlob(blob: Blob, label: string, keep = false) {
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
      logCompute(v);
      drawHist();
      if (keep) return;
      slider = { n: 0, max: 0, sum: 0, samples: [] };
      hlSlider = { n: 0, max: 0, samples: [] };
      palette = null;
      markerCheck = null;
      picked = null;
      pickMs = [];
      computeLog = {};
      drawSlider = { n: 0, max: 0, samples: [] };
      svgInfo = null;
      tattooLog = {};
      stencilInfo = null;
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      busy = '';
    }
  }

  function logCompute(r: ViewResult) {
    if (vs.view === 'tattoo' && r.timings.computeMs > 0) {
      tattooLog[vs.tattoo.tool] = { ms: r.timings.computeMs, work: `${r.work.width}×${r.work.height}` };
      return;
    }
    if ((vs.view !== 'simplify' && vs.view !== 'drawing') || !(r.timings.computeMs > 0)) return;
    const key = vs.view === 'simplify' ? vs.simplify.mode : vs.drawing.mode;
    computeLog[key] = { ms: r.timings.computeMs, algoMs: r.stats.simplify?.ms.total, work: `${r.work.width}×${r.work.height}`, regions: r.stats.simplify?.regions, colors: r.stats.simplify?.colors };
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
    progress = 0;
    // Frames that had to re-run the analysis (new smoothing) are not slider frames.
    if (vs.view === 'tattoo') { logCompute(r); return; }
    if (vs.view === 'simplify' || vs.view === 'drawing') {
      logCompute(r);
      // Line slider frames only: same style, Stroke and smoothing, a new Line value.
      const base = JSON.stringify([vs.smoothing, vs.drawing.mode, vs.drawing.stroke, vs.drawing.invert]);
      const lineOnly = vs.view === 'drawing' && base === lastDraw.base && vs.drawing.line !== lastDraw.line;
      if (vs.view === 'drawing') lastDraw = { base, line: vs.drawing.line };
      if (lineOnly && fromSlider && r.roundTripMs != null && r.timings.analyzeMs === 0) {
        const s = drawSlider;
        s.samples.push(r.roundTripMs);
        if (s.samples.length > 200) s.samples.shift();
        drawSlider = { n: s.n + 1, max: Math.max(s.max, r.roundTripMs), samples: s.samples };
      }
      return;
    }
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

  /** Black & Grey: a brand series sets the number of tones and their names, L* evenly to start. */
  function setSeries(k: number) {
    vs.tattoo.pigments = { ...vs.tattoo.pigments, series: k, tonesL: evenTones(k >= 0 ? GREY_SERIES[k].names.length : vs.tattoo.pigments.tonesL.length) };
  }

  /** Switching sections drops what belonged to the previous one: the colour card and the loupe. */
  function openSection(v: Section) {
    if (v !== section) { current = null; picked = null; loupeAt = null; hint = null; }
    section = v;
    setView(v === 'palette' ? 'original' : v);
  }

  function compat() {
    vs.values = { ...vs.values, scale: 'luma', method: 'kmeans', levels: 9, brightness: 0 };
  }

  async function tap(e: PointerEvent) {
    if (!engine) return;
    // In Highlight a tap (or drag) on the photo picks the colour to find.
    if (tool === 'pipette' || vs.view === 'highlight') {
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
        if (vs.view === 'highlight') vs.highlight = { ...vs.highlight, target: [...p.info.lab] as [number, number, number] };
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
    if ((tool === 'pipette' || vs.view === 'highlight') && e.buttons) void pipette(e);
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
    if (section !== 'palette' || !last || !palette || !showMarkers || !swatches.length) return [];
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
      const before = opened;
      parity = await engine.selftest(FIXTURES);
      opened = null;
      last = null;
      if (lastBlob) await openBlob(lastBlob.blob, lastBlob.label, true);
      // The first-open timings belong to the original open, not the re-open after the test.
      const now = opened as typeof before;
      if (now && before) opened = { ...now, firstFrameMs: before.firstFrameMs, stallMs: before.stallMs };
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    } finally {
      busy = '';
    }
  }

  function report() {
    return {
      schema: 'vishar-stage4-report/1',
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
      stage3: {
        compute: $state.snapshot(computeLog),
        progressEvents,
        drawingSlider: { frames: drawSlider.n, maxMs: drawSlider.max, p95Ms: p95(drawSlider.samples) },
        svg: svgInfo,
        simplify: $state.snapshot(vs.simplify),
        drawing: $state.snapshot(vs.drawing),
      },
      stage4: {
        compute: $state.snapshot(tattooLog),
        tattoo: $state.snapshot(vs.tattoo),
        stats: last?.stats.tattoo ?? null,
        stencil: stencilInfo,
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
    const file = new File([text], `vishar-stage4-${Date.now()}.json`, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Vishar Stage 4' });
      else await navigator.share({ text });
    } catch {}
  }

  function download(blob: Blob, name: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** Share sheet on iPhone (Files, Illustrator, Procreate), download elsewhere. */
  async function shareFile(blob: Blob, name: string) {
    const file = new File([blob], name, { type: blob.type });
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
    download(blob, name);
  }

  async function exportSvg() {
    if (!engine) return;
    try {
      const s = await engine.exportSvg(), blob = new Blob([s.svg], { type: 'image/svg+xml' });
      svgInfo = { loops: s.loops, points: s.points, ms: s.ms, bytes: blob.size };
      await shareFile(blob, `vishar-${vs.drawing.mode}.svg`);
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }
  }

  async function exportInk() {
    if (!engine) return;
    await shareFile(await engine.exportInkPng(), `vishar-${vs.drawing.mode}-transparent.png`);
  }

  async function exportStencil() {
    if (!engine) return;
    try {
      const s = await engine.exportStencil(), blob = new Blob([s.pdf as BlobPart], { type: 'application/pdf' });
      stencilInfo = { pageMm: s.pageMm, designMm: s.designMm, ms: s.ms, bytes: blob.size };
      await shareFile(blob, `vishar-stencil-${vs.tattoo.widthCm}cm${vs.tattoo.lines.mirror ? '-mirror' : ''}.pdf`);
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }
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
    <h1>Vishar Engine · Stage 4</h1>
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
    {#if progress > 0}<div class="progress"><span style="width: {Math.round(progress * 100)}%"></span></div>{/if}
  </div>
  {#if error}<p class="error">{error}</p>{/if}

  <nav class="tabs">
    {#each TABS as [v, label]}
      <button class:active={section === v} onclick={() => openSection(v)}>{label}</button>
    {/each}
  </nav>

  <section class="card controls">
    {#if section === 'original'}
      <p class="muted">Тапни по фото: пипетка покажет цвет и его коды.</p>
    {:else if section === 'palette'}
      <p class="muted">Палитра считается по оригиналу. Тап по образцу или по фото открывает карточку цвета.</p>
    {/if}
    {#if vs.view === 'values'}
      <label class="row"><span>Уровни {@render i('values.levels')}</span> <b>{vs.values.levels}</b><input type="range" min="2" max="20" bind:value={vs.values.levels} /></label>
      <div class="row">
        <span>Шкала {@render i('values.scale')}</span>
        <div class="seg">
          <button class:active={vs.values.scale === 'lstar'} onclick={() => (vs.values.scale = 'lstar')}>L*</button>
          <button class:active={vs.values.scale === 'luma'} onclick={() => (vs.values.scale = 'luma')}>luma</button>
        </div>
      </div>
      <div class="row">
        <span>Пороги {@render i('values.method')}</span>
        <div class="seg">
          <button class:active={vs.values.method === 'kmeans'} onclick={() => (vs.values.method = 'kmeans')}>k-means</button>
          <button class:active={vs.values.method === 'kmeans-sqrt'} onclick={() => (vs.values.method = 'kmeans-sqrt')}>√count</button>
          <button class:active={vs.values.method === 'even'} onclick={() => (vs.values.method = 'even')}>равные</button>
        </div>
      </div>
      <label class="row"><span>Яркость {@render i('values.brightness')}</span> <b>{vs.values.brightness}</b><input type="range" min="-50" max="50" bind:value={vs.values.brightness} /></label>
      <label class="row check"><input type="checkbox" bind:checked={vs.values.showHue} /> Show Hue {@render i('values.showHue')}</label>
      <div class="row">
        <button class="chip" onclick={compat}>Как в оригинале</button> {@render i('values.compat')}
        <span class="muted">тап по фото подсвечивает уровень{vs.values.highlight >= 0 ? ` · уровень ${vs.values.highlight + 1}` : ''}</span>
      </div>
    {:else if vs.view === 'notan'}
      <div class="row">
        <span>Порог {@render i('notan.mode')}</span>
        <div class="seg">
          {#each [['otsu', 'Otsu'], ['median', 'медиана'], ['auto', 'авто']] as [v, label]}
            <button class:active={vs.notan.mode === v} onclick={() => (vs.notan.mode = v as 'otsu')}>{label}</button>
          {/each}
        </div>
      </div>
      <div class="row">
        <span>Уровни {@render i('notan.levels')}</span>
        <div class="seg">
          <button class:active={vs.notan.levels === 2} onclick={() => (vs.notan.levels = 2)}>2</button>
          <button class:active={vs.notan.levels === 3} onclick={() => (vs.notan.levels = 3)}>3</button>
        </div>
      </div>
      <div class="row">
        <span>Шкала {@render i('notan.scale')}</span>
        <div class="seg">
          <button class:active={vs.notan.scale === 'lstar'} onclick={() => (vs.notan.scale = 'lstar')}>L*</button>
          <button class:active={vs.notan.scale === 'luma'} onclick={() => (vs.notan.scale = 'luma')}>luma</button>
        </div>
      </div>
      <label class="row"><span>Баланс {@render i('notan.balance')}</span> <b>{vs.notan.balance}</b><input type="range" min="-50" max="50" bind:value={vs.notan.balance} /></label>
      <label class="row check"><input type="checkbox" bind:checked={vs.notan.invert} /> Инверсия {@render i('notan.invert')}</label>
    {:else if vs.view === 'temperature'}
      <div class="row">
        <span>Нейтраль {@render i('temp.mode')}</span>
        <div class="seg">
          <button class:active={vs.temperature.mode === 'relative'} onclick={() => (vs.temperature.mode = 'relative')}>по фото</button>
          <button class:active={vs.temperature.mode === 'absolute'} onclick={() => (vs.temperature.mode = 'absolute')}>абсолютная</button>
        </div>
      </div>
      <div class="row">
        <span>Вид {@render i('temp.style')}</span>
        <div class="seg">
          {#each [['map', 'карта'], ['shaded', 'со светлотой'], ['two', '2 цвета']] as [v, label]}
            <button class:active={vs.temperature.style === v} onclick={() => (vs.temperature.style = v as 'map')}>{label}</button>
          {/each}
        </div>
      </div>
      <label class="row"><span>Баланс {@render i('temp.balance')}</span> <b>{vs.temperature.balance}</b><input type="range" min="-30" max="30" bind:value={vs.temperature.balance} /></label>
    {:else if vs.view === 'highlight'}
      {#if vs.highlight.target}
        <div class="row">
          <span>Цвет</span>
          <span class="dot" style="background: {hex(labToSrgb(...vs.highlight.target))}"></span>
          <span class="muted">L* {vs.highlight.target[0].toFixed(1)}, a* {vs.highlight.target[1].toFixed(1)}, b* {vs.highlight.target[2].toFixed(1)}</span>
        </div>
        <p class="muted">Тапни по фото, чтобы выбрать другой цвет.</p>
      {:else}
        <p class="muted">Тапни по фото: подсветятся все места похожего цвета. Допуск задаёт, насколько похожего.</p>
      {/if}
      <label class="row"><span>Допуск ΔE2000 {@render i('hl.tolerance')}</span> <b>{vs.highlight.tolerance}</b><input type="range" min="0" max="50" step="0.5" bind:value={vs.highlight.tolerance} /></label>
      <div class="row">
        <span>Вид {@render i('hl.mode')}</span>
        <div class="seg">
          <button class:active={vs.highlight.mode === 'highlight'} onclick={() => (vs.highlight.mode = 'highlight')}>подсветка</button>
          <button class:active={vs.highlight.mode === 'outline'} onclick={() => (vs.highlight.mode = 'outline')}>контур</button>
        </div>
      </div>
    {:else if vs.view === 'simplify'}
      <div class="row">
        <span>Стиль {@render i('simp.mode')}</span>
        <div class="seg">
          {#each [['clustering', 'кластеры'], ['graph', 'граф'], ['posterize', 'постер']] as [v, label]}
            <button class:active={vs.simplify.mode === v} onclick={() => (vs.simplify.mode = v as 'clustering')}>{label}</button>
          {/each}
        </div>
      </div>
      <label class="row"><span>Детали {@render i('simp.details')}</span> <b>{vs.simplify.details + 1}</b><input type="range" min="0" max="8" bind:value={vs.simplify.details} /></label>
      <label class="row"><span>Лимит цветов {@render i('simp.limit')}</span> <b>{vs.simplify.paletteLimit || 'нет'}</b><input type="range" min="0" max="16" bind:value={vs.simplify.paletteLimit} /></label>
      <label class="row check"><input type="checkbox" bind:checked={vs.simplify.keepDark} /> Сохранять тонкие тёмные элементы {@render i('simp.keepDark')}</label>
      {#if vs.simplify.keepDark}
        <label class="row"><span>Темнее пятна на ΔL* {@render i('simp.darkDelta')}</span> <b>{vs.simplify.darkDelta}</b><input type="range" min="5" max="40" bind:value={vs.simplify.darkDelta} /></label>
      {/if}
    {:else if vs.view === 'drawing'}
      <div class="row">
        <span>Стиль {@render i('draw.mode')}</span>
        <div class="seg">
          <button class:active={vs.drawing.mode === 'sketch'} onclick={() => (vs.drawing.mode = 'sketch')}>Sketch</button>
          <button class:active={vs.drawing.mode === 'contours'} onclick={() => (vs.drawing.mode = 'contours')}>Contours</button>
        </div>
      </div>
      <label class="row"><span>Line {@render i('draw.line')}</span> <b>{vs.drawing.line}</b><input type="range" min="0" max="100" bind:value={vs.drawing.line} /></label>
      <label class="row"><span>Stroke {@render i('draw.stroke')}</span> <b>{vs.drawing.stroke}</b><input type="range" min="1" max="5" bind:value={vs.drawing.stroke} /></label>
      <label class="row check"><input type="checkbox" bind:checked={vs.drawing.invert} /> Инверсия {@render i('draw.invert')}</label>
      <div class="row">
        <button class="primary" onclick={exportSvg} disabled={!opened}>SVG</button>
        <button onclick={exportInk} disabled={!opened}>PNG без фона</button>
        {@render i('draw.export')}
      </div>
      {#if svgInfo}<p class="muted">SVG: {svgInfo.loops} контуров, {svgInfo.points} точек, {(svgInfo.bytes / 1024).toFixed(0)} КБ, {svgInfo.ms} мс</p>{/if}
    {:else if vs.view === 'tattoo'}
      {@const t = vs.tattoo}
      <div class="seg wrap">
        {#each TOOLS as [k, label]}<button class:active={t.tool === k} onclick={() => (vs.tattoo.tool = k)}>{label}</button>{/each}
        {@render i('tat.tool')}
      </div>
      {#if t.tool !== 'skin' && t.tool !== 'pigments'}
        <label class="row"><span>Ширина тату, см {@render i('tat.width')}</span> <b>{t.widthCm}</b><input type="range" min="2" max="40" step="0.5" bind:value={vs.tattoo.widthCm} /></label>
      {/if}
      <div class="row"><span class="muted">Настройки всех инструментов {@render i('tat.reset')}</span><button onclick={() => (vs.tattoo = { ...structuredClone(DEFAULT_TATTOO), tool: t.tool })}>Сбросить</button></div>
      {#if t.tool === 'contrast'}
        <p class="muted">Эскиз упрощается до пятен; границы соседних цветов с близкой светлотой отмечены полосками: со временем они могут слиться.</p>
        <label class="row"><span>Порог ΔL* {@render i('con.minDL')}</span> <b>{t.contrast.minDL}</b><input type="range" min="3" max="40" bind:value={vs.tattoo.contrast.minDL} /></label>
        <label class="row"><span>Детали {@render i('con.details')}</span> <b>{t.contrast.details + 1}</b><input type="range" min="0" max="8" bind:value={vs.tattoo.contrast.details} /></label>
        <label class="row"><span>Лимит цветов {@render i('con.levels')}</span> <b>{t.contrast.levels || 'нет'}</b><input type="range" min="0" max="5" bind:value={vs.tattoo.contrast.levels} /></label>
        <label class="row"><span>«Один градиент» до ΔE {@render i('con.sameDE')}</span> <b>{t.contrast.sameDE}</b><input type="range" min="0" max="15" bind:value={vs.tattoo.contrast.sameDE} /></label>
        <label class="row check"><input type="checkbox" bind:checked={vs.tattoo.contrast.bw} /> Ч/б: показать светлоту вместо цвета {@render i('con.bw')}</label>
      {:else if t.tool === 'pigments'}
        {@const pg = t.pigments}
        <div class="row">
          <span>Режим {@render i('pig.mode')}</span>
          <div class="seg">
            <button class:active={pg.mode === 'color'} onclick={() => (vs.tattoo.pigments.mode = 'color')}>Цвет</button>
            <button class:active={pg.mode === 'bg'} onclick={() => (vs.tattoo.pigments.mode = 'bg')}>Black & Grey</button>
          </div>
        </div>
        {#if pg.mode === 'color'}
          <label class="row"><span>Бренд {@render i('pig.brand')}</span>
            <select bind:value={vs.tattoo.pigments.brand}>
              {#each INK_BRANDS as b}<option value={b}>{b}</option>{/each}
              <option value="">все бренды</option>
            </select>
          </label>
          <label class="row"><span>Красок {@render i('pig.max')}</span> <b>{pg.maxInks}</b><input type="range" min="1" max="10" bind:value={vs.tattoo.pigments.maxInks} /></label>
          <label class="row"><span>Далеко, ΔE {@render i('pig.far')}</span> <b>{pg.farDE}</b><input type="range" min="3" max="25" bind:value={vs.tattoo.pigments.farDE} /></label>
        {:else}
          <label class="row"><span>Линейка {@render i('pig.series')}</span>
            <select value={pg.series} onchange={(e) => setSeries(+(e.currentTarget as HTMLSelectElement).value)}>
              <option value={-1}>свои тоны</option>
              {#each GREY_SERIES as g, k}<option value={k}>{g.brand} · {g.series} ({g.names.length})</option>{/each}
            </select>
          </label>
          {#if pg.series < 0}
            <label class="row"><span>Тонов</span> <b>{pg.tonesL.length}</b><input type="range" min="2" max="6" value={pg.tonesL.length} oninput={(e) => (vs.tattoo.pigments.tonesL = evenTones(+(e.currentTarget as HTMLInputElement).value))} /></label>
          {/if}
          {#each pg.tonesL as L, k}
            <label class="row"><span>{pg.series >= 0 ? GREY_SERIES[pg.series].names[k] : `Тон ${k + 1}`} {#if k === 0}{@render i('pig.tone')}{/if}</span> <b>{L}</b><input type="range" min="0" max="95" bind:value={vs.tattoo.pigments.tonesL[k]} /></label>
          {/each}
        {/if}
        <label class="row"><span>Детали {@render i('simp.details')}</span> <b>{pg.details + 1}</b><input type="range" min="0" max="8" bind:value={vs.tattoo.pigments.details} /></label>
      {:else if t.tool === 'lines'}
        <p class="muted">Проверка, удержатся ли линии и просветы при этом размере тату. Красное: линия тоньше минимума, может расплыться или пропасть. Синее: просвет уже минимума, может затянуться. Ширина в см задаёт масштаб: чем меньше тату, тем больше красного и синего.</p>
        <div class="row">
          <span>Линии {@render i('lin.source')}</span>
          <div class="seg">
            <button class:active={t.lines.source === 'design'} onclick={() => (vs.tattoo.lines.source = 'design')}>тёмное эскиза</button>
            <button class:active={t.lines.source === 'drawing'} onclick={() => (vs.tattoo.lines.source = 'drawing')}>из Drawing</button>
          </div>
        </div>
        {#if t.lines.source === 'design'}
          <label class="row"><span>Линия темнее L* {@render i('lin.inkL')}</span> <b>{t.lines.inkL}</b><input type="range" min="5" max="80" bind:value={vs.tattoo.lines.inkL} /></label>
          <p class="muted">Пиксели темнее этой светлоты считаются линией (серые на картинке). 0 = чёрный, 100 = белый.</p>
        {:else}
          <p class="muted">Берётся текущий Drawing: стиль, Line и Stroke настраиваются во вкладке Drawing.</p>
        {/if}
        <label class="row"><span>Мин. линия, мм {@render i('lin.minLine')}</span> <b>{t.lines.minLineMm}</b><input type="range" min="0.1" max="2" step="0.05" bind:value={vs.tattoo.lines.minLineMm} /></label>
        <label class="row"><span>Мин. зазор, мм {@render i('lin.minGap')}</span> <b>{t.lines.minGapMm}</b><input type="range" min="0.2" max="3" step="0.1" bind:value={vs.tattoo.lines.minGapMm} /></label>
        <p class="muted"><span class="dot" style="background: rgb(230,0,40)"></span> линия тоньше минимума · <span class="dot" style="background: rgb(0,110,255)"></span> зазор уже минимума</p>
        <div class="row">
          <label class="check"><input type="checkbox" bind:checked={vs.tattoo.lines.mirror} /> зеркально</label>
          <button class="primary" onclick={exportStencil} disabled={!opened}>Трафарет PDF 1:1</button> {@render i('lin.pdf')}
        </div>
        {#if stencilInfo}<p class="muted">PDF: эскиз {stencilInfo.designMm[0]}×{stencilInfo.designMm[1]} мм на листе {stencilInfo.pageMm[0]}×{stencilInfo.pageMm[1]} мм, {(stencilInfo.bytes / 1024).toFixed(0)} КБ. Печатай в масштабе 100 % и проверь линейку 10 мм.</p>{/if}
      {:else if t.tool === 'distance'}
        <label class="row"><span>Расстояние, м {@render i('dist.m')}</span> <b>{t.distance.distanceM}</b><input type="range" min="0.5" max="10" step="0.5" bind:value={vs.tattoo.distance.distanceM} /></label>
        <label class="row"><span>Острота зрения, ′ {@render i('dist.arcmin')}</span> <b>{t.distance.arcmin}</b><input type="range" min="0.5" max="3" step="0.5" bind:value={vs.tattoo.distance.arcmin} /></label>
      {:else if t.tool === 'spread'}
        <label class="row"><span>Растекание, мм {@render i('spr.mm')}</span> <b>{t.spread.spreadMm}</b><input type="range" min="0" max="0.6" step="0.05" bind:value={vs.tattoo.spread.spreadMm} /></label>
        <label class="row"><span>Контраст {@render i('spr.contrast')}</span> <b>{Math.round(t.spread.contrast * 100)}%</b><input type="range" min="0.5" max="1" step="0.05" bind:value={vs.tattoo.spread.contrast} /></label>
        <label class="row"><span>Размытие, мм {@render i('spr.blur')}</span> <b>{t.spread.blurMm}</b><input type="range" min="0" max="0.5" step="0.05" bind:value={vs.tattoo.spread.blurMm} /></label>
        <p class="muted">Так может снизиться читаемость; реальный результат зависит от кожи и техники.</p>
      {:else}
        <p class="muted">Своих настроек нет. Эскиз поверх тонов кожи I–VI (шкала Фицпатрика, ориентировочно): слева направо, сверху вниз. Белый пигмент на тёмной коже почти не виден.</p>
        <div class="row">{#each SKIN_TONES as c, i}<span class="dot" style="background: rgb({c.join(',')})"></span><span class="muted">{SKIN_NAMES[i]}</span>{/each}</div>
      {/if}
    {/if}

    {#if vs.view !== 'original' && vs.view !== 'simplify' && vs.view !== 'drawing' && vs.view !== 'tattoo'}<canvas class="hist" bind:this={hcanvas}></canvas>{/if}
    {#if last?.stats.simplify}
      {@const s = last.stats.simplify}
      <p class="muted">Пятен {s.regions} · цветов {s.colors}{s.inkShare ? ` · тёмных элементов ${(s.inkShare * 100).toFixed(1)}%` : ''} · {s.ms.total} мс (сегментация {s.ms.segment}, слияние {s.ms.merge}, заливка {s.ms.paint}){last.timings.computeMs ? '' : ' · из кэша'}</p>
    {/if}
    {#if last?.stats.drawing}
      <p class="muted">Линий {(last.stats.drawing.inkShare * 100).toFixed(1)}% площади · расчёт {last.timings.computeMs} мс, загрузка в GPU {last.timings.uploadMs} мс, туда-обратно {last.roundTripMs} мс</p>
    {/if}
    {#if last?.stats.tattoo}
      {@const ts = last.stats.tattoo}
      {#if ts.contrast}
        <p class="muted">Цветов {ts.contrast.colors} · слабых границ {ts.contrast.weakPairs} ({Math.round(ts.contrast.weakShare * 100)}% длины всех границ) · {ts.ms} мс{last.timings.computeMs ? '' : ' · из кэша'}</p>
        <div class="pairs">
          {#each ts.contrast.pairs as p}
            <div class="row" class:weak={p.weak}>
              <span class="dot" style="background: {p.a}"></span><span class="dot" style="background: {p.b}"></span>
              <span>ΔL* {p.dL} · ΔE {p.dE} · граница {p.border}{p.colorOnColor ? ' · цвет на цвете' : ''}</span>
            </div>
          {/each}
        </div>
      {:else if ts.pigments && 'inks' in ts.pigments}
        {@const pr = ts.pigments}
        <p class="muted">Средняя разница с эскизом ΔE {pr.meanDE} · кожа без краски {Math.round(pr.skinShare * 100)}% · {ts.ms} мс{last.timings.computeMs ? '' : ' · из кэша'}</p>
        <div class="pairs">
          {#each pr.inks as k}
            <div class="row"><span class="dot" style="background: {k.hex}"></span><span>{k.name} <span class="muted">· {k.line} · {Math.round(k.share * 100)}%{k.conf === 'm' ? '' : ' · цвет по фото флакона'}</span></span></div>
          {/each}
        </div>
        {#if pr.misses.length}
          <p class="muted">Не попадают ни в одну краску ближе ΔE {vs.tattoo.pigments.farDE}:</p>
          <div class="pairs">
            {#each pr.misses as m}
              <div class="row weak"><span class="dot" style="background: {m.hex}"></span><span class="dot" style="background: {m.nearestHex}"></span><span>{Math.round(m.share * 100)}% эскиза · ближе всего {m.nearest}, ΔE {m.nearestDE}{m.usedDE > m.nearestDE + 0.5 ? ` (сейчас ΔE ${m.usedDE}: добавь краску)` : ''}</span></div>
            {/each}
          </div>
        {/if}
      {:else if ts.pigments && 'tones' in ts.pigments}
        {@const pr = ts.pigments}
        <div class="levels">
          {#each pr.tones as L, k}<span style="background: rgb({labToSrgb(L, 0, 0).join(',')}); color: {L > 55 ? '#000' : '#fff'}">{Math.round(pr.shares[k] * 100)}%</span>{/each}
        </div>
        <p class="muted">Кожа без краски {Math.round(pr.skinShare * 100)}% · {ts.ms} мс</p>
      {:else if ts.lines}
        <p class="muted">{ts.lines.pxPerMm} px/мм · линий {(ts.lines.inkShare * 100).toFixed(1)}% · тонких {(ts.lines.thinShare * 100).toFixed(1)}% линий · узких зазоров {(ts.lines.gapShare * 100).toFixed(1)}% площади · {ts.ms} мс</p>
        {#if ts.lines.inkShare < 0.005}<p class="error">Линией почти ничего не считается ({(ts.lines.inkShare * 100).toFixed(1)}%). Подними «Линия темнее L*» или нажми «Сбросить».</p>{/if}
        {#if ts.lines.lowResolution}<p class="error">Разрешения мало: минимальная линия меньше 2 px. Уменьши ширину тату или открой фото крупнее.</p>{/if}
      {:else if ts.distance}
        {@const f = ts.distance.figure}
        <p class="muted">Размытие {ts.distance.blurPx} px · Notan совпадает на {Math.round(ts.distance.iou * 100)}% (IoU) · {ts.ms} мс</p>
        <p class="muted">Фигура/фон: тёмного {Math.round(f.darkShare * 100)}%, крупных тёмных пятен {f.bigDark}, главное пятно {Math.round(f.dominant * 100)}% тёмного</p>
      {:else if ts.spread}
        <p class="muted">Растекание {ts.spread.spreadPx} px · размытие {ts.spread.blurPx} px · {ts.ms} мс</p>
      {:else}
        <p class="muted">{ts.ms} мс</p>
      {/if}
    {/if}
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
    <details class="common">
      <summary>Общие настройки</summary>
      <div class="row">
        <span>Сглаживание {@render i('smoothing')}</span>
        <div class="seg">
          {#each [[0, 'нет'], [1, 'слабое'], [2, 'сильное']] as [v, label]}
            <button class:active={vs.smoothing === v} onclick={() => (vs.smoothing = v as 0 | 1 | 2)}>{label}</button>
          {/each}
        </div>
      </div>
      {#if tool === 'pipette'}
        <div class="row">
          <span>Размер пробы {@render i('sampleSize')}</span>
          <div class="seg">
            {#each SIZES as n}<button class:active={sampleSize === n} onclick={() => (sampleSize = n)}>{n === 1 ? '1 px' : `${n}×${n}`}</button>{/each}
          </div>
        </div>
      {/if}
    </details>
  </section>

  {#if section === 'palette'}
  <section class="card controls">
    <h2>Палитра</h2>
    <label class="row"><span>Dominant {@render i('pal.dominant')}</span> <b>{pparams.dominant}</b><input type="range" min="3" max="12" bind:value={pparams.dominant} /></label>
    <label class="row"><span>Range {@render i('pal.range')}</span> <b>{pparams.range}</b><input type="range" min="3" max="12" bind:value={pparams.range} /></label>
    <label class="row"><span>Accents {@render i('pal.accents')}</span> <b>{pparams.accents}</b><input type="range" min="0" max="12" bind:value={pparams.accents} /></label>
    <label class="row"><span>Слияние ΔE {@render i('pal.merge')}</span> <b>{pparams.mergeDE}</b><input type="range" min="0" max="20" bind:value={pparams.mergeDE} /></label>
    <div class="row">
      <button class="primary" onclick={runPalette} disabled={!opened || !!busy}>Извлечь палитру</button>
      <label class="check"><input type="checkbox" bind:checked={showMarkers} /> маркеры на фото {@render i('pal.markers')}</label>
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
  {/if}

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

  <details class="card diag">
    <summary>Диагностика: цели этапов, сверка GPU и CPU</summary>
  <section>
    <h2>Этап 4: тату-инструменты</h2>
    {#if opened}
      <ul class="targets">
        {#each TOOLS as [k, label]}
          <li class={ok(!!tattooLog[k])}>{label}: {tattooLog[k] ? `${tattooLog[k].ms} мс на ${tattooLog[k].work}` : 'открой во вкладке Тату'}</li>
        {/each}
        <li class={ok(!!stencilInfo)}>Трафарет PDF: {stencilInfo ? `${stencilInfo.designMm[0]}×${stencilInfo.designMm[1]} мм; распечатай в 100 % и сверь линейку` : 'Тату → Линии → «Трафарет PDF 1:1»'}</li>
      </ul>
      <p class="muted">Приёмка этапа: на 10 эскизах студии предупреждения совпадают с оценкой мастера минимум в 8 случаях. Пороги стартовые и настраиваются.</p>
    {:else}
      <p class="muted">Открой эскиз.</p>
    {/if}
  </section>

  <section>
    <h2>Цели этапа 3</h2>
    {#if opened}
      <ul class="targets">
        <li class={ok(!!computeLog.clustering && computeLog.clustering.ms <= TARGET3.clusteringMs)}>
          Clustering: {computeLog.clustering ? `${computeLog.clustering.ms} мс на ${computeLog.clustering.work} (алгоритм ${computeLog.clustering.algoMs}), пятен ${computeLog.clustering.regions}` : 'открой Simplify, стиль «кластеры»'} (цель ≤ {TARGET3.clusteringMs})
        </li>
        <li class={ok(!!computeLog.graph && computeLog.graph.ms <= TARGET3.graphMs && progressEvents > 0)}>
          Graph: {computeLog.graph ? `${computeLog.graph.ms} мс на ${computeLog.graph.work} (алгоритм ${computeLog.graph.algoMs}), пятен ${computeLog.graph.regions}, индикатор ${progressEvents ? 'есть' : 'нет'}` : 'стиль «граф»'} (цель ≤ {TARGET3.graphMs} с индикатором)
        </li>
        <li class={ok(!!computeLog.posterize)}>Posterize: {computeLog.posterize ? `${computeLog.posterize.ms} мс` : 'стиль «постер»'}</li>
        <li class={ok(drawSlider.n > 0 && p95(drawSlider.samples) <= TARGET3.drawSliderMs)}>
          Drawing, слайдер Line: {drawSlider.n ? `p95 ${p95(drawSlider.samples)} мс, макс ${drawSlider.max} мс, кадров ${drawSlider.n}` : 'подвигай Line'} (ориентир ≤ {TARGET3.drawSliderMs})
        </li>
        <li class={ok(!!svgInfo)}>SVG: {svgInfo ? `${svgInfo.loops} контуров, ${(svgInfo.bytes / 1024).toFixed(0)} КБ; открой в Illustrator` : 'нажми SVG во вкладке Drawing'}</li>
      </ul>
      <p class="muted">Время включает первое чтение пикселей из GPU; «алгоритм» — только расчёт на CPU.</p>
      {#if computeLog.sketch || computeLog.contours}
        <p class="muted">Первый расчёт Drawing: Sketch {computeLog.sketch?.ms ?? '—'} мс, Contours {computeLog.contours?.ms ?? '—'} мс (при смене Line пересчитывается только порог).</p>
      {/if}
    {:else}
      <p class="muted">Открой фото: цели считаются на рабочей копии, для честного замера нужен образец 12 МП.</p>
    {/if}
  </section>

  <section>
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

  <section>
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

  <section>
    <h2>Сверка GPU и CPU</h2>
    <p class="muted">Рендерит 20 режимов на 4 эталонных фото на GPU и на CPU и сравнивает пиксели (Simplify и Drawing: результат CPU против показа на GPU). Плюс режим «как в оригинале» против порогов Color Study.</p>
    <button class="primary" onclick={runSelftest} disabled={!engine || !!busy}>Запустить сверку</button>
    {#if parity}
      <p class={ok(parity.pass)}>{parity.pass ? 'Совпадает' : 'Есть расхождения'} · {parity.cases.filter((c) => c.pass).length}/{parity.cases.length} · {parity.ms} мс · гистограммы ±{(parity.histogramMaxShareDiff * 100).toFixed(2)}%</p>
      <ul class="compact">
        {#each parity.cases.filter((c) => c.computeMs != null && c.fixture === 'stilllife') as c}
          <li class={ok(c.pass)}>{c.name}: {c.computeMs} мс на 1024×768</li>
        {/each}
        {#each parity.compat as c}
          <li class={ok(c.agreement >= 0.95)}>Как в оригинале, {c.fixture}: {(c.agreement * 100).toFixed(1)}% пикселей</li>
        {/each}
        {#each parity.cases.filter((c) => !c.pass) as c}
          <li class="fail">{c.fixture} · {c.name}: MSE L* {c.mseL}, расхождение {(c.mismatch * 100).toFixed(2)}%, макс {c.maxDiff}</li>
        {/each}
      </ul>
    {/if}
  </section>

  </details>

  <section class="card actions">
    <button class="primary" onclick={shareReport}>Поделиться отчётом</button>
    <button onclick={copyReport}>{copied || 'Копировать JSON'}</button>
    <button onclick={exportPng} disabled={!opened}>PNG рабочей копии</button>
  </section>
  {#if engine}<p class="sub">GPU: {engine.caps.renderer} · MAX_TEXTURE_SIZE {engine.caps.maxTextureSize} · вывод: {engine.caps.present === 'canvas' ? 'canvas в Worker' : 'ImageBitmap'}</p>{/if}
  {#if hint && HINTS[hint]}
    <div class="sheet" role="dialog" aria-label={HINTS[hint][0]}>
      <b>{HINTS[hint][0]}</b>
      <p>{HINTS[hint][1]}</p>
      <button onclick={() => (hint = null)}>Понятно</button>
    </div>
  {/if}
</main>

{#snippet i(key: string)}
  <span class="i" role="button" tabindex="0" aria-label="Что это"
    onclick={(e) => { e.preventDefault(); e.stopPropagation(); hint = hint === key ? null : key; }}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hint = hint === key ? null : key; } }}>i</span>
{/snippet}

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
  .tabs { display: grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 4px; margin-top: 10px; }
  .progress { position: absolute; left: 12px; right: 12px; bottom: 12px; height: 6px; border-radius: 3px; background: rgba(0, 0, 0, 0.25); overflow: hidden; }
  .progress span { display: block; height: 100%; background: var(--accent); transition: width 0.1s; }
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
  .controls .row > span:first-child:not(.dot) { min-width: 92px; color: var(--muted); font-size: 14px; }
  .controls label.row { color: var(--muted); font-size: 14px; }
  .controls label.row b { color: var(--fg); min-width: 26px; }
  .controls input[type='range'] { flex: 1; min-width: 160px; }
  .check { gap: 6px !important; color: var(--fg) !important; }
  .i {
    display: inline-grid; place-items: center; width: 18px; height: 18px; margin-left: 4px; vertical-align: 1px;
    border: 1px solid var(--muted); border-radius: 50%; color: var(--muted); font: italic 600 11px/1 Georgia, serif; cursor: pointer;
  }
  .sheet {
    position: fixed; left: 12px; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); z-index: 10;
    max-width: 640px; margin: 0 auto; padding: 14px; border-radius: 14px;
    background: var(--card); border: 1px solid var(--line); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
  }
  .sheet p { margin: 6px 0 10px; }
  details.common { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 8px; }
  details summary { cursor: pointer; color: var(--muted); font-size: 14px; }
  .diag > section { border-top: 1px solid var(--line); padding: 10px 0 2px; margin-top: 10px; }
  select { font: inherit; font-size: 14px; flex: 1; min-width: 160px; padding: 5px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
  .seg { display: flex; gap: 4px; flex-wrap: wrap; }
  .pairs .row { font-size: 13px; }
  .pairs .weak { color: var(--accent); }
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
