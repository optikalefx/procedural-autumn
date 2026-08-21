#!/usr/bin/env node
/**
 * How close does the tent actually get to the fire?
 *
 * `layoutCamp` never puts the fire into its own separation test — the fire is
 * the origin the layout is built around and is not in `placed` — so the only
 * thing keeping a tent out of the flames is the nominal radius it was asked
 * for. This counts what that is worth once the tent's `insist` path starts
 * pulling candidates inward, which is the case on any site with obstacles.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const r = await page.evaluate(() => {
  const S = window.__campSiteMod, W = window.__world;
  const rows = [];
  const mk = (i) => { let a = ((i * 0x9e3779b1) >>> 0); return () => {
    a += 0x6d2b79f5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  // Four populations: full and compact, each on clear ground and under
  // obstacle pressure. The obstacle case is the one that matters — it is what
  // makes `insist` fall through to its least-bad candidate, and the least-bad
  // test cannot see the fire.
  const cases = [
    { name: 'full  clear ', small: false, obs: 0 },
    { name: 'full  trees ', small: false, obs: 3 },
    { name: 'small clear ', small: true,  obs: 0 },
    { name: 'small trees ', small: true,  obs: 3 },
  ];
  const out = {};
  for (const c of cases) {
    const R = c.small ? 3.4 : 5.8;
    const d = [], props = {}, kmin = {};
    let missing = 0, n = 0;
    for (let i = 0; i < 600; i++) {
      const x = -300 + (i % 25) * 25.3, z = -300 + Math.floor(i / 25) * 24.9;
      if (!W.isInBounds(x, z)) continue;
      const rnd = mk(i * 7 + (c.small ? 1 : 0) + c.obs * 13);
      // Trunks scattered where the valley would have put them: inside the
      // clearing but outside the centre, which is exactly what `_obstacles`
      // hands the layout.
      const obstacles = [];
      for (let k = 0; k < c.obs; k++) {
        const a = rnd() * Math.PI * 2, rr = R * (0.45 + rnd() * 0.45);
        obstacles.push({ x: x + Math.cos(a) * rr, z: z + Math.sin(a) * rr, r: 0.7 + rnd() * 0.6 });
      }
      const items = S.layoutCamp(rnd, W, x, z, { radius: R, small: c.small, obstacles });
      n++;
      for (const it of items) props[it.kind] = (props[it.kind] ?? 0) + 1;
      const t = items.find((q) => q.kind === 'tent');
      // Every kind's closest approach to the fire, not just the tent's: seeding
      // the fire into `placed` touches all of them, and the claim that it costs
      // the others nothing has to be checked rather than asserted.
      for (const it of items) {
        const dd = Math.hypot(it.x - x, it.z - z);
        kmin[it.kind] = Math.min(kmin[it.kind] ?? Infinity, dd);
      }
      if (!t) { missing++; continue; }
      d.push(Math.hypot(t.x - x, t.z - z));
    }
    d.sort((p, q) => p - q);
    // Also: how close does ANYTHING get, since the same hole applies to the
    // chairs and the woodpile.
    out[c.name] = {
      n, missing,
      min: +d[0].toFixed(2),
      p05: +d[Math.floor(d.length * 0.05)].toFixed(2),
      med: +d[Math.floor(d.length * 0.50)].toFixed(2),
      max: +d[d.length - 1].toFixed(2),
      under2: d.filter((v) => v < 2.0).length,
      under25: d.filter((v) => v < 2.5).length,
      props, kmin,
    };
  }
  return out;
});
for (const [k, v] of Object.entries(r)) {
  console.log(`${k}  n=${String(v.n).padStart(3)}  tent→fire  min ${String(v.min).padStart(5)}  med ${String(v.med).padStart(5)}  max ${String(v.max).padStart(5)}   under 2.0 m: ${v.under2}   no tent: ${v.missing}`);
  const per = Object.keys(v.props).sort().map((kk) =>
    `${kk} x${String(v.props[kk]).padStart(4)} @${(+v.kmin[kk]).toFixed(2)}`).join('  ');
  console.log(`              ${per}`);
}
await browser.close();
