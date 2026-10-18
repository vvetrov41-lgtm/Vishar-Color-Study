import fs from 'node:fs';
import * as A from './csalgo.mjs';
const [, , IMG, OUT] = process.argv;
const readPPM = f => { const b = fs.readFileSync(f); let pos = 0; const tok = () => { while (/\s/.test(String.fromCharCode(b[pos]))) pos++; let s = ''; while (!/\s/.test(String.fromCharCode(b[pos]))) s += String.fromCharCode(b[pos++]); return s; }; tok(); const w = +tok(), h = +tok(); tok(); pos++; return { w, h, rgb: new Uint8Array(b.buffer, b.byteOffset + pos, w * h * 3) }; };
const writePGM = (f, w, h, g) => fs.writeFileSync(f, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), Buffer.from(g)]));
const res = {};
for (const name of ['stilllife', 'landscape', 'flash', 'portrait']) {
  const img = readPPM(`${IMG}/${name}_1k.ppm`), { w, h } = img, n = w * h, lab = A.toLab(img), r = (res[name] = {});
  for (const [label, th] of [['even', A.evenBins(5)], ['kmeans', A.kmeansBins(lab.L, 5)], ['kmeans_sqrt', A.kmeansBinsWeighted(lab.L, 5, 0.5)], ['kmeans_flat', A.kmeansBinsWeighted(lab.L, 5, 0)]]) {
    const l = A.quantize(lab.L, th), m = A.levelMeans(lab.L, l, 5);
    r[label] = { thresholds: th.map(v => +v.toFixed(1)), mse: +A.quantMSE(lab.L, l, m).toFixed(2), used_levels: new Set(l).size };
    if (label === 'kmeans_sqrt') { const g = new Uint8Array(n); for (let i = 0; i < n; i++) g[i] = m[l[i]] * 2.55; writePGM(`${OUT}/${name}_values5_kmeans_sqrt.pgm`, w, h, g); }
  }
  const Ls = A.smooth(lab.L, w, h, 1), tm = A.median(Ls), to = A.otsu(Ls);
  const mo = new Uint8Array(n); let dark = 0; for (let i = 0; i < n; i++) { mo[i] = Ls[i] >= to ? 255 : 0; dark += mo[i] ? 0 : 1; }
  writePGM(`${OUT}/${name}_notan_otsu.pgm`, w, h, mo);
  r.notan = { median_threshold: +tm.toFixed(1), otsu_threshold: +to.toFixed(1), otsu_dark_ratio: +(dark / n).toFixed(3) };
}
fs.writeFileSync(`${OUT}/results2.json`, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res));
