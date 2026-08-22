// Proof that fx.shadeOnly keeps the world and fx.flatShade does not.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

await acquire('ablate', { exclusive: true });
const OUT = 'shots/override';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGEERROR', String(e.message).slice(0,200)));
await page.goto('http://127.0.0.1:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await page.evaluate(() => { window.__engine.adaptive = false; window.__engine.autoQuality = false; });
await page.evaluate(() => window.__settleStable(1500, 30));

const n = await page.evaluate(() => { const st = window.__stylize; st.harvest(); return st.setFlatShade(true); });
console.log('materials flat-shaded:', n);
await page.evaluate(() => new Promise(r => setTimeout(r, 4000)));
await page.screenshot({ path: `${OUT}/shadeOnly.png` });
console.log('info', JSON.stringify(await page.evaluate(() => window.__engine.renderer.info.render)));
await browser.close();
