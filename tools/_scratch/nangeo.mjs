// Scratch: which geometry gets a NaN bounding sphere, and from where?
import { chromium } from 'playwright';
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5205') + '/?res=512';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
await page.addInitScript(() => {
  const orig = console.error;
  window.__nanStacks = [];
  console.error = (...a) => {
    const s = String(a[0] ?? '');
    if (s.includes('NaN')) window.__nanStacks.push(s + '\n' + new Error().stack);
    orig.apply(console, a);
  };
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.waitForTimeout(3000);
const out = await page.evaluate(() => window.__nanStacks.slice(0, 4));
console.log(out.join('\n----\n') || 'no NaN warnings seen');
await browser.close();
