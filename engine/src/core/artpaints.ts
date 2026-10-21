// Art paints (acrylic, oil, watercolour…) for the palette: the nearest paints of a chosen set
// to a colour, and replacements for a paint the artist does not have. Catalogue colours come
// from retailer swatch photos (public/art-paints.json, built by scripts/build-art-paints.mjs):
// a first approximation, 4–12 ΔE between brands for the same pigment, never a spectrophotometer.

import { srgbToLab } from './color';
import { deltaE2000, type Lab } from './colorinfo';

export interface ArtPaint {
  id: string;
  type: string;
  brand: string;
  line: string;
  name: string;
  code: string;
  /** Colour Index pigments sorted and joined by '+', '' when the maker does not tell. */
  pigmentKey: string;
  hex: string;
  lab: Lab;
  conf: 'm' | 'l';
  /** Tint (oil, acrylic: mixed with white; watercolour: thin wash), when the swatch has one. */
  tint?: { hex: string; lab: Lab };
}

export interface ArtCatalogue {
  types: Array<{ id: string; ru: string }>;
  brands: string[];
  paints: ArtPaint[];
}

type Row = [string, number, number, string, string, string, string, string, 'm' | 'l', string];

const labOf = (hex: string): Lab => {
  const v = parseInt(hex.slice(1), 16);
  return srgbToLab(v >> 16, (v >> 8) & 255, v & 255);
};

export function parseArtCatalogue(json: { types: ArtCatalogue['types']; brands: string[]; paints: Row[] }): ArtCatalogue {
  const paints = json.paints.map(([id, t, b, line, name, code, pigmentKey, hex, conf, tint]) => ({
    id, type: json.types[t].id, brand: json.brands[b], line, name, code, pigmentKey, hex, conf, lab: labOf(hex),
    ...(tint ? { tint: { hex: tint, lab: labOf(tint) } } : {}),
  }));
  return { types: json.types, brands: json.brands, paints };
}

export interface ArtSet {
  type: string;
  /** '' = every brand of the type. */
  brand: string;
  /** Match against the tint (thin layer, mixed with white) instead of the masstone. */
  tint: boolean;
}

export const inSet = (p: ArtPaint, s: ArtSet) => p.type === s.type && (!s.brand || p.brand === s.brand);
const colorOf = (p: ArtPaint, tint: boolean) => (tint && p.tint ? p.tint.lab : p.lab);

export interface PaintMatch { paint: ArtPaint; dE: number; why?: string }

/** The n paints of the set nearest to a colour, by ΔE2000. */
export function nearestPaints(cat: ArtCatalogue, s: ArtSet, lab: Lab, n = 3): PaintMatch[] {
  return cat.paints.filter((p) => inSet(p, s)).map((p) => ({ paint: p, dE: round1(deltaE2000(lab, colorOf(p, s.tint))) }))
    .sort((a, b) => a.dE - b.dE).slice(0, n);
}

/**
 * Replacements for a paint, in the catalogue's recommended order: the same pigments in the
 * same type from other brands, then other lines of the same brand, then the nearest colour
 * of the same type.
 */
export function paintAlternatives(cat: ArtCatalogue, paint: ArtPaint, tint = false, n = 8): PaintMatch[] {
  const out: PaintMatch[] = [], seen = new Set([paint.id]);
  const add = (p: ArtPaint, why: string) => {
    if (seen.has(p.id) || out.length >= n) return;
    seen.add(p.id);
    out.push({ paint: p, dE: round1(deltaE2000(colorOf(paint, tint), colorOf(p, tint))), why });
  };
  const same = cat.paints.filter((p) => p.type === paint.type && p.id !== paint.id);
  const byDE = (list: ArtPaint[]) => list.map((p) => ({ p, d: deltaE2000(colorOf(paint, tint), colorOf(p, tint)) })).sort((a, b) => a.d - b.d).map((x) => x.p);
  if (paint.pigmentKey) {
    byDE(same.filter((p) => p.pigmentKey === paint.pigmentKey && p.brand !== paint.brand)).forEach((p) => add(p, 'тот же состав'));
    byDE(same.filter((p) => p.pigmentKey === paint.pigmentKey && p.brand === paint.brand)).forEach((p) => add(p, 'тот же состав'));
  }
  byDE(same).forEach((p) => add(p, 'близкий цвет'));
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
