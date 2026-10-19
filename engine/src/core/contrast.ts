// Contrast check for tattoo designs (plan 5.1). The design is simplified to a few colours
// (Simplify Clustering with a palette limit, thin dark elements kept), then every pair of
// colours that touch is measured: ΔL* and ΔE2000. Borders between colours closer in
// lightness than the threshold are marked: such a border can lose readability over time.
// "Colour on colour" is the sneaky case: similar lightness, clearly different hue. It reads
// on screen, but much less in skin; the b/w view shows why.
// These are warnings about readability, not a prediction of how a tattoo heals.

import { srgbToLab } from './color';
import { deltaE2000, type Lab } from './colorinfo';
import type { SimplifyParams } from './simplify';

export interface ContrastParams {
  /** Colour limit after simplification, 3..5; 0 = no limit, every patch keeps its own colour
   *  (a limit merges close colours, e.g. yellow into paper, and hides the very pairs we look for). */
  levels: number;
  /** Simplify Details, 0..8. */
  details: number;
  /** A border is weak when ΔL* between its two colours is below this. Start value 15. */
  minDL: number;
  /** Weak by lightness but ΔE2000 at least this: "colour on colour". */
  hueDE: number;
  /** Neighbours closer than this (ΔE2000) are one area in a gradient, not a border. */
  sameDE: number;
  /** Show the simplified design in L* greys instead of colour. */
  bw: boolean;
}

export const DEFAULT_CONTRAST: ContrastParams = { levels: 0, details: 3, minDL: 15, hueDE: 15, sameDE: 6, bw: false };

/** Simplify settings the contrast map is built from. */
export const contrastSimplify = (p: ContrastParams): SimplifyParams => ({
  mode: 'clustering', details: p.details, paletteLimit: p.levels > 0 ? Math.min(5, Math.max(3, Math.round(p.levels))) : 0, keepDark: true, darkDelta: 18,
});

export interface ContrastPair {
  a: string;
  b: string;
  dL: number;
  dE: number;
  /** Border length in px divided by (w + h): about 1 = a border across the whole design. */
  border: number;
  weak: boolean;
  colorOnColor: boolean;
}

export interface ContrastResult {
  rgba: Uint8ClampedArray;
  /** At most MAX_PAIRS: weak ones first (longest border first), then the lowest ΔL*. */
  pairs: ContrastPair[];
  weakPairs: number;
  /** Share of all colour borders that are weak. */
  weakShare: number;
  ms: number;
}

/** Marked borders: diagonal stripes, magenta and white, readable on any colour. */
export const MARK_A = [255, 0, 170] as const;
export const MARK_B = [255, 255, 255] as const;
const STRIPE = 6;
export const MAX_PAIRS = 12;

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0').toUpperCase();

/** Contrast map of a simplified design (every pixel one of a few colours). */
export function contrastMap(rgba: ArrayLike<number>, w: number, h: number, p: ContrastParams): ContrastResult {
  const t0 = performance.now(), n = w * h;
  // Colour classes.
  const idx = new Map<number, number>(), cls = new Int32Array(n), cols: number[] = [];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const c = (rgba[j] << 16) | (rgba[j + 1] << 8) | rgba[j + 2];
    let k = idx.get(c);
    if (k === undefined) { k = cols.length; idx.set(c, k); cols.push(c); }
    cls[i] = k;
  }
  const lab: Lab[] = cols.map((c) => srgbToLab(c >> 16, (c >> 8) & 255, c & 255));
  // Border length per pair of colours (4-neighbourhood, each contact counted once).
  const K = cols.length, seen = new Map<number, number>();
  const touch = (a: number, b: number) => { const key = a < b ? a * K + b : b * K + a; seen.set(key, (seen.get(key) ?? 0) + 1); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, a = cls[i];
    if (x + 1 < w && cls[i + 1] !== a) touch(a, cls[i + 1]);
    if (y + 1 < h && cls[i + w] !== a) touch(a, cls[i + w]);
  }
  // Contacts shorter than this are corners and specks, not borders.
  const minBorder = Math.max(16, 0.01 * (w + h));
  const weakPair = new Set<number>(), pairs: ContrastPair[] = [];
  let all = 0, weakLen = 0;
  for (const [key, len] of seen) {
    const a = Math.floor(key / K), b = key % K, dE = deltaE2000(lab[a], lab[b]);
    // Close colours are steps of one gradient, not a border between two areas.
    if (dE < p.sameDE) continue;
    all += len;
    const dL = Math.abs(lab[a][0] - lab[b][0]), weak = dL < p.minDL && len >= minBorder;
    if (weak) { weakPair.add(key); weakLen += len; }
    pairs.push({ a: hex(cols[a]), b: hex(cols[b]), dL: Math.round(dL * 10) / 10, dE: Math.round(dE * 10) / 10, border: Math.round((len / (w + h)) * 100) / 100, weak, colorOnColor: weak && dE >= p.hueDE });
  }
  // Weak borders first, longest first; then the rest by ΔL*.
  pairs.sort((x, y) => (x.weak !== y.weak ? (x.weak ? -1 : 1) : x.weak ? y.border - x.border : x.dL - y.dL));

  // Weak border pixels, both sides, widened to stay visible on a phone.
  const mark = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, a = cls[i];
    for (const q of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
      if (q < 0 || cls[q] === a) continue;
      const b = cls[q];
      if (weakPair.has(a < b ? a * K + b : b * K + a)) mark[i] = mark[q] = 1;
    }
  }
  const r = Math.max(1, Math.round(Math.max(w, h) / 600)), wide = dilate(mark, w, h, r);

  const gray = cols.map((_, c) => Math.round(Math.min(255, Math.max(0, lab[c][0] * 2.55))));
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (wide[i]) {
      const s = Math.floor(((i % w) + ((i / w) | 0)) / STRIPE) % 2 ? MARK_B : MARK_A;
      out[j] = s[0]; out[j + 1] = s[1]; out[j + 2] = s[2];
    } else if (p.bw) {
      out[j] = out[j + 1] = out[j + 2] = gray[cls[i]];
    } else {
      out[j] = rgba[j]; out[j + 1] = rgba[j + 1]; out[j + 2] = rgba[j + 2];
    }
    out[j + 3] = 255;
  }
  return { rgba: out, pairs: pairs.slice(0, MAX_PAIRS), weakPairs: weakPair.size, weakShare: all ? Math.round((weakLen / all) * 1000) / 1000 : 0, ms: Math.round(performance.now() - t0) };
}

/** Square dilation of a 0/1 mask by r px (separable running max). */
export function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    for (let x = 0; x < Math.min(w, r); x++) if (m[y * w + x]) last = x;
    for (let x = 0; x < w; x++) {
      if (x + r < w && m[y * w + x + r]) last = x + r;
      tmp[y * w + x] = last >= x - r ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < Math.min(h, r); y++) if (tmp[y * w + x]) last = y;
    for (let y = 0; y < h; y++) {
      if (y + r < h && tmp[(y + r) * w + x]) last = y + r;
      out[y * w + x] = last >= y - r ? 1 : 0;
    }
  }
  return out;
}
