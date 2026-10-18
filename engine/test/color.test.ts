import { describe, expect, it } from 'vitest';
import { srgbToLab } from '../src/core/color';
import { colorCodes, colorInfo, colorName, compareColors, complementary, deltaE2000, temperatureOf } from '../src/core/colorinfo';
import { extractPalette, meanRgb, sampleGrid, square } from '../src/core/palette';
import { deltaHistogram, matchedShare } from '../src/core/highlight';
import { histogramsFromLab8 } from '../src/core/histogram';
import { DEFAULT_VIEW, planView, renderReference } from '../src/core/view';
import { FIXTURES, lab8FromRgba, loadFixture } from './util';

describe('ΔE2000', () => {
  // Sharma, Wu, Dalal (2005), test data pairs 1, 7, 13, 15, 17, 25, 33.
  const PAIRS: Array<[number[], number[], number]> = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  ];
  for (const [a, b, want] of PAIRS) {
    it(`${a} vs ${b} = ${want}`, () => {
      expect(deltaE2000(a as never, b as never)).toBeCloseTo(want, 4);
      expect(deltaE2000(b as never, a as never)).toBeCloseTo(want, 4);
    });
  }
});

describe('colour card', () => {
  it('codes for pure red', () => {
    const c = colorCodes([255, 0, 0]);
    expect(c.HEX).toBe('#FF0000');
    expect(c.CMYK).toBe('0, 100, 100, 0');
    expect(c.HSL).toBe('0°, 100%, 50%');
    expect(c.HSV).toBe('0°, 100%, 100%');
    expect(c.LAB).toBe('53.2, 80.1, 67.2');
    expect(c.XYZ).toBe('41.2, 21.3, 1.9');
  });
  it('names and temperature', () => {
    expect(colorName([0, 0, 0])).toBe('чёрный');
    expect(colorName([128, 128, 128])).toBe('серый');
    expect(colorName([220, 30, 30])).toBe('красный');
    expect(colorName([40, 80, 220])).toBe('синий');
    expect(colorName([110, 60, 20])).toBe('коричневый');
    expect(temperatureOf(srgbToLab(230, 120, 40)).label).toBe('тёплый');
    expect(temperatureOf(srgbToLab(40, 90, 200)).label).toBe('холодный');
    expect(temperatureOf(srgbToLab(128, 128, 128)).label).toBe('нейтральный');
  });
  it('complementary keeps lightness and turns the hue', () => {
    const src: [number, number, number] = [200, 120, 40], out = complementary(src);
    const a = srgbToLab(...src), b = srgbToLab(...out);
    expect(Math.abs(a[0] - b[0])).toBeLessThan(1.5);
    const h = (l: number[]) => (Math.atan2(l[2], l[1]) * 180) / Math.PI;
    expect(Math.abs(((h(b) - h(a) + 540) % 360) - 180)).toBeGreaterThan(170);
  });
  it('compare is B minus A', () => {
    const d = compareColors([100, 100, 100], [150, 150, 150]);
    expect(d.dValue).toBeGreaterThan(15);
    expect(d.dHue).toBe(0);
    expect(colorInfo([150, 150, 150]).value).toBeCloseTo(62.0, 0);
  });
});

describe('palette', () => {
  for (const name of FIXTURES) {
    it(`markers sit on their colour (${name})`, () => {
      const img = loadFixture(name), g = sampleGrid(img.data, img.w, img.h);
      const p = extractPalette(img.data, g);
      expect(p.dominant.length).toBe(6);
      expect(p.range.length).toBe(12);
      // Range runs dark to light.
      for (let i = 1; i < p.range.length; i++) expect(p.range[i].lab[0]).toBeGreaterThan(p.range[i - 1].lab[0] - 3);
      for (const s of [...p.dominant, ...p.accents, ...p.range]) {
        // The marker is re-sampled independently, as the pipette would do.
        const x = Math.floor(s.marker.x * img.w), y = Math.floor(s.marker.y * img.h);
        const got = srgbToLab(...meanRgb(img.data, square(x, y, s.marker.size, img.w, img.h)));
        expect(deltaE2000(got, s.lab)).toBeLessThan(1);
      }
      // The real colour at the marker stays close to the colour of its group.
      for (const s of p.dominant) expect(s.markerDE).toBeLessThan(8);
      const shares = p.dominant.reduce((a, s) => a + s.share, 0);
      expect(shares).toBeCloseTo(1, 2);
    });
  }
  it('finds a small saturated accent', () => {
    // Grey field with a 30×30 red patch: red must make it into the palette, not get lost in the grey.
    const w = 400, h = 300, px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { const v = 90 + ((i % w) / w) * 80; px.set([v, v, v + 5, 255], i * 4); }
    for (let y = 100; y < 130; y++) for (let x = 200; x < 230; x++) px.set([210, 30, 40, 255], (y * w + x) * 4);
    const p = extractPalette(px, sampleGrid(px, w, h));
    const red = [...p.dominant, ...p.accents].find((a) => a.rgb[0] > 180 && a.rgb[1] < 60);
    expect(red).toBeTruthy();
    expect(red!.marker.x * w).toBeGreaterThan(200);
    expect(red!.marker.x * w).toBeLessThan(230);
  });
  it('mergeDE 0 keeps near-duplicate dominant colours apart', () => {
    const img = loadFixture('portrait'), g = sampleGrid(img.data, img.w, img.h);
    const merged = extractPalette(img.data, g, { dominant: 12, range: 3, accents: 0, mergeDE: 12 });
    const plain = extractPalette(img.data, g, { dominant: 12, range: 3, accents: 0, mergeDE: 0 });
    expect(plain.dominant.length).toBe(12);
    const minPair = (s: typeof plain.dominant) => Math.min(...s.flatMap((a, i) => s.slice(i + 1).map((b) => deltaE2000(a.lab, b.lab))));
    expect(minPair(merged.dominant)).toBeGreaterThan(minPair(plain.dominant));
  });
});

describe('highlight', () => {
  // 20×10: left half red, right half grey.
  const w = 20, h = 10, px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(i % w < 10 ? [200, 30, 30, 255] : [120, 120, 120, 255], i * 4);
  const red = srgbToLab(200, 30, 30);
  const plan = (mode: 'highlight' | 'outline') =>
    planView({ ...DEFAULT_VIEW, view: 'highlight', highlight: { target: red, tolerance: 5, mode } }, histogramsFromLab8(lab8FromRgba(px))).plan;
  it('keeps matching pixels and fades the rest', () => {
    const out = renderReference(px, plan('highlight'), w);
    expect([...out.subarray(0, 3)]).toEqual([200, 30, 30]);
    const g = out.subarray((w - 1) * 4, (w - 1) * 4 + 3);
    expect(g[0]).toBe(g[1]);
    expect(g[0]).toBeGreaterThan(180);
  });
  it('outlines only the inner edge of the match, not the frame', () => {
    const out = renderReference(px, plan('outline'), w);
    const at = (x: number, y: number) => [...out.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)];
    expect(at(0, 5)).toEqual([200, 30, 30]);
    expect(at(9, 5)[0]).toBe(at(9, 5)[1]);
    expect(at(10, 5)).toEqual([120, 120, 120]);
  });
  it('matched share follows the tolerance', () => {
    const g = sampleGrid(px, w, h), hist = deltaHistogram(g, red);
    expect(matchedShare(hist, 1)).toBeCloseTo(0.5, 5);
    expect(matchedShare(hist, 100)).toBeCloseTo(1, 5);
  });
  it('no target means the original photo', () => {
    expect(planView({ ...DEFAULT_VIEW, view: 'highlight' }, histogramsFromLab8(lab8FromRgba(px))).plan.view).toBe(0);
  });
});
