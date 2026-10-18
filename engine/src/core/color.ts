// Colour math shared by the CPU reference, the histograms and (as GLSL twins in
// gpu/shaders.ts) the GPU passes. sRGB D65, CIE L*a*b*, Rec.601 luma.
// Keep the constants identical in both places: the parity self-test compares them.

export const EPS = 216 / 24389;
export const KAPPA = 24389 / 27;
const XN = 0.95047;
const ZN = 1.08883;

export const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const f = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const finv = (v: number) => (v ** 3 > EPS ? v ** 3 : (116 * v - 16) / KAPPA);

/** 8-bit sRGB → [L*, a*, b*]. */
export function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = SRGB_TO_LINEAR[r], gl = SRGB_TO_LINEAR[g], bl = SRGB_TO_LINEAR[b];
  const x = (0.4124 * rl + 0.3576 * gl + 0.1805 * bl) / XN;
  const y = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
  const z = (0.0193 * rl + 0.1192 * gl + 0.9505 * bl) / ZN;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Rec.601 luma on gamma-encoded values, 0..255. This is what the original app thresholds. */
export const luma601 = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

const enc = (c: number) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(255 * Math.min(1, Math.max(0, v)));
};

/** [L*, a*, b*] → 8-bit sRGB, clipped to the gamut. */
export function labToSrgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = finv(fx) * XN, y = finv(fy), z = finv(fz) * ZN;
  return [
    enc(3.2406 * x - 1.5372 * y - 0.4986 * z),
    enc(-0.9689 * x + 1.8758 * y + 0.0415 * z),
    enc(0.0557 * x - 0.204 * y + 1.057 * z),
  ];
}

/** Grey level (0..255) whose L* equals L. */
export function lstarToGray(L: number): number {
  return enc(finv((Math.min(100, Math.max(0, L)) + 16) / 116));
}

/** L* of a neutral grey 0..255 (fractional input allowed). */
export function grayToLstar(g: number): number {
  const c = Math.min(1, Math.max(0, g / 255));
  const lin = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 116 * f(lin) - 16;
}

/** Warmth axis: projection of (a*, b*) on hue 60° (orange). Positive = warm. */
export const WARM_X = Math.cos(Math.PI / 3);
export const WARM_Y = Math.sin(Math.PI / 3);
export const warmth = (a: number, b: number) => a * WARM_X + b * WARM_Y;
