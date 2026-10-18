import { grayToLstar, lstarToGray } from './color';
import { histRange, type Scale } from './histogram';

/**
 * 'kmeans'      1-D k-means on the 256-bin histogram, weight = pixel count.
 *               With scale 'luma' it runs exactly as the original does: compatibility mode
 *               (99.8–100 % of pixels on three test photos, 89.9 % on the landscape).
 * 'kmeans-sqrt' same, weight = √count: rare tones (thin lines, highlights) get their own level.
 * 'even'        equal intervals over 0..255 (the original with Smart Grouping off).
 */
export type ValuesMethod = 'kmeans' | 'kmeans-sqrt' | 'even';

export interface ValuesParams {
  levels: number; // 2..20
  scale: Scale;
  method: ValuesMethod;
  /** Shift of every output level in L* units, −50..50. */
  brightness: number;
  /** Tint each level with the source hue and chroma. */
  showHue: boolean;
  /** Level to emphasise (tap on the image), −1 = none. */
  highlight: number;
}

export const DEFAULT_VALUES: ValuesParams = {
  levels: 9,
  scale: 'lstar',
  method: 'kmeans',
  brightness: 0,
  showHue: false,
  highlight: -1,
};

/**
 * 1-D k-means on a histogram. 'linear' mirrors experiments/original_web/src/a2.py km1d
 * (centres spread between the darkest and the lightest non-empty bin), which is what
 * reproduces the original. 'quantile' starts from equal-count quantiles, as the Node
 * prototype does.
 */
export function kmeans1d(hist: ArrayLike<number>, k: number, weight: 'count' | 'sqrt', init: 'linear' | 'quantile' = 'linear', iters = 100): number[] {
  const n = hist.length;
  const w = new Float64Array(n);
  for (let v = 0; v < n; v++) w[v] = weight === 'sqrt' ? Math.sqrt(hist[v]) : hist[v];
  let c: number[];
  if (init === 'quantile') {
    const total = w.reduce((a, b) => a + b, 0);
    c = [];
    let acc = 0, q = 1;
    for (let v = 0; v < n && c.length < k; v++) {
      acc += w[v];
      while (acc >= ((q - 0.5) * total) / k && c.length < k) { c.push(v); q++; }
    }
    while (c.length < k) c.push(n - 1);
  } else {
    const [lo, hi] = histRange(hist);
    c = Array.from({ length: k }, (_, j) => (k === 1 ? lo : lo + ((hi - lo) * j) / (k - 1)));
  }
  for (let it = 0; it < iters; it++) {
    const s = new Float64Array(k), m = new Float64Array(k);
    for (let v = 0; v < n; v++) {
      let bi = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = Math.abs(v - c[j]);
        if (d < bd) { bd = d; bi = j; }
      }
      s[bi] += w[v] * v;
      m[bi] += w[v];
    }
    const nc = c.map((cv, j) => (m[j] > 0 ? s[j] / m[j] : cv));
    const done = nc.every((v, j) => Math.abs(v - c[j]) <= 1e-8 + 1e-5 * Math.abs(c[j]));
    c = nc;
    if (done) break;
  }
  return c.sort((a, b) => a - b);
}

/** Weighted squared error of a set of centres against the histogram. */
export function kmeansError(hist: ArrayLike<number>, centres: number[], weight: 'count' | 'sqrt'): number {
  let e = 0;
  for (let v = 0; v < hist.length; v++) {
    if (!hist[v]) continue;
    let b = Infinity;
    for (const c of centres) b = Math.min(b, (v - c) ** 2);
    e += b * (weight === 'sqrt' ? Math.sqrt(hist[v]) : hist[v]);
  }
  return e;
}

/**
 * k−1 thresholds in scale units (0..255). A value v belongs to level = #(t < v).
 * compat = true keeps the original's linear init only; otherwise both inits run and the
 * better fit wins, so a stuck local optimum never reaches the user.
 */
export function valuesThresholds(hist: ArrayLike<number>, p: Pick<ValuesParams, 'levels' | 'method'>, compat = false): number[] {
  const k = Math.max(2, Math.min(20, Math.round(p.levels)));
  if (p.method === 'even') return Array.from({ length: k - 1 }, (_, i) => (255 * (i + 1)) / k);
  const weight = p.method === 'kmeans-sqrt' ? 'sqrt' : 'count';
  let c = kmeans1d(hist, k, weight, 'linear');
  if (!compat) {
    const q = kmeans1d(hist, k, weight, 'quantile');
    if (kmeansError(hist, q, weight) < kmeansError(hist, c, weight)) c = q;
  }
  return c.slice(1).map((v, j) => (c[j] + v) / 2);
}

export function levelOf(v: number, thresholds: ArrayLike<number>): number {
  let j = 0;
  while (j < thresholds.length && v > thresholds[j]) j++;
  return j;
}

export interface LevelStats {
  /** Output grey per level, 0..255 (after brightness). */
  gray: number[];
  /** L* of that grey; Show Hue keeps the source a*b* with this lightness. */
  lstar: number[];
  /** Share of pixels per level, 0..1. */
  share: number[];
}

/**
 * Representative tone of each level = mean of the scale inside the level. With 'luma'
 * the output grey equals the mean luma, as in the original's exports.
 */
export function levelStats(hist: ArrayLike<number>, thresholds: number[], scale: Scale, brightness = 0): LevelStats {
  const k = thresholds.length + 1;
  const s = new Float64Array(k), m = new Float64Array(k);
  let total = 0;
  for (let v = 0; v < hist.length; v++) {
    if (!hist[v]) continue;
    const j = levelOf(v, thresholds);
    s[j] += v * hist[v];
    m[j] += hist[v];
    total += hist[v];
  }
  const gray: number[] = [], lstar: number[] = [], share: number[] = [];
  for (let j = 0; j < k; j++) {
    const lo = j === 0 ? 0 : thresholds[j - 1], hi = j === k - 1 ? 255 : thresholds[j];
    const mean = m[j] ? s[j] / m[j] : (lo + hi) / 2;
    let L = scale === 'lstar' ? mean / 2.55 : grayToLstar(mean);
    if (brightness) L = Math.min(100, Math.max(0, L + brightness));
    lstar.push(L);
    gray.push(scale === 'luma' && !brightness ? mean : lstarToGray(L));
    share.push(total ? m[j] / total : 0);
  }
  return { gray, lstar, share };
}
