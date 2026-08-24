#!/usr/bin/env node
/**
 * Does grass stand up inside the tent?
 *
 * The player sent a capture of a compact camp with the meadow standing inside
 * the door. This measures the field that decides it — the `campCover()` every
 * grass ring and every shrub reads — over the disc the tent's fabric covers.
 *
 * Two numbers per camp:
 *   · `clearing` — what the camp's own clearing gives that ground, which is
 *     what shipped before the pad.
 *   · `withPad`  — what the same ground gets now.
 *
 * 0 is bare. Above about 0.1 the meadow is visibly back: the grass shader maps
 * cover through `1.24c - 0.12` and thresholds it against each blade's own
 * random phase, so a quarter of the blades survive a cover of 0.3.
 *
 * ── why this reimplements campCover instead of importing it ──────────────────
 *
 * It did import it, and the numbers inverted after an unrelated comment edit.
 * Vite serves an edited module and everything that imports it under a
 * cache-busting `?t=` URL, so `await import('/src/camp/camp_clearing.js')` from
 * the page hands back a SECOND, freshly-initialised copy of the module — whose
 * uniform arrays are all zeros, which reads as "no camp anywhere" and reports a
 * clean bill of health for a broken build. Reading the uniform block off the
 * live grass material instead measures the values that actually reach the GPU,
 * and cannot be fooled by which copy of a module the harness got.
 */
import { chromium } from 'playwright';

const url = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5178';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto(`${url}?car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const r = await page.evaluate(() => {
  const C = window.__camp;
  const U = C.ctx.systems.grass.uniforms;   // the block the GPU reads
  const wob = (a) => Math.sin(a * 2 + 1.7) * 0.115
                   + Math.sin(a * 3 - 0.6) * 0.075
                   + Math.sin(a * 7 + 2.3) * 0.038;
  const sstep = (t) => { const k = t < 0 ? 0 : t > 1 ? 1 : t; return k * k * (3 - 2 * k); };
  // The clearing: smoothstep over [R - w, R] with a wobble that may cut inward.
  const clearingAt = (x, z, s) => {
    const dx = x - s.x, dz = z - s.y, r = Math.hypot(dx, dz);
    if (r > s.z + 4) return 1;
    const R = s.z * (1 + wob(Math.atan2(dz, dx)));
    return sstep((r - (R - s.w)) / Math.max(s.w, 1e-4));
  };
  // The pad: the same, with the wobble allowed to push outward only.
  const padAt = (x, z, s) => {
    const dx = x - s.x, dz = z - s.y, r = Math.hypot(dx, dz);
    if (r > s.z * 1.25 + 1) return 1;
    const R = s.z * (1 + Math.max(0, wob(Math.atan2(dz, dx))));
    return sstep((r - (R - s.w)) / Math.max(s.w, 1e-4));
  };
  const coverAt = (x, z) => {
    let c = 1;
    for (let i = 0; i < U.uCampSites.value.length; i++) {
      const s = U.uCampSites.value[i];
      if (s.z <= 0) continue;
      c = Math.min(c, clearingAt(x, z, s));
      const d = U.uCampPads.value[i];
      if (d.z > 0) c = Math.min(c, padAt(x, z, d));
    }
    return c;
  };

  const FABRIC = 1.26;               // measured fly reach, tentreach.mjs
  const rows = { full: [], small: [] };
  for (const small of [false, true]) {
    for (let i = 0; i < 30; i++) {
      C.strike();
      const a = i * 2.39996, rr = 40 + i * 41;
      const camp = C.pitchNear(Math.cos(a) * rr, Math.sin(a) * rr, { instant: true, small });
      if (!camp) continue;
      const tent = camp.props.find((p) => p.item.kind === 'tent');
      if (!tent) continue;
      const tx = tent.item.x, tz = tent.item.z;
      const site = U.uCampSites.value.find((s) => s.z > 0
        && Math.hypot(s.x - camp.x, s.y - camp.z) < 0.01);
      if (!site) continue;            // the camp was never published; measuring it would lie
      let worstClear = 0, worstPad = 0, grassy = 0, n = 0, coreClear = 0;
      // Polar sample over the fabric disc: 24 bearings x 9 radii.
      for (let b = 0; b < 24; b++) {
        const ang = (b / 24) * Math.PI * 2;
        for (let q = 0; q <= 8; q++) {
          const rad = (q / 8) * FABRIC;
          const px = tx + Math.cos(ang) * rad, pz = tz + Math.sin(ang) * rad;
          const c = clearingAt(px, pz, site);
          worstClear = Math.max(worstClear, c);
          if (rad <= 0.7) coreClear = Math.max(coreClear, c);   // the middle of the floor
          if (c > 0.10) grassy++;
          n++;
          worstPad = Math.max(worstPad, coverAt(px, pz));
        }
      }
      rows[camp.small ? 'small' : 'full'].push({
        R: +camp.radius.toFixed(2),
        d: +Math.hypot(tx - camp.x, tz - camp.z).toFixed(2),
        clearing: +worstClear.toFixed(3),
        core: +coreClear.toFixed(3),
        grassyFrac: +(grassy / n).toFixed(3),
        withPad: +worstPad.toFixed(3),
      });
    }
  }
  C.strike();
  return rows;
});
await browser.close();

for (const [k, rows] of Object.entries(r)) {
  if (!rows.length) { console.log(`${k}  none pitched`); continue; }
  const bad = (f) => rows.filter((x) => x[f] > 0.10).length;
  const mx = (f) => Math.max(...rows.map((x) => x[f]));
  const med = (f) => rows.map((x) => x[f]).sort((a, b) => a - b)[rows.length >> 1];
  console.log(`${k}  n=${rows.length}  R=${rows[0].R}  tent at ${Math.min(...rows.map(x=>x.d)).toFixed(2)}–${Math.max(...rows.map(x=>x.d)).toFixed(2)} m`);
  console.log(`  clearing alone : worst ${mx('clearing').toFixed(3)}  worst in the middle of the floor ${mx('core').toFixed(3)}`);
  console.log(`                   median share of the floor left in grass ${med('grassyFrac')}   tents with any ${bad('clearing')}/${rows.length}`);
  console.log(`  with the pad   : worst ${mx('withPad').toFixed(3)}   tents with any ${bad('withPad')}/${rows.length}`);
}
