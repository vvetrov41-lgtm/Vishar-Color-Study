// Engine Worker: decoding, the working copy, GPU passes and histograms.
// The main thread only sends view states and receives numbers (or a frame).

import * as Comlink from 'comlink';
import { srgbToLab, luma601 } from '../core/color';
import { colorInfo, type Lab } from '../core/colorinfo';
import { deltaHistogram, matchedShare } from '../core/highlight';
import { DrawingCache, lightness, type DrawingResult } from '../core/drawing';
import { DEFAULT_PALETTE, extractPalette, meanRgb, sampleGrid, square, type Grid, type PaletteParams } from '../core/palette';
import { simplify, type SimplifyParams, type SimplifyResult } from '../core/simplify';
import { maskToSvg } from '../core/vector';
import { contrastMap, contrastSimplify } from '../core/contrast';
import { stencilPdf } from '../core/pdf';
import { focusOn, greyTones, PHOTO_SHIFT, pigmentMap, pigmentSimplify } from '../core/pigments';
import { calibrateImage, calOf, isNeutral, onSkin, skinRgb, skinView } from '../core/skin';
import { checkLines, designInk, spreadPreview, viewFromDistance, type TattooParams } from '../core/tattoo';
import { ORIGINAL_VALUES_9, levelAgreement } from '../core/compat';
import { histogramsFromLab8, type Histograms } from '../core/histogram';
import { fitLongSide, HEADER_BYTES, parseImageInfo } from '../core/imageinfo';
import { DEFAULT_VIEW, planView, renderReference, type Smoothing, type TattooStats, type ViewPlan, type ViewState } from '../core/view';
import { levelOf, valuesThresholds } from '../core/values';
import { Renderer, type ScreenRect } from '../gpu/renderer';
import type { Caps, CompatCase, OpenOptions, OpenResult, PaletteResult, ParityCase, ParityReport, PickResult, StencilExport, SvgExport, ViewResult } from '../types';

const now = () => performance.now();
const round1 = (v: number) => Math.round(v * 10) / 10;

interface Analysis { lab8: Uint8Array; hist: Histograms }

export const LADDER = [1600, 1200, 800];
/** Loupe size in working-copy pixels. */
export const LOUPE = 21;

class Engine {
  private r: Renderer | null = null;
  private present: Caps['present'] = 'canvas';
  private analysis = new Map<Smoothing, Analysis>();
  private state: ViewState = DEFAULT_VIEW;
  private plan: ViewPlan | null = null;
  private screen = { cssW: 1, cssH: 1, dpr: 1, bg: [128, 128, 128] as [number, number, number] };
  // Per photo, built on first use: unsmoothed pixels for the pipette and palette, the grid
  // sample, and the ΔE histogram of the current Highlight target.
  // Keyed by smoothing level: the pipette and palette use 0, Highlight the active level.
  private px = new Map<Smoothing, Uint8Array>();
  private grid = new Map<Smoothing, Grid>();
  private dHist: { key: string; h: Float64Array } | null = null;
  // Simplify / Drawing: the last result per kind, the per-smoothing drawing caches, and the key
  // of what is in the GPU result texture now.
  private simplified: { key: string; res: SimplifyResult; ms: number } | null = null;
  private drawn: { key: string; res: DrawingResult; ms: number } | null = null;
  private drawCache = new Map<Smoothing, DrawingCache>();
  // Tattoo tools: the current result, plus the simplification the contrast map is built from.
  private tat: { key: string; rgba: Uint8ClampedArray; stats: TattooStats; ink?: Uint8Array } | null = null;
  private tatSeg: { key: string; res: SimplifyResult } | null = null;
  // The design calibrated for the chosen skin tone, per smoothing level (only the current calibration).
  private calibrated = new Map<Smoothing, { key: string; px: Uint8Array; lab8: Uint8Array }>();
  /** Pigments before a focus is applied: the per-pixel index lets a tap find its pigment. */
  private pig: { key: string; rgba: Uint8ClampedArray; index: Int8Array; index2?: Int8Array; stats: NonNullable<TattooStats['pigments']>; ms: number } | null = null;
  private uploaded = '';
  private progress: ((share: number, stage: string) => void) | null = null;

  private reset() {
    this.analysis.clear();
    this.plan = null;
    this.px.clear();
    this.grid.clear();
    this.dHist = null;
    this.simplified = this.drawn = null;
    this.drawCache.clear();
    this.tat = this.tatSeg = this.pig = null;
    this.calibrated.clear();
    this.uploaded = '';
  }

  setProgress(cb: (share: number, stage: string) => void) {
    this.progress = cb;
  }

  /**
   * Simplify or Drawing result for a state, computed on the CPU if the parameters changed.
   * Returns the pixels, the key and the compute time (0 when cached).
   */
  private computed(state: ViewState): { rgba: Uint8ClampedArray; key: string; ms: number } {
    const r = this.renderer, lv = state.smoothing;
    if (state.view === 'simplify') {
      const key = `s:${lv}:${JSON.stringify(state.simplify)}`;
      if (this.simplified?.key !== key) {
        const t0 = now();
        const res = simplify({
          w: r.w, h: r.h, px: this.pixels(lv), lab8: this.analyzed(lv).a.lab8,
          px0: this.pixels(0), lab0: this.analyzed(0).a.lab8,
        }, state.simplify, (s, stage) => this.progress?.(s, stage));
        this.simplified = { key, res, ms: now() - t0 };
        return { rgba: res.rgba, key, ms: this.simplified.ms };
      }
      return { rgba: this.simplified.res.rgba, key, ms: 0 };
    }
    if (state.view === 'tattoo') return this.tattoo(state);
    return this.drawing(state);
  }

  private drawing(state: ViewState): { rgba: Uint8ClampedArray; key: string; ms: number } {
    const r = this.renderer, lv = state.smoothing, key = `d:${lv}:${JSON.stringify(state.drawing)}`;
    if (this.drawn?.key !== key) {
      const t0 = now();
      let c = this.drawCache.get(lv);
      if (!c) this.drawCache.set(lv, (c = new DrawingCache(lightness(this.analyzed(lv).a.lab8, r.w * r.h), r.w, r.h)));
      const res = c.render(state.drawing);
      this.drawn = { key, res, ms: now() - t0 };
      return { rgba: res.rgba, key, ms: this.drawn.ms };
    }
    return { rgba: this.drawn.res.rgba, key, ms: 0 };
  }

  /** Key of the calibrated version the tattoo tools work with; '' = the design as it is. */
  private calKey(t: TattooParams): string {
    const cal = calOf(t.skin);
    return t.skin.use && !isNeutral(cal) ? JSON.stringify(cal) : '';
  }

  /** Pixels and analysis the tattoo tools read: the version calibrated for the chosen skin when «use» is on. */
  private design(lv: Smoothing, t: TattooParams): { px: Uint8Array; lab8: Uint8Array } {
    const key = this.calKey(t);
    if (!key) return { px: this.pixels(lv), lab8: this.analyzed(lv).a.lab8 };
    let c = this.calibrated.get(lv);
    if (c?.key !== key) this.calibrated.set(lv, (c = { key, ...calibrateImage(this.pixels(lv), this.renderer.w * this.renderer.h, calOf(t.skin)) }));
    return c;
  }

  /** Current tattoo tool (plan 5.1–5.4); only the parameters of that tool are in the key. */
  private tattoo(state: ViewState): { rgba: Uint8ClampedArray; key: string; ms: number } {
    const r = this.renderer, lv = state.smoothing, t = state.tattoo, w = r.w, h = r.h, n = w * h;
    // Pigments are shown on the chosen skin while working with its calibrated version.
    const onTone = t.skin.use && t.tool === 'pigments' ? skinRgb(t.skin) : null;
    const srcKey = t.tool === 'skin' ? '' : `${this.calKey(t)}:${onTone ?? ''}`;
    const own = t.tool === 'skin' ? t.skin : t.tool === 'contrast' ? t.contrast : t.tool === 'pigments' ? t.pigments : t.tool === 'lines' ? [t.lines, t.lines.source === 'drawing' ? state.drawing : null]
      : t.tool === 'distance' ? t.distance : t.tool === 'spread' ? t.spread : null;
    const key = `t:${lv}:${t.tool}:${t.widthCm}:${srcKey}:${JSON.stringify(own)}`;
    if (this.tat?.key === key) return { rgba: this.tat.rgba, key, ms: 0 };
    const t0 = now(), stats: TattooStats = { tool: t.tool, ms: 0 };
    let rgba: Uint8ClampedArray, ink: Uint8Array | undefined;
    const segment = (sp: SimplifyParams): SimplifyResult => {
      const skey = `${lv}:${this.calKey(t)}:${JSON.stringify(sp)}`;
      if (this.tatSeg?.key !== skey) {
        const d = this.design(lv, t), d0 = this.design(0, t);
        const res = simplify({ w, h, px: d.px, lab8: d.lab8, px0: d0.px, lab0: d0.lab8 }, sp, (s, stage) => this.progress?.(s * 0.9, stage));
        this.tatSeg = { key: skey, res };
      }
      return this.tatSeg.res;
    };
    if (t.tool === 'pigments') {
      const pg = t.pigments, { focus: _f, ...base } = pg, pkey = `${lv}:${this.calKey(t)}:${JSON.stringify(pg.mode === 'bg' ? [base.source, base.details, base.tonesL, base.blend] : { ...base, series: 0, tonesL: 0 })}`;
      if (this.pig?.key !== pkey) {
        const tp = now(), photo = pg.source === 'photo';
        const src = photo ? this.design(lv, t).px : segment(pigmentSimplify(pg)).rgba, shift = photo ? PHOTO_SHIFT : 0;
        const colors = photo ? 0 : this.tatSeg!.res.colors;
        if (pg.mode === 'bg') {
          const res = greyTones(src, w, h, pg.tonesL, shift, pg.blend);
          this.pig = { key: pkey, rgba: res.rgba, index: res.index, stats: { tones: [...pg.tonesL], shares: res.shares, skinShare: res.skinShare, colors }, ms: now() - tp };
        } else {
          const res = pigmentMap(src, w, h, pg, shift);
          this.pig = { key: pkey, rgba: res.rgba, index: res.index, index2: res.index2, stats: { inks: res.inks, skinShare: res.skinShare, misses: res.misses, meanDE: res.meanDE, colors }, ms: now() - tp };
        }
      }
      rgba = pg.focus === -1 ? this.pig.rgba : focusOn(this.pig.rgba, this.pig.index, pg.focus, this.pig.index2);
      if (onTone) rgba = onSkin(rgba, n, onTone);
      stats.pigments = this.pig.stats;
    } else if (t.tool === 'design') {
      // The design as it is (taken into work, or its skin version): nothing simplified.
      rgba = new Uint8ClampedArray(this.design(lv, t).px);
    } else if (t.tool === 'contrast') {
      segment(contrastSimplify(t.contrast));
      const c = contrastMap(this.tatSeg!.res.rgba, w, h, t.contrast);
      rgba = c.rgba;
      stats.contrast = { pairs: c.pairs, weakPairs: c.weakPairs, weakShare: c.weakShare, colors: this.tatSeg!.res.colors };
    } else if (t.tool === 'lines') {
      if (t.lines.source === 'drawing') {
        this.drawing(state);
        const inkF = this.drawn!.res.ink;
        ink = new Uint8Array(n);
        for (let i = 0; i < n; i++) ink[i] = inkF[i] > 0.5 ? 1 : 0;
      } else ink = designInk(this.design(lv, t).lab8, n, t.lines.inkL);
      const res = checkLines(ink, w, h, t.widthCm, t.lines);
      rgba = res.rgba;
      stats.lines = { pxPerMm: res.pxPerMm, inkShare: res.inkShare, thinShare: res.thinShare, gapShare: res.gapShare, lowResolution: res.lowResolution };
    } else if (t.tool === 'distance') {
      const res = viewFromDistance(this.design(lv, t).px, w, h, t.widthCm, t.distance);
      rgba = res.rgba;
      stats.distance = { blurPx: res.blurPx, iou: res.iou, figure: res.figure };
    } else if (t.tool === 'spread') {
      const res = spreadPreview(this.design(lv, t).px, w, h, t.widthCm, t.spread);
      rgba = res.rgba;
      stats.spread = { spreadPx: res.spreadPx, blurPx: res.blurPx };
    } else rgba = skinView(this.pixels(lv), w, h, t.skin);
    this.progress?.(1, 'done');
    const ms = now() - t0;
    stats.ms = round1(ms);
    this.tat = { key, rgba, stats, ink };
    return { rgba, key, ms };
  }

  /** Makes the GPU result texture hold the state's Simplify / Drawing; returns compute and upload ms. */
  private ensureResult(state: ViewState): { computeMs: number; uploadMs: number } {
    const { rgba, key, ms } = this.computed(state);
    if (this.uploaded === key) return { computeMs: ms, uploadMs: 0 };
    const t0 = now();
    this.renderer.setResult(rgba);
    this.uploaded = key;
    return { computeMs: ms, uploadMs: now() - t0 };
  }

  private pixels(level: Smoothing = 0): Uint8Array {
    let px = this.px.get(level);
    if (!px) this.px.set(level, (px = this.renderer.readSource(level)));
    return px;
  }

  private sample(level: Smoothing = 0): Grid {
    const r = this.renderer;
    let g = this.grid.get(level);
    if (!g) this.grid.set(level, (g = sampleGrid(this.pixels(level), r.w, r.h)));
    return g;
  }

  /** ΔE histogram on the same smoothing level the Highlight mask is rendered from. */
  private deltaHist(target: Lab, level: Smoothing): Float64Array {
    const key = `${level}:${target.join(',')}`;
    if (this.dHist?.key !== key) this.dHist = { key, h: deltaHistogram(this.sample(level), target) };
    return this.dHist.h;
  }

  init(canvas?: OffscreenCanvas): Caps {
    this.present = canvas ? 'canvas' : 'bitmap';
    this.r = new Renderer(canvas ?? new OffscreenCanvas(1, 1));
    const gl = this.r.gl, dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      present: this.present,
      maxTextureSize: this.r.maxTextureSize,
      renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
    };
  }

  private get renderer(): Renderer {
    if (!this.r) throw new Error('engine not initialised');
    if (this.r.lost || this.r.gl.isContextLost()) throw new Error('WebGL-контекст потерян, перезагрузи страницу');
    return this.r;
  }

  async open(blob: Blob, opts: OpenOptions = {}): Promise<OpenResult> {
    const r = this.renderer, t: Record<string, number> = {}, warnings: string[] = [];
    let t0 = now();
    const info = parseImageInfo(new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()));
    let sizeFrom: 'header' | 'probe' = 'header';
    let { width: w, height: h } = info;
    t.header = now() - t0;
    if (!w || !h) {
      // Size unknown from the header: a tiny decode gives the displayed aspect ratio.
      t0 = now();
      const probe = await createImageBitmap(blob, { resizeWidth: 64, resizeQuality: 'pixelated', imageOrientation: 'from-image' });
      w = probe.width;
      h = probe.height;
      probe.close();
      sizeFrom = 'probe';
      t.probe = now() - t0;
    }
    const budget = (opts.budgetMB ?? 512) * 1024 * 1024;
    const ladder = [opts.workLong ?? LADDER[0], ...LADDER.filter((v) => v < (opts.workLong ?? LADDER[0]))];
    let bitmap: ImageBitmap | null = null, step = 0, method: OpenResult['method'] = 'decode-to-size';
    t0 = now();
    for (; step < ladder.length && !bitmap; step++) {
      const long = ladder[step];
      const [tw, th] = sizeFrom === 'probe'
        ? (w >= h ? [long, Math.round((long * h) / w)] : [Math.round((long * w) / h), long])
        : fitLongSide(w, h, long);
      try {
        const b = await createImageBitmap(blob, {
          resizeWidth: tw, resizeHeight: th, resizeQuality: 'high', imageOrientation: 'from-image', premultiplyAlpha: 'none',
        });
        if (b.width === tw && b.height === th) { bitmap = b; break; }
        warnings.push(`decode-to-size вернул ${b.width}×${b.height} вместо ${tw}×${th}`);
        b.close();
      } catch (e) {
        warnings.push(`decode-to-size ${tw}×${th}: ${(e as Error).message}`);
      }
      // Fallback: one full decode, downscale on a canvas, free the full frame at once.
      // Unknown source size means the decode cannot be budgeted: skip it and go down the ladder.
      if (sizeFrom === 'probe' || w * h * 4 > budget) {
        warnings.push(sizeFrom === 'probe'
          ? 'размер исходника неизвестен, полное декодирование пропускаю'
          : `полное декодирование ${w}×${h} не влезает в бюджет ${opts.budgetMB ?? 512} МБ, пропускаю`);
        continue;
      }
      let full: ImageBitmap | null = null;
      try {
        full = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
        const c = new OffscreenCanvas(tw, th), ctx = c.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(full, 0, 0, tw, th);
        bitmap = c.transferToImageBitmap();
        method = 'full-decode+downscale';
        break;
      } catch (e) {
        warnings.push(`полное декодирование: ${(e as Error).message}`);
      } finally {
        full?.close();
      }
    }
    if (!bitmap) throw new Error('не удалось декодировать фото: ' + warnings.join('; '));
    t.decode = now() - t0;
    t0 = now();
    r.setSource(bitmap);
    const work = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    this.reset();
    t.upload = now() - t0;
    for (const k in t) t[k] = round1(t[k]);
    return { info: { ...info, width: w, height: h, sizeFrom }, work, step, method, warnings, timings: t };
  }

  private analyzed(level: Smoothing): { a: Analysis; ms: number } {
    const hit = this.analysis.get(level);
    if (hit) return { a: hit, ms: 0 };
    const t0 = now(), lab8 = this.renderer.analyze(level), a = { lab8, hist: histogramsFromLab8(lab8) };
    this.analysis.set(level, a);
    return { a, ms: now() - t0 };
  }

  /** Image rect inside the canvas, 0..1 units, letterboxed. */
  private rect(): ScreenRect {
    const r = this.renderer, cw = r.canvas.width, ch = r.canvas.height;
    const s = Math.min(cw / r.w, ch / r.h), w = (r.w * s) / cw, h = (r.h * s) / ch;
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }

  resize(cssW: number, cssH: number, dpr: number, bg?: [number, number, number]) {
    this.screen = { cssW, cssH, dpr, bg: bg ?? this.screen.bg };
    const r = this.renderer, cap = Math.min(4096, r.maxTextureSize);
    r.canvas.width = Math.max(1, Math.min(cap, Math.round(cssW * dpr)));
    r.canvas.height = Math.max(1, Math.min(cap, Math.round(cssH * dpr)));
    return this.r && this.r.w ? this.setView(this.state) : null;
  }

  setView(state: ViewState): ViewResult {
    const r = this.renderer, t0 = now();
    this.state = state;
    const { a, ms: analyzeMs } = this.analyzed(state.smoothing);
    const t1 = now();
    const { plan, stats } = planView(state, a.hist);
    this.plan = plan;
    let computeMs = 0, uploadMs = 0;
    if (plan.view === 5) {
      ({ computeMs, uploadMs } = this.ensureResult(state));
      if (state.view === 'simplify' && this.simplified) {
        const s = this.simplified.res;
        stats.simplify = { regions: s.regions, colors: s.colors, inkShare: Math.round(s.inkShare * 1e4) / 1e4, ms: s.ms };
      } else if (state.view === 'tattoo' && this.tat) stats.tattoo = this.tat.stats;
      else if (this.drawn) stats.drawing = { inkShare: Math.round(this.drawn.res.inkShare * 1e4) / 1e4 };
    }
    const t2 = now();
    r.renderScreen(plan, state.smoothing, this.rect(), this.screen.bg);
    r.finish();
    const t3 = now();
    let hist: ArrayLike<number> = state.view === 'temperature' ? a.hist.warmth : a.hist[state.view === 'notan' ? state.notan.scale : state.values.scale];
    let histMs = 0;
    if (state.view === 'highlight') {
      const tg = state.highlight.target, th = now();
      hist = tg ? this.deltaHist(tg, state.smoothing) : [];
      histMs = now() - th;
      stats.highlight = { share: tg ? Math.round(matchedShare(hist, state.highlight.tolerance) * 1e4) / 1e4 : 0 };
    }
    const t4 = now();
    const res: ViewResult = {
      stats,
      hist: Array.from(hist),
      timings: {
        analyzeMs: round1(analyzeMs), planMs: round1(t2 - t1 + t4 - t3 - computeMs - uploadMs), renderMs: round1(t3 - t2), totalMs: round1(t4 - t0),
        histMs: round1(histMs), computeMs: round1(computeMs), uploadMs: round1(uploadMs),
      },
      rect: this.rect(),
      work: { width: r.w, height: r.h },
    };
    if (this.present === 'bitmap') {
      res.frame = r.canvas.transferToImageBitmap();
      return Comlink.transfer(res, [res.frame]);
    }
    return res;
  }

  /** Values level under a point of the canvas (CSS px), −1 outside the image. */
  pick(x: number, y: number): number {
    const r = this.renderer, rect = this.rect();
    const u = (x / this.screen.cssW - rect.x) / rect.w, v = (y / this.screen.cssH - rect.y) / rect.h;
    if (u < 0 || v < 0 || u >= 1 || v >= 1 || !this.plan || this.state.view !== 'values') return -1;
    const a = this.analysis.get(this.state.smoothing);
    if (!a) return -1;
    const i = (Math.floor(v * r.h) * r.w + Math.floor(u * r.w)) * 4;
    const tone = this.plan.scale === 1 ? a.lab8[i + 3] : a.lab8[i];
    return levelOf(tone, this.plan.thresholds);
  }

  /** Pigment or tone under (u, v), 0..1 of the working copy: its index, −2 = skin, null = none shown. */
  pickPigment(u: number, v: number): number | null {
    const r = this.renderer;
    if (u < 0 || v < 0 || u >= 1 || v >= 1 || this.state.view !== 'tattoo' || this.state.tattoo.tool !== 'pigments' || !this.pig) return null;
    const k = this.pig.index[Math.floor(v * r.h) * r.w + Math.floor(u * r.w)];
    return k < 0 ? -2 : k;
  }

  /** Palette of the unsmoothed working copy. */
  palette(params: PaletteParams = DEFAULT_PALETTE): PaletteResult {
    const t0 = now(), px = this.pixels(), t1 = now(), g = this.sample(), t2 = now(), p = extractPalette(px, g, params);
    return { ...p, totalMs: Math.round(now() - t0), readMs: Math.round(t1 - t0), gridMs: Math.round(t2 - t1) };
  }

  /**
   * Pipette at (u, v), 0..1 of the working copy: size×size average in linear RGB on the
   * unsmoothed copy, with the colour card and a loupe patch.
   */
  pickColor(u: number, v: number, size: number): PickResult | null {
    const r = this.renderer, t0 = now();
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return null;
    // In Тату the pipette reads the design the tools work on (its skin version, when chosen).
    const px = this.state.view === 'tattoo' ? this.design(0, this.state.tattoo).px : this.pixels(), x = Math.floor(u * r.w), y = Math.floor(v * r.h);
    const rgb = meanRgb(px, square(x, y, size, r.w, r.h));
    const patch = new Uint8Array(LOUPE * LOUPE * 4), o = LOUPE >> 1;
    for (let j = 0; j < LOUPE; j++) for (let i = 0; i < LOUPE; i++) {
      const xx = Math.min(r.w - 1, Math.max(0, x + i - o)), yy = Math.min(r.h - 1, Math.max(0, y + j - o));
      patch.set(px.subarray((yy * r.w + xx) * 4, (yy * r.w + xx) * 4 + 4), (j * LOUPE + i) * 4);
    }
    const res: PickResult = { x, y, size, info: colorInfo(rgb), patch, ms: round1(now() - t0) };
    return Comlink.transfer(res, [patch.buffer]);
  }

  /** Current Drawing as SVG: the ink mask (coverage > 0.5) traced into outlines. */
  exportSvg(): SvgExport {
    const r = this.renderer;
    if (this.state.view !== 'drawing' || !this.drawn) throw new Error('SVG есть только у Drawing');
    const t0 = now(), ink = this.drawn.res.ink, mask = new Uint8Array(ink.length);
    for (let i = 0; i < ink.length; i++) mask[i] = ink[i] > 0.5 ? 1 : 0;
    const s = maskToSvg(mask, r.w, r.h, this.state.drawing.invert);
    return { ...s, ms: round1(now() - t0) };
  }

  /**
   * Current Drawing as a PNG with a transparent sheet: ink is black (white when inverted) with
   * alpha = coverage. Procreate does not import SVG; this drops onto a layer instead.
   */
  async exportInkPng(): Promise<Blob> {
    const r = this.renderer;
    if (this.state.view !== 'drawing' || !this.drawn) throw new Error('прозрачный PNG есть только у Drawing');
    const ink = this.drawn.res.ink, v = this.state.drawing.invert ? 255 : 0, px = new Uint8ClampedArray(ink.length * 4);
    for (let i = 0; i < ink.length; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = Math.round(ink[i] * 255); }
    const c = new OffscreenCanvas(r.w, r.h);
    c.getContext('2d')!.putImageData(new ImageData(px, r.w, r.h), 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }

  /**
   * Stencil PDF at 1:1 from the line check's ink mask (Тату → Линии): A4 or larger, a 10 mm
   * scale bar, mirrored on request.
   */
  async exportStencil(): Promise<StencilExport> {
    const r = this.renderer, t = this.state.tattoo;
    if (this.state.view !== 'tattoo' || t.tool !== 'lines' || !this.tat?.ink) throw new Error('трафарет делается во вкладке Тату → Линии');
    const t0 = now(), ink = this.tat.ink, gray = new Uint8Array(ink.length);
    for (let i = 0; i < ink.length; i++) gray[i] = ink[i] ? 0 : 255;
    const s = await stencilPdf(gray, r.w, r.h, { widthCm: t.widthCm, mirror: t.lines.mirror, label: 'Vishar Color Study stencil' });
    const res: StencilExport = { pdf: s.pdf, pageMm: s.pageMm, designMm: s.designMm, ms: round1(now() - t0) };
    return Comlink.transfer(res, [s.pdf.buffer]);
  }

  /** The design calibrated for the chosen skin tone (Тату → Кожа), without the skin, as PNG. */
  async exportCalibrated(): Promise<Blob> {
    const r = this.renderer, t = this.state.tattoo, n = r.w * r.h, px = this.pixels(this.state.smoothing);
    const out = isNeutral(calOf(t.skin)) ? px : calibrateImage(px, n, calOf(t.skin), false).px;
    const c = new OffscreenCanvas(r.w, r.h);
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out), r.w, r.h), 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }

  /** Working copy rendered with the current view at work size, as PNG. */
  async exportWork(): Promise<Blob> {
    const r = this.renderer;
    if (!this.plan) throw new Error('нечего экспортировать');
    const px = r.renderPixels(this.plan, this.state.smoothing);
    const c = new OffscreenCanvas(r.w, r.h);
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), r.w, r.h), 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }

  /**
   * GPU ↔ CPU parity on the reference photos: every case renders on the GPU and through
   * renderReference() from the same source pixels. Also checks the compatibility mode
   * against the original's Values thresholds.
   */
  async selftest(fixtures: Record<string, string>): Promise<ParityReport> {
    const t0 = now(), cases: ParityCase[] = [], compat: CompatCase[] = [];
    let histDiff = 0;
    const base = DEFAULT_VIEW;
    const variants: Array<[string, ViewState]> = [
      ['values L* k-means 9', { ...base, view: 'values' }],
      ['values luma (как в оригинале) 9', { ...base, view: 'values', values: { ...base.values, scale: 'luma' } }],
      ['values √count 4 + Show Hue', { ...base, view: 'values', values: { ...base.values, levels: 4, method: 'kmeans-sqrt', showHue: true } }],
      ['values even 6 + brightness + highlight', { ...base, view: 'values', values: { ...base.values, levels: 6, method: 'even', brightness: 10, highlight: 2 } }],
      ['values smoothing strong', { ...base, view: 'values', smoothing: 2 }],
      ['notan otsu', { ...base, view: 'notan' }],
      ['notan median 3 + invert', { ...base, view: 'notan', notan: { ...base.notan, mode: 'median', levels: 3, invert: true } }],
      ['notan auto luma', { ...base, view: 'notan', notan: { ...base.notan, mode: 'auto', scale: 'luma' } }],
      ['temperature map', { ...base, view: 'temperature' }],
      ['temperature shaded absolute', { ...base, view: 'temperature', temperature: { mode: 'absolute', style: 'shaded', balance: 0 } }],
      ['temperature two', { ...base, view: 'temperature', temperature: { ...base.temperature, style: 'two' } }],
      ['highlight skin ΔE 15', { ...base, view: 'highlight', highlight: { target: [65, 15, 20], tolerance: 15, mode: 'highlight' } }],
      // Same red without the outline: tells ΔE precision apart from neighbour sampling.
      ['highlight red ΔE 20', { ...base, view: 'highlight', highlight: { target: [45, 55, 35], tolerance: 20, mode: 'highlight' } }],
      ['highlight red ΔE 20 outline', { ...base, view: 'highlight', highlight: { target: [45, 55, 35], tolerance: 20, mode: 'outline' } }],
      ['highlight grey ΔE 8 outline', { ...base, view: 'highlight', highlight: { target: [50, 0, 0], tolerance: 8, mode: 'outline' } }],
      // Simplify / Drawing: the CPU result vs what the GPU shows from the result texture.
      ['simplify clustering', { ...base, view: 'simplify' }],
      ['simplify graph', { ...base, view: 'simplify', simplify: { ...base.simplify, mode: 'graph' } }],
      ['simplify posterize, 4 цвета, тёмные элементы', { ...base, view: 'simplify', simplify: { ...base.simplify, mode: 'posterize', paletteLimit: 4, keepDark: true } }],
      ['drawing sketch', { ...base, view: 'drawing' }],
      ['drawing contours stroke 3 invert', { ...base, view: 'drawing', smoothing: 1, drawing: { mode: 'contours', line: 60, stroke: 3, invert: true } }],
      ['тату: контраст', { ...base, view: 'tattoo', tattoo: { ...base.tattoo, tool: 'contrast' } }],
      ['тату: линии 0,5 мм', { ...base, view: 'tattoo', tattoo: { ...base.tattoo, tool: 'lines' } }],
    ];
    for (const [name, url] of Object.entries(fixtures)) {
      const blob = await (await fetch(url)).blob();
      await this.open(blob, { workLong: 1024 });
      const r = this.renderer;
      // Histograms from the GPU analysis buffer vs L* computed on the CPU.
      const src0 = r.readSource(0), { a } = this.analyzed(0), cpuHist = new Float64Array(256);
      const n = src0.length >> 2, luma = new Float64Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const L = srgbToLab(src0[j], src0[j + 1], src0[j + 2])[0];
        cpuHist[Math.min(255, Math.max(0, Math.round(L * 2.55)))]++;
        luma[i] = luma601(src0[j], src0[j + 1], src0[j + 2]);
      }
      let hd = 0;
      for (let v = 0; v < 256; v++) hd += Math.abs(cpuHist[v] - a.hist.lstar[v]);
      histDiff = Math.max(histDiff, hd / 2 / n);
      if (ORIGINAL_VALUES_9[name]) {
        const ours = valuesThresholds(a.hist.luma, { levels: 9, method: 'kmeans' }, true);
        compat.push({ fixture: name, ours: ours.map(round1), original: ORIGINAL_VALUES_9[name], agreement: levelAgreement(luma, ours, ORIGINAL_VALUES_9[name]) });
      }
      for (const [vname, state] of variants) {
        const { a: an } = this.analyzed(state.smoothing);
        const { plan } = planView(state, an.hist);
        let computeMs: number | undefined, result: Uint8ClampedArray | undefined;
        if (plan.view === 5) {
          computeMs = round1(this.ensureResult(state).computeMs);
          result = this.computed(state).rgba;
        }
        const gpu = r.renderPixels(plan, state.smoothing), cpu = renderReference(r.readSource(state.smoothing), plan, r.w, result);
        let se = 0, bad = 0, maxDiff = 0;
        for (let j = 0; j < gpu.length; j += 4) {
          const d = Math.max(Math.abs(gpu[j] - cpu[j]), Math.abs(gpu[j + 1] - cpu[j + 1]), Math.abs(gpu[j + 2] - cpu[j + 2]));
          if (d > maxDiff) maxDiff = d;
          if (d > 2) bad++;
          if (d) se += (srgbToLab(gpu[j], gpu[j + 1], gpu[j + 2])[0] - srgbToLab(cpu[j], cpu[j + 1], cpu[j + 2])[0]) ** 2;
        }
        const mseL = se / n, mismatch = bad / n;
        cases.push({ fixture: name, name: vname, mseL: Math.round(mseL * 1000) / 1000, mismatch: Math.round(mismatch * 1e5) / 1e5, maxDiff, pass: mseL <= 1 && mismatch <= 0.005, computeMs });
      }
    }
    this.reset();
    this.renderer.clear();
    return {
      cases, compat, histogramMaxShareDiff: Math.round(histDiff * 1e5) / 1e5,
      pass: cases.every((c) => c.pass) && histDiff <= 0.01,
      ms: Math.round(now() - t0),
    };
  }
}

export type EngineApi = Engine;
Comlink.expose(new Engine());
