// Full-resolution export check in headless Chromium: tiles = whole frame. A 1K photo has
// a working copy of its own size, so the tiled export (small tiles, many seams) must match
// the whole-frame render in every GPU view and smoothing level: at most 1 level off, except
// up to 0.01 % of pixels where the steep Temperature map turns a 1-LSB blur difference
// (the preview samples a mipmapped texture) into a few levels. Then a
// 12 MP export for size and timing. Timings are SwiftShader, not iPhone.
//   npm run build && node scripts/full-export-check.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const server = spawn('npx', ['vite', 'preview', '--port', '4177', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };
const decode = (bytes) => PNG.sync.read(Buffer.from(bytes));
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  page.on('pageerror', (e) => { console.error('pageerror', e.message); failed = true; });
  await page.goto('http://localhost:4177/');
  await page.waitForFunction(() => window.__engineDev, null, { timeout: 30000 });
  await page.evaluate(() => window.__engineDev.open('fixtures/landscape_1k.png'));
  const views = [
    ['original', {}], ['values', {}], ['notan', {}], ['temperature', {}],
    ['highlight', { highlight: { target: [60, -20, -20], tolerance: 12, mode: 'outline' } }],
  ];
  for (const smoothing of [0, 2]) {
    for (const [view, extra] of views) {
      await page.evaluate((p) => window.__engineDev.set(p), { view, smoothing, ...extra });
      const whole = decode(await page.evaluate(() => window.__engineDev.work()));
      const r = await page.evaluate(() => window.__engineDev.full({ tile: 200 }));
      const tiled = decode(r.bytes);
      let max = 0, bad = 0;
      for (let i = 0; i < whole.width * whole.height; i++) {
        const d = Math.max(...[0, 1, 2].map((c) => Math.abs(whole.data[i * 4 + c] - tiled.data[i * 4 + c])));
        max = Math.max(max, d);
        if (d > 1) bad++;
      }
      check(tiled.width === whole.width && tiled.height === whole.height && bad <= whole.width * whole.height * 1e-4, `${view}, smoothing ${smoothing}: ${r.tiles} tiles, max diff ${max}, pixels off by >1: ${bad}`);
    }
  }
  await page.evaluate(() => window.__engineDev.open('samples/synth_12mp.jpg'));
  await page.evaluate(() => window.__engineDev.set({ view: 'values', smoothing: 1 }));
  const big = await page.evaluate(() => window.__engineDev.full());
  const img = decode(big.bytes);
  check(img.width === big.sourceWidth && img.height === big.sourceHeight, `12 MP values: ${img.width}×${img.height}, ${(big.bytes.length / 1048576).toFixed(1)} MB, ${big.tiles} tiles, decode ${big.ms.decode} ms, render ${big.ms.render}, encode ${big.ms.encode}, total ${big.ms.total}`);
  const small = await page.evaluate(() => window.__engineDev.full({ budgetMB: 40 }));
  check(small.width < small.sourceWidth && small.notes.length > 0, `over budget steps down: ${small.width}×${small.height}, ${small.notes[0]}`);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
