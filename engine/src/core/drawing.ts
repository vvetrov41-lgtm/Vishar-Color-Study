// Drawing: a line drawing of the photo with classic filters instead of the original's two
// 17 MB neural networks. Sketch = XDoG (Winnemöller et al. 2012): difference of two blurs
// with a soft threshold, keeps hatching and texture. Contours = Canny: gradient, thin edges,
// hysteresis, short fragments dropped; clean outlines of large shapes.
// Line (light ↔ dark) moves the threshold, Stroke (thin ↔ thick) the blur or line width.
// Everything here is O(n): blurs are three box passes, line width is a stamped disc.
// The expensive part (blurs, gradients) is cached per Stroke; Line only re-thresholds.

export type DrawingMode = 'sketch' | 'contours';

export interface DrawingParams {
  mode: DrawingMode;
  /** 0..100: more = darker, more lines. */
  line: number;
  /** 1..5: thin ↔ thick. */
  stroke: number;
  invert: boolean;
}

export const DEFAULT_DRAWING: DrawingParams = { mode: 'sketch', line: 50, stroke: 2, invert: false };

/** Sketch: sigma of the inner blur per Stroke step, px of a 1600 px working copy. */
export const SKETCH_SIGMA = [0.6, 0.9, 1.3, 1.9, 2.7];
/** Contours: pre-blur sigma, px of a 1600 px working copy. */
export const CANNY_SIGMA = 1.4;
const XDOG_K = 1.6;
const XDOG_PHI = 1.2;

/** L* plane (0..100) from the analysis buffer (L*·2.55 in the first byte of each pixel). */
export function lightness(lab8: ArrayLike<number>, n: number): Float32Array {
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = lab8[i * 4] / 2.55;
  return L;
}

/** Box widths whose three passes approximate a Gaussian of this sigma (Kovesi). */
function boxes(sigma: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  return [0, 1, 2].map((i) => (i < m ? wl : wu));
}

/** One horizontal + vertical running-sum box pass with clamped edges. */
function boxPass(src: Float32Array, dst: Float32Array, tmp: Float32Array, w: number, h: number, r: number) {
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = src[o] * (r + 1);
    for (let x = 1; x <= r; x++) acc += src[o + Math.min(w - 1, x)];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = acc / d;
      acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = tmp[x] * (r + 1);
    for (let y = 1; y <= r; y++) acc += tmp[Math.min(h - 1, y) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / d;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
}

/** Gaussian blur approximated by three box passes; sigma < 0.3 returns a copy. */
export function gauss(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const out = Float32Array.from(src);
  if (sigma < 0.3) return out;
  const tmp = new Float32Array(src.length);
  for (const b of boxes(sigma)) if (b > 1) boxPass(out, out, tmp, w, h, (b - 1) >> 1);
  return out;
}

const scaleOf = (w: number, h: number) => Math.max(w, h) / 1600;

/** XDoG field: inner blur minus outer blur. Negative = darker than surroundings = ink. */
export function dogField(L: Float32Array, w: number, h: number, stroke: number): Float32Array {
  const s = SKETCH_SIGMA[Math.min(4, Math.max(0, Math.round(stroke) - 1))] * Math.max(0.5, scaleOf(w, h));
  const g1 = gauss(L, w, h, s), g2 = gauss(L, w, h, s * XDOG_K);
  for (let i = 0; i < g1.length; i++) g1[i] -= g2[i];
  return g1;
}

/** Line 0..100 → XDoG epsilon in L* units: a pixel turns to ink below −eps. */
export const sketchEps = (line: number) => 0.15 + 3 * (1 - Math.min(100, Math.max(0, line)) / 100) ** 2;

/** Local darkness: L* minus a wide blur. A thick black outline is far below its surroundings
 *  across its whole width, so it stays solid instead of turning into two thin lines along its
 *  edges; a dark but flat background is not. */
export const FILL_SIGMA = 8;
export function localDark(L: Float32Array, w: number, h: number): Float32Array {
  const g = gauss(L, w, h, FILL_SIGMA * Math.max(0.5, scaleOf(w, h)));
  for (let i = 0; i < g.length; i++) g[i] = L[i] - g[i];
  return g;
}

/** Line 0..100 → how far below its surroundings (L*) a pixel must be to count as filled ink. */
export const sketchFill = (line: number) => 10 + 30 * (1 - Math.min(100, Math.max(0, line)) / 100) ** 2;

/** Sketch tone per pixel, 0 = full stroke, 1 = paper. */
export function sketchTone(dog: Float32Array, local: Float32Array, line: number, out: Float32Array = new Float32Array(dog.length)): Float32Array {
  const eps = sketchEps(line), fillAt = sketchFill(line);
  for (let i = 0; i < dog.length; i++) {
    const u = dog[i] + eps, edge = u >= 0 ? 1 : Math.max(0, 1 + Math.tanh(XDOG_PHI * u));
    const fill = Math.min(1, Math.max(0, (local[i] + fillAt + 3) / 6));
    out[i] = Math.min(edge, fill);
  }
  return out;
}

export interface Gradient { mag: Float32Array; nms: Float32Array }

/** Canny front end: blur, Sobel, non-maximum suppression. Cached by the caller. */
export function cannyGradient(L: Float32Array, w: number, h: number): Gradient {
  const s = gauss(L, w, h, CANNY_SIGMA * Math.max(0.5, scaleOf(w, h))), n = w * h;
  const mag = new Float32Array(n), dir = new Uint8Array(n), nms = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x, a = s[p - w - 1], b = s[p - w], c = s[p - w + 1], d = s[p - 1], f = s[p + 1], g = s[p + w - 1], i = s[p + w], j = s[p + w + 1];
    const gx = c + 2 * f + j - a - 2 * d - g, gy = g + 2 * i + j - a - 2 * b - c;
    mag[p] = Math.sqrt(gx * gx + gy * gy) / 4;
    // Direction quantised to 0°, 45°, 90°, 135°.
    const t = Math.atan2(gy, gx) * (180 / Math.PI), an = t < 0 ? t + 180 : t;
    dir[p] = an < 22.5 || an >= 157.5 ? 0 : an < 67.5 ? 1 : an < 112.5 ? 2 : 3;
  }
  const off = [1, w + 1, w, w - 1];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x, o = off[dir[p]], m = mag[p];
    if (m > 0 && m >= mag[p + o] && m > mag[p - o]) nms[p] = m;
  }
  return { mag, nms };
}

/** Line 0..100 → Canny high threshold (L* per px); the low one is 40 % of it. */
export const cannyHigh = (line: number) => 0.6 + 9 * (1 - Math.min(100, Math.max(0, line)) / 100) ** 1.5;

/** Hysteresis + removal of fragments shorter than minLen pixels; returns a 0/1 edge mask. */
export function hysteresis(nms: Float32Array, w: number, h: number, line: number, minLen: number): Uint8Array {
  const hi = cannyHigh(line), lo = hi * 0.4, n = w * h, out = new Uint8Array(n), stack = new Int32Array(n);
  const comp: number[] = [];
  for (let s = 0; s < n; s++) {
    if (out[s] || nms[s] < hi) continue;
    let sp = 0;
    comp.length = 0;
    stack[sp++] = s;
    out[s] = 1;
    while (sp) {
      const p = stack[--sp], x = p % w;
      comp.push(p);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const q = p + dy * w + dx;
        if ((!dx && !dy) || x + dx < 0 || x + dx >= w || q < 0 || q >= n || out[q] || nms[q] < lo) continue;
        out[q] = 1;
        stack[sp++] = q;
      }
    }
    // Speckle: a short isolated fragment is noise, not an outline.
    if (comp.length < minLen) for (const p of comp) out[p] = 2;
  }
  for (let p = 0; p < n; p++) if (out[p] === 2) out[p] = 0;
  return out;
}

/** Contour line radius per Stroke step, px of a 1600 px working copy (0 = 1 px line). */
export const CONTOUR_RADIUS = [0, 0.8, 1.5, 2.3, 3.2];

/** Edge mask thickened to the Stroke width: a disc stamped on every edge pixel. */
export function thicken(edges: Uint8Array, w: number, h: number, stroke: number): Uint8Array {
  const r = CONTOUR_RADIUS[Math.min(4, Math.max(0, Math.round(stroke) - 1))] * Math.max(0.5, scaleOf(w, h));
  if (r < 0.5) return edges;
  const R = Math.ceil(r), lim = (r + 0.25) ** 2, dx: number[] = [], dy: number[] = [];
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) if (x * x + y * y <= lim && (x || y)) { dx.push(x); dy.push(y); }
  const out = Uint8Array.from(edges), m = dx.length;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!edges[y * w + x]) continue;
    for (let k = 0; k < m; k++) {
      const xx = x + dx[k], yy = y + dy[k];
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
    }
  }
  return out;
}

/** Minimum fragment length for Contours, px of a 1600 px working copy. */
export const MIN_FRAGMENT = 12;

/** Ink coverage 0..1 per pixel (1 = full stroke) → RGBA, black on white or inverted. */
export function paint(ink: ArrayLike<number>, invert: boolean, out: Uint8ClampedArray = new Uint8ClampedArray(ink.length * 4)): Uint8ClampedArray {
  const u32 = new Uint32Array(out.buffer, out.byteOffset, ink.length), lut = new Uint32Array(256);
  // One 32-bit store per pixel (little-endian RGBA = grey, grey, grey, 255).
  for (let v = 0; v < 256; v++) lut[v] = (0xff000000 | (v << 16) | (v << 8) | v) >>> 0;
  for (let i = 0; i < ink.length; i++) u32[i] = lut[Math.round(255 * (invert ? ink[i] : 1 - ink[i]))];
  return out;
}

export interface DrawingResult {
  /** Ink coverage per pixel, 0..1. */
  ink: Float32Array;
  rgba: Uint8ClampedArray;
  /** Share of pixels that are mostly ink (> 0.5). */
  inkShare: number;
}

/** Caches the per-Stroke work so a Line change costs one threshold pass. */
/**
 * Caches the per-Stroke work so a Line change costs one threshold pass. The ink and RGBA
 * buffers are reused between renders: a result stays valid only until the next render().
 */
export class DrawingCache {
  private dog = new Map<number, Float32Array>();
  private grad: Gradient | null = null;
  private local: Float32Array | null = null;
  private ink: Float32Array;
  private rgba: Uint8ClampedArray;
  constructor(readonly L: Float32Array, readonly w: number, readonly h: number) {
    this.ink = new Float32Array(w * h);
    this.rgba = new Uint8ClampedArray(w * h * 4);
  }

  render(p: DrawingParams): DrawingResult {
    const { L, w, h, ink } = this, n = w * h;
    if (p.mode === 'sketch') {
      let dog = this.dog.get(p.stroke);
      if (!dog) this.dog.set(p.stroke, (dog = dogField(L, w, h, p.stroke)));
      this.local ??= localDark(L, w, h);
      sketchTone(dog, this.local, p.line, ink);
      for (let i = 0; i < n; i++) ink[i] = 1 - ink[i];
    } else {
      this.grad ??= cannyGradient(L, w, h);
      const minLen = Math.max(3, Math.round(MIN_FRAGMENT * scaleOf(w, h)));
      const mask = thicken(hysteresis(this.grad.nms, w, h, p.line, minLen), w, h, p.stroke);
      for (let i = 0; i < n; i++) ink[i] = mask[i];
    }
    let dark = 0;
    for (let i = 0; i < n; i++) if (ink[i] > 0.5) dark++;
    return { ink, rgba: paint(ink, p.invert, this.rgba), inkShare: dark / n };
  }
}
