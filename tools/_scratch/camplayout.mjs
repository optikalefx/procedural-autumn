#!/usr/bin/env node
/**
 * What does the layout actually produce, over many sites?
 *
 * The whole feature is one arrangement seen once, so it is easy to tune it to
 * the one camp you happen to be looking at and never notice that nine sites in
 * ten come out with the tent in the same place. This builds the layout for a
 * few hundred sites and prints the census: how often each prop appears, how
 * many props a camp has, and — the one that matters — the spread of the tent's
 * bearing relative to the seating axis.
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
  const counts = {}, sizes = [], tentBear = [], tentDist = [], chairSpread = [];
  const seatAxis = Math.atan2(0.51, 0.86) + Math.PI;
  let n = 0;
  for (let i = 0; i < 400; i++) {
    // Deterministic but different per site, exactly as the game does it.
    const x = -300 + (i % 20) * 31.7, z = -300 + Math.floor(i / 20) * 31.1;
    if (!W.isInBounds(x, z)) continue;
    const rnd = (() => { let a = ((i * 0x9e3779b1) >>> 0); return () => {
      a += 0x6d2b79f5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
    const items = S.layoutCamp(rnd, W, x, z, {});
    n++;
    const kinds = {};
    for (const it of items) { kinds[it.kind] = (kinds[it.kind] ?? 0) + 1; }
    for (const [k, c] of Object.entries(kinds)) {
      counts[k] ??= { any: 0, total: 0, max: 0 };
      counts[k].any++; counts[k].total += c; counts[k].max = Math.max(counts[k].max, c);
    }
    sizes.push(items.length);
    const t = items.find((q) => q.kind === 'tent');
    if (t) {
      let b = Math.atan2(t.z - z, t.x - x) - seatAxis;
      while (b > Math.PI) b -= Math.PI * 2;
      while (b < -Math.PI) b += Math.PI * 2;
      tentBear.push(Math.abs(b));
      tentDist.push(Math.hypot(t.x - x, t.z - z));
    }
    const ch = items.filter((q) => q.kind === 'chair');
    if (ch.length >= 2) {
      // Bearings RELATIVE to the seating axis and wrapped into [-pi, pi] before
      // sorting. Sorting raw atan2 values is wrong and it lied: two chairs 0.3
      // rad apart that happen to straddle the +-pi seam sort as 6.0 rad apart,
      // and the first run of this census reported a median arc of 4.48 rad for
      // a layout that was actually fine.
      const bs = ch.map((q) => {
        let b = Math.atan2(q.z - z, q.x - x) - seatAxis;
        while (b > Math.PI) b -= Math.PI * 2;
        while (b < -Math.PI) b += Math.PI * 2;
        return b;
      }).sort((p, q) => p - q);
      chairSpread.push(bs[bs.length - 1] - bs[0]);
    }
  }
  const q = (arr, p) => { const a = arr.slice().sort((x2, y2) => x2 - y2); return +a[Math.floor(a.length * p)].toFixed(2); };
  const stat = (arr) => arr.length ? [q(arr, 0.05), q(arr, 0.5), q(arr, 0.95)] : null;
  return { n, counts, size: stat(sizes), tentBearing: stat(tentBear), tentDist: stat(tentDist),
           chairSpread: stat(chairSpread), tentMissing: n - tentBear.length };
});
console.log(`${r.n} layouts`);
for (const [k, c] of Object.entries(r.counts)) {
  console.log(`  ${k.padEnd(9)} appears in ${(100 * c.any / r.n).toFixed(0).padStart(3)}% of camps, ${(c.total / r.n).toFixed(2)} per camp, max ${c.max}`);
}
console.log(`  props/camp p5/50/95 ${r.size}`);
console.log(`  tent bearing off the seating axis (rad) ${r.tentBearing}`);
console.log(`  tent distance from fire (m)             ${r.tentDist}`);
console.log(`  chair arc width (rad)                   ${r.chairSpread}`);
console.log(`  camps with NO tent: ${r.tentMissing}`);
await browser.close();
