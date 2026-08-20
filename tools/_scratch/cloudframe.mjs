// How often does a cloud-shadow edge land in an eye-level frame?
// Samples the ground footprint a `drive` camera actually sees (a 200 m fan)
// at many world positions and reports the distribution of shadowed fraction.
// "All or nothing" is the failure mode X2 is about: 21% global coverage is
// worthless if it arrives as one 2 km blob that is never where the eye is.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('cloudframe');
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
await p.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await p.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
const out = await p.evaluate(() => {
  const img = window.__systems.clouds.shadowMap.image, d = img.data, W = img.width;
  const at = (u, v) => {
    const x = (((u % 1) + 1) % 1) * W - 0.5, y = (((v % 1) + 1) % 1) * W - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const g = (i, j) => d[((((j % W) + W) % W) * W + (((i % W) + W) % W))] / 255;
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy)
         + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  };
  const ss = (x, lo, hi) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
  const cover = (wx, wz, sc, s2) => {
    const u = wx * sc, v = wz * sc;
    const a = 0.8 * u - 0.6 * v, bb = 0.6 * u + 0.8 * v;
    return ss(Math.max(at(u, v), at(a * s2 + 0.421, bb * s2 + 0.137)), 0.38, 0.62);
  };
  const rows = [];
  for (const mul of [1.0, 1.6, 2.2, 3.0, 4.0, 5.5]) {
    const sc = mul / 7000, s2 = 0.57;
    const buckets = [0, 0, 0, 0, 0];   // <5% | 5-25 | 25-60 | 60-95 | >95
    const M = 600;
    for (let k = 0; k < M; k++) {
      const cx = (k * 977.13) % 6000 - 3000, cz = (k * 1613.71) % 6000 - 3000;
      let acc = 0, n = 0;
      for (let r = 10; r < 200; r += 12) for (let t = -0.5; t <= 0.5; t += 0.08) {
        acc += cover(cx + Math.sin(t) * r, cz + Math.cos(t) * r, sc, s2); n++;
      }
      const f = acc / n;
      buckets[f < 0.05 ? 0 : f < 0.25 ? 1 : f < 0.60 ? 2 : f < 0.95 ? 3 : 4]++;
    }
    const pc = buckets.map((x) => (100 * x / 600).toFixed(0).padStart(3));
    rows.push(`mul ${String(mul).padEnd(4)} tile ${String(Math.round(7000 / mul)).padStart(5)} m   flat:${pc[0]}%  trace:${pc[1]}%  MASS+EDGE:${pc[2]}%  mostly-shaded:${pc[3]}%  all-shaded:${pc[4]}%`);
  }
  return rows;
});
console.log(out.join('\n'));
await b.close();
