import { histQuantile, histTotal, type Scale } from './histogram';
import { levelOf } from './values';

/**
 * 'otsu'   maximises between-class variance (default: works on sketches with a lot of paper).
 * 'median' the original's rule: half of the pixels dark, half light.
 * 'auto'   median, unless the median lands inside a dominant flat tone (paper, studio
 *          background), where it splits the background into noise; then Otsu.
 */
export type NotanMode = 'otsu' | 'median' | 'auto';

export interface NotanParams {
  scale: Scale;
  mode: NotanMode;
  /** Threshold shift in % of the tone range, −50..50. Positive = more dark. */
  balance: number;
  levels: 2 | 3;
  invert: boolean;
}

export const DEFAULT_NOTAN: NotanParams = { scale: 'lstar', mode: 'otsu', balance: 0, levels: 2, invert: false };

/** Median bin; pixels with v ≥ median are light, as in the original. Returned as a boundary. */
export function medianThreshold(hist: ArrayLike<number>): number {
  return histQuantile(hist, 0.5) - 0.5;
}

/** Otsu on 256 bins; bins ≤ t are dark. Returned as a boundary t + 0.5. */
export function otsuThreshold(hist: ArrayLike<number>): number {
  const n = histTotal(hist);
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let wB = 0, sB = 0, best = -1, t = 127;
  for (let v = 0; v < 255; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sB += v * hist[v];
    const mB = sB / wB, mF = (sum - sB) / wF, b = wB * wF * (mB - mF) ** 2;
    if (b > best) { best = b; t = v; }
  }
  return t + 0.5;
}

/** Three-class Otsu: two boundaries maximising between-class variance. */
export function otsu3Thresholds(hist: ArrayLike<number>): [number, number] {
  const P = new Float64Array(257), S = new Float64Array(257);
  for (let v = 0; v < 256; v++) { P[v + 1] = P[v] + hist[v]; S[v + 1] = S[v] + v * hist[v]; }
  const term = (a: number, b: number) => { // bins a..b inclusive
    const w = P[b + 1] - P[a];
    return w > 0 ? (S[b + 1] - S[a]) ** 2 / w : 0;
  };
  let best = -1, t1 = 84, t2 = 170;
  for (let i = 0; i < 254; i++) {
    const a = term(0, i);
    for (let j = i + 1; j < 255; j++) {
      const v = a + term(i + 1, j) + term(j + 1, 255);
      if (v > best) { best = v; t1 = i; t2 = j; }
    }
  }
  return [t1 + 0.5, t2 + 0.5];
}

/** True when the median sits inside one dominant tone (±4 bins hold over 25 % of pixels). */
export function medianInFlatTone(hist: ArrayLike<number>): boolean {
  const m = histQuantile(hist, 0.5), total = histTotal(hist);
  let near = 0;
  for (let v = Math.max(0, m - 4); v <= Math.min(255, m + 4); v++) near += hist[v];
  return total > 0 && near / total > 0.25;
}

export interface NotanResult {
  thresholds: number[];
  modeUsed: 'otsu' | 'median';
  /** Share of pixels per output level, darkest first. */
  share: number[];
}

export function notanThresholds(hist: ArrayLike<number>, p: NotanParams): NotanResult {
  const modeUsed = p.mode === 'auto' ? (medianInFlatTone(hist) ? 'otsu' : 'median') : p.mode;
  let t: number[];
  if (p.levels === 3) {
    t = modeUsed === 'otsu' ? otsu3Thresholds(hist) : [histQuantile(hist, 1 / 3) - 0.5, histQuantile(hist, 2 / 3) - 0.5];
  } else {
    t = [modeUsed === 'otsu' ? otsuThreshold(hist) : medianThreshold(hist)];
  }
  const shift = p.balance * 2.55;
  t = t.map((v) => Math.min(255.5, Math.max(-0.5, v + shift)));
  const share = new Array(t.length + 1).fill(0);
  const total = histTotal(hist) || 1;
  for (let v = 0; v < 256; v++) if (hist[v]) share[levelOf(v, t)] += hist[v] / total;
  return { thresholds: t, modeUsed, share };
}
