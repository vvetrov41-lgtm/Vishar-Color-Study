// Smoke test: serve dist/, open it in headless Chromium, press Run Tests and
// print the text report. Chromium is not Safari: this only proves the bench
// itself works, its numbers say nothing about the iPhone.
//
//   npm run build && npm run smoke [-- --no48] [-- --url https://...]
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const args = process.argv.slice(2);
const no48 = args.includes('--no48');
const urlArg = args[args.indexOf('--url') + 1];

let server;
let url = args.includes('--url') ? urlArg : null;
if (!url) {
  server = await preview({ preview: { port: 4174, host: '127.0.0.1' } });
  url = 'http://127.0.0.1:4174/';
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));
await page.goto(url);
// second load: the Service Worker should now control the page
await page.waitForTimeout(1500);
await page.reload();
if (no48) {
  await page.click('summary');
  await page.uncheck('text=Тесты 48 МП');
}
const t0 = Date.now();
await page.click('button.primary');
await page.waitForSelector('text=Отчёт готов', { timeout: 600000 });
const report = await page.evaluate(() => JSON.parse(localStorage.getItem('vishar-bench.last-report')));
console.log(await page.evaluate(() => window.__benchReportText?.()));
console.log(`\nwall ${Math.round((Date.now() - t0) / 1000)} s`);
const failed = report.checks.filter((c) => c.status === 'fail').map((c) => c.id);
console.log('fail:', failed.join(', ') || 'none');
await browser.close();
await server?.close();
