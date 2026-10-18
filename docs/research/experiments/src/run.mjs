// Runs every prototype algorithm on the test images, writes outputs (PPM/PGM) and results.json with timings.
import fs from 'node:fs';
import * as A from './csalgo.mjs';

const [, , IMG, OUT] = process.argv;
const readPPM = f => { const b = fs.readFileSync(f); let pos = 0; const tok = () => { while (/\s/.test(String.fromCharCode(b[pos]))) pos++; let s = ''; while (!/\s/.test(String.fromCharCode(b[pos]))) s += String.fromCharCode(b[pos++]); return s; }; tok(); const w = +tok(), h = +tok(); tok(); pos++; return { w, h, rgb: new Uint8Array(b.buffer, b.byteOffset + pos, w * h * 3) }; };
const writePPM = (f, img) => fs.writeFileSync(f, Buffer.concat([Buffer.from(`P6\n${img.w} ${img.h}\n255\n`), Buffer.from(img.rgb)]));
const writePGM = (f, w, h, g) => fs.writeFileSync(f, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), Buffer.from(g)]));
const t = (label, fn, sink) => { const s = performance.now(); const r = fn(); sink[label] = +(performance.now() - s).toFixed(1); return r; };
const gray = (n, f) => { const g = new Uint8Array(n); for (let i = 0; i < n; i++) g[i] = f(i); return g; };
const hex = c => '#' + A.labToRgb(c.L, c.a, c.b).map(v => v.toString(16).padStart(2, '0')).join('');

const results = {};
for (const name of ['stilllife', 'landscape', 'flash', 'portrait']) {
  const R = (results[name] = { timings_ms: {} }), T = R.timings_ms;

  // --- 12 MP: what is affordable at full resolution on one thread ---
  const big = readPPM(`${IMG}/${name}_12mp.ppm`), n12 = big.w * big.h;
  const lab12 = t('12mp_toLab', () => A.toLab(big), T);
  t('12mp_median', () => A.median(lab12.L), T);
  t('12mp_values_kmeans5_thresholds', () => A.kmeansBins(lab12.L, 5), T);
  t('12mp_quantize5', () => A.quantize(lab12.L, A.evenBins(5)), T);
  t('12mp_boxblur_strong_L', () => A.smooth(lab12.L, big.w, big.h, 2), T);
  t('12mp_temperature', () => A.temperature(lab12), T);
  t('12mp_kmeansLab_k12_sample40k', () => A.kmeansLab(lab12, 12), T);
  t('12mp_assign_k12_fullres', () => A.assign(lab12, A.kmeansLab(lab12, 12)), T);
  const work = t('12mp_downscale_to_1600', () => A.downscale(big, 1600), T);
  R.bytes = { rgb_12mp: n12 * 3, rgba_12mp: n12 * 4, lab_float32_12mp: n12 * 12 };
  void work;

  // --- working resolution 1024×768 for interactive tools ---
  const img = readPPM(`${IMG}/${name}_1k.ppm`), { w, h } = img, n = w * h;
  const lab = t('1k_toLab', () => A.toLab(img), T);

  // Values: even binning vs histogram k-means, 3 and 5 levels
  R.values = {};
  for (const k of [3, 5]) {
    const even = A.evenBins(k), km = t(`1k_values_kmeans${k}`, () => A.kmeansBins(lab.L, k), T);
    const le = A.quantize(lab.L, even), lk = A.quantize(lab.L, km), me = A.levelMeans(lab.L, le, k), mk = A.levelMeans(lab.L, lk, k);
    const ce = A.components(le, w, h), ck = A.components(lk, w, h);
    R.values[k] = {
      even: { thresholds: even.map(v => +v.toFixed(1)), mse: +A.quantMSE(lab.L, le, me).toFixed(2), regions: ce.count, regions_over_0_1pct: ce.sizes.filter(s => s > n * 0.001).length, empty_levels: me.filter((v, j) => !le.includes(j)).length },
      kmeans: { thresholds: km.map(v => +v.toFixed(1)), mse: +A.quantMSE(lab.L, lk, mk).toFixed(2), regions: ck.count, regions_over_0_1pct: ck.sizes.filter(s => s > n * 0.001).length },
    };
    if (k === 5) {
      writePGM(`${OUT}/${name}_values5_even.pgm`, w, h, gray(n, i => me[le[i]] * 2.55));
      writePGM(`${OUT}/${name}_values5_kmeans.pgm`, w, h, gray(n, i => mk[lk[i]] * 2.55));
    }
  }

  // Notan: median threshold, with/without smoothing
  const nt = t('1k_notan', () => A.notan(lab.L), T), ns = A.notan(A.smooth(lab.L, w, h, 2));
  R.notan = { threshold_L: +nt.threshold.toFixed(1), dark_ratio: +nt.darkRatio.toFixed(3), regions_raw: A.components(nt.mask, w, h).count, regions_smoothed: A.components(ns.mask, w, h).count };
  writePGM(`${OUT}/${name}_notan.pgm`, w, h, gray(n, i => ns.mask[i] * 255));

  // Temperature
  const tp = t('1k_temperature', () => A.temperature({ ...lab, A: A.smooth(lab.A, w, h, 1), B: A.smooth(lab.B, w, h, 1) }), T);
  R.temperature = { median_warmth: +tp.median.toFixed(2), warm_ratio: +tp.warmRatio.toFixed(3) };
  const trgb = new Uint8Array(n * 3); for (let i = 0; i < n; i++) { const v = Math.min(1, Math.abs(tp.rel[i]) / 25), L = lab.L[i] / 100; const [r, g, b] = tp.rel[i] > 0 ? [255, 140, 30] : [40, 110, 255]; trgb[i * 3] = (r * v + 255 * L * (1 - v)) * 0.9; trgb[i * 3 + 1] = (g * v + 255 * L * (1 - v)) * 0.9; trgb[i * 3 + 2] = (b * v + 255 * L * (1 - v)) * 0.9; }
  writePPM(`${OUT}/${name}_temperature.ppm`, { w, h, rgb: trgb });

  // Simplify: clustering (two detail levels), graph, posterize
  R.simplify = {};
  for (const d of [0.1, 0.6]) {
    const s = t(`1k_simplify_cluster_d${d}`, () => A.simplifyCluster(lab, d, 1), T), o = A.regionMeanRgb(img, s.labels);
    R.simplify[`cluster_d${d}`] = { k: s.k, regions: A.components(s.labels, w, h).count };
    writePPM(`${OUT}/${name}_simplify_cluster_d${d}.ppm`, o);
  }
  const sl = { w, h, L: A.smooth(lab.L, w, h, 1), A: A.smooth(lab.A, w, h, 1), B: A.smooth(lab.B, w, h, 1) };
  const gl = t('1k_simplify_graph', () => A.simplifyGraph(sl, 400, 400), T), go = A.regionMeanRgb(img, gl);
  R.simplify.graph = { regions: go.regions }; writePPM(`${OUT}/${name}_simplify_graph.ppm`, go);
  writePPM(`${OUT}/${name}_posterize4.ppm`, t('1k_posterize', () => A.posterize(img, 4), T));

  // Palette extraction
  const pal = t('1k_extract_palette', () => A.extractPalette(lab, 6), T);
  R.palette = Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, v.map(c => ({ hex: hex(c), L: +c.L.toFixed(1), share: +(c.share * 100).toFixed(2) }))]));

  // Drawing
  const ct = t('1k_contours', () => A.contours(lab.L, w, h), T);
  writePGM(`${OUT}/${name}_contours.pgm`, w, h, gray(n, i => (ct[i] ? 0 : 255)));
  const sk = t('1k_sketch', () => A.sketch(lab.L, w, h), T);
  writePGM(`${OUT}/${name}_sketch.pgm`, w, h, gray(n, i => sk[i] * 255));

  // Highlight (ΔE76 tolerance mask around the most dominant colour)
  const d0 = pal.dominant[0];
  R.highlight = t('1k_highlight', () => { let c = 0; for (let i = 0; i < n; i++) if (A.deltaE76(lab.L[i], lab.A[i], lab.B[i], d0.L, d0.a, d0.b) < 10) c++; return { color: hex(d0), tolerance_dE: 10, coverage: +(c / n).toFixed(3) }; }, T);

  // Tattoo readability: design 8 cm wide seen from 2 m vs 50 cm; notan stability + weakest value boundary
  const tat = {};
  for (const [label, wCm, dCm] of [['8cm@50cm', 8, 50], ['8cm@200cm', 8, 200], ['4cm@200cm', 4, 200]]) {
    const px = A.viewBlurPx(w, wCm, dCm), r = Math.max(1, Math.round(px / 1.7));
    const Lb = A.boxBlur(A.boxBlur(A.boxBlur(lab.L, w, h, r), w, h, r), w, h, r);
    tat[label] = { blur_px: +px.toFixed(1), notan_iou_vs_full: +A.iou(nt.mask, A.notan(Lb, nt.threshold - A.median(Lb)).mask).toFixed(3) };
  }
  const k3 = A.kmeansBins(lab.L, 3), l3 = A.quantize(lab.L, k3), m3 = A.levelMeans(lab.L, l3, 3);
  tat.weakest_value_boundaries = A.boundaryContrast(m3, l3, w, h).slice(0, 2).map(p => ({ levels: [p.a, p.b], dL: +p.dL.toFixed(1), border_px: p.border }));
  R.tattoo = tat;
}
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ node: process.version, cpu: (await import('node:os')).cpus()[0].model, results }, null, 1));
console.log(JSON.stringify(results, null, 1));
