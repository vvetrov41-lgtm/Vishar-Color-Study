import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const out = process.argv[2];
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const log = (o) => fs.appendFileSync(out, JSON.stringify({ t: Date.now(), ...o }) + '\n');
const hook = (p) => {
  p.on('request', r => { const pd = r.postDataBuffer(); log({ ev: 'req', m: r.method(), u: r.url().slice(0, 300), type: r.resourceType(), body: pd ? pd.length : 0, ct: r.headers()['content-type'] || '' }); });
  p.on('requestfailed', r => log({ ev: 'fail', u: r.url().slice(0, 200), err: r.failure()?.errorText }));
  p.on('console', m => log({ ev: 'console', type: m.type(), text: m.text().slice(0, 400) }));
  p.on('pageerror', e => log({ ev: 'pageerror', text: String(e).slice(0, 400) }));
  p.on('worker', w => log({ ev: 'worker', u: w.url() }));
};
ctx.pages().forEach(hook); ctx.on('page', hook);
log({ ev: 'start' });
setInterval(() => {}, 1e6);
