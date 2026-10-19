import { describe, expect, it } from 'vitest';
import { srgbToLab } from '../src/core/color';
import { DrawingCache, lightness } from '../src/core/drawing';
import { absorbSmall, components, DEFAULT_SIMPLIFY, simplify, type SimplifyParams } from '../src/core/simplify';
import { loopArea, maskToSvg, simplifyLoop, traceLoops, type Loop } from '../src/core/vector';
import { FIXTURES, lab8FromRgba, loadFixture } from './util';

const input = (name: string) => {
  const img = loadFixture(name);
  return { w: img.w, h: img.h, px: img.data, lab8: lab8FromRgba(img.data) };
};
const distinct = (rgba: Uint8ClampedArray) => {
  const s = new Set<number>();
  for (let j = 0; j < rgba.length; j += 4) s.add((rgba[j] << 16) | (rgba[j + 1] << 8) | rgba[j + 2]);
  return s.size;
};

describe('simplify', () => {
  it('absorbSmall leaves no region under the minimum', () => {
    // Checkerboard noise of 1-px regions inside two big halves.
    const w = 40, h = 20, lab = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lab[y * w + x] = x < 20 ? 0 : 1;
    for (let i = 0; i < 30; i++) lab[(3 + (i % 14)) * w + 3 + ((i * 7) % 34)] = 2 + i;
    const { comp, count } = absorbSmall(lab, w, h, 10);
    expect(count).toBe(2);
    const { sizes } = components(comp, w, h);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10);
  });

  for (const mode of ['clustering', 'graph', 'posterize'] as const) {
    it(`${mode}: more Details, more patches; every pixel painted`, () => {
      const inp = input('stilllife');
      const at = (details: number) => simplify(inp, { ...DEFAULT_SIMPLIFY, mode, details });
      const lo = at(0), hi = at(8);
      expect(hi.regions).toBeGreaterThan(lo.regions);
      expect(lo.colors).toBeLessThanOrEqual(lo.regions + 1);
      let opaque = true;
      for (let j = 3; j < hi.rgba.length; j += 4) opaque &&= hi.rgba[j] === 255;
      expect(opaque).toBe(true);
      expect(distinct(lo.rgba)).toBe(lo.colors);
    });
  }

  it('patches keep the colour of what they cover', () => {
    // Mean ΔE76 between the photo and its simplified version stays moderate on every fixture.
    for (const name of FIXTURES) {
      const inp = input(name), r = simplify(inp, DEFAULT_SIMPLIFY);
      let sum = 0, n = 0;
      for (let j = 0; j < r.rgba.length; j += 4 * 7) {
        const a = srgbToLab(inp.px[j], inp.px[j + 1], inp.px[j + 2]), b = srgbToLab(r.rgba[j], r.rgba[j + 1], r.rgba[j + 2]);
        sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        n++;
      }
      expect(sum / n).toBeLessThan(8);
    }
  });

  it('palette limit caps the number of colours, dark elements included', () => {
    const inp = input('flash');
    for (const mode of ['clustering', 'graph', 'posterize'] as const) {
      const r = simplify(inp, { ...DEFAULT_SIMPLIFY, mode, paletteLimit: 4, keepDark: true });
      expect(distinct(r.rgba)).toBeLessThanOrEqual(4);
    }
  });

  it('keep thin dark elements brings the dotwork back', () => {
    // Flash fixture: the dotwork band at the top (rows 5–15 %) melts into paper without the option.
    const inp = input('flash'), p: SimplifyParams = { ...DEFAULT_SIMPLIFY, details: 2 };
    const darkIn = (rgba: ArrayLike<number>) => {
      let d = 0;
      for (let y = Math.round(inp.h * 0.05); y < inp.h * 0.15; y++) for (let x = 0; x < inp.w; x++) {
        const j = (y * inp.w + x) * 4;
        if (srgbToLab(rgba[j], rgba[j + 1], rgba[j + 2])[0] < 50) d++;
      }
      return d;
    };
    const src = darkIn(inp.px), off = darkIn(simplify(inp, p).rgba), on = simplify(inp, { ...p, keepDark: true });
    expect(src).toBeGreaterThan(500);
    expect(darkIn(on.rgba)).toBeGreaterThan(src * 0.6);
    expect(darkIn(on.rgba)).toBeGreaterThan(off * 2);
    expect(on.inkShare).toBeGreaterThan(0.01);
  });

  it('graph on a large copy works on a reduced copy and refines to full size', () => {
    // 2× upscale (1.6 MP) goes above the 0.5 MP limit; edges must still sit on pixel edges.
    const img = loadFixture('flash'), w = img.w * 2, h = img.h * 2, px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(img.data.subarray(((y >> 1) * img.w + (x >> 1)) * 4, ((y >> 1) * img.w + (x >> 1)) * 4 + 4), (y * w + x) * 4);
    const r = simplify({ w, h, px, lab8: lab8FromRgba(px) }, { ...DEFAULT_SIMPLIFY, mode: 'graph' });
    expect(r.labels.length).toBe(w * h);
    expect(r.regions).toBeGreaterThan(10);
  });

  it('progress goes up to 1', () => {
    const seen: number[] = [];
    simplify(input('portrait'), { ...DEFAULT_SIMPLIFY, mode: 'graph' }, (s) => seen.push(s));
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});

describe('drawing', () => {
  const cache = (name: string) => {
    const img = loadFixture(name);
    return { img, c: new DrawingCache(lightness(lab8FromRgba(img.data), img.w * img.h), img.w, img.h) };
  };
  it('Line darkens, Invert flips', () => {
    const { c } = cache('stilllife');
    for (const mode of ['sketch', 'contours'] as const) {
      const light = c.render({ mode, line: 20, stroke: 2, invert: false });
      const lightShare = light.inkShare;
      const dark = c.render({ mode, line: 90, stroke: 2, invert: false });
      expect(dark.inkShare).toBeGreaterThan(lightShare);
      // Buffers are reused between renders: keep a copy before the next one.
      const darkPx = Uint8ClampedArray.from(dark.rgba);
      const inv = c.render({ mode, line: 90, stroke: 2, invert: true });
      for (let j = 0; j < inv.rgba.length; j += 4 * 101) expect(inv.rgba[j]).toBe(255 - darkPx[j]);
    }
  });
  it('Stroke thickens contours', () => {
    const { c } = cache('flash');
    const thin = c.render({ mode: 'contours', line: 50, stroke: 1, invert: false });
    const thick = c.render({ mode: 'contours', line: 50, stroke: 5, invert: false });
    expect(thick.inkShare).toBeGreaterThan(thin.inkShare * 2);
  });
  it('sketch keeps a thick black outline solid', () => {
    // Flash: the outline of the flower centre, sampled across its width, is ink all the way.
    const { img, c } = cache('flash'), r = c.render({ mode: 'sketch', line: 50, stroke: 2, invert: false });
    let darkSrc = 0, inkThere = 0;
    for (let p = 0; p < img.w * img.h; p++) {
      if (srgbToLab(img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2])[0] < 10) { darkSrc++; if (r.ink[p] > 0.5) inkThere++; }
    }
    expect(darkSrc).toBeGreaterThan(1000);
    expect(inkThere / darkSrc).toBeGreaterThan(0.85);
  });
  it('contours drop speckle on a flat noisy area', () => {
    // Portrait background is flat with sensor-like noise: no contour there at the default Line.
    const { img, c } = cache('portrait'), r = c.render({ mode: 'contours', line: 50, stroke: 1, invert: false });
    let ink = 0;
    for (let y = 0; y < 60; y++) for (let x = 0; x < 120; x++) ink += r.ink[y * img.w + x];
    expect(ink).toBe(0);
  });
});

/** Even-odd rasteriser at pixel centres: the inverse of the tracer. */
function rasterise(loops: Loop[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5, xs: number[] = [];
    for (const l of loops) for (let i = 0, n = l.length; i < n; i += 2) {
      const x0 = l[i], y0 = l[i + 1], x1 = l[(i + 2) % n], y1 = l[(i + 3) % n];
      if ((y0 <= yc) !== (y1 <= yc)) xs.push(x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - 0.5); x < xs[k + 1] - 0.5; x++) if (x >= 0 && x < w) out[y * w + x] ^= 1;
  }
  return out;
}

describe('svg', () => {
  it('traced outlines rasterise back to the exact mask, holes and corner-touching pixels included', () => {
    const w = 12, h = 9, m = new Uint8Array(w * h);
    for (let y = 1; y < 8; y++) for (let x = 1; x < 7; x++) m[y * w + x] = 1;
    for (let y = 3; y < 6; y++) for (let x = 3; x < 5; x++) m[y * w + x] = 0; // hole
    m[2 * w + 8] = m[3 * w + 9] = m[2 * w + 10] = 1; // diagonal neighbours
    const loops = traceLoops(m, w, h);
    expect([...rasterise(loops, w, h)]).toEqual([...m]);
    expect(loops.length).toBe(5);
    // Outer outline clockwise on screen (positive shoelace with y down), hole the other way.
    const areas = loops.map(loopArea).sort((a, b) => a - b);
    expect(areas[0]).toBe(-6);
    expect(areas.at(-1)).toBe(42);
  });
  it('simplified drawing stays within a pixel of the mask', () => {
    const img = loadFixture('flash'), c = new DrawingCache(lightness(lab8FromRgba(img.data), img.w * img.h), img.w, img.h);
    const r = c.render({ mode: 'contours', line: 50, stroke: 3, invert: false }), mask = Uint8Array.from(r.ink, (v) => (v > 0.5 ? 1 : 0));
    const loops = traceLoops(mask, img.w, img.h).filter((l) => Math.abs(loopArea(l)) >= 2).map((l) => simplifyLoop(l, 0.7));
    const back = rasterise(loops, img.w, img.h);
    let inter = 0, uni = 0;
    for (let p = 0; p < mask.length; p++) { if (mask[p] && back[p]) inter++; if (mask[p] || back[p]) uni++; }
    expect(inter / uni).toBeGreaterThan(0.9);
    const { svg, loops: count, points } = maskToSvg(mask, img.w, img.h);
    expect(svg).toMatch(/^<\?xml[^]*<svg [^>]*viewBox="0 0 1024 768"[^]*<path fill="#000" fill-rule="evenodd" d="M/);
    expect(count).toBe(loops.length);
    expect(points).toBeLessThan(mask.reduce((a, v) => a + v, 0));
  });
});
