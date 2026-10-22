// Headless check of the built page: GPU ↔ CPU parity self-test, then a 12 MP open and
// a few view changes. Chromium uses SwiftShader here, so timings say nothing about iPhone.
//   npm run build && npm run test:gpu [-- --url https://...]
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
let url = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
let server = null;
if (!url) {
  server = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], { stdio: 'ignore' });
  url = 'http://localhost:4174/';
  await new Promise((r) => setTimeout(r, 2500));
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => { console.error('pageerror', e.message); failed = true; });
  await page.goto(url);
  await page.waitForFunction(() => window.__engineDev, null, { timeout: 30000 });
  const parity = await page.evaluate(() => window.__engineDev.selftest());
  const bad = parity.cases.filter((c) => !c.pass);
  console.log(`parity: ${parity.pass ? 'PASS' : 'FAIL'} ${parity.cases.length - bad.length}/${parity.cases.length}, histogram ±${parity.histogramMaxShareDiff}, ${parity.ms} ms`);
  for (const c of parity.compat) console.log(`  compat ${c.fixture}: ${(c.agreement * 100).toFixed(1)}%  ours ${c.ours.join(',')}`);
  const worst = [...parity.cases].sort((a, b) => b.mseL - a.mseL).slice(0, 3);
  for (const c of worst) console.log(`  worst ${c.fixture} / ${c.name}: mseL ${c.mseL}, mismatch ${c.mismatch}, max ${c.maxDiff}`);
  for (const c of bad) console.log(`  FAIL ${c.fixture} / ${c.name}: mseL ${c.mseL}, mismatch ${c.mismatch}, max ${c.maxDiff}`);
  if (!parity.pass) failed = true;

  for (const s of ['samples/synth_12mp.jpg', 'samples/synth_48mp.jpg']) {
    const r = await page.evaluate((u) => window.__engineDev.open(u), s);
    console.log(`${s}: ${r.open.work.width}×${r.open.work.height} via ${r.open.method}, first frame ${r.open.firstFrameMs} ms, decode ${r.open.timings.decode} ms, stall ${r.maxMainThreadStallMs} ms`);
  }
  for (const view of ['notan', 'temperature', 'original', 'values']) {
    const r = await page.evaluate((v) => window.__engineDev.set({ view: v }), view);
    console.log(`  ${view}: render ${r.lastFrame.timings.renderMs} ms, round trip ${r.lastFrame.roundTripMs} ms`);
  }

  // Stage 2 on the 48 MP working copy: palette, marker check, Highlight from a swatch.
  const { palette, markers } = await page.evaluate(() => window.__engineDev.palette());
  console.log(`palette: ${palette.totalMs} ms (read ${palette.readMs}, grid ${palette.gridMs}, extract ${palette.ms}), dominant ${palette.dominant.map((s) => s.hex).join(' ')}, accents ${palette.accents.length}`);
  console.log(`  markers: ${markers.n} re-picked, max ΔE ${markers.maxDE}`);
  if (markers.maxDE > 2 || palette.dominant.length === 0) failed = true;
  const target = palette.dominant[1]?.lab ?? palette.dominant[0].lab;
  for (const [tol, mode] of [[10, 'highlight'], [10.5, 'highlight'], [20, 'outline']]) {
    const r = await page.evaluate(([t, tl, m]) => window.__engineDev.set({ view: 'highlight', highlight: { target: t, tolerance: tl, mode: m } }), [target, tol, mode]);
    console.log(`  highlight ${mode} ΔE ${tol}: share ${r.lastFrame.stats.highlight.share}, render ${r.lastFrame.timings.renderMs} ms, round trip ${r.lastFrame.roundTripMs} ms`);
  }
  const pick = await page.evaluate(() => window.__engineDev.pick(0.5, 0.5, 5));
  console.log(`  pipette 5×5 at centre: ${pick.info.codes.HEX} «${pick.info.name}», ${pick.ms} ms`);

  // Stage 3 on the same working copy: Simplify styles, Drawing, SVG.
  for (const mode of ['clustering', 'graph', 'posterize']) {
    const r = await page.evaluate((m) => window.__engineDev.set({ view: 'simplify', simplify: { mode: m, details: 4, paletteLimit: 0, keepDark: false, darkDelta: 18 } }), mode);
    const st = r.lastFrame.stats.simplify;
    console.log(`simplify ${mode}: compute ${r.lastFrame.timings.computeMs} ms, upload ${r.lastFrame.timings.uploadMs} ms, regions ${st.regions}, colours ${st.colors}`);
    if (!st.regions) failed = true;
  }
  for (const [mode, line] of [['sketch', 50], ['sketch', 51], ['contours', 50], ['contours', 51]]) {
    const r = await page.evaluate(([m, l]) => window.__engineDev.set({ view: 'drawing', drawing: { mode: m, line: l, stroke: 2, invert: false } }), [mode, line]);
    console.log(`drawing ${mode} line ${line}: compute ${r.lastFrame.timings.computeMs} ms, upload ${r.lastFrame.timings.uploadMs} ms, round trip ${r.lastFrame.roundTripMs} ms, ink ${r.lastFrame.stats.drawing.inkShare}`);
  }
  const svg = await page.evaluate(() => window.__engineDev.svg());
  console.log(`svg: ${svg.loops} outlines, ${svg.points} points, ${(svg.bytes / 1024).toFixed(0)} KB, ${svg.ms} ms`);
  if (!svg.head.includes('<svg') || !svg.loops) failed = true;

  // Stage 4: every tattoo tool on the flash fixture, then the stencil PDF.
  await page.evaluate(() => window.__engineDev.open('fixtures/flash_1k.png'));
  for (const tool of ['design', 'contrast', 'pigments', 'lines', 'distance', 'spread', 'skin']) {
    const r = await page.evaluate((t) => window.__engineDev.tattoo(t), tool);
    const st = r.lastFrame.stats.tattoo;
    console.log(`tattoo ${tool}: compute ${r.lastFrame.timings.computeMs} ms, ${JSON.stringify({ ...st, contrast: st.contrast && { weakPairs: st.contrast.weakPairs, weakShare: st.contrast.weakShare, colors: st.contrast.colors }, pigments: st.pigments && 'inks' in st.pigments ? { inks: st.pigments.inks.map((k) => k.name), meanDE: st.pigments.meanDE, misses: st.pigments.misses.length } : st.pigments })}`);
    if (!st || st.tool !== tool) failed = true;
  }
  await page.evaluate(() => window.__engineDev.tattoo('lines'));
  const pdf = await page.evaluate(() => window.__engineDev.stencil());
  console.log(`stencil: ${pdf.head.trim()} ${pdf.designMm.join('×')} mm on ${pdf.pageMm.join('×')} mm, ${(pdf.bytes / 1024).toFixed(0)} KB, ${pdf.ms} ms`);
  if (!pdf.head.startsWith('%PDF')) failed = true;
  await page.screenshot({ path: process.env.SHOT || 'dist/screenshot.png', fullPage: true });
} finally {
  await browser.close();
  server?.kill();
}
process.exit(failed ? 1 : 0);
