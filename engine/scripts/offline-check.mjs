// Stage 5 check in headless Chromium: the Service Worker caches the app, a project survives
// a reload, the page opens and works offline on a new photo, and the project file round-trips.
// Safari is not covered: on iPhone the same checks are done by hand (airplane mode, home screen).
//   npm run build && node scripts/offline-check.mjs   (STORE=idb for the IndexedDB fallback)
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const server = spawn('npx', ['vite', 'preview', '--port', '4176', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
// STORE=idb runs the same checks on the IndexedDB fallback instead of OPFS.
const url = `http://localhost:4176/${process.env.STORE === 'idb' ? '?store=idb' : ''}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };
try {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.error('pageerror', e.message); failed = true; });
  const ready = () => page.waitForFunction(() => window.__engineDev, null, { timeout: 30000 });
  await page.goto(url);
  await ready();
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready, null, { timeout: 15000 });
  await page.reload();
  await ready();
  await page.waitForFunction(() => window.__engineDev.sw(), null, { timeout: 10000 }).catch(() => {});
  const sw = await page.evaluate(() => window.__engineDev.sw());
  check(!!sw, `Service Worker ${sw?.version}, ${sw?.precached} files precached`);

  await page.evaluate(() => window.__engineDev.open('fixtures/flash_1k.png'));
  await page.evaluate(() => window.__engineDev.set({ view: 'notan' }));
  const saved = await page.evaluate(() => window.__engineDev.projects.save());
  check(!!saved.project, `project saved: ${saved.msg}`);
  const chain = await page.evaluate(() => window.__engineDev.projects.commit());
  check(chain.length === 2, `work chain saved: ${chain.join(' → ')}`);
  await page.waitForTimeout(1200);

  // Offline from here: no server, no network.
  await ctx.setOffline(true);
  server.kill();
  await page.reload();
  await ready();
  const list = await page.evaluate(() => window.__engineDev.projects.list());
  check(list.list.length === 1 && list.list[0].steps === 2, `offline reload: ${list.list.length} project, ${list.list[0]?.steps} steps, ${list.storage?.kind}`);
  const opened = await page.evaluate(() => window.__engineDev.projects.open(0));
  check(opened.opened && opened.chain.length === 2 && opened.view === 'original', `project opened offline: ${opened.chain.join(' → ')}, view ${opened.view} ${opened.msg}`);

  // A new photo from the device, offline: through the file input, as on iPhone.
  await page.locator('input[type=file]').first().setInputFiles(fileURLToPath(new URL('../test/fixtures/portrait_1k.png', import.meta.url)));
  await page.waitForFunction(() => window.__engineDev.report().open?.label === 'portrait_1k.png', null, { timeout: 30000 }).catch(() => {});
  const r = await page.evaluate(() => window.__engineDev.set({ view: 'values' }));
  check(r.open?.label === 'portrait_1k.png' && r.lastFrame?.timings, `new photo processed offline: ${r.open?.work?.width}×${r.open?.work?.height}, values ${r.lastFrame?.timings?.renderMs} ms`);

  const bytes = await page.evaluate(() => window.__engineDev.projects.fileBytes(0));
  const name = await page.evaluate((b) => window.__engineDev.projects.importBytes(b), bytes);
  const after = await page.evaluate(() => window.__engineDev.projects.list());
  check(after.list.length === 2 && after.list.every((p) => p.steps === 2), `project file ${Math.round(bytes.length / 1024)} KB re-imported as «${name}»`);

  const net = await page.evaluate(() => window.__engineDev.net());
  check(!net.external.length && !net.bodies && !net.images.length, `network: ${net.total} requests, external ${net.external.length}, with data ${net.bodies}, photos ${net.images.length}`);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
