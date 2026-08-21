#!/usr/bin/env node
/**
 * wedgedrive — can a player *drive* into the wedge, or only be teleported into it?
 *
 *   node tools/_scratch/wedgedrive.mjs --runs 12
 *
 * wedge.mjs proved the pose is inescapable once you are in it. This asks the
 * question that decides whether it matters: does ordinary driving produce it?
 * Each run starts on ground the camper can stand on, points it at a steep face
 * within 30 m, and holds the throttle — a player exploring a mountainside — and
 * then takes its hands off and watches.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const RUNS = parseInt(arg('runs', '12'), 10);
const URL = `${arg('url', 'http://localhost:5178')}?res=${arg('res', '640')}`;
const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const deg = (u) => (Math.acos(Math.max(-1, Math.min(1, u))) * 180) / Math.PI;

async function main() {
  const release = await acquire('wedgedrive');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
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
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => typeof window.__vehicleState === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    const W = window.__world;
    const grad = (x, z) => {
      const d = 2.0;
      const gx = (W.getHeight(x + d, z) - W.getHeight(x - d, z)) / (2 * d);
      const gz = (W.getHeight(x, z + d) - W.getHeight(x, z - d)) / (2 * d);
      return Math.hypot(gx, gz);
    };
    /** Flat-ish launch pads that point at a steep face 20–30 m away. */
    window.__crests = (n) => {
      const out = [];
      for (let i = 0; i < 200000 && out.length < n; i++) {
        const x = (Math.random() * 2 - 1) * 1400, z = (Math.random() * 2 - 1) * 1400;
        if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0.02) continue;
        if (grad(x, z) > 0.35) continue;                    // must be drivable to start
        const h = Math.random() * Math.PI * 2;
        const dx = Math.sin(h), dz = Math.cos(h);
        const h0 = W.getHeight(x, z);
        let ok = true, steep = 0, drop = 0;
        for (let d = 4; d <= 30; d += 2) {
          const px = x + dx * d, pz = z + dz * d;
          if (!W.isInBounds(px, pz) || W.getWaterDepth(px, pz) > 0.02) { ok = false; break; }
          steep = Math.max(steep, grad(px, pz));
          drop = Math.max(drop, h0 - W.getHeight(px, pz));
        }
        // A crest with a steep face falling away past it — the thing you drive
        // off without meaning to, which is how a camper ends up on a mountainside.
        if (!ok || steep < 1.1 || drop < 12) continue;
        out.push({ x, z, h, steep });
      }
      return out;
    };
    window.__rec = (ms) => new Promise((res) => {
      const out = []; const t0 = performance.now();
      const tick = () => {
        const s = window.__vehicleState(); const P = window.__vehicle.phys;
        out.push({ t: (performance.now() - t0) / 1000, x: s.x, y: s.y, z: s.z, speed: s.speed,
                   up: s.up, grounded: s.grounded, rec: s.recoveries, ground: s.ground,
                   air: P.airborne, stuckFor: P._stuckFor });
        if (performance.now() - t0 >= ms) res(out); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    /** How deep the *drawn* shell is under the *drawn* ground, worst corner. */
    window.__sunk = () => {
      const THREE = window.__THREE, W = window.__world, V = window.__vehicle;
      let deepest = 0;
      for (const x of [-0.95, 0.95]) for (const y of [-0.30, 1.16]) for (const z of [-2.32, 2.34]) {
        const v = new THREE.Vector3(x, y, z).applyQuaternion(V.rig.quaternion).add(V.rig.position);
        deepest = Math.max(deepest, W.getHeight(v.x, v.z) - v.y);
      }
      return deepest;
    };
  });

  const sites = await page.evaluate((n) => window.__crests(n), RUNS);
  console.log(`\n${sites.length} crests: drivable ground with a 12 m+ drop over a face steeper than 1.1\n`);
  console.log('  site         face | tilt°  wheels  air  sunk m  recov | outcome');

  let wedged = 0;
  for (const s of sites) {
    await page.evaluate(([x, z, h]) => window.__vehicleTeleport(x, z, h), [s.x, s.z, s.h]);
    await page.waitForTimeout(600);
    const rec0 = (await page.evaluate(() => window.__vehicleState())).recoveries;
    await page.keyboard.down('KeyW');
    await page.evaluate(() => window.__rec(7000));          // charge the hill
    await page.keyboard.up('KeyW');
    const rows = await page.evaluate(() => window.__rec(20000));   // hands off, let it tumble out
    const last = rows[rows.length - 1];
    const tail = rows.filter((r) => r.t > last.t - 4);
    const span = Math.max(...tail.map((r) => Math.hypot(r.x - last.x, r.y - last.y, r.z - last.z)));
    const sunk = await page.evaluate(() => window.__sunk());
    const tilt = deg(last.up);
    const recov = last.rec - rec0;

    let outcome = 'parked normally';
    if (span > 0.5) outcome = 'still moving';
    else if (last.grounded === 0 && tilt > 25) { outcome = 'WEDGED'; wedged++; }
    else if (tilt > 25) outcome = 'resting tilted';
    console.log(`  ${f(s.x, 0).padStart(6)},${f(s.z, 0).padStart(6)}  ${f(s.steep)} |`
      + ` ${f(tilt, 0).padStart(4)}  ${String(last.grounded).padStart(4)}  ${String(last.air).padStart(5)}`
      + `  ${f(sunk).padStart(5)}  ${String(recov).padStart(4)}  | ${outcome}`);
  }
  console.log(`\n${wedged}/${sites.length} wedged by driving.`);
  await browser.close();
  release();
}
main().catch((e) => { console.error(e); process.exit(1); });
