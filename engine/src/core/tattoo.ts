// Tattoo tools (plan 5.3–5.4) on the working copy, CPU, in the Worker. Every threshold is a
// start value the user can change. The output is a warning about readability, never a
// prediction of how a tattoo heals: that depends on skin, technique, pigment and aftercare.
//  - lines:    line thickness and gaps in mm at the design's physical size;
//  - distance: the design seen from a distance (1′ visual acuity), Notan IoU, figure/ground;
//  - spread:   possible ink spread (dark grows, contrast drops, slight blur);
//  - skin:     the design multiplied onto six skin tones (Fitzpatrick I–VI).

import { enc, SRGB_TO_LINEAR, srgbToLab } from './color';
import { DEFAULT_CONTRAST, type ContrastParams } from './contrast';
import { gauss } from './drawing';
import { components } from './simplify';

export type TattooTool = 'contrast' | 'lines' | 'distance' | 'spread' | 'skin';

export interface LinesParams {
  /** design: dark pixels of the design itself (L* below inkL); drawing: the Drawing result. */
  source: 'design' | 'drawing';
  inkL: number;
  /** Lines thinner than this are marked. Start value 0.5 mm. */
  minLineMm: number;
  /** Gaps between lines narrower than this are marked. Start value 1 mm. */
  minGapMm: number;
  /** Stencil PDF mirrored (for transfer paper printed face down). */
  mirror: boolean;
}

export interface DistanceParams {
  /** Viewing distance, m. */
  distanceM: number;
  /** Visual acuity, arc minutes (1′ = normal sight). */
  arcmin: number;
}

export interface SpreadParams {
  /** How far dark areas may grow, mm. Start value 0.2 (plan: 0.1–0.3). */
  spreadMm: number;
  /** Contrast kept, 0..1. */
  contrast: number;
  /** Softening blur, mm. */
  blurMm: number;
}

export interface TattooParams {
  tool: TattooTool;
  /** Physical width of the design on skin, cm: everything in mm is measured against it. */
  widthCm: number;
  contrast: ContrastParams;
  lines: LinesParams;
  distance: DistanceParams;
  spread: SpreadParams;
}

export const DEFAULT_TATTOO: TattooParams = {
  tool: 'contrast',
  widthCm: 10,
  contrast: DEFAULT_CONTRAST,
  lines: { source: 'design', inkL: 35, minLineMm: 0.5, minGapMm: 1, mirror: false },
  distance: { distanceM: 2, arcmin: 1 },
  spread: { spreadMm: 0.2, contrast: 0.85, blurMm: 0.1 },
};

/** Fitzpatrick I–VI, approximate sRGB of each skin type (orientation only). */
export const SKIN_TONES: Array<[number, number, number]> = [
  [243, 214, 193], [232, 188, 154], [208, 155, 118], [168, 114, 79], [122, 75, 48], [74, 44, 29],
];

export const pxPerMm = (w: number, widthCm: number) => w / (Math.max(0.1, widthCm) * 10);

// ---------- distance transform ----------

const FAR = 1e20;

/** 1-D squared distance transform (Felzenszwalb–Huttenlocher) of f into d. */
function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

/**
 * Euclidean distance (px) from every pixel to the nearest pixel where `target` is set;
 * 0 on target pixels. With `edgeIsTarget`, everything outside the image counts as target.
 */
export function distanceTo(target: Uint8Array, w: number, h: number, edgeIsTarget = false): Float32Array {
  const n = w * h, g = new Float64Array(n), m = Math.max(w, h);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = target[y * w + x] ? 0 : FAR;
    dt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    dt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) {
      let r = Math.sqrt(d[x]);
      if (edgeIsTarget) r = Math.min(r, x + 1, w - x, y + 1, h - y);
      out[y * w + x] = r;
    }
  }
  return out;
}

/**
 * Parts of a mask narrower than `width` px: what a morphological opening with a disc of that
 * diameter removes. `edgeIsOutside`: the image frame counts as the other phase.
 */
export function narrowParts(mask: Uint8Array, w: number, h: number, width: number, edgeIsOutside: boolean): Uint8Array {
  const n = w * h, other = new Uint8Array(n);
  for (let i = 0; i < n; i++) other[i] = mask[i] ? 0 : 1;
  const r = width / 2, inside = distanceTo(other, w, h, edgeIsOutside), core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = mask[i] && inside[i] >= r ? 1 : 0;
  const reach = distanceTo(core, w, h), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = mask[i] && reach[i] > r + 0.5 ? 1 : 0;
  return out;
}

// ---------- lines ----------

export interface LinesResult {
  rgba: Uint8ClampedArray;
  /** Ink mask used (1 = ink). */
  ink: Uint8Array;
  pxPerMm: number;
  inkShare: number;
  /** Share of ink pixels in lines thinner than the minimum. */
  thinShare: number;
  /** Paper pixels in gaps narrower than the minimum, share of the image. */
  gapShare: number;
  /** The check needs at least 2 px across the minimum line. */
  lowResolution: boolean;
}

export const THIN_COLOR = [230, 0, 40] as const;
export const GAP_COLOR = [0, 110, 255] as const;
const INK_GRAY = 70;

/** Ink mask of the design: L* below inkL (from the analysis buffer, L*·2.55 per pixel). */
export function designInk(lab8: ArrayLike<number>, n: number, inkL: number): Uint8Array {
  const m = new Uint8Array(n), t = inkL * 2.55;
  for (let i = 0; i < n; i++) m[i] = lab8[i * 4] < t ? 1 : 0;
  return m;
}

export function checkLines(ink: Uint8Array, w: number, h: number, widthCm: number, p: LinesParams): LinesResult {
  const n = w * h, ppm = pxPerMm(w, widthCm);
  const thin = narrowParts(ink, w, h, p.minLineMm * ppm, true);
  const paper = new Uint8Array(n);
  for (let i = 0; i < n; i++) paper[i] = ink[i] ? 0 : 1;
  const gap = narrowParts(paper, w, h, p.minGapMm * ppm, false);
  const rgba = new Uint8ClampedArray(n * 4);
  let inkN = 0, thinN = 0, gapN = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let c: readonly number[] = [255, 255, 255];
    if (ink[i]) { inkN++; c = thin[i] ? (thinN++, THIN_COLOR) : [INK_GRAY, INK_GRAY, INK_GRAY]; }
    else if (gap[i]) { gapN++; c = GAP_COLOR; }
    rgba[j] = c[0]; rgba[j + 1] = c[1]; rgba[j + 2] = c[2]; rgba[j + 3] = 255;
  }
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    rgba, ink, pxPerMm: Math.round(ppm * 100) / 100, inkShare: r4(inkN / n), thinShare: r4(inkN ? thinN / inkN : 0),
    gapShare: r4(gapN / n), lowResolution: p.minLineMm * ppm < 2,
  };
}

// ---------- distance and figure/ground ----------

/** Blur sigma (px of the design) that matches the eye's acuity at that distance (prototype). */
export function viewBlurPx(w: number, widthCm: number, distanceCm: number, arcmin = 1): number {
  const cmPerPx = widthCm / w, blurCm = distanceCm * Math.tan(((arcmin / 60) * Math.PI) / 180);
  return blurCm / cmPerPx;
}

function planesOf(px: ArrayLike<number>, n: number): Float32Array[] {
  const p = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) p[c][i] = SRGB_TO_LINEAR[px[i * 4 + c]];
  return p;
}

function toRgba(p: Float32Array[], n: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { out[i * 4] = enc(p[0][i]); out[i * 4 + 1] = enc(p[1][i]); out[i * 4 + 2] = enc(p[2][i]); out[i * 4 + 3] = 255; }
  return out;
}

/** Otsu threshold on L* (0..100) of a set of pixels; dark = below it. */
function otsuL(L: Float32Array): number {
  const hst = new Float64Array(256);
  for (let i = 0; i < L.length; i++) hst[Math.min(255, Math.max(0, Math.round(L[i] * 2.55)))]++;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hst[v];
  let wB = 0, sB = 0, best = -1, t = 127;
  for (let v = 0; v < 255; v++) {
    wB += hst[v];
    if (!wB) continue;
    const wF = L.length - wB;
    if (!wF) break;
    sB += v * hst[v];
    const b = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (b > best) { best = b; t = v; }
  }
  return (t + 0.5) / 2.55;
}

const lstarOf = (px: ArrayLike<number>, n: number) => {
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = srgbToLab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2])[0];
  return L;
};

export interface FigureGround {
  /** Share of the design that is dark (Notan, Otsu). */
  darkShare: number;
  /** Dark masses of at least 1 % of the design. */
  bigDark: number;
  /** Largest dark mass, share of all dark. */
  dominant: number;
}

export function figureGround(dark: Uint8Array, w: number, h: number): FigureGround {
  const n = w * h, lab = new Int32Array(n);
  let darkN = 0;
  for (let i = 0; i < n; i++) { lab[i] = dark[i]; darkN += dark[i]; }
  const { comp, sizes, count } = components(lab, w, h);
  let big = 0, top = 0;
  const isDark = new Uint8Array(count);
  for (let i = 0; i < n; i++) if (dark[i]) isDark[comp[i]] = 1;
  for (let c = 0; c < count; c++) {
    if (!isDark[c]) continue;
    if (sizes[c] >= n * 0.01) big++;
    top = Math.max(top, sizes[c]);
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { darkShare: r3(darkN / n), bigDark: big, dominant: r3(darkN ? top / darkN : 0) };
}

export interface DistanceResult {
  rgba: Uint8ClampedArray;
  blurPx: number;
  /** Notan of the blurred design vs Notan of the design: intersection over union of dark. */
  iou: number;
  figure: FigureGround;
}

export function viewFromDistance(px: ArrayLike<number>, w: number, h: number, widthCm: number, p: DistanceParams): DistanceResult {
  const n = w * h, sigma = viewBlurPx(w, widthCm, p.distanceM * 100, p.arcmin);
  const blurred = toRgba(planesOf(px, n).map((c) => gauss(c, w, h, sigma)), n);
  const L0 = lstarOf(px, n), L1 = lstarOf(blurred, n), t0 = otsuL(L0);
  const d0 = new Uint8Array(n);
  let inter = 0, uni = 0;
  for (let i = 0; i < n; i++) {
    const a = L0[i] < t0, b = L1[i] < t0;
    d0[i] = a ? 1 : 0;
    if (a && b) inter++;
    if (a || b) uni++;
  }
  return { rgba: blurred, blurPx: Math.round(sigma * 100) / 100, iou: uni ? Math.round((inter / uni) * 1000) / 1000 : 1, figure: figureGround(d0, w, h) };
}

// ---------- spread ----------

/** Separable running minimum over a (2r+1)² window, per channel. */
function erode(p: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return p;
  const tmp = new Float32Array(p.length), out = new Float32Array(p.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = Infinity;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.min(m, p[y * w + k]);
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = Infinity;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.min(m, tmp[k * w + x]);
    out[y * w + x] = m;
  }
  return out;
}

export interface SpreadResult { rgba: Uint8ClampedArray; spreadPx: number; blurPx: number }

/** Possible spread: dark grows by spreadMm, contrast drops towards the mean, slight blur. */
export function spreadPreview(px: ArrayLike<number>, w: number, h: number, widthCm: number, p: SpreadParams): SpreadResult {
  const n = w * h, ppm = pxPerMm(w, widthCm), r = Math.round(p.spreadMm * ppm), sigma = p.blurMm * ppm;
  const planes = planesOf(px, n).map((c) => {
    const e = erode(c, w, h, r);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += e[i];
    mean /= n;
    for (let i = 0; i < n; i++) e[i] = mean + (e[i] - mean) * p.contrast;
    return gauss(e, w, h, sigma);
  });
  return { rgba: toRgba(planes, n), spreadPx: r, blurPx: Math.round(sigma * 100) / 100 };
}

// ---------- skin ----------

/**
 * Six tiles (3 × 2, Fitzpatrick I–VI left to right, top to bottom): the design multiplied
 * onto each skin tone in linear light, so white pigment all but disappears on dark skin.
 */
export function skinPreview(px: ArrayLike<number>, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  const tw = Math.floor(w / 3), th = Math.floor(h / 2), pad = Math.round(Math.min(tw, th) * 0.04);
  const s = Math.min((tw - 2 * pad) / w, (th - 2 * pad) / h), dw = Math.max(1, Math.floor(w * s)), dh = Math.max(1, Math.floor(h * s));
  for (let t = 0; t < 6; t++) {
    const ox = (t % 3) * tw, oy = Math.floor(t / 3) * th, skin = SKIN_TONES[t].map((v) => SRGB_TO_LINEAR[v]);
    const ix = ox + Math.floor((tw - dw) / 2), iy = oy + Math.floor((th - dh) / 2);
    for (let y = oy; y < oy + th; y++) for (let x = ox; x < ox + tw; x++) {
      const j = (y * w + x) * 4, u = x - ix, v = y - iy;
      let d = [1, 1, 1];
      if (u >= 0 && v >= 0 && u < dw && v < dh) {
        // Box average of the source pixels this tile pixel covers.
        const x0 = Math.floor(u / s), x1 = Math.max(x0 + 1, Math.floor((u + 1) / s)), y0 = Math.floor(v / s), y1 = Math.max(y0 + 1, Math.floor((v + 1) / s));
        const acc = [0, 0, 0];
        let k = 0;
        for (let yy = y0; yy < Math.min(h, y1); yy++) for (let xx = x0; xx < Math.min(w, x1); xx++) {
          const q = (yy * w + xx) * 4;
          acc[0] += SRGB_TO_LINEAR[px[q]]; acc[1] += SRGB_TO_LINEAR[px[q + 1]]; acc[2] += SRGB_TO_LINEAR[px[q + 2]]; k++;
        }
        if (k) d = acc.map((a) => a / k);
      }
      out[j] = enc(skin[0] * d[0]); out[j + 1] = enc(skin[1] * d[1]); out[j + 2] = enc(skin[2] * d[2]);
    }
  }
  return out;
}
