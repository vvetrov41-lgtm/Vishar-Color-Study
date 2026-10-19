// Colour masses under real pigments (plan 5.2). The design is simplified to patches, then
// every patch colour is painted with the nearest of a few pigments of one brand, chosen so
// that the area-weighted ΔE2000 is lowest. Colours no pigment of the brand reaches closer
// than farDE are reported with the nearest one. Black & Grey maps L* to the master's tones.
// Catalogue colours are estimates from shop photos (except Radiant's published swatches):
// a first approximation, never a replacement for the studio's own swatches.

import { labToSrgb, srgbToLab } from './color';
import { deltaE2000, type Lab } from './colorinfo';
import catalogue from './inks.json';
import type { SimplifyParams } from './simplify';

export type Confidence = 'm' | 'l' | 'v';

export interface Ink {
  id: string;
  brand: string;
  line: string;
  name: string;
  family: string;
  hex: string;
  lab: Lab;
  conf: Confidence;
  bg?: { role: string; step: number };
}

export interface GreySeries {
  brand: string;
  line: string;
  series: string;
  names: string[];
}

type Row = [string, number, string, string, string, string, Confidence, string?, number?];
const cat = catalogue as unknown as { brands: string[]; inks: Row[]; series: Array<GreySeries & { ids: string[] }> };

export const INKS: Ink[] = cat.inks.map(([id, b, line, name, family, hex, conf, role, step]) => {
  const v = parseInt(hex.slice(1), 16);
  return { id, brand: cat.brands[b], line, name, family, hex, conf, lab: srgbToLab(v >> 16, (v >> 8) & 255, v & 255), ...(role ? { bg: { role, step: step ?? 0 } } : {}) };
});
export const GREY_SERIES: GreySeries[] = cat.series.map(({ brand, line, series, names }) => ({ brand, line, series, names }));

/** Inks usable for colour matching: medium/low colours, plus black and white (their flask is the ink). */
const usable = (i: Ink) => i.conf !== 'v' || i.family === 'black' || i.family === 'white';
/** Brands with at least a few usable colours, most first. */
export const INK_BRANDS: string[] = (() => {
  const n = new Map<string, number>();
  for (const i of INKS) if (usable(i)) n.set(i.brand, (n.get(i.brand) ?? 0) + 1);
  return [...n].filter(([, c]) => c >= 10).sort((a, b) => b[1] - a[1]).map(([b]) => b);
})();

export interface PigmentParams {
  mode: 'color' | 'bg';
  /** photo: every pixel of the photo (as smoothed); patches: Simplify patches first. */
  source: 'photo' | 'patches';
  /** Pigment (colour) or tone (B&G) to show on the image, −1 = all, −2 = skin. */
  focus: number;
  /** Brand name; '' = every brand. */
  brand: string;
  /** Pigments the design may use, besides untouched skin. */
  maxInks: number;
  details: number;
  /** A design colour farther than this (ΔE2000) from every pigment of the brand is reported. */
  farDE: number;
  /** Black & Grey: index in GREY_SERIES for the tone names, −1 = no series. */
  series: number;
  /** Black & Grey: L* of each tone from light to dark (the darkest one is black). */
  tonesL: number[];
}

export const DEFAULT_PIGMENTS: PigmentParams = { mode: 'color', source: 'photo', focus: -1, brand: INK_BRANDS[0] ?? '', maxInks: 4, details: 3, farDE: 10, series: -1, tonesL: [75, 55, 35, 12] };

/** Evenly spaced tones for n dilutions, light to dark, the last one black. */
export const evenTones = (n: number): number[] => Array.from({ length: n }, (_, i) => Math.round(80 - (i * (80 - 12)) / Math.max(1, n - 1)));

export const pigmentSimplify = (p: PigmentParams): SimplifyParams => ({ mode: 'clustering', details: p.details, paletteLimit: 0, keepDark: true, darkDelta: 18 });

export interface UsedInk { id: string; name: string; line: string; hex: string; conf: Confidence; share: number }
export interface MissColor { hex: string; share: number; nearest: string; nearestHex: string; nearestDE: number; usedDE: number }

export interface PigmentResult {
  rgba: Uint8ClampedArray;
  /** Per pixel: index in inks (−1 = skin). */
  index: Int8Array;
  /** Chosen pigments with their share of the design; skin is the unpainted rest. */
  inks: UsedInk[];
  skinShare: number;
  /** Design colours (≥ 0.5 % of the area) no pigment of the brand reaches closer than farDE. */
  misses: MissColor[];
  /** Area-weighted ΔE2000 between the design and its pigment version. */
  meanDE: number;
  ms: number;
}

const SKIN: Lab = [96, 0, 2];
const hex = (c: readonly number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

/**
 * Colour classes: colour, Lab and area per distinct colour. A photo has too many colours,
 * so with shift > 0 they are binned (shift bits per channel) and each bin takes its mean colour.
 */
function classes(rgba: ArrayLike<number>, n: number, shift = 0) {
  const idx = new Map<number, number>(), cls = new Int32Array(n), sum: number[] = [], area: number[] = [];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const c = ((rgba[j] >> shift) << 16) | ((rgba[j + 1] >> shift) << 8) | (rgba[j + 2] >> shift);
    let k = idx.get(c);
    if (k === undefined) { k = area.length; idx.set(c, k); area.push(0); sum.push(0, 0, 0); }
    cls[i] = k; area[k]++;
    sum[k * 3] += rgba[j]; sum[k * 3 + 1] += rgba[j + 1]; sum[k * 3 + 2] += rgba[j + 2];
  }
  const cols = area.map((a, k) => (Math.round(sum[k * 3] / a) << 16) | (Math.round(sum[k * 3 + 1] / a) << 8) | Math.round(sum[k * 3 + 2] / a));
  const lab: Lab[] = cols.map((c) => srgbToLab(c >> 16, (c >> 8) & 255, c & 255));
  return { cls, cols, area, lab };
}

/** Bits dropped per channel when the source is the photo: 32 levels, a few thousand bins. */
export const PHOTO_SHIFT = 3;
/** Above this many class × pigment pairs the choice uses plain Lab distance (ΔE76) to stay fast. */
const DE2000_PAIRS = 400_000;
const de76 = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Pigment version of a simplified design (plan 5.2, colour). */
export function pigmentMap(rgba: ArrayLike<number>, w: number, h: number, p: PigmentParams, shift = 0): PigmentResult {
  const t0 = performance.now(), n = w * h, { cls, cols, area, lab } = classes(rgba, n, shift);
  const cand = INKS.filter((i) => usable(i) && (!p.brand || i.brand === p.brand));
  const K = cols.length, C = cand.length, de = K * C <= DE2000_PAIRS ? deltaE2000 : de76;
  // ΔE from every design colour to every pigment, and to untouched skin.
  const D = new Float32Array(K * C), skin = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    skin[k] = de(lab[k], SKIN);
    for (let c = 0; c < C; c++) D[k * C + c] = de(lab[k], cand[c].lab);
  }
  // Greedy choice: add the pigment that lowers the area-weighted ΔE most, up to maxInks.
  const best = Float32Array.from(skin), chosen: number[] = [];
  for (let step = 0; step < Math.max(1, Math.round(p.maxInks)); step++) {
    let pick = -1, gain = 0;
    for (let c = 0; c < C; c++) {
      if (chosen.includes(c)) continue;
      let g = 0;
      for (let k = 0; k < K; k++) { const d = D[k * C + c]; if (d < best[k]) g += (best[k] - d) * area[k]; }
      if (g > gain) { gain = g; pick = c; }
    }
    if (pick < 0) break;
    chosen.push(pick);
    for (let k = 0; k < K; k++) best[k] = Math.min(best[k], D[k * C + pick]);
  }
  // Assignment per class: −1 = skin. The mean is always ΔE2000.
  const asg = new Int32Array(K), used = new Float64Array(chosen.length);
  let skinArea = 0, sumDE = 0;
  for (let k = 0; k < K; k++) {
    let a = -1, d = skin[k];
    chosen.forEach((c, j) => { if (D[k * C + c] < d) { d = D[k * C + c]; a = j; } });
    asg[k] = a; sumDE += (a < 0 ? deltaE2000(lab[k], SKIN) : deltaE2000(lab[k], cand[chosen[a]].lab)) * area[k];
    if (a < 0) skinArea += area[k]; else used[a] += area[k];
  }
  // Inks are reported by share, largest first; the per-pixel index follows that order.
  const order = chosen.map((_, j) => j).sort((x, y) => used[y] - used[x]), rank = new Int8Array(chosen.length);
  order.forEach((j, r) => (rank[j] = r));
  const index = new Int8Array(n);
  for (let i = 0; i < n; i++) { const a = asg[cls[i]]; index[i] = a < 0 ? -1 : rank[a]; }
  const paint = chosen.map((c) => { const v = parseInt(cand[c].hex.slice(1), 16); return [v >> 16, (v >> 8) & 255, v & 255]; });
  const skinRgb = labToSrgb(...SKIN);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = asg[cls[i]], c = a < 0 ? skinRgb : paint[a];
    out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2]; out[j + 3] = 255;
  }
  // Colours out of the brand's reach, biggest first.
  const misses: MissColor[] = [];
  for (let k = 0; k < K; k++) {
    // Small patches and paper (light, almost neutral: it stays skin) are not reported.
    if (area[k] < 0.005 * n || (lab[k][0] > 90 && Math.hypot(lab[k][1], lab[k][2]) < 10)) continue;
    let c0 = -1, d0 = Infinity;
    for (let c = 0; c < C; c++) if (D[k * C + c] < d0) { d0 = D[k * C + c]; c0 = c; }
    const usedDE = asg[k] < 0 ? skin[k] : D[k * C + chosen[asg[k]]];
    if (c0 >= 0 && (d0 >= p.farDE || usedDE >= p.farDE)) {
      misses.push({ hex: hex([cols[k] >> 16, (cols[k] >> 8) & 255, cols[k] & 255]), share: round3(area[k] / n), nearest: `${cand[c0].name} (${cand[c0].line})`, nearestHex: cand[c0].hex, nearestDE: round1(d0), usedDE: round1(usedDE) });
    }
  }
  misses.sort((a, b) => b.share - a.share);
  const inks = order.map((j) => { const c = cand[chosen[j]]; return { id: c.id, name: c.name, line: c.line, hex: c.hex, conf: c.conf, share: round3(used[j] / n) }; });
  return { rgba: out, index, inks, skinShare: round3(skinArea / n), misses: misses.slice(0, 8), meanDE: round1(sumDE / n), ms: Math.round(performance.now() - t0) };
}

export interface GreyResult {
  rgba: Uint8ClampedArray;
  /** Per pixel: tone index (−1 = skin). */
  index: Int8Array;
  /** Share of the design per tone, light to dark; skin is the rest. */
  shares: number[];
  skinShare: number;
  ms: number;
}

/** Black & Grey: every patch goes to the tone of nearest L*; lighter than the lightest tone's midpoint to 100 stays skin. */
export function greyTones(rgba: ArrayLike<number>, w: number, h: number, tonesL: number[], shift = 0): GreyResult {
  const t0 = performance.now(), n = w * h, { cls, area, lab } = classes(rgba, n, shift);
  const tones = [...tonesL].map((v) => Math.min(100, Math.max(0, v)));
  const skinFrom = (100 + Math.max(...tones)) / 2;
  const grey = tones.map((L) => labToSrgb(L, 0, 0)[0]);
  const asg = lab.map(([L]) => {
    if (L >= skinFrom) return -1;
    let a = 0;
    tones.forEach((t, j) => { if (Math.abs(L - t) < Math.abs(L - tones[a])) a = j; });
    return a;
  });
  const shares = tones.map(() => 0);
  let skinArea = 0;
  asg.forEach((a, k) => { if (a < 0) skinArea += area[k]; else shares[a] += area[k]; });
  const out = new Uint8ClampedArray(n * 4), index = new Int8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = asg[cls[i]], g = a < 0 ? 255 : grey[a];
    out[j] = out[j + 1] = out[j + 2] = g; out[j + 3] = 255;
    index[i] = a;
  }
  return { rgba: out, index, shares: shares.map((s) => round3(s / n)), skinShare: round3(skinArea / n), ms: Math.round(performance.now() - t0) };
}

/**
 * One pigment or tone on the image: its pixels keep their colour, the rest fades to a pale
 * grey of its own lightness. focus −2 shows the untouched skin.
 */
export function focusOn(rgba: Uint8ClampedArray, index: Int8Array, focus: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length), want = focus === -2 ? -1 : focus;
  for (let i = 0, j = 0; i < index.length; i++, j += 4) {
    if (index[i] === want) { out[j] = rgba[j]; out[j + 1] = rgba[j + 1]; out[j + 2] = rgba[j + 2]; }
    else { const y = (rgba[j] * 0.3 + rgba[j + 1] * 0.59 + rgba[j + 2] * 0.11) * 0.25 + 190; out[j] = out[j + 1] = out[j + 2] = y; }
    out[j + 3] = 255;
  }
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
