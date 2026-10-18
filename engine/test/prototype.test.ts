// Stage 1 criterion: results match the Node prototype (experiments/src/csalgo.mjs,
// copied to test/prototype) with MSE L* ≤ 1.
import { describe, expect, it } from 'vitest';
import { srgbToLab } from '../src/core/color';
import { histogramsFromLab8 } from '../src/core/histogram';
import { notanThresholds } from '../src/core/notan';
import { temperatureStats } from '../src/core/temperature';
import { levelOf, levelStats, valuesThresholds } from '../src/core/values';
// @ts-expect-error plain JS prototype without types
import * as proto from './prototype/csalgo.mjs';
import { FIXTURES, lab8FromRgba, loadFixture, toRgb } from './util';

for (const name of FIXTURES) {
  describe(`prototype parity: ${name}`, () => {
    const img = loadFixture(name), lab8 = lab8FromRgba(img.data), h = histogramsFromLab8(lab8);
    const plab = proto.toLab(toRgb(img));
    const n = img.w * img.h;
    const ourL = new Float64Array(n), ourLf = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ourL[i] = lab8[i * 4] / 2.55;
      ourLf[i] = srgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2])[0];
    }

    it('L* channel', () => {
      let se = 0;
      for (let i = 0; i < n; i++) se += (ourL[i] - plab.L[i]) ** 2;
      // Only the 8-bit storage of the analysis buffer differs: ±0.2 L*.
      expect(se / n).toBeLessThan(0.03);
    });

    // Same thresholds → same output: quantisation and level tones match the prototype.
    it('Values output with the prototype thresholds, MSE L* ≤ 1', () => {
      for (const k of [3, 5, 9]) {
        const pt: number[] = proto.kmeansBins(plab.L, k), labels = proto.quantize(plab.L, pt), means = proto.levelMeans(plab.L, labels, k);
        const t = pt.map((v) => v * 2.55), ls = levelStats(h.lstar, t, 'lstar');
        let se = 0;
        for (let i = 0; i < n; i++) se += (ls.lstar[levelOf(ourLf[i] * 2.55, t)] - means[labels[i]]) ** 2;
        expect(se / n, `k=${k}`).toBeLessThanOrEqual(1);
      }
    });

    // Our k-means starts from a linear init (as the original does, see compat tests); the
    // prototype starts from quantiles and can stop in a worse local optimum. Ours must
    // never fit the histogram worse.
    it('k-means fits at least as well as the prototype', () => {
      const sse = (t: number[]) => {
        const ls = levelStats(h.lstar, t, 'lstar');
        let s = 0;
        for (let v = 0; v < 256; v++) if (h.lstar[v]) s += h.lstar[v] * (v / 2.55 - ls.lstar[levelOf(v, t)]) ** 2;
        return s / n;
      };
      for (const k of [3, 5, 9]) {
        const ours = sse(valuesThresholds(h.lstar, { levels: k, method: 'kmeans' }));
        const theirs = sse(proto.kmeansBins(plab.L, k).map((v: number) => v * 2.55));
        expect(ours, `k=${k}`).toBeLessThanOrEqual(theirs * 1.001);
      }
    });

    it('Notan median and Otsu thresholds', () => {
      const med = notanThresholds(h.lstar, { scale: 'lstar', mode: 'median', balance: 0, levels: 2, invert: false });
      const ot = notanThresholds(h.lstar, { scale: 'lstar', mode: 'otsu', balance: 0, levels: 2, invert: false });
      expect(Math.abs((med.thresholds[0] + 0.5) / 2.55 - proto.median(plab.L))).toBeLessThanOrEqual(0.4);
      expect(Math.abs(ot.thresholds[0] / 2.55 - proto.otsu(plab.L))).toBeLessThanOrEqual(0.4);
    });

    it('Temperature neutral point', () => {
      const s = temperatureStats(h.warmth, { mode: 'relative', style: 'map', balance: 0 });
      expect(Math.abs(s.neutral - proto.temperature(plab).median)).toBeLessThanOrEqual(1);
    });
  });
}
