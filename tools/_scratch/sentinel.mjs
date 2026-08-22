// Scratch: how many waterfalls on this bake carried the -9999 sentinel?
// Reads the repair's own console line, and independently re-derives the count
// from the raw bake so the number does not depend on the repair being right.
import { chromium } from 'playwright';
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5205') + '/?seed=20261018';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const lines = [];
page.on('console', (m) => { const t = m.text(); if (/waterfall|STALE|repaired/i.test(t)) lines.push(t); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
const info = await page.evaluate(() => {
  const W = window.__world;
  // Re-derive from the water grid the same way TerrainGen did, so this does
  // not just read back what the repair wrote.
  const res = W.res, half = W.half, texel = W.texel;
  let bad = 0; const list = [];
  for (const wf of W.waterfalls) {
    const gx = Math.round((wf.bottom[0] + half) / texel);
    const gz = Math.round((wf.bottom[2] + half) / texel);
    const raw = W.water[Math.min(res - 1, Math.max(0, gz)) * res + Math.min(res - 1, Math.max(0, gx))];
    if (raw < -9000) { bad++; list.push({ h: +wf.height.toFixed(1), bot: wf.bottom.map((v) => +v.toFixed(1)) }); }
  }
  const tall = [...W.waterfalls].sort((a, b) => b.height - a.height).slice(0, 6)
    .map((w) => ({ h: +w.height.toFixed(1), sentinel: (() => {
      const gx = Math.round((w.bottom[0] + half) / texel), gz = Math.round((w.bottom[2] + half) / texel);
      return W.water[Math.min(res - 1, Math.max(0, gz)) * res + Math.min(res - 1, Math.max(0, gx))] < -9000;
    })() }));
  return { n: W.waterfalls.length, bad, list: list.slice(0, 10), tall };
});
console.log(JSON.stringify(info));
console.log(lines.join('\n'));
await browser.close();
