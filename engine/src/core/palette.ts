// Palette extraction from the working copy: Dominant (by area), Range (equal L* steps
// between the 1st and 99th percentile) and Accents (saturated colours that differ from
// the dominant ones). Every swatch carries a marker: the point of the photo where that
// colour actually is, so the UI can draw a numbered dot and a line to the swatch.

import { SRGB_TO_LINEAR, srgbToLab } from './color';
import { deltaE2000, hex, type Lab, type Rgb } from './colorinfo';

export interface PaletteParams {
  dominant: number; // 3..12
  range: number; // 3..12
  accents: number; // 0..12
  /** Dominant colours closer than this ΔE2000 are merged; 0 = plain k-means, as the original. */
  mergeDE: number;
}

export const DEFAULT_PALETTE: PaletteParams = { dominant: 6, range: 12, accents: 6, mergeDE: 6 };

export interface Swatch {
  rgb: Rgb;
  lab: Lab;
  hex: string;
  /** Share of the photo this swatch stands for. */
  share: number;
  /** Marker position, 0..1 of the working copy, top-left origin, and the pipette size
   *  (5, 3 or 1 px) that returns exactly this swatch there. */
  marker: { x: number; y: number; size: number };
  /** ΔE2000 between the swatch (a real colour at the marker) and the mean of its group. */
  markerDE: number;
}

export interface Palette {
  dominant: Swatch[];
  range: Swatch[];
  accents: Swatch[];
  ms: number;
}

/** Grid sample of the working copy: ~GRID_TARGET points, Lab per point. */
export interface Grid {
  w: number;
  h: number;
  step: number;
  n: number;
  lab: Float32Array;
  /** Pixel index (y·w + x) of each point. */
  pos: Uint32Array;
}

export const GRID_TARGET = 200_000;

export function sampleGrid(px: Uint8Array | Uint8ClampedArray, w: number, h: number, target = GRID_TARGET): Grid {
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / target)));
  const o = step >> 1, gw = Math.ceil((w - o) / step), gh = Math.ceil((h - o) / step), n = gw * gh;
  const lab = new Float32Array(n * 3), pos = new Uint32Array(n);
  let k = 0;
  for (let y = o; y < h; y += step) {
    for (let x = o; x < w; x += step, k++) {
      const p = y * w + x, j = p * 4, L = srgbToLab(px[j], px[j + 1], px[j + 2]);
      lab[k * 3] = L[0]; lab[k * 3 + 1] = L[1]; lab[k * 3 + 2] = L[2];
      pos[k] = p;
    }
  }
  return { w, h, step, n, lab, pos };
}

/** Deterministic PRNG (mulberry32): same photo, same palette. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means++ in Lab on a subset of points; returns k centres. */
function kmeansLab(lab: Float32Array, idx: Uint32Array, k: number, seed: number, iters = 10): Float64Array {
  const rand = rng(seed), n = idx.length, c = new Float64Array(k * 3), best = new Float64Array(n).fill(Infinity);
  // Points copied out once: the loops below touch only contiguous memory.
  const P = new Float64Array(n * 3);
  for (let s = 0; s < n; s++) { const i = idx[s] * 3; P[s * 3] = lab[i]; P[s * 3 + 1] = lab[i + 1]; P[s * 3 + 2] = lab[i + 2]; }
  const setC = (j: number, s: number) => { c[j * 3] = P[s * 3]; c[j * 3 + 1] = P[s * 3 + 1]; c[j * 3 + 2] = P[s * 3 + 2]; };
  setC(0, Math.floor(rand() * n));
  for (let j = 1; j < k; j++) {
    let sum = 0;
    const cl = c[(j - 1) * 3], ca = c[(j - 1) * 3 + 1], cb = c[(j - 1) * 3 + 2];
    for (let s = 0; s < n; s++) {
      const dl = P[s * 3] - cl, da = P[s * 3 + 1] - ca, db = P[s * 3 + 2] - cb, d = dl * dl + da * da + db * db;
      if (d < best[s]) best[s] = d;
      sum += best[s];
    }
    let r = rand() * sum, s = 0;
    while (s < n - 1 && (r -= best[s]) > 0) s++;
    setC(j, s);
  }
  const acc = new Float64Array(k * 4), lbl = new Uint8Array(n);
  for (let it = 0; it < iters; it++) {
    acc.fill(0);
    nearest(P, n, c, k, lbl);
    for (let s = 0; s < n; s++) {
      const j = lbl[s] * 4;
      acc[j] += P[s * 3]; acc[j + 1] += P[s * 3 + 1]; acc[j + 2] += P[s * 3 + 2]; acc[j + 3]++;
    }
    for (let j = 0; j < k; j++) {
      const m = acc[j * 4 + 3];
      if (m) { c[j * 3] = acc[j * 4] / m; c[j * 3 + 1] = acc[j * 4 + 1] / m; c[j * 3 + 2] = acc[j * 4 + 2] / m; }
    }
  }
  return c;
}

/** Index of the nearest centre for each of n points (flat Lab triples). */
function nearest(P: ArrayLike<number>, n: number, c: Float64Array, k: number, out: Uint8Array) {
  for (let s = 0; s < n; s++) {
    const L = P[s * 3], a = P[s * 3 + 1], b = P[s * 3 + 2];
    let bj = 0, bd = Infinity;
    for (let j = 0; j < k; j++) {
      const dl = L - c[j * 3], da = a - c[j * 3 + 1], db = b - c[j * 3 + 2], d = dl * dl + da * da + db * db;
      if (d < bd) { bd = d; bj = j; }
    }
    out[s] = bj;
  }
}

function assign(lab: Float32Array, idx: Uint32Array, c: Float64Array, k: number): Uint8Array {
  const out = new Uint8Array(idx.length), P = new Float32Array(idx.length * 3);
  idx.forEach((i, s) => { P[s * 3] = lab[i * 3]; P[s * 3 + 1] = lab[i * 3 + 1]; P[s * 3 + 2] = lab[i * 3 + 2]; });
  nearest(P, idx.length, c, k, out);
  return out;
}

function subsample(idx: Uint32Array, max: number, seed: number): Uint32Array {
  if (idx.length <= max) return idx;
  const rand = rng(seed), out = new Uint32Array(max);
  for (let i = 0; i < max; i++) out[i] = idx[Math.floor(rand() * idx.length)];
  return out;
}

// Math.hypot is several times slower than this in the hot loops below.
const len3 = (x: number, y: number, z = 0) => Math.sqrt(x * x + y * y + z * z);

const encode = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(255 * Math.min(1, Math.max(0, c)));
};

/** Mean colour of pixels, averaged in linear RGB (as light mixes). */
export function meanRgb(px: Uint8Array | Uint8ClampedArray, pixels: Iterable<number>): Rgb {
  let r = 0, g = 0, b = 0, n = 0;
  for (const p of pixels) {
    const j = p * 4;
    r += SRGB_TO_LINEAR[px[j]]; g += SRGB_TO_LINEAR[px[j + 1]]; b += SRGB_TO_LINEAR[px[j + 2]]; n++;
  }
  return n ? [encode(r / n), encode(g / n), encode(b / n)] : [0, 0, 0];
}

/** Pixels of a size×size square centred on (x, y), clipped to the image. */
export function* square(x: number, y: number, size: number, w: number, h: number) {
  const r = size >> 1;
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y - r + size - 1); yy++)
    for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x - r + size - 1); xx++) yield yy * w + xx;
}

/** Pipette sizes tried at a marker, with a penalty that prefers the larger, steadier sample. */
const MARKER_SIZES: Array<[number, number]> = [[5, 0], [3, 2], [1, 4]];
const MARKER_CANDIDATES = 120;

/**
 * Marker for a swatch among the given grid points. The closest colours are checked with
 * 5×5, 3×3 and 1 px samples; the spot that is both close to the target and uniform wins,
 * so a tap there returns this colour and not an edge between two colours. Thin strokes
 * (tattoo lines) end up with a 3 or 1 px sample.
 */
function findMarker(px: Uint8Array | Uint8ClampedArray, g: Grid, members: number[], target: Lab) {
  const dist = new Float32Array(members.length);
  let d0 = Infinity;
  for (let i = 0; i < members.length; i++) {
    const s = members[i], dl = g.lab[s * 3] - target[0], da = g.lab[s * 3 + 1] - target[1], db = g.lab[s * 3 + 2] - target[2];
    dist[i] = Math.sqrt(dl * dl + da * da + db * db);
    if (dist[i] < d0) d0 = dist[i];
  }
  let cand: number[] = [];
  for (let i = 0; i < members.length; i++) if (dist[i] <= d0 + 6) cand.push(members[i]);
  if (cand.length > MARKER_CANDIDATES) {
    const st = cand.length / MARKER_CANDIDATES;
    cand = Array.from({ length: MARKER_CANDIDATES }, (_, i) => cand[Math.floor(i * st)]);
  }
  // The 5×5 window of a candidate, computed once and reused for the 3×3 and 1 px samples.
  const win = { n: 0, ring: new Uint8Array(25), lin: new Float64Array(75), lab: new Float64Array(75) };
  let best = { s: members[0] ?? 0, size: 1, score: Infinity, rgb: [0, 0, 0] as Rgb };
  for (const s of cand) {
    const p = g.pos[s], x = p % g.w, y = (p / g.w) | 0;
    win.n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= g.w || yy >= g.h) continue;
      const j = (yy * g.w + xx) * 4, k = win.n++, l = srgbToLab(px[j], px[j + 1], px[j + 2]);
      win.ring[k] = Math.max(Math.abs(dx), Math.abs(dy));
      win.lin[k * 3] = SRGB_TO_LINEAR[px[j]]; win.lin[k * 3 + 1] = SRGB_TO_LINEAR[px[j + 1]]; win.lin[k * 3 + 2] = SRGB_TO_LINEAR[px[j + 2]];
      win.lab[k * 3] = l[0]; win.lab[k * 3 + 1] = l[1]; win.lab[k * 3 + 2] = l[2];
    }
    for (const [size, penalty] of MARKER_SIZES) {
      const r = size >> 1;
      let lr = 0, lg = 0, lb = 0, n = 0;
      for (let k = 0; k < win.n; k++) if (win.ring[k] <= r) { lr += win.lin[k * 3]; lg += win.lin[k * 3 + 1]; lb += win.lin[k * 3 + 2]; n++; }
      const m: Rgb = [encode(lr / n), encode(lg / n), encode(lb / n)], ml = srgbToLab(...m);
      let spread = 0;
      for (let k = 0; k < win.n; k++) if (win.ring[k] <= r) spread += len3(win.lab[k * 3] - ml[0], win.lab[k * 3 + 1] - ml[1], win.lab[k * 3 + 2] - ml[2]);
      const score = len3(ml[0] - target[0], ml[1] - target[1], ml[2] - target[2]) + (0.5 * spread) / n + penalty;
      if (score < best.score) best = { s, size, score, rgb: m };
    }
  }
  const p = g.pos[best.s];
  return { marker: { x: ((p % g.w) + 0.5) / g.w, y: (((p / g.w) | 0) + 0.5) / g.h, size: best.size }, rgb: best.rgb };
}

/** Lab mean of grid points: the colour a group of pixels stands for. */
function meanLab(g: Grid, members: number[]): Lab {
  let L = 0, a = 0, b = 0;
  for (const s of members) { L += g.lab[s * 3]; a += g.lab[s * 3 + 1]; b += g.lab[s * 3 + 2]; }
  const n = members.length || 1;
  return [L / n, a / n, b / n];
}

/** The swatch is the real colour at its marker; markerDE says how far it is from the group mean. */
function swatch(px: Uint8Array | Uint8ClampedArray, g: Grid, members: number[], share: number): Swatch {
  const target = meanLab(g, members), { marker, rgb } = findMarker(px, g, members, target), lab = srgbToLab(...rgb);
  return { rgb, lab, hex: hex(rgb), share: Math.round(share * 1e4) / 1e4, marker, markerDE: Math.round(deltaE2000(lab, target) * 10) / 10 };
}

const K_DOMINANT = 24;
const K_ACCENT = 16;
const FIT_SAMPLE = 16_000;

export function extractPalette(px: Uint8Array | Uint8ClampedArray, g: Grid, p: PaletteParams = DEFAULT_PALETTE): Palette {
  const t0 = performance.now(), all = new Uint32Array(g.n).map((_, i) => i);
  const k = Math.min(K_DOMINANT, g.n);
  const centres = kmeansLab(g.lab, subsample(all, FIT_SAMPLE, 1), k, 7);
  const label = new Uint8Array(g.n);
  nearest(g.lab, g.n, centres, k, label);
  const count = new Float64Array(k);
  for (let s = 0; s < g.n; s++) count[label[s]]++;
  const members = (pred: (s: number) => boolean) => { const out: number[] = []; for (let s = 0; s < g.n; s++) if (pred(s)) out.push(s); return out; };
  const centre = (j: number): Lab => [centres[j * 3], centres[j * 3 + 1], centres[j * 3 + 2]];

  // Dominant: largest clusters first; a cluster too close to a chosen one is merged into it.
  const order = [...count.keys()].filter((j) => count[j] > 0).sort((a, b) => count[b] - count[a]);
  const chosen: Array<{ seed: number; clusters: number[] }> = [];
  for (const j of order) {
    const near = p.mergeDE > 0 ? chosen.find((c) => deltaE2000(centre(c.seed), centre(j)) < p.mergeDE) : undefined;
    if (near) near.clusters.push(j);
    else if (chosen.length < p.dominant) chosen.push({ seed: j, clusters: [j] });
  }
  // Clusters left out of the palette count towards the nearest chosen swatch.
  for (const j of order) {
    if (chosen.some((c) => c.clusters.includes(j))) continue;
    let bi = 0, bd = Infinity;
    chosen.forEach((c, i) => { const d = deltaE2000(centre(c.seed), centre(j)); if (d < bd) { bd = d; bi = i; } });
    chosen[bi]?.clusters.push(j);
  }
  const dominant = chosen.map((c) => {
    const share = c.clusters.reduce((a, j) => a + count[j], 0) / g.n;
    return swatch(px, g, members((s) => label[s] === c.seed), share);
  });

  // Range: equal L* steps between p1 and p99; in each band the most common cluster gives the colour.
  // Points bucketed by L* in quarter units (counting sort): bands are read from buckets.
  const BQ = 4, NB = 100 * BQ + 1, start = new Uint32Array(NB + 1), byL = new Uint32Array(g.n);
  const bucket = (L: number) => Math.min(NB - 1, Math.max(0, Math.round(L * BQ)));
  for (let s = 0; s < g.n; s++) start[bucket(g.lab[s * 3]) + 1]++;
  for (let i = 0; i < NB; i++) start[i + 1] += start[i];
  const fill = start.slice(0, NB);
  for (let s = 0; s < g.n; s++) byL[fill[bucket(g.lab[s * 3])]++] = s;
  const atRank = (r: number) => g.lab[byL[Math.floor(r * (g.n - 1))] * 3];
  const band = (lo: number, hi: number) => Array.from(byL.subarray(start[bucket(lo)], start[bucket(hi) + 1]));

  // Range: equal L* steps between p1 and p99; in each band the most common cluster gives the colour.
  const lo = atRank(0.01), hi = atRank(0.99);
  const range: Swatch[] = [];
  const nr = Math.max(2, p.range), stepL = (hi - lo) / (nr - 1);
  for (let i = 0; i < nr; i++) {
    const t = lo + i * stepL;
    let half = Math.max(0.5, stepL / 2), pts: number[] = [];
    for (let tries = 0; tries < 5 && !pts.length; tries++, half *= 2) pts = band(t - half, t + half);
    if (!pts.length) continue;
    const votes = new Float64Array(k);
    for (const s of pts) votes[label[s]]++;
    const top = votes.indexOf(Math.max(...votes));
    range.push(swatch(px, g, pts.filter((s) => label[s] === top), pts.length / g.n));
  }

  // Accents: chromatic points far from every dominant colour, clustered on their own and
  // scored by chroma × distance to the dominant set × √share.
  const dom = dominant.map((d) => d.lab);
  const minDom = (l: Lab) => Math.min(...dom.map((d) => deltaE2000(d, l)));
  const cand: number[] = [];
  for (let s = 0; s < g.n; s++) {
    const a = g.lab[s * 3 + 1], b = g.lab[s * 3 + 2];
    if (a * a + b * b < 225) continue;
    let near = Infinity;
    for (const d of dom) {
      const dl = g.lab[s * 3] - d[0], da = a - d[1], db = b - d[2];
      near = Math.min(near, dl * dl + da * da + db * db);
    }
    if (near >= 225) cand.push(s);
  }
  const accents: Swatch[] = [];
  const minCount = Math.max(4, 0.0005 * g.n);
  if (p.accents > 0 && cand.length >= minCount) {
    const cidx = Uint32Array.from(cand), ka = Math.min(K_ACCENT, cand.length);
    const ac = kmeansLab(g.lab, subsample(cidx, FIT_SAMPLE / 2, 3), ka, 11);
    const al = assign(g.lab, cidx, ac, ka);
    const groups = Array.from({ length: ka }, () => [] as number[]);
    al.forEach((j, i) => groups[j].push(cand[i]));
    const scored = groups
      .filter((m) => m.length >= minCount)
      .map((m) => {
        const lab = meanLab(g, m);
        return { m, lab, score: len3(lab[1], lab[2]) * minDom(lab) * Math.sqrt(m.length / g.n) };
      })
      .sort((a, b) => b.score - a.score);
    for (const c of scored) {
      if (accents.length >= p.accents) break;
      if (accents.some((a) => deltaE2000(a.lab, c.lab) < 10)) continue;
      accents.push(swatch(px, g, c.m, c.m.length / g.n));
    }
  }
  return { dominant, range, accents, ms: Math.round(performance.now() - t0) };
}
