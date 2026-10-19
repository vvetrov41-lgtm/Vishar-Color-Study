// Skin tool: the design on one skin tone, calibrated for that tone. Each tone keeps its own
// calibration (brightness, contrast, shadows, highlights, saturation, warmth), so the artist
// can tune a version of the design for dark skin and another one for light skin. With «use»,
// the other tattoo tools (pigments first of all) work with the calibrated version.
// Skin is modelled as a multiplier in linear light: the ink layer is seen through the skin,
// so white all but disappears on dark skin. This is orientation, not a healing forecast.

import { enc, labToSrgb, SRGB_TO_LINEAR, srgbToLab } from './color';

/** Fitzpatrick I–VI, approximate sRGB of each skin type (orientation only). */
export const SKIN_TONES: Array<[number, number, number]> = [
  [243, 214, 193], [232, 188, 154], [208, 155, 118], [168, 114, 79], [122, 75, 48], [74, 44, 29],
];
/** Index of the user's own tone in SkinParams.cal (after I–VI). */
export const OWN_TONE = 6;

export interface Calibration {
  /** Midtones lighter (+) or darker (−), L*; black and white stay. */
  brightness: number;
  /** Contrast around L* 50, %. */
  contrast: number;
  /** Dark tones lighter (+) or deeper (−), L*. */
  shadows: number;
  /** Light tones lighter (+) or darker (−), L*. */
  highlights: number;
  /** Chroma, %. */
  saturation: number;
  /** Shift towards warm (+) or cool (−), b*. */
  warmth: number;
}

export const NEUTRAL: Calibration = { brightness: 0, contrast: 100, shadows: 0, highlights: 0, saturation: 100, warmth: 0 };

export interface SkinParams {
  /** 0..5 = Fitzpatrick I–VI, 6 = own tone. */
  tone: number;
  /** Own tone, sRGB. */
  own: [number, number, number];
  /** One calibration per tone, index as in `tone`. */
  cal: Calibration[];
  /** one: the chosen tone; compare: before | after on it; all: I–VI, each with its calibration. */
  show: 'one' | 'compare' | 'all';
  /** Other tattoo tools work with the version calibrated for the chosen tone. */
  use: boolean;
}

export const DEFAULT_SKIN: SkinParams = {
  tone: 5, own: [150, 100, 70], cal: Array.from({ length: 7 }, () => ({ ...NEUTRAL })), show: 'one', use: false,
};

export const skinRgb = (p: SkinParams): [number, number, number] => (p.tone === OWN_TONE ? p.own : SKIN_TONES[p.tone]) ?? SKIN_TONES[0];
export const isNeutral = (c: Calibration) => (Object.keys(NEUTRAL) as Array<keyof Calibration>).every((k) => c[k] === NEUTRAL[k]);
/** Calibration of the chosen tone. */
export const calOf = (p: SkinParams): Calibration => p.cal[p.tone] ?? NEUTRAL;

/** Calibrated colour, Lab in → Lab out. */
export function calibrateLab(L: number, a: number, b: number, c: Calibration): [number, number, number] {
  const t0 = Math.min(1, Math.max(0, L / 100));
  L += c.brightness * 4 * t0 * (1 - t0);
  L = 50 + (L - 50) * (c.contrast / 100);
  const t = Math.min(1, Math.max(0, L / 100));
  // Weights peak at L* 33 (shadows) and 67 (highlights) and vanish at black and white.
  L += c.shadows * 6.75 * t * (1 - t) ** 2 + c.highlights * 6.75 * t * t * (1 - t);
  const s = c.saturation / 100;
  return [Math.min(100, Math.max(0, L)), a * s + c.warmth * 0.25, b * s + c.warmth];
}

// The calibration is a smooth function of the colour, so it is tabulated on a 33³ grid of
// 8-bit sRGB and interpolated per pixel: exact on the grid, fast on 48 MP working copies.
const G = 33, STEP = 255 / (G - 1);
/** Channels per grid node: sRGB out (0..255), then lab8 (L*·2.55, a*+128, b*+128, luma). */
const CH = 7;

export class CalLut {
  readonly lut: Float32Array;
  constructor(readonly cal: Calibration) {
    this.lut = new Float32Array(G * G * G * CH);
    let o = 0;
    for (let ri = 0; ri < G; ri++) for (let gi = 0; gi < G; gi++) for (let bi = 0; bi < G; bi++) {
      const [L, a, b] = srgbToLab(Math.round(ri * STEP), Math.round(gi * STEP), Math.round(bi * STEP));
      const out = calibrateLab(L, a, b, cal), rgb = labToSrgb(...out);
      // Lab of the clipped colour, so lab8 matches the pixels exactly on the grid.
      const lab = srgbToLab(...rgb);
      this.lut.set([rgb[0], rgb[1], rgb[2], lab[0] * 2.55, lab[1] + 128, lab[2] + 128, 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]], o);
      o += CH;
    }
  }

  /** Trilinear lookup of one 8-bit colour into `out`: the first `ch` channels (3 = sRGB only, 7 = with lab8). */
  map(r: number, g: number, b: number, out: Float32Array, ch = CH) {
    const x = r / STEP, y = g / STEP, z = b / STEP;
    const x0 = Math.min(G - 2, x | 0), y0 = Math.min(G - 2, y | 0), z0 = Math.min(G - 2, z | 0);
    const fx = x - x0, fy = y - y0, fz = z - z0, L = this.lut;
    const p000 = ((x0 * G + y0) * G + z0) * CH, p001 = p000 + CH, p010 = p000 + G * CH, p011 = p010 + CH;
    const p100 = p000 + G * G * CH, p101 = p100 + CH, p110 = p100 + G * CH, p111 = p110 + CH;
    const w000 = (1 - fx) * (1 - fy) * (1 - fz), w001 = (1 - fx) * (1 - fy) * fz, w010 = (1 - fx) * fy * (1 - fz), w011 = (1 - fx) * fy * fz;
    const w100 = fx * (1 - fy) * (1 - fz), w101 = fx * (1 - fy) * fz, w110 = fx * fy * (1 - fz), w111 = fx * fy * fz;
    for (let c = 0; c < ch; c++) {
      out[c] = w000 * L[p000 + c] + w001 * L[p001 + c] + w010 * L[p010 + c] + w011 * L[p011 + c]
        + w100 * L[p100 + c] + w101 * L[p101 + c] + w110 * L[p110 + c] + w111 * L[p111 + c];
    }
  }
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0);

/** The design calibrated for one tone: RGBA pixels and the lab8 analysis buffer other tools read. */
export function calibrateImage(px: ArrayLike<number>, n: number, cal: Calibration): { px: Uint8Array; lab8: Uint8Array };
export function calibrateImage(px: ArrayLike<number>, n: number, cal: Calibration, withLab: false): { px: Uint8Array };
export function calibrateImage(px: ArrayLike<number>, n: number, cal: Calibration, withLab = true): { px: Uint8Array; lab8?: Uint8Array } {
  const lut = new CalLut(cal), outPx = new Uint8Array(n * 4), lab8 = withLab ? new Uint8Array(n * 4) : null, v = new Float32Array(CH);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    lut.map(px[j], px[j + 1], px[j + 2], v, lab8 ? CH : 3);
    outPx[j] = clamp8(v[0]); outPx[j + 1] = clamp8(v[1]); outPx[j + 2] = clamp8(v[2]); outPx[j + 3] = 255;
    if (lab8) { lab8[j] = clamp8(v[3]); lab8[j + 1] = clamp8(v[4]); lab8[j + 2] = clamp8(v[5]); lab8[j + 3] = clamp8(v[6]); }
  }
  return lab8 ? { px: outPx, lab8 } : { px: outPx };
}

/** A design on skin: every pixel multiplied onto the skin tone in linear light. */
export function onSkin(px: ArrayLike<number>, n: number, skin: readonly number[]): Uint8ClampedArray {
  const s = skin.map((v) => SRGB_TO_LINEAR[v]), out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[j] = enc(s[0] * SRGB_TO_LINEAR[px[j]]); out[j + 1] = enc(s[1] * SRGB_TO_LINEAR[px[j + 1]]); out[j + 2] = enc(s[2] * SRGB_TO_LINEAR[px[j + 2]]); out[j + 3] = 255;
  }
  return out;
}

export interface Tile { skin: readonly number[]; cal: Calibration }

/**
 * Tiles (cols × rows, left to right, top to bottom) on a white sheet of the image's size:
 * the design scaled to fit each tile, calibrated with the tile's calibration and multiplied
 * onto its skin tone.
 */
export function skinTiles(px: ArrayLike<number>, w: number, h: number, cols: number, rows: number, tiles: Tile[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  const tw = Math.floor(w / cols), th = Math.floor(h / rows), pad = Math.round(Math.min(tw, th) * 0.04);
  const s = Math.min((tw - 2 * pad) / w, (th - 2 * pad) / h), dw = Math.max(1, Math.floor(w * s)), dh = Math.max(1, Math.floor(h * s));
  const v = new Float32Array(CH);
  tiles.forEach((tile, t) => {
    const ox = (t % cols) * tw, oy = Math.floor(t / cols) * th, skin = tile.skin.map((c) => SRGB_TO_LINEAR[c]);
    const lut = isNeutral(tile.cal) ? null : new CalLut(tile.cal);
    const ix = ox + Math.floor((tw - dw) / 2), iy = oy + Math.floor((th - dh) / 2);
    for (let y = oy; y < oy + th; y++) for (let x = ox; x < ox + tw; x++) {
      const j = (y * w + x) * 4, u = x - ix, vv = y - iy;
      let d = [1, 1, 1];
      if (u >= 0 && vv >= 0 && u < dw && vv < dh) {
        // Box average of the source pixels this tile pixel covers, calibrated per pixel.
        const x0 = Math.floor(u / s), x1 = Math.max(x0 + 1, Math.floor((u + 1) / s)), y0 = Math.floor(vv / s), y1 = Math.max(y0 + 1, Math.floor((vv + 1) / s));
        const acc = [0, 0, 0];
        let k = 0;
        for (let yy = y0; yy < Math.min(h, y1); yy++) for (let xx = x0; xx < Math.min(w, x1); xx++) {
          const q = (yy * w + xx) * 4;
          if (lut) {
            lut.map(px[q], px[q + 1], px[q + 2], v, 3);
            acc[0] += SRGB_TO_LINEAR[clamp8(v[0])]; acc[1] += SRGB_TO_LINEAR[clamp8(v[1])]; acc[2] += SRGB_TO_LINEAR[clamp8(v[2])];
          } else {
            acc[0] += SRGB_TO_LINEAR[px[q]]; acc[1] += SRGB_TO_LINEAR[px[q + 1]]; acc[2] += SRGB_TO_LINEAR[px[q + 2]];
          }
          k++;
        }
        if (k) d = acc.map((a) => a / k);
      }
      out[j] = enc(skin[0] * d[0]); out[j + 1] = enc(skin[1] * d[1]); out[j + 2] = enc(skin[2] * d[2]);
    }
  });
  return out;
}

/** Six tiles (3 × 2, Fitzpatrick I–VI), each with its own calibration (neutral by default). */
export function skinPreview(px: ArrayLike<number>, w: number, h: number, cal: Calibration[] = []): Uint8ClampedArray {
  return skinTiles(px, w, h, 3, 2, SKIN_TONES.map((skin, t) => ({ skin, cal: cal[t] ?? NEUTRAL })));
}

/** Result of the skin tool for the current parameters. */
export function skinView(px: ArrayLike<number>, w: number, h: number, p: SkinParams): Uint8ClampedArray {
  const cal = calOf(p), skin = skinRgb(p);
  if (p.show === 'all') return skinPreview(px, w, h, p.cal);
  if (p.show === 'compare') {
    // Side by side on a landscape sheet, one above the other on a portrait one.
    const wide = w >= h;
    return skinTiles(px, w, h, wide ? 2 : 1, wide ? 1 : 2, [{ skin, cal: NEUTRAL }, { skin, cal }]);
  }
  const n = w * h;
  return onSkin(isNeutral(cal) ? px : calibrateImage(px, n, cal, false).px, n, skin);
}

/** Index of the I–VI tile at (u, v), 0..1 of the image, in the «all» layout. */
export const tileAt = (u: number, v: number) => Math.min(2, Math.max(0, Math.floor(u * 3))) + 3 * Math.min(1, Math.max(0, Math.floor(v * 2)));
