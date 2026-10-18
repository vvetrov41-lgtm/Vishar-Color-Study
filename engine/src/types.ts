import type { ColorInfo } from './core/colorinfo';
import type { ImageInfo } from './core/imageinfo';
import type { Palette } from './core/palette';
import type { ViewStats } from './core/view';

export interface Caps {
  /** 'canvas' = the page's <canvas> was transferred to the Worker; 'bitmap' = frames come back as ImageBitmap. */
  present: 'canvas' | 'bitmap';
  maxTextureSize: number;
  renderer: string;
}

export interface OpenOptions {
  /** Long side of the working copy, px. */
  workLong?: number;
  /** Memory budget for a fallback full decode, MB. */
  budgetMB?: number;
}

export interface OpenResult {
  info: ImageInfo & { sizeFrom: 'header' | 'probe' };
  work: { width: number; height: number };
  /** Rung of the degradation ladder that succeeded: 0 = requested size. */
  step: number;
  method: 'decode-to-size' | 'full-decode+downscale';
  warnings: string[];
  timings: Record<string, number>;
}

export interface ViewResult {
  stats: ViewStats;
  /** Histogram behind the current view: tone scale for Values/Notan, warmth + 128 for Temperature. */
  hist: number[];
  /** histMs: ΔE histogram for a new Highlight target (0 when cached). */
  timings: { analyzeMs: number; planMs: number; renderMs: number; totalMs: number; histMs: number };
  /** Image rect inside the canvas, 0..1 of its size: maps markers and taps. */
  rect: { x: number; y: number; w: number; h: number };
  work: { width: number; height: number };
  frame?: ImageBitmap;
  /** Filled on the main thread: postMessage round trip including the render. */
  roundTripMs?: number;
}

export interface ParityCase {
  fixture: string;
  name: string;
  /** Mean squared L* difference between GPU output and the CPU reference. */
  mseL: number;
  /** Share of pixels where any channel differs by more than 2. */
  mismatch: number;
  maxDiff: number;
  pass: boolean;
}

export interface CompatCase {
  fixture: string;
  ours: number[];
  original: number[];
  /** Share of pixels on the same Values level as the original's thresholds. */
  agreement: number;
}

export interface ParityReport {
  cases: ParityCase[];
  compat: CompatCase[];
  histogramMaxShareDiff: number;
  pass: boolean;
  ms: number;
}

export interface PaletteResult extends Palette {
  /** Read-back + grid + extraction, ms; readMs and gridMs are 0 when cached for this photo. */
  totalMs: number;
  readMs: number;
  gridMs: number;
}

export interface PickResult {
  /** Pixel of the working copy at the centre of the sample. */
  x: number;
  y: number;
  size: number;
  info: ColorInfo;
  /** Loupe: LOUPE×LOUPE pixels around the point, RGBA. */
  patch: Uint8Array;
  ms: number;
}
