import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('ERR', String(e)));
await page.goto('http://localhost:5178/?res=768');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 400 });
const out = await page.evaluate(() => {
  const wl = window.__systems.wildlife, W = window.__world, e = window.__engine;
  const S = wl.sites, keys = wl.keys, bi = keys.indexOf('bear');
  const car = window.__car ?? window.__systems?.car ?? null;
  const start = car?.pos ? {x: car.pos.x, z: car.pos.z} : {x: e.camera.position.x, z: e.camera.position.z};
  const roads = W.roads ?? [];
  function roadDist(x, z) {
    let best = 1e9, bi2 = -1;
    roads.forEach((r, ri) => { for (const p of r) { const d = Math.hypot(p.x - x, p.z - z); if (d < best) { best = d; bi2 = ri; } } });
    return { d: best, road: bi2 };
  }
  const bears = [];
  for (let i = 0; i < S.n; i++) {
    if (S.spec[i] !== bi) continue;
    const x = S.x[i], z = S.z[i];
    const rd = roadDist(x, z);
    bears.push({ x: +x.toFixed(0), z: +z.toFixed(0), roadM: +rd.d.toFixed(0), road: rd.road,
      fromStart: +Math.hypot(x - start.x, z - start.z).toFixed(0),
      bearing: +(((Math.atan2(x - start.x, -(z - start.z)) * 180 / Math.PI) + 360) % 360).toFixed(0) });
  }
  bears.sort((a, b) => a.roadM - b.roadM);
  return { start: {x: +start.x.toFixed(0), z: +start.z.toFixed(0)}, roadCount: roads.length, bears };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
