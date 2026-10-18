// A view state (what the user picked) becomes a ViewPlan (numbers the GPU needs):
// thresholds, level tones, neutral point. The same plan drives the CPU reference
// renderer below, which the parity self-test compares against the GPU output.

import { labToSrgb, luma601, srgbToLab, warmth } from './color';
import { deltaE2000 } from './colorinfo';
import { DASH, DEFAULT_HIGHLIGHT, HIGHLIGHT_MODE_CODE, type HighlightParams } from './highlight';
import type { Histograms } from './histogram';
import { DEFAULT_NOTAN, notanThresholds, type NotanParams } from './notan';
import { DEFAULT_TEMPERATURE, TEMP_COOL, TEMP_WARM, tempColor, temperatureStats, type TemperatureParams } from './temperature';
import { DEFAULT_VALUES, levelOf, levelStats, valuesThresholds, type ValuesParams } from './values';

export type ViewKind = 'original' | 'values' | 'notan' | 'temperature' | 'highlight';
export type Smoothing = 0 | 1 | 2;

export interface ViewState {
  view: ViewKind;
  /** Pre-smoothing: 0 none, 1 subtle, 2 strong. Shared by all views. */
  smoothing: Smoothing;
  values: ValuesParams;
  notan: NotanParams;
  temperature: TemperatureParams;
  highlight: HighlightParams;
}

export const DEFAULT_VIEW: ViewState = {
  view: 'values',
  smoothing: 0,
  values: DEFAULT_VALUES,
  notan: DEFAULT_NOTAN,
  temperature: DEFAULT_TEMPERATURE,
  highlight: DEFAULT_HIGHLIGHT,
};

export const VIEW_CODE: Record<ViewKind, number> = { original: 0, values: 1, notan: 2, temperature: 3, highlight: 4 };
export const TEMP_STYLE_CODE = { map: 0, shaded: 1, two: 2 } as const;
export const MAX_LEVELS = 20;

/** Highlight: levels other than the tapped one fade towards light grey. */
export const FADE_KEEP = 0.3;
export const FADE_TO = 230;
/** Notan output greys, darkest first; the middle one is L* 50. */
export const NOTAN_GRAYS = { 2: [0, 255], 3: [0, 119, 255] } as const;

export interface ViewPlan {
  view: number;
  scale: number; // 0 lstar, 1 luma
  thresholds: number[];
  levelGray: number[];
  levelL: number[];
  showHue: boolean;
  highlight: number;
  notanThresholds: number[];
  invert: boolean;
  neutral: number;
  spread: number;
  tempStyle: number;
  hlTarget: number[];
  hlTol: number;
  hlMode: number;
}

export interface ViewStats {
  values?: { thresholds: number[]; gray: number[]; share: number[] };
  notan?: { thresholds: number[]; modeUsed: string; share: number[] };
  temperature?: { neutral: number; spread: number; warmShare: number };
  /** Filled by the worker, which holds the grid sample. */
  highlight?: { share: number };
}

export function planView(state: ViewState, h: Histograms): { plan: ViewPlan; stats: ViewStats } {
  const plan: ViewPlan = {
    view: VIEW_CODE[state.view], scale: 0, thresholds: [], levelGray: [], levelL: [],
    showHue: false, highlight: -1, notanThresholds: [], invert: false, neutral: 0, spread: 1, tempStyle: 0,
    hlTarget: [0, 0, 0], hlTol: 0, hlMode: 0,
  };
  const stats: ViewStats = {};
  if (state.view === 'values') {
    const v = state.values, hist = h[v.scale];
    const t = valuesThresholds(hist, v, v.scale === 'luma' && v.method === 'kmeans');
    const ls = levelStats(hist, t, v.scale, v.brightness);
    Object.assign(plan, {
      scale: v.scale === 'luma' ? 1 : 0, thresholds: t, levelGray: ls.gray, levelL: ls.lstar,
      showHue: v.showHue, highlight: v.highlight < t.length + 1 ? v.highlight : -1,
    });
    stats.values = { thresholds: t, gray: ls.gray, share: ls.share };
  } else if (state.view === 'notan') {
    const n = state.notan, r = notanThresholds(h[n.scale], n);
    Object.assign(plan, { scale: n.scale === 'luma' ? 1 : 0, notanThresholds: r.thresholds, invert: n.invert });
    stats.notan = r;
  } else if (state.view === 'temperature') {
    const s = temperatureStats(h.warmth, state.temperature);
    Object.assign(plan, { neutral: s.neutral, spread: s.spread, tempStyle: TEMP_STYLE_CODE[state.temperature.style] });
    stats.temperature = s;
  } else if (state.view === 'highlight') {
    const hl = state.highlight;
    // Nothing picked yet: show the photo as it is.
    if (!hl.target) plan.view = 0;
    else Object.assign(plan, { hlTarget: [...hl.target], hlTol: hl.tolerance, hlMode: HIGHLIGHT_MODE_CODE[hl.mode] });
  }
  return { plan, stats };
}

/** Tone value of one pixel on the plan's scale, 0..255. */
export function toneOf(r: number, g: number, b: number, scale: number, L?: number): number {
  return scale === 1 ? luma601(r, g, b) : (L ?? srgbToLab(r, g, b)[0]) * 2.55;
}

const fade = (o: number[]) => o.map((c) => c * FADE_KEEP + FADE_TO * (1 - FADE_KEEP)) as [number, number, number];

/** Highlight view on the CPU; w = image width, needed for the outline neighbours. */
function renderHighlight(src: Uint8Array | Uint8ClampedArray, plan: ViewPlan, w: number, out: Uint8ClampedArray) {
  const n = src.length >> 2, h = n / w, labs = new Float64Array(n * 3), match = new Uint8Array(n);
  const target = plan.hlTarget as [number, number, number];
  for (let i = 0; i < n; i++) {
    const l = srgbToLab(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]);
    labs.set(l, i * 3);
    match[i] = deltaE2000(l, target) <= plan.hlTol ? 1 : 0;
  }
  // Outside the image counts as matching: no contour along the frame.
  const m = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 1 : match[y * w + x]);
  for (let i = 0; i < n; i++) {
    const j = i * 4, x = i % w, y = (i / w) | 0;
    let o: [number, number, number] = [src[j], src[j + 1], src[j + 2]];
    if (plan.hlMode === 0) {
      if (!match[i]) o = fade(labToSrgb(labs[i * 3], 0, 0));
    } else if (match[i] && (!m(x - 1, y) || !m(x + 1, y) || !m(x, y - 1) || !m(x, y + 1))) {
      const v = Math.floor((x + y) / (DASH / 2)) % 2 ? 0 : 255;
      o = [v, v, v];
    }
    out[j] = o[0]; out[j + 1] = o[1]; out[j + 2] = o[2]; out[j + 3] = 255;
  }
}

/** CPU twin of the GPU view shader; same plan in, same pixels out (within rounding). */
export function renderReference(src: Uint8Array | Uint8ClampedArray, plan: ViewPlan, w = 0): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  if (plan.view === 4) {
    renderHighlight(src, plan, w, out);
    return out;
  }
  for (let j = 0; j < src.length; j += 4) {
    const r = src[j], g = src[j + 1], b = src[j + 2];
    let o: [number, number, number] = [r, g, b];
    if (plan.view !== 0) {
      const [L, A, B] = srgbToLab(r, g, b);
      if (plan.view === 1) {
        const lev = levelOf(toneOf(r, g, b, plan.scale, L), plan.thresholds);
        o = plan.showHue ? labToSrgb(plan.levelL[lev], A, B) : [plan.levelGray[lev], plan.levelGray[lev], plan.levelGray[lev]];
        if (plan.highlight >= 0 && lev !== plan.highlight) o = fade(o);
      } else if (plan.view === 2) {
        const grays = NOTAN_GRAYS[plan.notanThresholds.length === 2 ? 3 : 2];
        let lev = levelOf(toneOf(r, g, b, plan.scale, L), plan.notanThresholds);
        if (plan.invert) lev = grays.length - 1 - lev;
        o = [grays[lev], grays[lev], grays[lev]];
      } else {
        const t = (warmth(A, B) - plan.neutral) / plan.spread;
        if (plan.tempStyle === 2) o = [...(t > 0 ? TEMP_WARM : TEMP_COOL)];
        else {
          const c = tempColor(t);
          if (plan.tempStyle === 1) {
            const [, ma, mb] = srgbToLab(Math.round(c[0]), Math.round(c[1]), Math.round(c[2]));
            o = labToSrgb(L, ma, mb);
          } else o = c;
        }
      }
    }
    out[j] = o[0]; out[j + 1] = o[1]; out[j + 2] = o[2]; out[j + 3] = 255;
  }
  return out;
}
