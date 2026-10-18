// Test plan of the Stage 0 bench. Runs on the main thread, but every pixel
// operation is delegated to the engine worker.
import { EngineClient } from './worker-client';
import { RunJournal, crashedSteps } from './journal';
import type { Check, PipelineOptions, PipelineResult, Status } from './types';

export const SAMPLES = {
  probeJpg: 'samples/probe.jpg',
  probePng: 'samples/probe.png',
  probeWebp: 'samples/probe.webp',
  probeHeic: 'samples/probe.heic',
  orient: 'samples/orient6.jpg',
  jpg12: 'samples/synth_12mp.jpg',
  heic12: 'samples/synth_12mp.heic',
  jpg48: 'samples/synth_48mp.jpg',
  heic48: 'samples/synth_48mp.heic',
};

export const DEFAULT_OPTS: PipelineOptions = {
  workLong: 1600,
  fullRes: true,
  tile: 2048,
  overlap: 16,
  levels: 5,
  preview: false,
};

/** Safe limits: nothing in the default run allocates more than one 48 MP bitmap at a time. */
export const LIMITS = {
  canvasSizesWorker: [
    [4096, 4096],
    [4100, 4100],
    [5000, 4000],
    [8064, 6048],
  ] as [number, number][],
  canvasSizesMain: [
    [4096, 4096],
    [4100, 4100],
    [8064, 6048],
  ] as [number, number][],
  pipelineTimeoutMs: 120000,
};

const round = (v: number) => Math.round(v * 10) / 10;
const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const yes = (b: unknown) => (b ? 'да' : 'нет');

export interface RunCallbacks {
  onCheck: (checks: Check[]) => void;
  onProgress: (label: string, done: number, total: number) => void;
}

export interface RunConfig {
  include48: boolean;
  /** run steps that crashed the tab in a previous run */
  forceCrashed: boolean;
}

interface Step {
  id: string;
  label: string;
  run: () => Promise<void>;
}

/** Measures the longest main-thread stall while a worker job runs. */
function jankMonitor() {
  let last = performance.now();
  let max = 0;
  const t = setInterval(() => {
    const n = performance.now();
    max = Math.max(max, n - last - 16);
    last = n;
  }, 16);
  return () => {
    clearInterval(t);
    return Math.max(0, round(max));
  };
}

async function fetchBlob(url: string): Promise<{ blob: Blob; ms: number; fromCache: string }> {
  const t0 = performance.now();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const blob = await r.blob();
  return { blob, ms: round(performance.now() - t0), fromCache: r.headers.get('x-bench-cache') ?? 'network' };
}

export class Runner {
  checks: Check[] = [];
  engine = new EngineClient();
  private cb: RunCallbacks;
  private caps: any = null;

  constructor(cb: RunCallbacks) {
    this.cb = cb;
  }

  add(c: Check) {
    const i = this.checks.findIndex((x) => x.id === c.id);
    if (i >= 0) this.checks[i] = c;
    else this.checks.push(c);
    this.cb.onCheck([...this.checks]);
  }

  async runAll(cfg: RunConfig): Promise<{ runId: string; startedAt: string; durationMs: number }> {
    this.checks = [];
    this.cb.onCheck([]);
    const journal = new RunJournal('run-tests');
    const crashed = crashedSteps();
    const steps = this.plan(cfg);
    const t0 = performance.now();
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      this.cb.onProgress(s.label, i, steps.length);
      // Any step that took the tab down before is skipped, so the run can still finish.
      if (crashed.has(s.id) && !cfg.forceCrashed) {
        this.add({
          id: s.id,
          group: s.id.split('.')[0],
          name: s.label,
          status: 'skip',
          note: 'пропущено: прошлый прогон оборвался на этом шаге (включи «Повторить шаги, на которых был сбой», чтобы проверить снова)',
        });
        continue;
      }
      journal.step(s.id, s.label);
      try {
        await s.run();
      } catch (e) {
        this.add({ id: s.id + '.error', group: 'runner', name: s.label, status: 'fail', note: errMsg(e) });
      }
      journal.stepDone(this.checks);
      // let the page paint between steps
      await new Promise((r) => setTimeout(r, 30));
    }
    this.cb.onProgress('Готово', steps.length, steps.length);
    journal.finish();
    return { runId: journal.runId, startedAt: journal.startedAt, durationMs: Math.round(performance.now() - t0) };
  }

  private plan(cfg: RunConfig): Step[] {
    const steps: Step[] = [
      { id: 'env', label: 'Окружение', run: () => this.env() },
      { id: 'features', label: 'API в главном потоке', run: () => this.features() },
      { id: 'worker', label: 'Worker, OffscreenCanvas, WebGL2', run: () => this.worker() },
      { id: 'bitmap', label: 'createImageBitmap: параметры', run: () => this.bitmapOptions() },
      { id: 'decode', label: 'Декодирование форматов', run: () => this.decodeFormats() },
      { id: 'canvas', label: 'Лимит площади canvas', run: () => this.canvasLimits(cfg.include48) },
      { id: 'storage', label: 'IndexedDB и OPFS', run: () => this.storage() },
      { id: 'sw', label: 'Service Worker и офлайн', run: () => this.serviceWorker() },
      { id: 'memory', label: 'Память', run: () => this.memory() },
      { id: 'perf.jpg12', label: '12 МП JPEG', run: () => this.perf('perf.jpg12', '12 МП JPEG', SAMPLES.jpg12) },
      { id: 'perf.heic12', label: '12 МП HEIC', run: () => this.perf('perf.heic12', '12 МП HEIC', SAMPLES.heic12) },
    ];
    if (cfg.include48) {
      steps.push(
        { id: 'perf.jpg48', label: '48 МП JPEG', run: () => this.perf('perf.jpg48', '48 МП JPEG', SAMPLES.jpg48) },
        { id: 'perf.heic48', label: '48 МП HEIC', run: () => this.perf('perf.heic48', '48 МП HEIC', SAMPLES.heic48) },
      );
    }
    return steps;
  }

  // ---------- steps ----------

  private async env() {
    const nav = navigator as any;
    const standalone =
      nav.standalone === true || matchMedia('(display-mode: standalone)').matches;
    this.add({
      id: 'env.ua',
      group: 'env',
      name: 'Браузер',
      status: 'info',
      value: navigator.userAgent,
    });
    this.add({
      id: 'env.screen',
      group: 'env',
      name: 'Экран',
      status: 'info',
      value: `${screen.width}x${screen.height} @${devicePixelRatio}x`,
    });
    this.add({
      id: 'env.mode',
      group: 'env',
      name: 'Запуск с домашнего экрана',
      status: 'info',
      value: yes(standalone),
    });
    this.add({
      id: 'env.secure',
      group: 'env',
      name: 'Безопасный контекст (HTTPS)',
      status: isSecureContext ? 'pass' : 'fail',
      value: yes(isSecureContext),
    });
    this.add({
      id: 'env.cpu',
      group: 'env',
      name: 'Потоков CPU (hardwareConcurrency)',
      status: 'info',
      value: navigator.hardwareConcurrency ?? 'нет данных',
    });
    this.add({
      id: 'env.coi',
      group: 'env',
      name: 'crossOriginIsolated / SharedArrayBuffer',
      status: 'info',
      value: `${yes(crossOriginIsolated)} / ${yes(typeof SharedArrayBuffer !== 'undefined')}`,
    });
  }

  private async features() {
    const has = (b: boolean) => (b ? 'pass' : 'fail') as Status;
    this.add({ id: 'feat.offscreen', group: 'features', name: 'OffscreenCanvas', status: has(typeof OffscreenCanvas !== 'undefined'), value: yes(typeof OffscreenCanvas !== 'undefined') });
    this.add({ id: 'feat.cib', group: 'features', name: 'createImageBitmap', status: has(typeof createImageBitmap === 'function'), value: yes(typeof createImageBitmap === 'function') });
    this.add({ id: 'feat.imagedecoder', group: 'features', name: 'ImageDecoder (WebCodecs)', status: 'info', value: yes('ImageDecoder' in window) });
    let simd = false;
    try {
      // same probe as wasm-feature-detect: i32.const 0; i8x16.splat; i8x16.popcnt
      simd = WebAssembly.validate(
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
      );
    } catch {}
    this.add({ id: 'feat.wasmsimd', group: 'features', name: 'WebAssembly SIMD', status: 'info', value: yes(simd) });
    // Main-thread WebGL2 for the on-screen viewer
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      this.add({
        id: 'feat.webgl2main',
        group: 'features',
        name: 'WebGL2 в главном потоке',
        status: gl ? 'pass' : 'fail',
        value: gl ? `да, MAX_TEXTURE_SIZE ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}` : 'нет',
      });
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch (e) {
      this.add({ id: 'feat.webgl2main', group: 'features', name: 'WebGL2 в главном потоке', status: 'fail', note: errMsg(e) });
    }
    const gpu = (navigator as any).gpu;
    let gpuNote = 'нет';
    if (gpu) {
      try {
        const a = await gpu.requestAdapter();
        gpuNote = a ? `да, maxTextureDimension2D ${a.limits.maxTextureDimension2D}` : 'navigator.gpu есть, адаптера нет';
      } catch (e) {
        gpuNote = 'ошибка: ' + errMsg(e);
      }
    }
    this.add({ id: 'feat.webgpu', group: 'features', name: 'WebGPU (главный поток)', status: 'info', value: gpuNote });
  }

  private async worker() {
    const t0 = performance.now();
    try {
      await this.engine.call('ping', undefined, 10000);
      this.add({ id: 'worker.start', group: 'worker', name: 'Модульный Web Worker', status: 'pass', value: 'запущен', ms: round(performance.now() - t0) });
    } catch (e) {
      this.add({ id: 'worker.start', group: 'worker', name: 'Модульный Web Worker', status: 'fail', note: this.engine.startError ?? errMsg(e) });
      return;
    }
    const c = (this.caps = await this.engine.call('caps', undefined, 30000));
    this.add({ id: 'worker.offscreen', group: 'worker', name: 'OffscreenCanvas в Worker', status: c.offscreenCanvas ? 'pass' : 'fail', value: yes(c.offscreenCanvas) });
    this.add({ id: 'worker.ctx2d', group: 'worker', name: 'OffscreenCanvas 2D в Worker', status: c.ctx2d ? 'pass' : 'fail', value: yes(c.ctx2d), note: c.errors.ctx2d });
    this.add({
      id: 'worker.webgl2',
      group: 'worker',
      name: 'WebGL2 в Worker',
      status: c.webgl2 ? 'pass' : 'fail',
      value: c.webgl2 ? `да, ${c.gl.renderer}` : 'нет',
      note: c.errors.webgl2,
      ms: c.webgl2InitMs,
    });
    if (c.webgl2) {
      this.add({
        id: 'gl.maxtex',
        group: 'worker',
        name: 'MAX_TEXTURE_SIZE (Worker)',
        status: c.gl.MAX_TEXTURE_SIZE >= 8192 ? 'pass' : 'warn',
        value: c.gl.MAX_TEXTURE_SIZE,
        note: `renderbuffer ${c.gl.MAX_RENDERBUFFER_SIZE}, viewport ${c.gl.MAX_VIEWPORT_DIMS.join('x')}`,
      });
      this.add({ id: 'gl.params', group: 'worker', name: 'Параметры WebGL2', status: 'info', value: c.gl });
      this.add({
        id: 'gl.unpackskip',
        group: 'worker',
        name: 'Загрузка тайла из ImageBitmap (UNPACK_SKIP)',
        status: c.unpackSkipImageBitmap ? 'pass' : 'warn',
        value: yes(c.unpackSkipImageBitmap),
        note: c.unpackSkipImageBitmap ? undefined : `тайлы пойдут через 2D-холст; ${c.errors.unpackSkip ?? 'образец ' + c.unpackSkipSample}`,
      });
    }
    this.add({
      id: 'worker.webgpu',
      group: 'worker',
      name: 'WebGPU в Worker',
      status: 'info',
      value: c.webgpuAdapter ? c.webgpuAdapter : yes(c.webgpu),
      note: c.errors.webgpu,
    });
    this.add({
      id: 'worker.opfssync',
      group: 'storage',
      name: 'OPFS SyncAccessHandle (Worker)',
      status: c.opfsSync ? 'pass' : 'warn',
      value: c.opfsSync ? 'да' : 'нет',
      ms: c.opfsSyncMs4MB,
      note: c.opfsSync ? 'запись+чтение 4 МБ' : c.errors.opfsSync,
    });
  }

  private async bitmapOptions() {
    const { blob } = await fetchBlob(SAMPLES.orient);
    const r = await this.engine.call('bitmapOptions', { orient: blob }, 30000);
    const ok = (k: string) => r[k]?.ok;
    this.add({
      id: 'bitmap.resize',
      group: 'bitmap',
      name: 'resizeWidth/resizeHeight',
      status: r.resizeWH?.honored ? 'pass' : 'fail',
      value: r.resizeWH?.honored ? 'работает' : `не работает (${r.resizeWH?.size ?? r.resizeWH?.error})`,
      note: `только resizeWidth: ${r.resizeWidthOnly?.honored ? 'пропорция сохраняется' : r.resizeWidthOnly?.size ?? r.resizeWidthOnly?.error}`,
    });
    const q = ['pixelated', 'low', 'medium', 'high'].map((k) => `${k}:${ok('resizeQuality_' + k) ? r['resizeQuality_' + k].size : '✗'}`);
    this.add({ id: 'bitmap.quality', group: 'bitmap', name: 'resizeQuality', status: q.every((s) => s.endsWith('16x8')) ? 'pass' : 'warn', value: q.join(' ') });
    const flip = r['imageOrientation_flipY'];
    this.add({
      id: 'bitmap.flipy',
      group: 'bitmap',
      name: "imageOrientation: 'flipY'",
      status: flip?.flipped ? 'pass' : 'warn',
      value: flip?.ok ? (flip.flipped ? 'переворачивает' : 'игнорируется') : flip?.error,
    });
    const none = r['imageOrientation_none'];
    this.add({
      id: 'bitmap.orientnone',
      group: 'bitmap',
      name: "imageOrientation: 'none'",
      status: 'info',
      value: none?.ok ? 'принимается' : `ошибка: ${none?.error}`,
    });
    const ex = r['exif_default'];
    this.add({
      id: 'bitmap.exif',
      group: 'bitmap',
      name: 'EXIF-поворот JPEG (по умолчанию)',
      status: ex?.rotated ? 'pass' : 'warn',
      value: ex?.ok ? (ex.rotated ? 'применяется' : `не применяется (${ex.size})`) : ex?.error,
      note: `from-image: ${r['exif_from-image']?.ok ? (r['exif_from-image'].rotated ? 'поворот' : 'без поворота') : r['exif_from-image']?.error}; none: ${r['exif_none']?.ok ? (r['exif_none'].rotated ? 'поворот' : 'без поворота') : r['exif_none']?.error}`,
    });
    const pa = ['none', 'premultiply', 'default'].map((k) => `${k}:${ok('premultiplyAlpha_' + k) ? '✓' : '✗'}`);
    const cs = ['none', 'default'].map((k) => `${k}:${ok('colorSpaceConversion_' + k) ? '✓' : '✗'}`);
    this.add({ id: 'bitmap.misc', group: 'bitmap', name: 'premultiplyAlpha / colorSpaceConversion', status: 'info', value: `${pa.join(' ')} | ${cs.join(' ')}` });
    this.add({ id: 'bitmap.raw', group: 'bitmap', name: 'createImageBitmap: сырые результаты', status: 'info', value: r });
  }

  private async decodeFormats() {
    const formats: [string, string][] = [
      ['JPEG', SAMPLES.probeJpg],
      ['PNG', SAMPLES.probePng],
      ['WebP', SAMPLES.probeWebp],
      ['HEIC', SAMPLES.probeHeic],
    ];
    for (const [name, url] of formats) {
      let blob: Blob;
      try {
        blob = (await fetchBlob(url)).blob;
      } catch (e) {
        this.add({ id: 'decode.' + name, group: 'decode', name: `Декодирование ${name}`, status: 'skip', note: errMsg(e) });
        continue;
      }
      const res: string[] = [];
      let workerOk = false;
      let ms: number | undefined;
      try {
        const r = await this.engine.call('decode', { blob }, 20000);
        workerOk = r.width === 640 && r.height === 480;
        ms = r.ms;
        res.push(`Worker: ${workerOk ? '✓' : `${r.width}x${r.height}`}`);
      } catch (e) {
        res.push(`Worker: ✗ ${errMsg(e)}`);
      }
      try {
        const b = await createImageBitmap(blob);
        res.push(`главный createImageBitmap: ✓`);
        b.close();
      } catch (e) {
        res.push(`главный createImageBitmap: ✗ ${errMsg(e)}`);
      }
      const url2 = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url2;
        await img.decode();
        res.push(`<img>: ✓`);
      } catch (e) {
        res.push(`<img>: ✗`);
      } finally {
        URL.revokeObjectURL(url2);
      }
      this.add({
        id: 'decode.' + name,
        group: 'decode',
        name: `Декодирование ${name}`,
        status: workerOk ? 'pass' : name === 'WebP' ? 'warn' : 'fail',
        value: workerOk ? 'да' : 'нет',
        ms,
        note: res.join('; '),
      });
    }
  }

  private async canvasLimits(include48: boolean) {
    const sizes = LIMITS.canvasSizesWorker.filter(([w, h]) => include48 || w * h < 30e6);
    try {
      const r: any[] = await this.engine.call('canvasLimit', { sizes }, 60000);
      for (const x of r) {
        this.add({
          id: 'canvas.worker.' + x.size,
          group: 'canvas',
          name: `OffscreenCanvas ${x.size} (${x.mp} МП)`,
          status: x.ok ? 'pass' : 'warn',
          value: x.ok ? 'работает' : 'не работает',
          ms: x.ms,
          note: x.error,
        });
      }
    } catch (e) {
      this.add({ id: 'canvas.worker', group: 'canvas', name: 'OffscreenCanvas: лимит', status: 'fail', note: errMsg(e) });
    }
    for (const [w, h] of LIMITS.canvasSizesMain.filter(([w, h]) => include48 || w * h < 30e6)) {
      const c = document.createElement('canvas');
      const id = `canvas.main.${w}x${h}`;
      try {
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('getContext returned null');
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(w - 2, h - 2, 2, 2);
        const d = ctx.getImageData(w - 1, h - 1, 1, 1).data;
        const ok = d[0] === 255 && d[1] === 0;
        this.add({ id, group: 'canvas', name: `<canvas> ${w}x${h} (${round((w * h) / 1e6)} МП)`, status: ok ? 'pass' : 'warn', value: ok ? 'работает' : 'не работает' });
      } catch (e) {
        this.add({ id, group: 'canvas', name: `<canvas> ${w}x${h}`, status: 'warn', value: 'не работает', note: errMsg(e) });
      } finally {
        c.width = c.height = 0;
      }
    }
  }

  private async storage() {
    // IndexedDB: write and read back a 1 MB blob
    try {
      const t0 = performance.now();
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('vishar-bench', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const data = new Blob([new Uint8Array(1024 * 1024).fill(7)]);
      await new Promise<void>((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(data, 'probe');
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      const back = await new Promise<Blob>((res, rej) => {
        const tx = db.transaction('kv', 'readonly');
        const r = tx.objectStore('kv').get('probe');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const ok = back instanceof Blob && back.size === data.size;
      await new Promise<void>((res) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete('probe');
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      });
      db.close();
      this.add({ id: 'storage.idb', group: 'storage', name: 'IndexedDB (Blob 1 МБ)', status: ok ? 'pass' : 'fail', value: yes(ok), ms: round(performance.now() - t0) });
    } catch (e) {
      this.add({ id: 'storage.idb', group: 'storage', name: 'IndexedDB (Blob 1 МБ)', status: 'fail', note: errMsg(e) });
    }
    // OPFS from the main thread
    try {
      const t0 = performance.now();
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle('bench-main.txt', { create: true });
      let how = 'createWritable';
      if ('createWritable' in fh) {
        const w = await (fh as any).createWritable();
        await w.write('vishar');
        await w.close();
      } else how = 'нет createWritable';
      const text = how === 'createWritable' ? await (await fh.getFile()).text() : '';
      await root.removeEntry('bench-main.txt');
      this.add({
        id: 'storage.opfs',
        group: 'storage',
        name: 'OPFS (главный поток)',
        status: text === 'vishar' ? 'pass' : 'warn',
        value: text === 'vishar' ? 'да' : 'частично',
        note: how,
        ms: round(performance.now() - t0),
      });
    } catch (e) {
      this.add({ id: 'storage.opfs', group: 'storage', name: 'OPFS (главный поток)', status: 'fail', note: errMsg(e) });
    }
    try {
      const est = await navigator.storage.estimate();
      const persisted = await navigator.storage.persisted?.();
      this.add({
        id: 'storage.estimate',
        group: 'storage',
        name: 'Квота хранилища',
        status: 'info',
        value: `использовано ${round((est.usage ?? 0) / 1048576)} МБ из ${round((est.quota ?? 0) / 1048576)} МБ`,
        note: `persisted: ${yes(persisted)}`,
      });
    } catch (e) {
      this.add({ id: 'storage.estimate', group: 'storage', name: 'Квота хранилища', status: 'warn', note: errMsg(e) });
    }
  }

  private async serviceWorker() {
    if (!('serviceWorker' in navigator)) {
      this.add({ id: 'sw.support', group: 'sw', name: 'Service Worker', status: 'fail', value: 'не поддерживается' });
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration();
    const active = reg?.active?.state ?? 'нет';
    this.add({ id: 'sw.reg', group: 'sw', name: 'Service Worker зарегистрирован', status: reg?.active ? 'pass' : 'warn', value: active });
    const controlled = !!navigator.serviceWorker.controller;
    this.add({
      id: 'sw.controlled',
      group: 'sw',
      name: 'Страница под управлением SW',
      status: controlled ? 'pass' : 'warn',
      value: yes(controlled),
      note: controlled ? undefined : 'обычно появляется со второго открытия страницы',
    });
    try {
      const keys = await caches.keys();
      let entries = 0;
      for (const k of keys) entries += (await (await caches.open(k)).keys()).length;
      this.add({ id: 'sw.cache', group: 'sw', name: 'Cache Storage', status: entries > 0 ? 'pass' : 'warn', value: `${keys.length} кэша, ${entries} записей` });
    } catch (e) {
      this.add({ id: 'sw.cache', group: 'sw', name: 'Cache Storage', status: 'fail', note: errMsg(e) });
    }
    // Ask the SW to answer strictly from cache: this is what an offline launch relies on.
    if (controlled) {
      try {
        const r = await fetch('./?sw-cache-only=1', { cache: 'no-store' });
        const ok = r.ok && r.headers.get('x-bench-cache') === 'hit';
        this.add({
          id: 'sw.offlineshell',
          group: 'sw',
          name: 'Оболочка отдаётся из кэша без сети',
          status: ok ? 'pass' : 'fail',
          value: yes(ok),
        });
      } catch (e) {
        this.add({ id: 'sw.offlineshell', group: 'sw', name: 'Оболочка отдаётся из кэша без сети', status: 'fail', note: errMsg(e) });
      }
    }
    const offlineNow = !navigator.onLine;
    this.add({
      id: 'sw.offlinelaunch',
      group: 'sw',
      name: 'Офлайн-запуск',
      status: offlineNow && controlled ? 'pass' : 'info',
      value: offlineNow ? (controlled ? 'страница открылась без сети' : 'нет сети, но SW не управляет страницей') : 'сеть есть, офлайн не проверялся',
      note: offlineNow ? undefined : 'для проверки: включи авиарежим, открой стенд с домашнего экрана и снова нажми Run Tests',
    });
  }

  private async memory() {
    const pm = (performance as any).memory;
    this.add({
      id: 'mem.heap',
      group: 'memory',
      name: 'performance.memory (JS heap)',
      status: 'info',
      value: pm
        ? `used ${round(pm.usedJSHeapSize / 1048576)} МБ, limit ${round(pm.jsHeapSizeLimit / 1048576)} МБ`
        : 'недоступно (Safari не отдаёт)',
    });
    this.add({ id: 'mem.device', group: 'memory', name: 'navigator.deviceMemory', status: 'info', value: (navigator as any).deviceMemory ?? 'недоступно' });
    const uasm = (performance as any).measureUserAgentSpecificMemory;
    let v = 'недоступно';
    if (uasm && crossOriginIsolated) {
      try {
        const m = await uasm.call(performance);
        v = `${round(m.bytes / 1048576)} МБ`;
      } catch (e) {
        v = 'ошибка: ' + errMsg(e);
      }
    } else if (uasm) v = 'есть, но нужен crossOriginIsolated';
    this.add({ id: 'mem.uasm', group: 'memory', name: 'measureUserAgentSpecificMemory', status: 'info', value: v });
  }

  async perf(id: string, label: string, url: string, opts: PipelineOptions = DEFAULT_OPTS) {
    let blob: Blob;
    let fetchMs: number;
    let fromCache: string;
    try {
      ({ blob, ms: fetchMs, fromCache } = await fetchBlob(url));
    } catch (e) {
      const note = navigator.onLine
        ? errMsg(e)
        : 'образец не скачан в этой копии стенда: у иконки на экране «Домой» своё хранилище, открой её один раз с сетью и нажми Run Tests';
      this.add({ id, group: 'perf', name: label, status: 'skip', note });
      return;
    }
    await this.pipeline(id, label, blob, opts, { fetchMs, fetchSource: fromCache });
  }

  async pipeline(
    id: string,
    label: string,
    blob: Blob,
    opts: PipelineOptions,
    extra: Record<string, number | string> = {},
  ): Promise<PipelineResult | null> {
    const stopJank = jankMonitor();
    const t0 = performance.now();
    let r: PipelineResult;
    try {
      r = await this.engine.call('pipeline', { blob, label, opts }, LIMITS.pipelineTimeoutMs);
    } catch (e) {
      stopJank();
      this.add({ id, group: 'perf', name: label, status: 'fail', note: errMsg(e) });
      return null;
    }
    Object.assign(r.steps, extra);
    r.steps.totalMs = round(performance.now() - t0);
    r.steps.mainThreadMaxStallMs = stopJank();
    const s = r.steps;
    const parts = [
      s.decodeFullMs !== undefined && `декод ${s.decodeFullMs}`,
      s.resizeFromBitmapMs !== undefined && `→${s.workSize} ${s.resizeFromBitmapMs}`,
      s.decodeResizeMs !== undefined && `декод сразу в ${s.workSize} ${s.decodeResizeMs}`,
      s.gpuWorkWarmMs !== undefined && `GPU Values ${s.gpuWorkColdMs}/${s.gpuWorkWarmMs}`,
      s.cpuHistKmeansMs !== undefined && `CPU k-means ${s.cpuGetImageDataMs}+${s.cpuHistKmeansMs}`,
      s.tiledMs !== undefined && `тайлы ${s.tiles}×${s.tileSize} ${s.tiledMs} (${s.tileMethod})`,
      `пауза UI ${s.mainThreadMaxStallMs}`,
    ].filter(Boolean);
    const resizeOk = s.resizeFromBitmapHonored !== false && s.decodeResizeHonored !== false;
    this.add({
      id,
      group: 'perf',
      name: label + (r.width ? ` ${r.width}x${r.height}` : ''),
      status: r.errors.length ? (s.decodeFullMs === undefined ? 'fail' : 'warn') : resizeOk ? 'pass' : 'warn',
      ms: s.totalMs as number,
      note: parts.join(', ') + ' мс' + (r.errors.length ? '; ошибки: ' + r.errors.join('; ') : ''),
      value: { ...s, bytes: r.bytes, type: r.type, megapixels: r.megapixels },
    });
    return r;
  }
}
