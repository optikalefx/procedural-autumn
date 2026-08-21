#!/usr/bin/env node
/**
 * How much of the ground the player may build on is actually buildable?
 *
 * The rescue button learned this lesson already (see the RESCUE_SLOPE note in
 * Vehicle.js): a rule tuned by taste rather than by measurement declined from
 * 57% of the ground where it was most needed, and nobody noticed until someone
 * counted. The camp's site test is the same shape of rule and deserves the same
 * treatment — so this samples the whole annulus the player may aim into, from
 * a spread of parking places, and prints the pass rate and what refused.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const SPOTS = ['road', 'meadow', 'forest', 'vista', 'river'];
const rows = [];
for (const kind of SPOTS) {
  await page.evaluate((k) => {
    const p = window.__poi.best(k) ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
  }, kind);
  await page.waitForTimeout(2200);   // let rocks and trees stream in around it
  const r = await page.evaluate(() => {
    const camp = window.__camp, v = window.__systems.vehicle;
    const S = window.__campSiteMod;
    const reasons = {}; let ok = 0, n = 0; let bestScore = 0;
    const sm = [], sx = [], rel = [], trees = [];
    const W = window.__world;
    // A dense sweep of the whole annulus: 24 bearings x 9 radii.
    for (let i = 0; i < 24; i++) {
      for (let j = 0; j < 9; j++) {
        const a = (i / 24) * Math.PI * 2;
        const rr = 6.5 + (j / 8) * 11;
        const x = v.position.x + Math.cos(a) * rr, z = v.position.z + Math.sin(a) * rr;
        // Raw statistics for the same disc, so the thresholds can be set from
        // the distribution rather than from taste.
        {
          let lo = 1e9, hi = -1e9, ssum = 0, smax = 0, cnt = 0;
          for (const rr2 of [0, 3.5, 6.4]) {
            const c2 = rr2 === 0 ? 1 : 12;
            for (let k = 0; k < c2; k++) {
              const a2 = (k / c2) * Math.PI * 2;
              const px = x + Math.cos(a2) * rr2, pz = z + Math.sin(a2) * rr2;
              const h = W.getHeight(px, pz), sl = W.getSlope(px, pz);
              if (h < lo) lo = h; if (h > hi) hi = h;
              ssum += sl; if (sl > smax) smax = sl; cnt++;
            }
          }
          sm.push(ssum / cnt); sx.push(smax); rel.push(hi - lo);
          trees.push((window.__systems.trees?.trunksNear?.(x, z, 5.0) ?? []).length);
        }
        const s = S.bestSite(window.__world, x, z, { blocked: (bx, bz, br) => camp._blocked(bx, bz, br) });
        n++;
        if (s.ok) {
          ok++;
          if (s.small) reasons['(compact)'] = (reasons['(compact)'] ?? 0) + 1;
          if (s.score > bestScore) bestScore = s.score;
        } else reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
      }
    }
    const q = (arr, p) => { const a = arr.slice().sort((x2, y2) => x2 - y2); return +a[Math.floor(a.length * p)].toFixed(2); };
    return { ok, n, pct: +(100 * ok / n).toFixed(1), bestScore: +bestScore.toFixed(2), reasons,
      slopeMean: [q(sm, 0.1), q(sm, 0.5), q(sm, 0.9)],
      slopeMax:  [q(sx, 0.1), q(sx, 0.5), q(sx, 0.9)],
      relief:    [q(rel, 0.1), q(rel, 0.5), q(rel, 0.9)],
      trunks:    [q(trees, 0.1), q(trees, 0.5), q(trees, 0.9)] };
  });
  rows.push({ kind, ...r });
  console.log(`${kind.padEnd(8)} ${String(r.pct).padStart(5)}% (${r.ok}/${r.n}) best ${r.bestScore}  slopeMean p10/50/90 ${r.slopeMean}  slopeMax ${r.slopeMax}  relief ${r.relief}  trunks<5m ${r.trunks}\n         ${JSON.stringify(r.reasons)}`);
}
const mean = rows.reduce((s, r) => s + r.pct, 0) / rows.length;
console.log(`\nmean ${mean.toFixed(1)}% across ${SPOTS.length} parking places`);
await browser.close();
