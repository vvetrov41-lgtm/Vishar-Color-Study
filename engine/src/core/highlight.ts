// Highlight: shows where a colour occurs. A pixel matches when its ΔE2000 to the target
// is within the tolerance. 'highlight' keeps matching pixels and fades the rest to grey,
// 'outline' keeps the photo and draws a dashed contour around the matching areas.

import { deltaE2000, type Lab } from './colorinfo';
import type { Grid } from './palette';

export type HighlightMode = 'highlight' | 'outline';

export interface HighlightParams {
  /** Colour to look for (from the pipette or a swatch); null = nothing picked yet. */
  target: Lab | null;
  /** ΔE2000, 0..50. */
  tolerance: number;
  mode: HighlightMode;
}

export const DEFAULT_HIGHLIGHT: HighlightParams = { target: null, tolerance: 10, mode: 'highlight' };
export const HIGHLIGHT_MODE_CODE: Record<HighlightMode, number> = { highlight: 0, outline: 1 };
/** Outline dashes: period in pixels, half white and half black, readable on any colour. */
export const DASH = 8;

/** ΔE2000 to the target over the grid, 1-unit bins 0..100 (the last bin holds everything above). */
export function deltaHistogram(g: Grid, target: Lab): Float64Array {
  const h = new Float64Array(101), p: Lab = [0, 0, 0];
  for (let s = 0; s < g.n; s++) {
    p[0] = g.lab[s * 3]; p[1] = g.lab[s * 3 + 1]; p[2] = g.lab[s * 3 + 2];
    h[Math.min(100, Math.floor(deltaE2000(p, target)))]++;
  }
  return h;
}

/** Share of the photo within the tolerance, read from the histogram. */
export function matchedShare(h: ArrayLike<number>, tolerance: number): number {
  let inside = 0, total = 0;
  for (let i = 0; i < h.length; i++) { total += h[i]; if (i < tolerance) inside += h[i] * Math.min(1, tolerance - i); }
  return total ? inside / total : 0;
}
