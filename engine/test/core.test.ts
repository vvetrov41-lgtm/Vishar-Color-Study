import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { grayToLstar, labToSrgb, lstarToGray, luma601, srgbToLab } from '../src/core/color';
import { ORIGINAL_VALUES_9, levelAgreement } from '../src/core/compat';
import { histogramsFromLab8 } from '../src/core/histogram';
import { fitLongSide, parseImageInfo } from '../src/core/imageinfo';
import { medianInFlatTone, notanThresholds, otsu3Thresholds } from '../src/core/notan';
import { temperatureStats } from '../src/core/temperature';
import { kmeans1d, levelStats, valuesThresholds } from '../src/core/values';
import { DEFAULT_VIEW, planView, renderReference } from '../src/core/view';
import { FIXTURES, lab8FromRgba, loadFixture } from './util';

describe('colour', () => {
  it('matches reference Lab values', () => {
    expect(srgbToLab(255, 255, 255)[0]).toBeCloseTo(100, 2);
    const red = srgbToLab(255, 0, 0);
    expect(red[0]).toBeCloseTo(53.24, 1);
    expect(red[1]).toBeCloseTo(80.09, 0);
    expect(red[2]).toBeCloseTo(67.2, 0);
  });
  it('round-trips sRGB through Lab', () => {
    for (const c of [[12, 200, 90], [250, 3, 128], [128, 128, 128]] as Array<[number, number, number]>) {
      expect(labToSrgb(...srgbToLab(...c))).toEqual(c);
    }
  });
  it('grey ↔ L* are inverse', () => {
    for (const g of [0, 18, 119, 200, 255]) expect(lstarToGray(grayToLstar(g))).toBe(g);
  });
});

describe('values', () => {
  it('k-means finds two clusters', () => {
    const h = new Float64Array(256);
    h[40] = 100; h[42] = 100; h[200] = 50; h[204] = 50;
    expect(kmeans1d(h, 2, 'count').map(Math.round)).toEqual([41, 202]);
  });
  it('luma output grey equals mean luma of the level (as in the original)', () => {
    const h = new Float64Array(256);
    h[10] = 1; h[20] = 1; h[200] = 2;
    const s = levelStats(h, [100], 'luma');
    expect(s.gray).toEqual([15, 200]);
    expect(s.share).toEqual([0.5, 0.5]);
  });

  // Compatibility mode against the original's thresholds (values_fit.txt "kmeans count"):
  // 99.8 / 89.9 / 100.0 / 99.8 %. The landscape gap is known and documented, the
  // algorithm is not fully recovered.
  const RECORDED = { stilllife: 0.998, landscape: 0.899, flash: 1.0, portrait: 0.998 };
  for (const name of FIXTURES) {
    it(`compat mode reproduces the original on ${name}`, () => {
      const img = loadFixture(name), h = histogramsFromLab8(lab8FromRgba(img.data));
      const ours = valuesThresholds(h.luma, { levels: 9, method: 'kmeans' }, true);
      const tones = new Float64Array(img.w * img.h);
      for (let i = 0, j = 0; i < tones.length; i++, j += 4) tones[i] = luma601(img.data[j], img.data[j + 1], img.data[j + 2]);
      const agree = levelAgreement(tones, ours, ORIGINAL_VALUES_9[name]);
      // Our PNGs differ from the original's own decode by a fraction of a level, and the
      // portrait background sits on a threshold, so allow 3 points below the record.
      expect(agree).toBeGreaterThan(RECORDED[name] - 0.03);
      if (name !== 'landscape') expect(agree).toBeGreaterThanOrEqual(0.95);
    });
  }
});

describe('notan', () => {
  it('auto switches to Otsu where the median falls into the background', () => {
    const flat = (n: string) => medianInFlatTone(histogramsFromLab8(lab8FromRgba(loadFixture(n).data)).lstar);
    expect(flat('flash')).toBe(true);
    expect(flat('portrait')).toBe(true);
    expect(flat('landscape')).toBe(false);
  });
  it('balance moves the threshold and the dark share', () => {
    const h = histogramsFromLab8(lab8FromRgba(loadFixture('stilllife').data)).lstar;
    const a = notanThresholds(h, { ...DEFAULT_VIEW.notan, balance: 0 });
    const b = notanThresholds(h, { ...DEFAULT_VIEW.notan, balance: 10 });
    expect(b.thresholds[0] - a.thresholds[0]).toBeCloseTo(25.5, 5);
    expect(b.share[0]).toBeGreaterThan(a.share[0]);
  });
  it('three-class Otsu separates three tones', () => {
    const h = new Float64Array(256);
    h[20] = 10; h[128] = 10; h[230] = 10;
    const [t1, t2] = otsu3Thresholds(h);
    expect(t1).toBeGreaterThan(20); expect(t1).toBeLessThan(128);
    expect(t2).toBeGreaterThan(128); expect(t2).toBeLessThan(230);
  });
});

describe('temperature', () => {
  it('relative neutral splits warm and cool near half', () => {
    const h = histogramsFromLab8(lab8FromRgba(loadFixture('landscape').data));
    const s = temperatureStats(h.warmth, { mode: 'relative', style: 'map', balance: 0 });
    expect(s.warmShare).toBeGreaterThan(0.3);
    expect(s.warmShare).toBeLessThan(0.6);
    expect(s.spread).toBeGreaterThan(6);
  });
});

describe('reference renderer', () => {
  const img = loadFixture('stilllife'), h = histogramsFromLab8(lab8FromRgba(img.data));
  const uniq = (px: Uint8ClampedArray) => new Set(Array.from({ length: px.length / 4 }, (_, i) => px[i * 4] * 65536 + px[i * 4 + 1] * 256 + px[i * 4 + 2])).size;
  it('values gives exactly k greys', () => {
    const { plan } = planView({ ...DEFAULT_VIEW, view: 'values' }, h);
    expect(uniq(renderReference(img.data, plan))).toBe(9);
  });
  it('notan gives two or three greys', () => {
    expect(uniq(renderReference(img.data, planView({ ...DEFAULT_VIEW, view: 'notan' }, h).plan))).toBe(2);
    expect(uniq(renderReference(img.data, planView({ ...DEFAULT_VIEW, view: 'notan', notan: { ...DEFAULT_VIEW.notan, levels: 3 } }, h).plan))).toBe(3);
  });
  it('temperature "two" gives two colours', () => {
    const st = { ...DEFAULT_VIEW, view: 'temperature' as const, temperature: { ...DEFAULT_VIEW.temperature, style: 'two' as const } };
    expect(uniq(renderReference(img.data, planView(st, h).plan))).toBe(2);
  });
});

describe('image header', () => {
  const sample = (f: string) => new Uint8Array(readFileSync(new URL(`../../stage0-bench/public/samples/${f}`, import.meta.url)));
  it('reads PNG, WebP, JPEG with EXIF rotation and HEIC', () => {
    expect(parseImageInfo(sample('probe.png'))).toMatchObject({ format: 'png', width: 640, height: 480 });
    expect(parseImageInfo(sample('probe.webp'))).toMatchObject({ format: 'webp', width: 640, height: 480 });
    expect(parseImageInfo(sample('orient6.jpg'))).toMatchObject({ format: 'jpeg', width: 32, height: 64 });
    expect(parseImageInfo(sample('synth_48mp.jpg'))).toMatchObject({ width: 8064, height: 6048 });
    expect(parseImageInfo(sample('synth_12mp.heic'))).toMatchObject({ format: 'heic', width: 4032, height: 3024 });
  });
  it('fits the long side without upscaling', () => {
    expect(fitLongSide(6048, 8064, 1600)).toEqual([1200, 1600]);
    expect(fitLongSide(800, 600, 1600)).toEqual([800, 600]);
  });
});
