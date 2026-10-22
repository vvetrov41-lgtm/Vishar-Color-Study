import { describe, expect, it } from 'vitest';
import { labToSrgb, srgbToLab } from '../src/core/color';
import { deltaE2000 } from '../src/core/colorinfo';
import { CalLut, calibrateImage, calibrateLab, DEFAULT_SKIN, NEUTRAL, OWN_TONE, skinView, tileAt } from '../src/core/skin';
import { contrastMap, DEFAULT_CONTRAST, MARK_A } from '../src/core/contrast';
import { stencilPdf } from '../src/core/pdf';
import { alternatives, DEFAULT_PIGMENTS, focusOn, GREY_SERIES, greyTones, INK_BRANDS, INKS, PHOTO_SHIFT, pigmentMap } from '../src/core/pigments';
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

describe('pigments', () => {
  it('loads the catalogue', () => {
    expect(INKS.length).toBeGreaterThan(1500);
    expect(INK_BRANDS).toContain('Radiant Colors');
    expect(GREY_SERIES.length).toBeGreaterThan(20);
  });

  it('paints each colour with the nearest of a few pigments and leaves paper as skin', () => {
    // A Radiant swatch, a colour no ink is near (pure #00FF00 is far from most inks), and paper.
    const ink = INKS.find((i) => i.brand === 'Radiant Colors' && i.conf === 'm')!;
    const v = parseInt(ink.hex.slice(1), 16), c = [v >> 16, (v >> 8) & 255, v & 255] as const;
    const w = 90, h = 40, px = paint(w, h, (x) => (x < 30 ? c : x < 60 ? [255, 255, 255] : [20, 20, 20]));
    const r = pigmentMap(px, w, h, { ...DEFAULT_PIGMENTS, blend: false, brand: 'Radiant Colors', maxInks: 2 });
    expect(r.inks.length).toBeLessThanOrEqual(2);
    const at = (x: number) => '#' + [...r.rgba.subarray((20 * w + x) * 4, (20 * w + x) * 4 + 3)].map((u) => u.toString(16).padStart(2, '0')).join('').toUpperCase();
    expect(r.inks.some((i) => i.hex === ink.hex)).toBe(true);
    expect(at(10)).toBe(ink.hex);
    expect(r.skinShare).toBeCloseTo(1 / 3, 2);
  });

  it('reports a colour the brand cannot reach', () => {
    const w = 60, h = 40, px = paint(w, h, (x) => (x < 30 ? [0, 255, 0] : [255, 255, 255]));
    const r = pigmentMap(px, w, h, { ...DEFAULT_PIGMENTS, blend: false, brand: 'Dynamic', maxInks: 3, farDE: 3 });
    expect(r.misses.length).toBe(1);
    expect(r.misses[0].hex).toBe('#00FF00');
    expect(r.misses[0].nearest.length).toBeGreaterThan(0);
  });

  it('photo source: the per-pixel index follows the ink list, focus keeps only that ink', () => {
    const img = loadFixture('portrait');
    const r = pigmentMap(img.data, img.w, img.h, { ...DEFAULT_PIGMENTS, blend: false, maxInks: 6 }, PHOTO_SHIFT);
    expect(r.inks.length).toBe(6);
    const count = r.inks.map(() => 0);
    for (const k of r.index) if (k >= 0) count[k]++;
    r.inks.forEach((k, j) => expect(Math.abs(count[j] / r.index.length - k.share)).toBeLessThan(0.002));
    const f = focusOn(r.rgba, r.index, 0), i = r.index.indexOf(0), o = r.index.findIndex((k) => k !== 0);
    expect([...f.subarray(i * 4, i * 4 + 3)]).toEqual([...r.rgba.subarray(i * 4, i * 4 + 3)]);
    expect(f[o * 4]).toBeGreaterThanOrEqual(190);
  });

  it('a missing ink is never chosen, a chosen alternative always is', () => {
    const img = loadFixture('flash');
    const base = pigmentMap(img.data, img.w, img.h, DEFAULT_PIGMENTS, PHOTO_SHIFT);
    const gone = base.inks[0].id, alt = alternatives(gone);
    expect(alt.same.length).toBeGreaterThan(0);
    expect(alt.other.length).toBeGreaterThan(0);
    expect(new Set(alt.other.map((a) => a.brand)).size).toBe(alt.other.length);
    const pick = alt.other[0].id;
    const r = pigmentMap(img.data, img.w, img.h, { ...DEFAULT_PIGMENTS, excluded: [gone], include: [pick] }, PHOTO_SHIFT);
    expect(r.inks.map((k) => k.id)).not.toContain(gone);
    expect(r.inks.map((k) => k.id)).toContain(pick);
    expect(r.inks.length).toBe(DEFAULT_PIGMENTS.maxInks);
  });

  it('blend: inks at their dilution follow a realistic photo far closer than flat inks', () => {
    const img = loadFixture('portrait'), p = { ...DEFAULT_PIGMENTS, maxInks: 6 };
    const flat = pigmentMap(img.data, img.w, img.h, { ...p, blend: false }, PHOTO_SHIFT);
    const mix = pigmentMap(img.data, img.w, img.h, p, PHOTO_SHIFT);
    expect(mix.meanDE).toBeLessThan(flat.meanDE * 0.75);
    expect(mix.index2).toBeDefined();
    // Focus on an ink also keeps the pixels where it is the second ink of the mix.
    const j = mix.index2!.findIndex((k) => k >= 0), k = mix.index2![j];
    const f = focusOn(mix.rgba, mix.index, k, mix.index2);
    expect([...f.subarray(j * 4, j * 4 + 3)]).toEqual([...mix.rgba.subarray(j * 4, j * 4 + 3)]);
  });

  it('blend: a diluted ink on white is found as that ink, paper stays skin', () => {
    const ink = INKS.find((i) => i.brand === 'Radiant Colors' && i.conf === 'm' && i.family !== 'black' && i.family !== 'white')!;
    const v = parseInt(ink.hex.slice(1), 16), c = [v >> 16, (v >> 8) & 255, v & 255];
    const half = c.map((x) => Math.round(255 * Math.sqrt((x / 255) * 1))) as unknown as readonly [number, number, number];
    const w = 60, h = 20, px = paint(w, h, (x) => (x < 20 ? (c as unknown as [number, number, number]) : x < 40 ? half : [255, 255, 255]));
    const r = pigmentMap(px, w, h, { ...DEFAULT_PIGMENTS, brand: 'Radiant Colors', maxInks: 2 });
    expect(r.inks[0].id).toBe(ink.id);
    expect(r.index[10 * w + 30]).toBe(0);
    expect(r.index[10 * w + 50]).toBe(-1);
    expect(r.meanDE).toBeLessThan(4);
  });

  it('black & grey maps L* to the nearest tone, light paper stays skin', () => {
    const w = 40, h = 10, px = paint(w, h, (x) => (x < 10 ? [0, 0, 0] : x < 20 ? [119, 119, 119] : [255, 255, 255]));
    const r = greyTones(px, w, h, [70, 50, 12]), b = greyTones(px, w, h, [70, 50, 12], 0, true);
    expect(b.shares).toEqual(r.shares);
    expect(b.rgba[15 * 4]).toBe(119);
    expect(r.shares).toEqual([0, 0.25, 0.25]);
    expect(r.skinShare).toBe(0.5);
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

describe('skin calibration', () => {
  it('neutral calibration keeps the design', () => {
    const w = 64, h = 64, px = paint(w, h, (x, y) => [x * 4, y * 4, (x * y) % 256]);
    const r = calibrateImage(px, w * h, NEUTRAL);
    let max = 0;
    for (let i = 0; i < w * h * 4; i += 4) for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(r.px[i + c] - px[i + c]));
    expect(max).toBeLessThanOrEqual(2);
  });

  it('the 33³ table matches the exact calibration within 1.5 ΔE on random colours', () => {
    const cal = { brightness: -15, contrast: 140, shadows: -20, highlights: -25, saturation: 150, warmth: 10 }, lut = new CalLut(cal), v = new Float32Array(7);
    let seed = 7, worst = 0;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256);
    for (let k = 0; k < 3000; k++) {
      const r = rnd(), g = rnd(), b = rnd();
      lut.map(r, g, b, v);
      const exact = srgbToLab(...labToSrgb(...calibrateLab(...srgbToLab(r, g, b), cal)));
      const got = srgbToLab(Math.round(v[0]), Math.round(v[1]), Math.round(v[2]));
      worst = Math.max(worst, deltaE2000(exact, got));
    }
    expect(worst).toBeLessThan(1.5);
  });

  it('contrast and lower highlights move light colours away from white, black stays black', () => {
    const cal = { ...NEUTRAL, contrast: 130, highlights: -30 };
    const [L] = calibrateLab(80, 0, 0, cal);
    expect(L).toBeLessThan(80);
    expect(calibrateLab(0, 0, 0, cal)[0]).toBe(0);
    expect(calibrateLab(100, 0, 0, { ...NEUTRAL, highlights: -30 })[0]).toBe(100);
  });

  it('lab8 of the calibrated version matches its pixels', () => {
    const w = 40, h = 40, px = paint(w, h, (x, y) => [x * 6, 255 - y * 6, 120]);
    const r = calibrateImage(px, w * h, { ...NEUTRAL, saturation: 160, contrast: 120 });
    let max = 0;
    for (let i = 0; i < w * h * 4; i += 4) max = Math.max(max, Math.abs(r.lab8[i] / 2.55 - srgbToLab(r.px[i], r.px[i + 1], r.px[i + 2])[0]));
    expect(max).toBeLessThan(1.5);
  });

  it('one tone: paper takes the chosen skin, each tone keeps its own calibration', () => {
    const w = 60, h = 40, px = paint(w, h, () => [255, 255, 255]);
    const p = { ...DEFAULT_SKIN, tone: 5, cal: DEFAULT_SKIN.cal.map((c) => ({ ...c })) };
    let out = skinView(px, w, h, p);
    expect(Math.abs(out[0] - SKIN_TONES[5][0])).toBeLessThanOrEqual(1);
    p.cal[5].brightness = -40;
    out = skinView(px, w, h, p);
    // White is not moved by brightness: still bare skin.
    expect(Math.abs(out[0] - SKIN_TONES[5][0])).toBeLessThanOrEqual(1);
    expect(p.cal[0]).toEqual(NEUTRAL);
    p.tone = OWN_TONE; p.own = [100, 60, 40];
    out = skinView(px, w, h, p);
    expect(Array.from(out.slice(0, 3))).toEqual([100, 60, 40]);
  });

  it('tile under a tap', () => {
    expect(tileAt(0.1, 0.1)).toBe(0);
    expect(tileAt(0.9, 0.9)).toBe(5);
    expect(tileAt(0.5, 0.7)).toBe(4);
  });

  it('calibrates a 1600×1200 design fast enough for a slider', () => {
    const w = 1600, h = 1200, px = paint(w, h, (x, y) => [x % 256, y % 256, (x + y) % 256]);
    const t0 = performance.now();
    calibrateImage(px, w * h, { ...NEUTRAL, contrast: 130 });
    const ms = performance.now() - t0, t1 = performance.now();
    calibrateImage(px, w * h, { ...NEUTRAL, contrast: 130 }, false);
    console.log(`calibrate 1600×1200: with lab8 ${ms.toFixed(0)} ms, sRGB only ${(performance.now() - t1).toFixed(0)} ms`);
    expect(ms).toBeLessThan(2000);
  });
});
