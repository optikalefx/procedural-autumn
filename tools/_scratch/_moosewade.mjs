import { chromium } from 'playwright';
const BASE = process.env.AUTUMN_URL || 'http://localhost:5178';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto(`${BASE}/?seed=20261018&car=camper`, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
console.log(JSON.stringify(await p.evaluate(() => {
  const W = window.__world, wl = window.__systems.wildlife, R = window.__systems.rocks;
  const S = wl.sites, ki = wl.keys.indexOf('moose');
  const out = [];
  for (let i = 0; i < S.n; i++) {
    if (S.spec[i] !== ki) continue;
    const x = S.x[i], z = S.z[i];
    // How much of the ground within the wander radius is water this animal can
    // stand in, and how much of THAT a boulder is sitting on.
    let wet = 0, wetClear = 0, n = 0;
    for (let a = 0; a < 64; a++) {
      for (let rr = 4; rr <= 55; rr += 6) {
        const th = (a / 64) * Math.PI * 2;
        const px = x + Math.sin(th) * rr, pz = z + Math.cos(th) * rr;
        if (!W.isInBounds(px, pz)) continue;
        n++;
        const d = W.getWaterDepth(px, pz);
        if (d <= 0.15 || d > 0.75) continue;
        wet++;
        const hits = [];
        R.rocksAround(px, pz, 12, 0, hits);
        const blocked = hits.some((k) => k.size >= 0.8
          && Math.hypot(k.x - px, k.z - pz) < R.reachOf(k) + 1.4);
        if (!blocked) wetClear++;
      }
    }
    out.push({ site: i, x: Math.round(x), z: Math.round(z),
               homeDepth: +W.getWaterDepth(x, z).toFixed(2),
               wadeableCells: wet, ofThoseClearOfRock: wetClear, sampled: n });
  }
  return out;
}), null, 1));
await b.close();
