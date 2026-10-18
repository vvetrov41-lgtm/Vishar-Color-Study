import { WARM_X, WARM_Y } from './color';

/** Tone scale used by Values and Notan. Both are expressed in 0..255 units:
 *  'lstar' = L* × 2.55, 'luma' = Rec.601 luma (compatibility with the original). */
export type Scale = 'lstar' | 'luma';

export interface Histograms {
  lstar: Float64Array;
  luma: Float64Array;
  /** Warmth + 128, one bin per unit of the warmth axis. */
  warmth: Float64Array;
  count: number;
}

/**
 * Histograms from the analysis buffer the GPU writes:
 * RGBA8 per pixel = (L*·2.55, a*+128, b*+128, luma601).
 */
export function histogramsFromLab8(lab8: Uint8Array | Uint8ClampedArray): Histograms {
  const lstar = new Float64Array(256), luma = new Float64Array(256), warm = new Float64Array(256);
  const n = lab8.length >> 2;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    lstar[lab8[j]]++;
    luma[lab8[j + 3]]++;
    const w = Math.round((lab8[j + 1] - 128) * WARM_X + (lab8[j + 2] - 128) * WARM_Y) + 128;
    warm[w < 0 ? 0 : w > 255 ? 255 : w]++;
  }
  return { lstar, luma, warmth: warm, count: n };
}

export function histTotal(h: ArrayLike<number>): number {
  let t = 0;
  for (let i = 0; i < h.length; i++) t += h[i];
  return t;
}

/** Smallest bin v with cumulative share ≥ q (0..1). */
export function histQuantile(h: ArrayLike<number>, q: number): number {
  const total = histTotal(h);
  let acc = 0;
  for (let v = 0; v < h.length; v++) {
    acc += h[v];
    if (acc >= q * total && acc > 0) return v;
  }
  return h.length - 1;
}

export function histRange(h: ArrayLike<number>): [number, number] {
  let lo = 0, hi = h.length - 1;
  while (lo < hi && !h[lo]) lo++;
  while (hi > lo && !h[hi]) hi--;
  return [lo, hi];
}
