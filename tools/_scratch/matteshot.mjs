// One frame with the matte-specular path compiled in, one without, same load
// order, so the look change can be looked at rather than argued about.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

await acquire('ablate', { exclusive: true });
const OUT = 'shots/matte';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });

for (const [name, q] of [['off', 'matte=0'], ['on', 'matte=1']]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.log(name, 'PAGEERROR', String(e.message).slice(0,200)));
  page.on('console', m => { if (m.type() === 'error') console.log(name, 'CONSOLE', m.text().slice(0,200)); });
  await page.goto(`http://127.0.0.1:5178/?res=1536&${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
  await page.evaluate(() => { window.__engine.adaptive = false; window.__engine.autoQuality = false; });
  await page.evaluate(() => window.__settleStable(1500, 30));
  await page.evaluate(() => new Promise(r => setTimeout(r, 1500)));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, 'matte =', await page.evaluate(() => window.__stylize.matte));
  await page.close();
}
await browser.close();
