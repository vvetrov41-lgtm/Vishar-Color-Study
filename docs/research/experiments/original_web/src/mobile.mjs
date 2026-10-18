import { chromium, devices } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const S = process.env.S;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'] });
const page = await ctx.newPage();
const reqs = [];
page.on('request', r => reqs.push(r.url()));
let t = Date.now();
await page.goto('https://colorstudy.app/app/', { waitUntil: 'load' });
await page.waitForTimeout(12000);
console.log('url', page.url(), 'load ms', Date.now() - t);
await page.screenshot({ path: `${S}/shots/40_mobile_start.png` });
console.log('reqs', reqs.filter(u => !u.includes('posthog')).map(u => u.slice(0, 90)).join('\n'));
// offline test
await ctx.setOffline(true);
try { await page.reload({ waitUntil: 'load', timeout: 15000 }); } catch (e) { console.log('offline reload error:', String(e).split('\n')[0]); }
await page.waitForTimeout(3000);
await page.screenshot({ path: `${S}/shots/41_mobile_offline.png` });
console.log('offline url', page.url());
const sw = await page.evaluate(async () => { try { return (await navigator.serviceWorker.getRegistrations()).length; } catch (e) { return 'err ' + e; } }).catch(e => 'eval-fail');
console.log('sw registrations', sw);
await ctx.setOffline(false);
await ctx.close();
process.exit(0);
