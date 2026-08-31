import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('ERR', String(e)));
await page.goto('http://localhost:5178/?res=768');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 400 });
const out = await page.evaluate(() => {
  const wl = window.__systems.wildlife, W = window.__world;
  const S = wl.sites, keys = wl.keys;
  const bi = keys.indexOf('bear');
  const bears = [];
  for (let i = 0; i < S.n; i++) {
    if (S.spec[i] !== bi) continue;
    bears.push({
      i, x: +S.x[i].toFixed(1), z: +S.z[i].toFixed(1),
      river: !!S.lines[i],
      h: +W.getHeight(S.x[i], S.z[i]).toFixed(1),
    });
  }
  const counts = {};
  for (let i = 0; i < S.n; i++) counts[keys[S.spec[i]]] = (counts[keys[S.spec[i]]] || 0) + 1;
  return { seed: window.__seed ?? null, total: S.n, counts, bears,
           half: W.half, worldSize: W.worldSize,
           camp: window.__world.campPos ?? null };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
