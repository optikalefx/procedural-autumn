import { chromium } from 'playwright';
const BASE = process.env.AUTUMN_URL || 'http://localhost:5178';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto(`${BASE}/?seed=20261018&car=camper`, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
console.log(JSON.stringify(await p.evaluate(() => {
  const W = window.__world, wl = window.__systems.wildlife;
  const S = wl.sites, ki = wl.keys.indexOf('moose');
  const out = [];
  for (let i = 0; i < S.n; i++) {
    if (S.spec[i] !== ki) continue;
    const poly = S.lines[i];
    // Depth on the centreline, and how much of a cross-section a 0.75 m wader
    // can stand in, over the stretch of line nearest the home.
    let near = 0, bestD = Infinity;
    for (let k = 0; k < poly.length; k++) {
      const d = Math.hypot(poly[k].x - S.x[i], poly[k].z - S.z[i]);
      if (d < bestD) { bestD = d; near = k; }
    }
    const centre = [], fordable = [];
    for (let k = Math.max(1, near - 12); k < Math.min(poly.length - 1, near + 12); k++) {
      const pt = poly[k];
      centre.push(+W.getWaterDepth(pt.x, pt.z).toFixed(2));
      // Cross-section: can the whole width be waded?
      const q = poly[k + 1];
      const tx = q.x - pt.x, tz = q.z - pt.z, tl = Math.hypot(tx, tz) || 1;
      let ok = true;
      for (let o = -10; o <= 10; o += 1) {
        const px = pt.x - (tz / tl) * o, pz = pt.z + (tx / tl) * o;
        if (W.getWaterDepth(px, pz) > 0.75) { ok = false; break; }
      }
      fordable.push(ok ? 1 : 0);
    }
    out.push({ site: i, width: +(poly[near].w ?? 0).toFixed(1),
               centreDepthMax: Math.max(...centre), centreDepthMed: centre.sort((a, c) => a - c)[centre.length >> 1],
               fordableNodes: `${fordable.reduce((a, c) => a + c, 0)}/${fordable.length}` });
  }
  return out;
}), null, 1));
await b.close();
