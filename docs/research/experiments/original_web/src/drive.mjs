import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const S = process.env.S;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages().find(p => p.url().includes('colorstudy')) || browser.contexts()[0].pages()[0];

async function findLabel(page, label) {
  return await page.evaluate((label) => {
    const els = [...document.querySelectorAll('flt-semantics')];
    const norm = t => (t||'').replace(/\s+/g,' ').trim();
    const txt = e => norm(e.getAttribute('aria-label') || (e.children.length===0 ? e.textContent : ''));
    let cand = els.filter(e => txt(e) === label || txt(e) === label+' '+label);
    if (!cand.length) cand = els.filter(e => txt(e).endsWith(label) && ['button','menuitem'].includes(e.getAttribute('role')));
    if (!cand.length) return null;
    const e = cand[cand.length-1]; const b = e.getBoundingClientRect();
    return [b.x + b.width/2, b.y + b.height/2];
  }, label);
}
const args = process.argv.slice(2);
const t0 = Date.now();
for (let i = 0; i < args.length; i++) {
  const c = args[i];
  if (c === 'shot') { const n = args[++i]; await page.screenshot({ path: `${S}/shots/${n}.png` }); console.log('shot', n); }
  else if (c === 'click') { const x = +args[++i], y = +args[++i]; await page.mouse.click(x, y); console.log('click', x, y); }
  else if (c === 'dbl') { const x = +args[++i], y = +args[++i]; await page.mouse.dblclick(x, y); }
  else if (c === 'drag') { const [x1,y1,x2,y2] = [1,2,3,4].map(()=>+args[++i]); await page.mouse.move(x1,y1); await page.mouse.down(); await page.mouse.move(x2,y2,{steps:8}); await page.mouse.up(); console.log('drag'); }
  else if (c === 'wait') { await page.waitForTimeout(+args[++i]); }
  else if (c === 'upload') { const f = args[++i], x = +args[++i], y = +args[++i];
    const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), page.mouse.click(x, y)]);
    const tu = Date.now(); await fc.setFiles(f); console.log('uploaded', f, 'at', tu - t0); }
  else if (c === 'download') { const x=+args[++i], y=+args[++i], n=args[++i]; const [d] = await Promise.all([page.waitForEvent('download',{timeout:30000}), page.mouse.click(x,y)]); await d.saveAs(`${S}/dl_out/${n}_${d.suggestedFilename()}`); console.log('download', d.suggestedFilename()); }
  else if (c === 'key') { await page.keyboard.press(args[++i]); }
  else if (c === 'tap' || c === 'tapdl' || c === 'tapup') { const lab = args[++i]; const extra = (c!=='tap') ? args[++i] : null; let pos=null; for (let k=0;k<20 && !pos;k++){ pos = await findLabel(page, lab); if(!pos) await page.waitForTimeout(500);} if(!pos){console.log('NOTFOUND', lab); continue;}
    if (c==='tap') { await page.mouse.click(pos[0],pos[1]); console.log('tap', lab); }
    else if (c==='tapdl') { const [d] = await Promise.all([page.waitForEvent('download',{timeout:30000}), page.mouse.click(pos[0],pos[1])]); await d.saveAs(`${S}/dl_out/${extra}_${d.suggestedFilename()}`); console.log('download', extra, d.suggestedFilename()); }
    else { let ok=false; for (let k=0;k<4&&!ok;k++){ try { const [fc] = await Promise.all([page.waitForEvent('filechooser',{timeout:5000}), page.mouse.click(pos[0],pos[1])]); await fc.setFiles(extra); ok=true; console.log('uploaded', extra, 'try', k); } catch(e){ await page.mouse.move(640,300); await page.waitForTimeout(800);} } if(!ok) console.log('UPLOADFAIL'); } }
  else if (c === 'viewport') { const w=+args[++i], h=+args[++i]; await page.setViewportSize({width:w,height:h}); }
  else if (c === 'eval') { const r = await page.evaluate(args[++i]); console.log('eval', JSON.stringify(r)); }
  else if (c === 'aria') { const r = await page.evaluate(() => [...document.querySelectorAll('flt-semantics [aria-label], flt-semantics[aria-label], flt-semantics [role], input')].map(e => { const b = e.getBoundingClientRect(); return [e.getAttribute('role')||e.tagName, e.getAttribute('aria-label')||e.textContent?.slice(0,60), e.getAttribute('aria-valuenow')||e.value||'', Math.round(b.x+b.width/2), Math.round(b.y+b.height/2)]; }).filter(a=>a[1]||a[2])); for (const a of r) console.log(a.join(' | ')); }
  else if (c === 'semantics') { await page.evaluate(() => { const p = document.querySelector('flt-semantics-placeholder'); if (p) p.click(); }); console.log('semantics on'); }
}
console.log('elapsed', Date.now() - t0);
process.exit(0);
