import * as A from './csalgo.mjs';
self.onmessage = async e => {
  const t0 = performance.now(), { url, maxSide } = e.data;
  const blob = await (await fetch(url)).blob();
  const t1 = performance.now();
  const full = await createImageBitmap(blob);                         // decode
  const t2 = performance.now();
  const s = Math.min(1, maxSide / Math.max(full.width, full.height));
  const bmp = await createImageBitmap(full, { resizeWidth: Math.round(full.width * s), resizeHeight: Math.round(full.height * s), resizeQuality: 'high' });
  const t3 = performance.now();
  const oc = new OffscreenCanvas(bmp.width, bmp.height), ctx = oc.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0); const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const rgb = new Uint8Array(bmp.width * bmp.height * 3); for (let i = 0, j = 0; i < id.data.length; i += 4, j += 3) { rgb[j] = id.data[i]; rgb[j + 1] = id.data[i + 1]; rgb[j + 2] = id.data[i + 2]; }
  const t4 = performance.now();
  const lab = A.toLab({ w: bmp.width, h: bmp.height, rgb }), th = A.kmeansBinsWeighted(lab.L, 5), q = A.quantize(lab.L, th);
  const t5 = performance.now();
  const sc = A.simplifyCluster(lab, 0.4, 1);
  const t6 = performance.now();
  self.postMessage({ src: [full.width, full.height], work: [bmp.width, bmp.height], ms: { fetch: t1 - t0, decode: t2 - t1, resize: t3 - t2, readPixels: t4 - t3, lab_values: t5 - t4, simplify: t6 - t5 }, regions: sc.k, levels: new Set(q).size }, []);
};
