// Interface check in headless Chromium, once per language (RU, EN, ES): the device language
// picks the interface, the intro and every section open without errors, the English and
// Spanish screens carry no Russian, every button has a name, and screenshots of the key
// screens go to OUT (default ./ui-shots). Chromium only: Safari on iPhone is not covered.
//   npm run build && node scripts/ui-check.mjs [OUT]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = process.argv[2] || 'ui-shots';
const PORT = 4181;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };
const CYRILLIC = /[А-Яа-яЁё]/;
// Words of the data, not of the interface, that may stay as they are in any language.
const LOCALES = { ru: 'ru-RU', en: 'en-US', es: 'es-ES' };
const SAMPLE = { ru: 'Флэш', en: 'Flash', es: 'Flash' };
const TOOLS = ['design', 'contrast', 'pigments', 'lines', 'distance', 'spread', 'skin'];

try {
  for (const [lang, locale] of Object.entries(LOCALES)) {
    const dir = `${OUT}/${lang}`;
    mkdirSync(dir, { recursive: true });
    const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 2, locale, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    let shot = 0;
    const snap = async (name) => page.screenshot({ path: `${dir}/${String(++shot).padStart(2, '0')}-${name}.png` });
    const settle = async () => {
      await page.waitForFunction(() => !document.querySelector('.stage .hint[role=status]') && !document.querySelector('.progress'), null, { timeout: 60000 });
      await page.waitForTimeout(400);
    };
    const leaks = new Set();
    const scan = async (where) => {
      if (lang === 'ru') return;
      const text = await page.evaluate(() => {
        // Hidden «i» sheets and the diagnostics panel are not part of the screen.
        const clone = document.querySelector('main').cloneNode(true);
        clone.querySelectorAll('.diag').forEach((n) => n.remove());
        return clone.innerText + '\n' + [...document.querySelectorAll('[aria-label], [title]')].map((n) => `${n.getAttribute('aria-label') ?? ''} ${n.getAttribute('title') ?? ''}`).join('\n');
      });
      for (const line of text.split('\n')) if (CYRILLIC.test(line.replaceAll('Русский', ''))) leaks.add(`${where}: ${line.trim().slice(0, 120)}`);
    };

    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => window.__engineDev, null, { timeout: 30000 });
    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    check(htmlLang === lang, `${lang}: device locale ${locale} → interface ${htmlLang}`);

    // First run: the intro, three steps.
    await page.locator('.intro').waitFor();
    await snap('intro');
    await scan('intro');
    for (let k = 0; k < 3; k++) await page.locator('.intro .primary').click();
    check(await page.locator('.intro').count() === 0, `${lang}: intro goes through 3 steps and closes`);
    await snap('start');
    await scan('start');

    await page.getByRole('button', { name: SAMPLE[lang], exact: true }).click();
    await page.waitForFunction(() => window.__engineDev.report().open, null, { timeout: 30000 });
    await settle();

    // Pipette on the original: the colour card.
    const box = await page.locator('.stage canvas').first().boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.42);
    await page.locator('section.card h2').filter({ hasText: /Цвет|Colour|Color/ }).waitFor({ timeout: 10000 });
    await page.mouse.click(box.x + 2, box.y + 2); // lifts the loupe
    await snap('original');
    await page.locator('section.card h2').filter({ hasText: /Цвет|Colour|Color/ }).scrollIntoViewIfNeeded();
    await snap('color-card');
    await scan('color card');

    // Full screen over the photo: the stage covers the window, zoom keeps a tap on the same pixel.
    {
      const at = { u: 0.5, v: 0.42 };
      await page.locator('.fsbtn').click();
      await page.waitForTimeout(500);
      const fb = await page.locator('.stage').boundingBox();
      check(fb.width >= 439 && fb.height >= 955, `${lang}: full screen covers the window (${Math.round(fb.width)}×${Math.round(fb.height)})`);
      const c = await page.locator('.stage canvas').first().boundingBox();
      const target = { x: c.x + c.width * at.u, y: c.y + c.height * at.v };
      for (let k = 0; k < 2; k++) await page.locator('.fsbar button[aria-label]').nth(1).click();
      await page.mouse.move(target.x, target.y);
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(300);
      const z = await page.evaluate(() => window.__engineDev.report().viewer.zoom);
      await snap('fullscreen-zoom');
      await scan('full screen');
      // The image point that was under target is now at: zoom maps p → p·s + t (stage px).
      const sb = await page.locator('.stage').boundingBox();
      const zx = sb.x + (target.x - sb.x) * z.s + z.x, zy = sb.y + (target.y - sb.y) * z.s + z.y;
      await page.mouse.click(zx, zy);
      await page.waitForTimeout(500);
      const zoomed = await page.evaluate(() => window.__engineDev.report().viewer.picked);
      // Unzoomed pick at the same image point, in full screen, for the reference.
      await page.locator('.fsbar button', { hasText: /Вписать|Fit|Ajustar/ }).click();
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(500);
      const ref = await page.evaluate(() => window.__engineDev.report().viewer.picked);
      check(z.s > 2 && zoomed && ref && Math.abs(zoomed.x - ref.x) <= 2 && Math.abs(zoomed.y - ref.y) <= 2,
        `${lang}: zoom ${z.s.toFixed(2)}× keeps the pipette on the same pixel (${zoomed?.x},${zoomed?.y} vs ${ref?.x},${ref?.y})`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => window.__engineDev.report().viewer);
      check(!after.full && (await page.locator('.stage').boundingBox()).height < 600, `${lang}: Escape leaves full screen`);
    }

    const tabs = page.locator('nav.tabs button');
    const nTabs = await tabs.count();
    check(nTabs === 9, `${lang}: ${nTabs} sections`);
    const names = await tabs.allInnerTexts();
    for (let k = 1; k < nTabs; k++) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await tabs.nth(k).click();
      await settle();
      const view = await page.evaluate(() => window.__engineDev.report().view.view);
      if (k === 1) {
        await page.locator('section.card.controls .primary').last().filter({ hasText: /палитр|palette|paleta/i }).click();
        await settle();
        await page.waitForFunction(() => window.__engineDev.report().stage2.palette, null, { timeout: 30000 });
      }
      if (view === 'highlight') {
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.42);
        await settle();
      }
      if (view === 'tattoo') {
        for (const tool of TOOLS) {
          await page.evaluate((t) => window.__engineDev.tattoo(t), tool);
          await settle();
          await page.locator('section.card.controls').last().scrollIntoViewIfNeeded();
          await snap(`tattoo-${tool}`);
          await scan(`tattoo ${tool}`);
        }
        continue;
      }
      await page.locator('section.card.controls').last().scrollIntoViewIfNeeded();
      await snap(`${String(k).padStart(2, '0')}-${view}${k === 1 ? '-palette' : ''}`);
      await scan(names[k]);
    }

    // Grid over the photo, then an «i» explanation sheet.
    await page.evaluate(() => window.scrollTo(0, 0));
    await tabs.nth(2).click();
    await settle();
    await page.locator('.chain button', { hasText: '#' }).click();
    await page.locator('details.common[open]').first().scrollIntoViewIfNeeded();
    const gridLines = await page.locator('svg.grid line').count();
    check(gridLines > 0, `${lang}: grid draws ${gridLines} lines over the photo`);
    await snap('grid');
    await scan('grid');
    await page.locator('.i').first().click();
    await page.locator('.sheet').waitFor();
    await snap('hint');
    await scan('hint');

    const unnamed = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => !(b.textContent.trim() || b.getAttribute('aria-label'))).map((b) => b.outerHTML.slice(0, 160)));
    check(unnamed.length === 0, `${lang}: every button has a name${unnamed.length ? ': ' + unnamed.join(' | ') : ''}`);
    check(!leaks.size, `${lang}: no Russian on English/Spanish screens${leaks.size ? '\n  ' + [...leaks].slice(0, 20).join('\n  ') : ''}`);
    check(!errors.length, `${lang}: no page errors${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`);
    console.log(`  ${shot} screenshots in ${dir}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
