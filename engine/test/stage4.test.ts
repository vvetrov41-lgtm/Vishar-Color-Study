import { describe, expect, it } from 'vitest';
import { srgbToLab } from '../src/core/color';
import { contrastMap, DEFAULT_CONTRAST, MARK_A } from '../src/core/contrast';
import { stencilPdf } from '../src/core/pdf';
import {
  checkLines, DEFAULT_TATTOO, distanceTo, narrowParts, SKIN_TONES, skinPreview, spreadPreview, viewBlurPx, viewFromDistance,
} from '../src/core/tattoo';
import { loadFixture } from './util';

/** Solid RGBA image painted by a function of (x, y). */
function paint(w: number, h: number, f: (x: number, y: number) => readonly [number, number, number]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { px.set(f(x, y), (y * w + x) * 4); px[(y * w + x) * 4 + 3] = 255; }
  return px;
}

describe('distance transform', () => {
  it('matches brute force on a random mask', () => {
    const w = 37, h = 23, t = new Uint8Array(w * h);
    let seed = 7;
    for (let i = 0; i < t.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; t[i] = seed % 17 === 0 ? 1 : 0; }
    const d = distanceTo(t, w, h);
    for (let p = 0; p < t.length; p++) {
      let best = Infinity;
      for (let q = 0; q < t.length; q++) if (t[q]) best = Math.min(best, Math.hypot((p % w) - (q % w), Math.floor(p / w) - Math.floor(q / w)));
      expect(d[p]).toBeCloseTo(best, 4);
    }
  });

  it('narrow parts: a 3 px line is narrow for 6 px, not for 2 px', () => {
    const w = 40, h = 30, m = new Uint8Array(w * h);
    for (let y = 5; y < 25; y++) for (let x = 10; x < 13; x++) m[y * w + x] = 1; // 3 px wide
    for (let y = 5; y < 25; y++) for (let x = 20; x < 32; x++) m[y * w + x] = 1; // 12 px wide
    const at = (r: Uint8Array, x: number) => r[15 * w + x];
    const six = narrowParts(m, w, h, 6, true), two = narrowParts(m, w, h, 2, true);
    expect(at(six, 11)).toBe(1);
    expect(at(six, 25)).toBe(0);
    expect(at(two, 11)).toBe(0);
  });
});

describe('lines in mm', () => {
  it('marks a gap under the minimum and leaves lines above it alone', () => {
    // 1 cm wide design, 100 px: 10 px per mm. Two 8 px bars (0.8 mm) with a 6 px gap (0.6 mm).
    const w = 100, h = 60, ink = new Uint8Array(w * h);
    for (let y = 10; y < 50; y++) for (let x = 0; x < w; x++) if ((x >= 30 && x < 38) || (x >= 44 && x < 52)) ink[y * w + x] = 1;
    const r = checkLines(ink, w, h, 1, { ...DEFAULT_TATTOO.lines, minLineMm: 0.5, minGapMm: 1 });
    expect(r.pxPerMm).toBe(10);
    expect(r.thinShare).toBe(0);
    expect(r.gapShare).toBeGreaterThan(0);
    // The gap between the bars is marked; open paper is not.
    expect([...r.rgba.subarray((30 * w + 40) * 4, (30 * w + 40) * 4 + 3)]).toEqual([0, 110, 255]);
    expect([...r.rgba.subarray((30 * w + 10) * 4, (30 * w + 10) * 4 + 3)]).toEqual([255, 255, 255]);
    // At 0.9 mm minimum line, the 0.8 mm bars are thin.
    expect(checkLines(ink, w, h, 1, { ...DEFAULT_TATTOO.lines, minLineMm: 0.9 }).thinShare).toBeGreaterThan(0.9);
  });

  it('flags low resolution when the minimum line is under 2 px', () => {
    const ink = new Uint8Array(100 * 10);
    expect(checkLines(ink, 100, 10, 50, DEFAULT_TATTOO.lines).lowResolution).toBe(true);
  });
});

describe('contrast', () => {
  it('marks a border between two colours of similar lightness and names it colour on colour', () => {
    // Red and green of nearly the same L*, next to a light area.
    const red = [200, 40, 40] as const, green = [40, 140, 40] as const, light = [240, 240, 230] as const;
    const dL = Math.abs(srgbToLab(...red)[0] - srgbToLab(...green)[0]);
    expect(dL).toBeLessThan(15);
    const w = 90, h = 60, px = paint(w, h, (x) => (x < 30 ? red : x < 60 ? green : light));
    const r = contrastMap(px, w, h, DEFAULT_CONTRAST);
    const weak = r.pairs.filter((p) => p.weak);
    expect(weak).toHaveLength(1);
    expect(weak[0].colorOnColor).toBe(true);
    expect(r.weakPairs).toBe(1);
    // The red/green border is striped, the green/light one is not.
    const at = (x: number) => [...r.rgba.subarray((30 * w + x) * 4, (30 * w + x) * 4 + 3)];
    expect([at(29), at(30)].some((c) => c.join() === MARK_A.join() || c.join() === '255,255,255')).toBe(true);
    expect(at(59)).toEqual([...green]);
    expect(at(60)).toEqual([...light]);
  });

  it('b/w shows patches in L* greys', () => {
    const w = 40, h = 20, px = paint(w, h, (x) => (x < 20 ? [200, 40, 40] : [240, 240, 230]));
    const r = contrastMap(px, w, h, { ...DEFAULT_CONTRAST, bw: true });
    const j = (10 * w + 5) * 4;
    expect(r.rgba[j]).toBe(r.rgba[j + 1]);
    expect(r.rgba[j]).toBe(Math.round(srgbToLab(200, 40, 40)[0] * 2.55));
  });
});

describe('readability', () => {
  it('blur from a distance follows 1′ acuity', () => {
    // 10 cm over 1000 px (0.01 cm per px), 2 m: 200 cm · tan(1′) ≈ 0.0582 cm = 5.82 px.
    expect(viewBlurPx(1000, 10, 200)).toBeCloseTo(5.818, 2);
  });

  it('the further away, the less of the Notan survives', () => {
    const img = loadFixture('flash');
    const near = viewFromDistance(img.data, img.w, img.h, 10, { distanceM: 1, arcmin: 1 });
    const far = viewFromDistance(img.data, img.w, img.h, 10, { distanceM: 6, arcmin: 1 });
    expect(far.iou).toBeLessThan(near.iou);
    expect(near.figure.darkShare).toBeGreaterThan(0);
    expect(near.figure.dominant).toBeGreaterThan(0);
  });

  it('spread grows dark areas', () => {
    const w = 100, h = 40, px = paint(w, h, (x) => (x >= 45 && x < 55 ? [0, 0, 0] : [255, 255, 255]));
    const r = spreadPreview(px, w, h, 1, { spreadMm: 0.3, contrast: 1, blurMm: 0 });
    expect(r.spreadPx).toBe(3);
    // Paper 2 px from the line is now ink.
    expect(r.rgba[(20 * w + 43) * 4]).toBeLessThan(10);
    expect(r.rgba[(20 * w + 30) * 4]).toBeGreaterThan(245);
  });

  it('skin: white paper takes the skin tone, black stays black', () => {
    const w = 300, h = 200, px = paint(w, h, (x) => (x < 150 ? [255, 255, 255] : [0, 0, 0]));
    const out = skinPreview(px, w, h);
    // Tile VI (bottom right), left half of the design is white.
    const tw = 100, th = 100, cx = 2 * tw + 30, cy = th + 50, j = (cy * w + cx) * 4;
    expect(Math.abs(out[j] - SKIN_TONES[5][0])).toBeLessThanOrEqual(1);
    const k = (cy * w + 2 * tw + 70) * 4;
    expect(out[k]).toBe(0);
  });
});

describe('stencil pdf', () => {
  it('writes a valid one-page PDF at 1:1 on A4', async () => {
    const w = 200, h = 100, gray = new Uint8Array(w * h).fill(255);
    for (let i = 0; i < w * 10; i++) gray[i] = 0;
    const { pdf, pageMm, designMm } = await stencilPdf(gray, w, h, { widthCm: 8, mirror: true, label: 'test' });
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pageMm).toEqual([210, 297]);
    expect(designMm).toEqual([80, 40]);
    // 80 mm = 226.772 pt wide image.
    expect(text).toContain('226.772 0 0 113.386');
    expect(text).toContain('/MediaBox [0 0 595.276 841.890]');
    // xref offsets point at the objects.
    const xref = Number(text.match(/startxref\n(\d+)/)![1]);
    const offs = text.slice(xref).match(/(\d{10}) 00000 n/g)!.map((s) => Number(s.slice(0, 10)));
    offs.forEach((o, i) => expect(text.slice(o, o + 7)).toBe(`${i + 1} 0 obj`));
  });

  it('a design wider than A4 gets a larger page', async () => {
    const { pageMm } = await stencilPdf(new Uint8Array(100 * 50).fill(255), 100, 50, { widthCm: 30, mirror: false });
    expect(pageMm[0]).toBe(320);
  });
});
