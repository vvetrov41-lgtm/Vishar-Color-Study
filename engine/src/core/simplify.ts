// Simplify: the photo becomes flat patches with clean edges. Three styles, as in the
// original (Clusters / Regions / Poster), all on the CPU in the Worker:
//  - clustering: SLIC superpixels, neighbours closer than mergeDE joined, small ones absorbed;
//  - graph: Felzenszwalb–Huttenlocher on a ≤ GRAPH_MAX_PX copy, labels refined to full size;
//  - posterize: Lab levels (L* bands, coarse a*/b* steps), regions under a minimum area absorbed.
// Clustering and graph paint each region with its mean colour (linear RGB), posterize with
// its level colour. Options: a palette limit (weighted k-means over region colours) and
// "keep thin dark elements", which stops hatching and dotwork from melting into patches.

import { enc, labToSrgb, SRGB_TO_LINEAR, srgbToLab as labOf } from './color';

export type SimplifyMode = 'clustering' | 'graph' | 'posterize';

export interface SimplifyParams {
  mode: SimplifyMode;
  /** 0..8, default 4: more = smaller patches. */
  details: number;
  /** 0 = off; otherwise the image ends up with at most this many colours, dark elements included. */
  paletteLimit: number;
  /** Keep pixels much darker than their patch (hatching, dotwork, thin lines). */
  keepDark: boolean;
  /** "Much darker": L* at least this far below the patch colour. */
  darkDelta: number;
}

export const DEFAULT_SIMPLIFY: SimplifyParams = { mode: 'clustering', details: 4, paletteLimit: 0, keepDark: false, darkDelta: 18 };
export const DETAIL_STEPS = 9;
/** Clustering and Graph segment a copy of at most this many pixels (plan: Graph ≤ 0.5 MP);
 *  labels are then refined on the full working copy. */
export const SEG_MAX_PX = 500_000;

export interface SimplifyInput {
  w: number;
  h: number;
  /** RGBA of the smoothed working copy and its analysis buffer (L*·2.55, a*+128, b*+128, luma). */
  px: Uint8Array | Uint8ClampedArray;
  lab8: Uint8Array | Uint8ClampedArray;
  /** Unsmoothed copy, for dark-element detection; defaults to px / lab8. */
  px0?: Uint8Array | Uint8ClampedArray;
  lab0?: Uint8Array | Uint8ClampedArray;
}

export interface SimplifyResult {
  rgba: Uint8ClampedArray;
  /** Region id per pixel, 0..regions−1. */
  labels: Int32Array;
  regions: number;
  /** Distinct colours in the output. */
  colors: number;
  /** Share of pixels kept as dark elements. */
  inkShare: number;
  ms: { segment: number; merge: number; paint: number; total: number };
}

export type Progress = (share: number, stage: string) => void;

const now = () => performance.now();

/** Segments per photo for each Details step: 24 … ~1700, geometric. */
export const segmentsFor = (d: number) => Math.round(24 * 1.7 ** d);

interface LabPlanes { L: Float32Array; A: Float32Array; B: Float32Array }

function planes(lab8: ArrayLike<number>, n: number): LabPlanes {
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { L[i] = lab8[j] / 2.55; A[i] = lab8[j + 1] - 128; B[i] = lab8[j + 2] - 128; }
  return { L, A, B };
}

/** 4-connected components of a label map. */
export function components(labels: Int32Array, w: number, h: number): { comp: Int32Array; sizes: Int32Array; count: number } {
  const n = w * h, comp = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  const sizes: number[] = [];
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const lab = labels[s];
    let sp = 0, size = 0;
    stack[sp++] = s;
    comp[s] = count;
    while (sp) {
      const p = stack[--sp], x = p % w;
      size++;
      if (x > 0 && comp[p - 1] < 0 && labels[p - 1] === lab) { comp[p - 1] = count; stack[sp++] = p - 1; }
      if (x < w - 1 && comp[p + 1] < 0 && labels[p + 1] === lab) { comp[p + 1] = count; stack[sp++] = p + 1; }
      if (p >= w && comp[p - w] < 0 && labels[p - w] === lab) { comp[p - w] = count; stack[sp++] = p - w; }
      if (p < n - w && comp[p + w] < 0 && labels[p + w] === lab) { comp[p + w] = count; stack[sp++] = p + w; }
    }
    sizes.push(size);
    count++;
  }
  return { comp, sizes: Int32Array.from(sizes), count };
}

/**
 * Regions smaller than minArea join the neighbour they share the longest border with,
 * smallest first; two small neighbours merge with each other instead of swapping labels.
 * Returns connected region ids (0..count−1).
 */
export function absorbSmall(labels: Int32Array, w: number, h: number, minArea: number, passes = 4): { comp: Int32Array; count: number } {
  let { comp, sizes, count } = components(labels, w, h);
  for (let pass = 0; pass < passes; pass++) {
    const votes = new Map<number, number>();
    let small = 0;
    for (let c = 0; c < count; c++) if (sizes[c] < minArea) small++;
    if (!small || count < 2) break;
    const n = w * h;
    for (let p = 0; p < n; p++) {
      const c = comp[p];
      const x = p % w;
      // Each border pixel pair votes for both sides that are small.
      if (x < w - 1) { const d = comp[p + 1]; if (d !== c) vote(votes, sizes, count, c, d, minArea); }
      if (p < n - w) { const d = comp[p + w]; if (d !== c) vote(votes, sizes, count, c, d, minArea); }
    }
    const best = new Int32Array(count).fill(-1), bestV = new Int32Array(count);
    for (const [key, v] of votes) {
      const c = Math.floor(key / count), d = key - c * count;
      if (v > bestV[c] || (v === bestV[c] && sizes[d] > sizes[best[c]])) { bestV[c] = v; best[c] = d; }
    }
    const parent = new Int32Array(count);
    for (let c = 0; c < count; c++) parent[c] = c;
    const find = (c: number) => { while (parent[c] !== c) c = parent[c] = parent[parent[c]]; return c; };
    const order: number[] = [];
    for (let c = 0; c < count; c++) if (best[c] >= 0) order.push(c);
    order.sort((a, b) => sizes[a] - sizes[b]);
    let changed = 0;
    for (const c of order) {
      const rc = find(c), rn = find(best[c]);
      if (rc !== rn) { parent[rc] = rn; changed++; }
    }
    if (!changed) break;
    const next = new Int32Array(n);
    for (let p = 0; p < n; p++) next[p] = find(comp[p]);
    ({ comp, sizes, count } = components(next, w, h));
  }
  return { comp, count };
}

function vote(votes: Map<number, number>, sizes: Int32Array, count: number, c: number, d: number, minArea: number) {
  if (sizes[c] < minArea) { const k = c * count + d; votes.set(k, (votes.get(k) ?? 0) + 1); }
  if (sizes[d] < minArea) { const k = d * count + c; votes.set(k, (votes.get(k) ?? 0) + 1); }
}

/** Mean Lab and area per region. */
function regionLab(comp: Int32Array, count: number, P: LabPlanes): { mean: Float64Array; area: Float64Array } {
  const mean = new Float64Array(count * 3), area = new Float64Array(count);
  for (let p = 0; p < comp.length; p++) {
    const c = comp[p];
    mean[c * 3] += P.L[p]; mean[c * 3 + 1] += P.A[p]; mean[c * 3 + 2] += P.B[p]; area[c]++;
  }
  for (let c = 0; c < count; c++) if (area[c]) { mean[c * 3] /= area[c]; mean[c * 3 + 1] /= area[c]; mean[c * 3 + 2] /= area[c]; }
  return { mean, area };
}

/**
 * Neighbouring regions whose mean colours are closer than maxDE (ΔE76) join, closest
 * pairs first. Means are updated as regions grow and no region grows past maxArea, so a
 * smooth gradient stays a set of facets instead of chaining into one blob.
 */
function mergeSimilar(comp: Int32Array, count: number, w: number, h: number, P: LabPlanes, maxDE: number, maxArea: number): Int32Array {
  const { mean, area } = regionLab(comp, count, P), n = w * h;
  const seen = new Set<number>(), ea: number[] = [], eb: number[] = [];
  for (let p = 0; p < n; p++) {
    const c = comp[p], x = p % w;
    const r = x < w - 1 ? comp[p + 1] : c, d = p < n - w ? comp[p + w] : c;
    for (const q of [r, d]) {
      if (q === c) continue;
      const a = Math.min(c, q), b = Math.max(c, q), k = a * count + b;
      if (!seen.has(k)) { seen.add(k); ea.push(a); eb.push(b); }
    }
  }
  const dist = (a: number, b: number) => {
    const dl = mean[a * 3] - mean[b * 3], da = mean[a * 3 + 1] - mean[b * 3 + 1], db = mean[a * 3 + 2] - mean[b * 3 + 2];
    return Math.sqrt(dl * dl + da * da + db * db);
  };
  const m = ea.length, wgt = new Float64Array(m);
  for (let e = 0; e < m; e++) wgt[e] = dist(ea[e], eb[e]);
  const order = Array.from({ length: m }, (_, e) => e).filter((e) => wgt[e] < maxDE).sort((x, y) => wgt[x] - wgt[y]);
  const parent = new Int32Array(count);
  for (let c = 0; c < count; c++) parent[c] = c;
  const find = (c: number) => { while (parent[c] !== c) c = parent[c] = parent[parent[c]]; return c; };
  for (const e of order) {
    const a = find(ea[e]), b = find(eb[e]);
    if (a === b || area[a] + area[b] > maxArea || dist(a, b) >= maxDE) continue;
    const t = area[a] + area[b];
    for (let k = 0; k < 3; k++) mean[a * 3 + k] = (mean[a * 3 + k] * area[a] + mean[b * 3 + k] * area[b]) / t;
    area[a] = t;
    parent[b] = a;
  }
  const out = new Int32Array(n);
  for (let p = 0; p < n; p++) out[p] = find(comp[p]);
  return out;
}

/** SLIC superpixels (Achanta et al. 2012) on Lab planes; returns raw (possibly disconnected) labels. */
export function slic(P: LabPlanes, w: number, h: number, k: number, compactness = 10, iters = 8): Int32Array {
  const n = w * h, S = Math.max(2, Math.sqrt(n / k)), gx = Math.max(1, Math.round(w / S)), gy = Math.max(1, Math.round(h / S));
  const nc = gx * gy, C = new Float64Array(nc * 5);
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
    let cx = Math.min(w - 2, Math.max(1, Math.floor(((i + 0.5) * w) / gx)));
    let cy = Math.min(h - 2, Math.max(1, Math.floor(((j + 0.5) * h) / gy)));
    // Start from the flattest pixel of the 3×3 neighbourhood, off edges and noise.
    if (w > 2 && h > 2) {
      let bg = Infinity, bx = cx, by = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
        const p = y * w + x, g = (P.L[p + 1] - P.L[p - 1]) ** 2 + (P.L[p + w] - P.L[p - w]) ** 2;
        if (g < bg) { bg = g; bx = x; by = y; }
      }
      cx = bx; cy = by;
    }
    const c = (j * gx + i) * 5, p = cy * w + cx;
    C[c] = P.L[p]; C[c + 1] = P.A[p]; C[c + 2] = P.B[p]; C[c + 3] = cx; C[c + 4] = cy;
  }
  const labels = new Int32Array(n).fill(-1), dist = new Float32Array(n), acc = new Float64Array(nc * 6);
  const ws = (compactness * compactness) / (S * S), R = Math.ceil(S);
  const { L, A, B } = P;
  for (let it = 0; it < iters; it++) {
    dist.fill(Infinity);
    for (let c = 0; c < nc; c++) {
      const o = c * 5, cl = C[o], ca = C[o + 1], cb = C[o + 2], cx = C[o + 3], cy = C[o + 4];
      const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R));
      const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
      for (let y = y0; y <= y1; y++) {
        const dy2 = (y - cy) * (y - cy), row = y * w;
        for (let x = x0; x <= x1; x++) {
          const p = row + x, dl = L[p] - cl, da = A[p] - ca, db = B[p] - cb, dx = x - cx;
          const d = dl * dl + da * da + db * db + (dx * dx + dy2) * ws;
          if (d < dist[p]) { dist[p] = d; labels[p] = c; }
        }
      }
    }
    acc.fill(0);
    for (let p = 0; p < n; p++) {
      const o = labels[p] * 6;
      acc[o] += L[p]; acc[o + 1] += A[p]; acc[o + 2] += B[p]; acc[o + 3] += p % w; acc[o + 4] += (p / w) | 0; acc[o + 5]++;
    }
    for (let c = 0; c < nc; c++) {
      const o = c * 6, m = acc[o + 5];
      if (m) for (let q = 0; q < 5; q++) C[c * 5 + q] = acc[o + q] / m;
    }
  }
  return labels;
}

/** Felzenszwalb–Huttenlocher (2004) on a 4-neighbour grid; edge weights bucket-sorted by 0.1 ΔE76. */
export function felzenszwalb(P: LabPlanes, w: number, h: number, kParam: number, minSize: number): Int32Array {
  const n = w * h, m = (w - 1) * h + w * (h - 1), ea = new Int32Array(m), eb = new Int32Array(m), bin = new Uint16Array(m);
  const NB = 4096, cnt = new Int32Array(NB + 1);
  const { L, A, B } = P;
  let e = 0;
  const add = (p: number, q: number) => {
    const dl = L[p] - L[q], da = A[p] - A[q], db = B[p] - B[q];
    const b = Math.min(NB - 1, Math.floor(Math.sqrt(dl * dl + da * da + db * db) * 10));
    ea[e] = p; eb[e] = q; bin[e] = b; cnt[b + 1]++; e++;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (x < w - 1) add(p, p + 1);
    if (y < h - 1) add(p, p + w);
  }
  for (let b = 0; b < NB; b++) cnt[b + 1] += cnt[b];
  const order = new Int32Array(m);
  for (let i = 0; i < m; i++) order[cnt[bin[i]]++] = i;
  const par = new Int32Array(n), sz = new Int32Array(n).fill(1), th = new Float32Array(n).fill(kParam);
  for (let i = 0; i < n; i++) par[i] = i;
  const find = (x: number) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let t = 0; t < m; t++) {
    const i = order[t];
    let a = find(ea[i]), b = find(eb[i]);
    if (a === b) continue;
    const wgt = bin[i] / 10;
    if (wgt <= th[a] && wgt <= th[b]) {
      if (sz[a] < sz[b]) { const s = a; a = b; b = s; }
      par[b] = a; sz[a] += sz[b]; th[a] = wgt + kParam / sz[a];
    }
  }
  for (let t = 0; t < m; t++) {
    const i = order[t], a = find(ea[i]), b = find(eb[i]);
    if (a !== b && (sz[a] < minSize || sz[b] < minSize)) {
      if (sz[a] < sz[b]) { par[a] = b; sz[b] += sz[a]; } else { par[b] = a; sz[a] += sz[b]; }
    }
  }
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) labels[i] = find(i);
  return labels;
}

/** Box-averaged copy of the Lab planes, s× smaller on each side. */
function shrink(P: LabPlanes, w: number, h: number, s: number): { P: LabPlanes; w: number; h: number } {
  const sw = Math.ceil(w / s), sh = Math.ceil(h / s), m = sw * sh;
  const L = new Float32Array(m), A = new Float32Array(m), B = new Float32Array(m), c = new Float32Array(m);
  for (let y = 0; y < h; y++) {
    const ry = ((y / s) | 0) * sw;
    for (let x = 0; x < w; x++) {
      const p = y * w + x, q = ry + ((x / s) | 0);
      L[q] += P.L[p]; A[q] += P.A[p]; B[q] += P.B[p]; c[q]++;
    }
  }
  for (let q = 0; q < m; q++) { L[q] /= c[q]; A[q] /= c[q]; B[q] /= c[q]; }
  return { P: { L, A, B }, w: sw, h: sh };
}

/**
 * Full-size labels from a coarse label map: each pixel takes whichever of the four nearest
 * coarse labels has the closest mean colour, so edges land on the real pixels, not on blocks.
 */
function refine(coarse: Int32Array, cw: number, ch: number, s: number, P: LabPlanes, w: number, h: number, small: LabPlanes): Int32Array {
  const { comp, count } = components(coarse, cw, ch), { mean } = regionLab(comp, count, small);
  const out = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / s - 0.5)), y0 = Math.floor(fy), y1 = Math.min(ch - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / s - 0.5)), x0 = Math.floor(fx), x1 = Math.min(cw - 1, x0 + 1);
      const p = y * w + x, l = P.L[p], a = P.A[p], b = P.B[p];
      let best = comp[y0 * cw + x0], bd = Infinity;
      for (const q of [y0 * cw + x0, y0 * cw + x1, y1 * cw + x0, y1 * cw + x1]) {
        const c = comp[q], dl = l - mean[c * 3], da = a - mean[c * 3 + 1], db = b - mean[c * 3 + 2], d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      out[p] = best;
    }
  }
  return out;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means++ over region colours (Lab), weighted by the caller (√area: a thin outline keeps its own cluster); returns the cluster of each region. */
export function limitPalette(lab: Float64Array, area: Float64Array, k: number, iters = 15): Int32Array {
  const R = area.length, out = new Int32Array(R);
  if (R <= k) { for (let r = 0; r < R; r++) out[r] = r; return out; }
  const rand = rng(11), C = new Float64Array(k * 3), best = new Float64Array(R).fill(Infinity);
  let first = 0, maxA = -1;
  for (let r = 0; r < R; r++) if (area[r] > maxA) { maxA = area[r]; first = r; }
  C.set(lab.subarray(first * 3, first * 3 + 3), 0);
  for (let j = 1; j < k; j++) {
    let sum = 0;
    for (let r = 0; r < R; r++) {
      const dl = lab[r * 3] - C[(j - 1) * 3], da = lab[r * 3 + 1] - C[(j - 1) * 3 + 1], db = lab[r * 3 + 2] - C[(j - 1) * 3 + 2];
      best[r] = Math.min(best[r], dl * dl + da * da + db * db);
      sum += best[r] * area[r];
    }
    let t = rand() * sum, r = 0;
    while (r < R - 1 && (t -= best[r] * area[r]) > 0) r++;
    C.set(lab.subarray(r * 3, r * 3 + 3), j * 3);
  }
  const acc = new Float64Array(k * 4);
  for (let it = 0; it <= iters; it++) {
    for (let r = 0; r < R; r++) {
      let bj = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const dl = lab[r * 3] - C[j * 3], da = lab[r * 3 + 1] - C[j * 3 + 1], db = lab[r * 3 + 2] - C[j * 3 + 2], d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; bj = j; }
      }
      out[r] = bj;
    }
    if (it === iters) break;
    acc.fill(0);
    for (let r = 0; r < R; r++) {
      const o = out[r] * 4;
      acc[o] += lab[r * 3] * area[r]; acc[o + 1] += lab[r * 3 + 1] * area[r]; acc[o + 2] += lab[r * 3 + 2] * area[r]; acc[o + 3] += area[r];
    }
    for (let j = 0; j < k; j++) if (acc[j * 4 + 3]) for (let q = 0; q < 3; q++) C[j * 3 + q] = acc[j * 4 + q] / acc[j * 4 + 3];
  }
  return out;
}

const posterLevels = (d: number) => 2 + Math.round((d * 6) / 8);
/** Posterize in Lab, not per sRGB channel: lv equal L* bands, a* and b* in steps of AB_STEP,
 *  so a near-neutral colour stays neutral instead of turning purple or green. */
const AB_STEP = 24, AB_HALF = 5, AB_N = 2 * AB_HALF + 1;
function posterCode(L: number, a: number, b: number, lv: number): number {
  const qL = Math.min(lv - 1, Math.max(0, Math.floor((L / 100) * lv)));
  const qa = Math.min(AB_HALF, Math.max(-AB_HALF, Math.round(a / AB_STEP))) + AB_HALF;
  const qb = Math.min(AB_HALF, Math.max(-AB_HALF, Math.round(b / AB_STEP))) + AB_HALF;
  return (qL * AB_N + qa) * AB_N + qb;
}
function posterColors(lv: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(lv * AB_N * AB_N * 3);
  for (let c = 0; c < lv * AB_N * AB_N; c++) {
    const qL = Math.floor(c / (AB_N * AB_N)), qa = Math.floor(c / AB_N) % AB_N, qb = c % AB_N;
    out.set(labToSrgb(((qL + 0.5) * 100) / lv, (qa - AB_HALF) * AB_STEP, (qb - AB_HALF) * AB_STEP), c * 3);
  }
  return out;
}
/** Clustering: neighbouring superpixels closer than this (ΔE76) join, per Details step. */
const MERGE_DE = [8, 6, 5, 4, 3, 2.2, 1.5, 0.8, 0];

export function simplify(input: SimplifyInput, params: SimplifyParams = DEFAULT_SIMPLIFY, progress?: Progress): SimplifyResult {
  const t0 = now(), { w, h, px, lab8 } = input, n = w * h, d = Math.min(DETAIL_STEPS - 1, Math.max(0, Math.round(params.details)));
  const P = planes(lab8, n);
  progress?.(0.05, 'segment');
  let labels: Int32Array, fixed: Uint8ClampedArray | null = null;
  let minArea: number;
  if (params.mode === 'posterize') {
    const lv = posterLevels(d);
    labels = new Int32Array(n);
    for (let p = 0; p < n; p++) labels[p] = posterCode(P.L[p], P.A[p], P.B[p], lv);
    minArea = Math.max(4, Math.round(n * 0.002 * 0.6 ** d));
    fixed = posterColors(lv);
  } else {
    const s = Math.max(1, Math.ceil(Math.sqrt(n / SEG_MAX_PX))), small = s > 1 ? shrink(P, w, h, s) : { P, w, h };
    const sw = small.w, sh = small.h, sn = sw * sh;
    let coarse: Int32Array;
    if (params.mode === 'graph') {
      coarse = felzenszwalb(small.P, sw, sh, 2000 * 0.65 ** d, Math.max(8, Math.round(sn * 0.0006 * 1.6 ** (4 - d))));
    } else {
      const k = segmentsFor(d), c = absorbSmall(slic(small.P, sw, sh, k), sw, sh, Math.max(4, Math.round(sn / k / 4)));
      progress?.(0.5, 'merge');
      coarse = mergeSimilar(c.comp, c.count, sw, sh, small.P, MERGE_DE[d], (8 * sn) / k);
    }
    progress?.(0.6, 'refine');
    labels = s > 1 ? refine(coarse, sw, sh, s, P, w, h, small.P) : coarse;
    minArea = Math.max(4, Math.round(n * 0.00003));
  }
  const t1 = now();
  progress?.(0.75, 'merge');
  const { comp, count } = absorbSmall(labels, w, h, minArea);
  // Posterize paints a region with the level of its mean colour: absorbed noise can make
  // the surviving label arbitrary, the mean is not.
  let level: Int32Array | null = null;
  if (fixed) {
    const lv = posterLevels(d), { mean } = regionLab(comp, count, P);
    level = new Int32Array(count);
    for (let c = 0; c < count; c++) level[c] = posterCode(mean[c * 3], mean[c * 3 + 1], mean[c * 3 + 2], lv);
  }
  const t2 = now();
  progress?.(0.85, 'paint');

  // Dark elements: unsmoothed L* well below the patch's L*. Patches then average without them.
  const lab0 = input.lab0 ?? lab8, px0 = input.px0 ?? px;
  let ink: Uint8Array | null = null, inkN = 0;
  if (params.keepDark) {
    const { mean } = regionLab(comp, count, P);
    ink = new Uint8Array(n);
    const lim = params.darkDelta * 2.55;
    for (let p = 0; p < n; p++) if (lab0[p * 4] < mean[comp[p] * 3] * 2.55 - lim) { ink[p] = 1; inkN++; }
  }
  // Mean colour per region in linear RGB (patches) and of its dark elements (ink).
  const lin = new Float64Array(count * 4), inkLin = ink ? new Float64Array(count * 4) : null;
  for (let p = 0, j = 0; p < n; p++, j += 4) {
    const o = comp[p] * 4;
    if (ink?.[p]) {
      inkLin![o] += SRGB_TO_LINEAR[px0[j]]; inkLin![o + 1] += SRGB_TO_LINEAR[px0[j + 1]]; inkLin![o + 2] += SRGB_TO_LINEAR[px0[j + 2]]; inkLin![o + 3]++;
    } else {
      lin[o] += SRGB_TO_LINEAR[px[j]]; lin[o + 1] += SRGB_TO_LINEAR[px[j + 1]]; lin[o + 2] += SRGB_TO_LINEAR[px[j + 2]]; lin[o + 3]++;
    }
  }
  const col = new Uint8ClampedArray(count * 3), inkCol = new Uint8ClampedArray(count * 3);
  for (let c = 0; c < count; c++) {
    const o = c * 4, m = lin[o + 3];
    if (level) col.set(fixed!.subarray(level[c] * 3, level[c] * 3 + 3), c * 3);
    else if (m) { col[c * 3] = enc(lin[o] / m); col[c * 3 + 1] = enc(lin[o + 1] / m); col[c * 3 + 2] = enc(lin[o + 2] / m); }
    if (inkLin && inkLin[o + 3]) { const k = inkLin[o + 3]; inkCol[c * 3] = enc(inkLin[o] / k); inkCol[c * 3 + 1] = enc(inkLin[o + 1] / k); inkCol[c * 3 + 2] = enc(inkLin[o + 2] / k); }
  }
  // A patch made entirely of ink (a thick line) has no patch colour: give it its ink colour.
  if (inkLin) for (let c = 0; c < count; c++) if (!lin[c * 4 + 3]) col.set(inkCol.subarray(c * 3, c * 3 + 3), c * 3);

  if (params.paletteLimit > 0) {
    // Patch colours and ink colours share the limit: items 0..count−1 are patches, count.. are inks.
    const k = params.paletteLimit, items = 2 * count, lab = new Float64Array(items * 3), wgt = new Float64Array(items);
    for (let c = 0; c < items; c++) {
      const src = c < count ? col : inkCol, i = c % count, m = c < count ? lin[i * 4 + 3] : inkLin?.[i * 4 + 3] ?? 0;
      if (c >= count && !m) continue;
      const [L, a, b] = labOf(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
      lab[c * 3] = L; lab[c * 3 + 1] = a; lab[c * 3 + 2] = b; wgt[c] = Math.sqrt(m || 1);
    }
    const cl = limitPalette(lab, wgt, k), acc = new Float64Array(k * 4);
    for (let c = 0; c < items; c++) {
      if (!wgt[c]) continue;
      const src = c < count ? col : inkCol, i = c % count, o = cl[c] * 4;
      for (let q = 0; q < 3; q++) acc[o + q] += SRGB_TO_LINEAR[src[i * 3 + q]] * wgt[c];
      acc[o + 3] += wgt[c];
    }
    for (let c = 0; c < items; c++) {
      if (!wgt[c]) continue;
      const dst = c < count ? col : inkCol, i = c % count, o = cl[c] * 4;
      for (let q = 0; q < 3; q++) dst[i * 3 + q] = enc(acc[o + q] / acc[o + 3]);
    }
  }


  const rgba = new Uint8ClampedArray(n * 4), seen = new Set<number>();
  for (let p = 0, j = 0; p < n; p++, j += 4) {
    const c = comp[p] * 3, src = ink?.[p] ? inkCol : col;
    rgba[j] = src[c]; rgba[j + 1] = src[c + 1]; rgba[j + 2] = src[c + 2]; rgba[j + 3] = 255;
  }
  for (let c = 0; c < count; c++) seen.add((col[c * 3] << 16) | (col[c * 3 + 1] << 8) | col[c * 3 + 2]);
  if (ink) for (let c = 0; c < count; c++) if (inkLin![c * 4 + 3]) seen.add((inkCol[c * 3] << 16) | (inkCol[c * 3 + 1] << 8) | inkCol[c * 3 + 2]);
  const t3 = now();
  progress?.(1, 'done');
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    rgba, labels: comp, regions: count, colors: seen.size, inkShare: inkN / n,
    ms: { segment: r1(t1 - t0), merge: r1(t2 - t1), paint: r1(t3 - t2), total: r1(t3 - t0) },
  };
}
