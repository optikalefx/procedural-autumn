#!/usr/bin/env node
/**
 * rightgeom — where does the auto-right put the camper on a slope?
 *
 * `_recover` stands the camper upright at `getHeight(x, z) + RIDE_HEIGHT + 0.15`
 * — one height sample, taken at the body's *centre*. The chassis box is 4.5 m
 * long, so on a gradient g its uphill end wants to be about 2.24·g metres
 * higher than that sample. This measures how far inside the hill each corner of
 * the collider lands, as a function of gradient, for every place in the valley
 * the camper can roll over: geometry only, no physics, no luck involved.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const URL = 'http://localhost:5178?res=640';

async function main() {
  const release = await acquire('rightgeom');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => typeof window.__vehicleState === 'function', null, { timeout: 20000 });

  const out = await page.evaluate(() => {
    const W = window.__world;
    // Matches VehiclePhysics: RIDE_HEIGHT and the roundCuboid half-extents
    // (0.86, 0.52, 2.18) + 0.06 border, at local (0, 0.34, -0.02).
    const RIDE = -0.04 + (0.55 - 9.81 / 4 / 26.0) + 0.44;
    const CX = 0.92, CY = 0.58, CZ = 2.24, OY = 0.34, OZ = -0.02;
    const bins = new Map();
    let n = 0;
    for (let i = 0; i < 60000; i++) {
      const x = (Math.random() * 2 - 1) * 1400, z = (Math.random() * 2 - 1) * 1400;
      if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0.02) continue;
      const d = 2.0;
      const gx = (W.getHeight(x + d, z) - W.getHeight(x - d, z)) / (2 * d);
      const gz = (W.getHeight(x, z + d) - W.getHeight(x, z - d)) / (2 * d);
      const g = Math.hypot(gx, gz);
      // The auto-right's own placement, upright, at the sample it uses.
      const y0 = W.getHeight(x, z) + RIDE + 0.15;
      // Worst penetration of a collider corner into the terrain. Yaw is the
      // camper's heading at the moment it rolled, so take the worst over yaw:
      // this is what the placement risks, not what one unlucky heading gives.
      let worst = 0;
      for (let a = 0; a < 8; a++) {
        const yaw = (a / 8) * Math.PI * 2, s = Math.sin(yaw), c = Math.cos(yaw);
        let w = 0;
        for (const sx of [-CX, CX]) for (const sz of [-CZ + OZ, CZ + OZ]) {
          const px = x + sx * c + sz * s, pz = z - sx * s + sz * c;
          if (!W.isInBounds(px, pz)) continue;
          w = Math.max(w, W.getHeight(px, pz) - (y0 + OY - CY));   // box underside
        }
        worst = Math.max(worst, w);
      }
      const key = Math.min(1.6, Math.floor(g * 5) / 5);
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(worst);
      n++;
    }
    const rows = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([g, v]) => {
      v.sort((a, b) => a - b);
      return {
        g, n: v.length,
        median: v[Math.floor(v.length * 0.5)],
        p90: v[Math.floor(v.length * 0.9)],
        max: v[v.length - 1],
        over1: v.filter((k) => k > 1).length / v.length,
      };
    });
    return { n, rows };
  });

  console.log(`\n${out.n} sites. Depth the auto-right buries the chassis box, by gradient:\n`);
  console.log('  gradient   deg   sites |  median    p90     max  | > 1 m');
  for (const r of out.rows) {
    const deg = ((Math.atan(r.g) * 180) / Math.PI).toFixed(0);
    console.log(`  ${r.g.toFixed(1).padStart(6)}   ${deg.padStart(4)}  ${String(r.n).padStart(6)} |`
      + ` ${r.median.toFixed(2).padStart(6)} ${r.p90.toFixed(2).padStart(6)} ${r.max.toFixed(2).padStart(7)}  |`
      + ` ${(r.over1 * 100).toFixed(0).padStart(3)}%`);
  }
  await browser.close();
  release();
}
main().catch((e) => { console.error(e); process.exit(1); });
