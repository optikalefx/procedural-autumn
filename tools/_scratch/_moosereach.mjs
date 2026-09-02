/** How far a moose pin has to reach to be useful anywhere on the map. */
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
  const sites = [];
  for (let i = 0; i < S.n; i++) if (S.spec[i] === ki) sites.push({ x: S.x[i], z: S.z[i] });
  // Worst case over the drivable map: the furthest any in-bounds point is from
  // its own nearest moose site.
  const half = W.half;
  let worst = 0, worstAt = null, sum = 0, n = 0;
  const hist = {};
  for (let z = -half; z <= half; z += 24) {
    for (let x = -half; x <= half; x += 24) {
      if (!W.isInBounds(x, z)) continue;
      let d = Infinity;
      for (const s of sites) d = Math.min(d, Math.hypot(s.x - x, s.z - z));
      if (d > worst) { worst = d; worstAt = { x: Math.round(x), z: Math.round(z) }; }
      sum += d; n++;
      for (const R of [190, 400, 700, 1000, 1300, 1600, 2000]) {
        hist[R] ??= 0; if (d <= R) hist[R]++;
      }
    }
  }
  return {
    sites: sites.map((s) => ({ x: Math.round(s.x), z: Math.round(s.z) })),
    worst: Math.round(worst), worstAt, mean: Math.round(sum / n), samples: n,
    coverage: Object.fromEntries(Object.entries(hist)
      .map(([R, c]) => [R + ' m', (100 * c / n).toFixed(1) + '%'])),
  };
}), null, 1));
await b.close();
