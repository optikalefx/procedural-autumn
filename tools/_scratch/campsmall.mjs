#!/usr/bin/env node
/**
 * How much ground does the compact camp unlock, and is it the RIGHT ground?
 *
 * The POI annuli campdiag sweeps are mostly flat meadow or open water, so they
 * barely exercise the fallback. This sweeps a wide grid over the whole valley
 * and sorts every sample into full / compact-only / refused, then reports the
 * slope and relief of each group — because the fallback is only correct if the
 * ground it unlocks is genuinely middling, and not if it is quietly letting
 * tents onto cliffs.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) return { readyState: 3, url: u, protocol: '', addEventListener() {}, removeEventListener() {}, send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    return new Real(u, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const r = await page.evaluate(() => {
  const S = window.__campSiteMod, W = window.__world;
  const g = { full: [], compact: [], refused: [] };
  const reasons = {};
  let n = 0, wet = 0;
  const STEP = 37;
  for (let x = -700; x <= 700; x += STEP) {
    for (let z = -700; z <= 700; z += STEP) {
      if (!W.isInBounds(x, z)) continue;
      // No blocked() here: trees and rocks are a separate question and would
      // just add noise to a measurement about slope.
      const s = S.bestSite(W, x, z, {});
      if (s.reason === 'in the water') { wet++; continue; }
      n++;
      // Statistics of the FULL disc, so the three groups are described on the
      // same footprint and can be compared.
      let lo = 1e9, hi = -1e9, ssum = 0, cnt = 0;
      for (const rr of [0, 3.2, 5.8]) {
        const c2 = rr === 0 ? 1 : 12;
        for (let k = 0; k < c2; k++) {
          const a = (k / c2) * Math.PI * 2;
          const h = W.getHeight(x + Math.cos(a) * rr, z + Math.sin(a) * rr);
          const sl = W.getSlope(x + Math.cos(a) * rr, z + Math.sin(a) * rr);
          if (h < lo) lo = h; if (h > hi) hi = h;
          ssum += sl; cnt++;
        }
      }
      const rec = { slope: ssum / cnt, relief: hi - lo };
      if (s.ok && !s.small) g.full.push(rec);
      else if (s.ok) g.compact.push(rec);
      else { g.refused.push(rec); reasons[s.reason] = (reasons[s.reason] ?? 0) + 1; }
    }
  }
  const q = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x2, y2) => x2 - y2); return +b[Math.floor(b.length * p)].toFixed(2); };
  const st = (arr, k) => arr.length ? [q(arr.map((o) => o[k]), 0.1), q(arr.map((o) => o[k]), 0.5), q(arr.map((o) => o[k]), 0.9)] : null;
  return {
    n, wet,
    full: { pct: +(100 * g.full.length / n).toFixed(1), slope: st(g.full, 'slope'), relief: st(g.full, 'relief') },
    compact: { pct: +(100 * g.compact.length / n).toFixed(1), slope: st(g.compact, 'slope'), relief: st(g.compact, 'relief') },
    refused: { pct: +(100 * g.refused.length / n).toFixed(1), slope: st(g.refused, 'slope'), relief: st(g.refused, 'relief'), reasons },
  };
});
console.log(`${r.n} dry samples across the valley (${r.wet} in water, skipped)\n`);
for (const k of ['full', 'compact', 'refused']) {
  const o = r[k];
  console.log(`${k.padEnd(8)} ${String(o.pct).padStart(5)}%   slopeMean p10/50/90 ${o.slope}   relief ${o.relief}`);
}
console.log('\nrefusal reasons:', JSON.stringify(r.refused.reasons));
await browser.close();
