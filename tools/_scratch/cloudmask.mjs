// Coverage of the baked cloud-shadow silhouette under candidate remaps.
// X2's cleanest number is that shadow AREA in the ground region halved from
// 21.0% (round 040) to 10.9%. This measures the area this term can supply
// before spending a capture on it.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('cloudmask');
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
await p.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await p.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
const out = await p.evaluate(() => {
  const c = window.__systems.clouds;
  const img = c.shadowMap.image, d = img.data, W = img.width;
  const at = (u, v) => {
    // bilinear, matching LinearFilter + RepeatWrapping
    const x = (((u % 1) + 1) % 1) * W - 0.5, y = (((v % 1) + 1) % 1) * W - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const g = (i, j) => d[((((j % W) + W) % W) * W + (((i % W) + W) % W))] / 255;
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy)
         + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  };
  const ss = (x, lo, hi) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
  const rows = [];
  const N = 384;
  for (const cfg of [
    { n: 'ship  1 tap  .38/.90', taps: 0, lo: 0.38, hi: 0.90 },
    { n: '1 tap        .38/.62', taps: 0, lo: 0.38, hi: 0.62 },
    { n: '1 tap        .38/.50', taps: 0, lo: 0.38, hi: 0.50 },
    { n: '2 tap rot .57 .38/.90', taps: 1, s2: 0.57, lo: 0.38, hi: 0.90 },
    { n: '2 tap rot .57 .38/.62', taps: 1, s2: 0.57, lo: 0.38, hi: 0.62 },
    { n: '2 tap rot .83 .38/.62', taps: 1, s2: 0.83, lo: 0.38, hi: 0.62 },
    { n: '2 tap rot .83 .38/.55', taps: 1, s2: 0.83, lo: 0.38, hi: 0.55 },
    { n: '3 tap rot     .38/.62', taps: 2, s2: 0.83, lo: 0.38, hi: 0.62 },
  ]) {
    let acc = 0, full = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = i / N, v = j / N;
      let cov = at(u, v);
      if (cfg.taps >= 1) {
        const a = 0.8 * u - 0.6 * v, bb = 0.6 * u + 0.8 * v;
        cov = Math.max(cov, at(a * cfg.s2 + 0.421, bb * cfg.s2 + 0.137));
      }
      if (cfg.taps >= 2) {
        const a = -0.5 * u + 0.87 * v, bb = -0.87 * u - 0.5 * v;
        cov = Math.max(cov, at(a * 1.37 + 0.713, bb * 1.37 + 0.902));
      }
      const s = ss(cov, cfg.lo, cfg.hi);
      acc += s; if (s > 0.5) full++;
    }
    rows.push(`${cfg.n}   mean ${(acc / (N * N)).toFixed(3)}   area>50% ${(100 * full / (N * N)).toFixed(1)}%`);
  }
  return rows;
});
console.log(out.join('\n'));
await b.close();
