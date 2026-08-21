#!/usr/bin/env node
/**
 * Drive at the biggest crag block that has an approach and photograph the
 * arrival. Two frames: the run-up, and where the camper ended up.
 *
 *   node tools/_scratch/cragshot.mjs --arm new
 *   node tools/_scratch/cragshot.mjs --arm old      (the pre-fix rules, emulated)
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const OUT = arg('out', 'shots/rock');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
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
await page.goto('http://localhost:5178?res=1024');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await page.waitForFunction(() => !!window.__vehicle && !!window.__systems?.rocks, null, { timeout: 60000, polling: 200 });
await page.waitForTimeout(1500);

// Both rule sets, on one block, in one page: the old ones are emulated by
// zeroing the cached hull's plan extents (which turns `protrusion` back into
// height-at-the-origin) and restoring the disc-shaped hold-back.
await page.evaluate(() => {
  const R = window.__vehicle.phys.rocks;
  const realHull = Object.getPrototypeOf(R)._hull;
  const realBox = R._nearBox.bind(R);
  window.__setArm = (arm) => {
    R._hulls.clear();
    R.clear();
    if (arm === 'old') {
      R._hull = function (a, v) { const h = realHull.call(this, a, v); if (h && h.bx !== 0) { h.bx = 0; h.bz = 0; } return h; };
      R._nearBox = (r, h, cx, cy, cz) => Math.hypot(r.x - cx, r.z - cz) < 2.9 + Math.max(r.sx, r.sz);
    } else {
      delete R._hull;
      R._nearBox = realBox;
    }
  };
});

const t = await page.evaluate(() => {
  const W = window.__world, rocks = window.__systems.rocks;
  const tops = {}, ext = {};
  for (const [a, gs] of Object.entries(rocks.library)) {
    tops[a] = gs.map((g) => { if (!g.boundingBox) g.computeBoundingBox(); return g.boundingBox.max.y; });
    ext[a] = gs.map((g) => Math.max(Math.abs(g.boundingBox.min.x), g.boundingBox.max.x,
                                    Math.abs(g.boundingBox.min.z), g.boundingBox.max.z));
  }
  let best = null;
  for (let i = 0; i < 4000; i++) {
    const x = (Math.random() * 2 - 1) * 1250, z = (Math.random() * 2 - 1) * 1250;
    if (W.getWaterDepth(x, z) > 0.05 || W.getSlope(x, z) < 0.25) continue;
    for (const r of rocks.rocksAround(x, z, 50, 5.0, [])) {
      const reach = ext[r.arch][r.variant] * Math.max(r.sx, r.sz);
      const gate = r.y + tops[r.arch][r.variant] * r.sy - r.groundY;
      if (gate > 0.14) continue;                    // the ones the old rule dropped
      // It also has to stand up where the camper will meet it, or the drive
      // proves nothing: the plane the scatter stored says how far.
      const fall = Math.hypot(r.groundGX, r.groundGZ) * reach;
      if (r.y + tops[r.arch][r.variant] * r.sy - (r.groundY - fall) < 2.0) continue;
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        // A short, gentle run-up: these blocks stand on ground the camper can
        // barely climb, and a long lane measures the hill, not the stone.
        const sx = r.x + Math.cos(a) * (reach + 14), sz = r.z + Math.sin(a) * (reach + 14);
        if (!W.isInBounds(sx, sz)) continue;
        let bad = false, worst = 0;
        for (let s = 0; s <= 1; s += 0.05) {
          const px = sx + (r.x - sx) * s, pz = sz + (r.z - sz) * s;
          if (W.getWaterDepth(px, pz) > 0.05) { bad = true; break; }
          worst = Math.max(worst, W.getSlope(px, pz));
        }
        if (bad || worst > 0.34) continue;
        if (!best || r.size > best.size) best = { x: r.x, z: r.z, size: r.size, arch: r.arch, gate, reach, sx, sz };
      }
    }
    if (best && best.size > 9) break;
  }
  return best;
});
if (!t) { console.log('no candidate'); await browser.close(); process.exit(0); }
console.log(`target: ${t.arch} ${t.size.toFixed(1)} m — the old gate reads it as ${t.gate.toFixed(1)} m proud, i.e. buried`);
console.log(`approach: ${Math.hypot(t.sx - t.x, t.sz - t.z).toFixed(0)} m of clean lane\n`);

// Unit vector of the approach. The camper's progress along it, measured from
// the block's own centre, is the number that decides this: 0 is the middle of
// the stone, negative is short of it.
const ux = (t.x - t.sx) / Math.hypot(t.x - t.sx, t.z - t.sz);
const uz = (t.z - t.sz) / Math.hypot(t.x - t.sx, t.z - t.sz);

for (const arm of ['old', 'new']) {
  await page.evaluate((A) => window.__setArm(A), arm);
  await page.evaluate((T) => { window.__vehicleTeleport(T.sx, T.sz, Math.atan2(T.x - T.sx, T.z - T.sz)); }, t);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/crag-${arm}-approach.png` });
  await page.keyboard.down('KeyW');
  let best = -Infinity;
  for (let i = 0; i < 70; i++) {
    await page.waitForTimeout(200);
    const s = await page.evaluate(() => window.__vehicleState());
    best = Math.max(best, (s.x - t.x) * ux + (s.z - t.z) * uz);
    if (s.recoveries > 0) break;
  }
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/crag-${arm}-arrival.png` });
  const fin = await page.evaluate(() => window.__vehicleState());
  console.log(`  ${arm}: furthest it got along the approach was ${best.toFixed(1)} m past the block's centre` +
    `  →  ${best > -t.reach * 0.5 ? 'INTO THE STONE' : 'stopped on the face'}   [${fin.rockColliders} rock colliders live]`);
}
await browser.close();
