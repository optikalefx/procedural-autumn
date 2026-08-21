#!/usr/bin/env node
/**
 * A/B on the same page, same route, same seed: does making the crag solid cost
 * the camper anything?
 *
 * "Old" is emulated at runtime rather than by checking out the previous file —
 * zeroing the cached hull's plan extents turns `protrusion` back into
 * `top - groundY`, and swapping `_nearBox` for a disc restores the old
 * hold-back. Same build, same world, so nothing but the two rules differs.
 *
 * Watched: auto-recoveries (the camper stuck, buried or flipped), NaN events,
 * time airborne, and any upward velocity spike — a collider built inside the
 * camper leaves by way of the sky, which is the one failure mode that making
 * more rock solid could introduce.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '40'));
const ROUTES = parseInt(arg('routes', '4'), 10);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
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
await page.goto('http://localhost:5178?res=768');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await page.waitForFunction(() => !!window.__vehicle && !!window.__systems?.rocks, null, { timeout: 60000, polling: 200 });
await page.waitForTimeout(1200);

// Routes: steep, high, standable starts. Chosen once and driven by both arms.
const starts = await page.evaluate((n) => {
  const W = window.__world;
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < 200000) {
    const x = (Math.random() * 2 - 1) * 1250, z = (Math.random() * 2 - 1) * 1250;
    if (W.getWaterDepth(x, z) > 0.05) continue;
    const s = W.getSlope(x, z), h = W.getHeight(x, z);
    if (s > 0.7 || s < 0.30 || h < 90) continue;
    out.push({ x, z, heading: Math.random() * Math.PI * 2 });
  }
  return out;
}, ROUTES);

await page.evaluate(() => {
  const RC = window.__vehicle.phys.rocks;
  window.__newBox = RC._nearBox.bind(RC);
  window.__setArm = (arm) => {
    const R = window.__vehicle.phys.rocks;
    R._hulls.clear();
    R.clear();
    if (arm === 'old') {
      // `protrusion` reads bx/bz off the cached hull; zero them and the fall
      // term vanishes, which is exactly the height-at-the-origin test.
      const real = Object.getPrototypeOf(R)._hull;
      R._hull = function (a, v) {
        const h = real.call(this, a, v);
        if (h && h.bx !== 0) { h.bx = 0; h.bz = 0; }
        return h;
      };
      R._nearBox = (r, h, cx, cy, cz) =>
        Math.hypot(r.x - cx, r.z - cz) < 2.9 + Math.max(r.sx, r.sz);
    } else {
      delete R._hull;
      R._nearBox = window.__newBox;
    }
  };
});

async function run(arm, start) {
  await page.evaluate((A) => window.__setArm(A), arm);
  await page.evaluate((S) => { window.__vehicleTeleport(S.x, S.z, S.heading); }, start);
  await page.waitForTimeout(1500);
  const base = await page.evaluate(() => {
    const s = window.__vehicleState();
    window.__vehicle.phys.recoveries = 0;
    return { x: s.x, z: s.z, rescues: s.rescues };
  });
  const samples = [];
  await page.keyboard.down('KeyW');
  let lastY = null, up = 0, air = 0;
  const steps = Math.round(SECONDS / 0.15);
  for (let i = 0; i < steps; i++) {
    // A lazy weave, so the run meets rock from more than one bearing.
    if (i % 40 === 0) { await page.keyboard.down(i % 80 === 0 ? 'KeyA' : 'KeyD'); }
    if (i % 40 === 20) { await page.keyboard.up('KeyA'); await page.keyboard.up('KeyD'); }
    await page.waitForTimeout(150);
    const s = await page.evaluate(() => window.__vehicleState());
    if (lastY !== null) up = Math.max(up, (s.y - lastY) / 0.15);
    lastY = s.y;
    if (s.grounded === 0) air += 0.15;
    samples.push(s);
  }
  await page.keyboard.up('KeyW');
  await page.keyboard.up('KeyA');
  await page.keyboard.up('KeyD');
  await page.waitForTimeout(400);
  const last = samples[samples.length - 1];
  return {
    dist: Math.hypot(last.x - base.x, last.z - base.z),
    recoveries: last.recoveries,
    rescues: last.rescues - base.rescues,
    nan: last.nan,
    air, climbRate: up,
    colliders: Math.max(...samples.map((s) => s.rockColliders)),
  };
}

const acc = { old: [], new: [] };
for (const s of starts) {
  for (const arm of ['old', 'new']) acc[arm].push(await run(arm, s));
  const a = acc.old[acc.old.length - 1], b = acc.new[acc.new.length - 1];
  console.log(`start ${s.x.toFixed(0)},${s.z.toFixed(0)}` +
    `   old: ${a.dist.toFixed(0)} m, ${a.recoveries} recoveries, ${a.colliders} colliders, up ${a.climbRate.toFixed(1)} m/s` +
    `   new: ${b.dist.toFixed(0)} m, ${b.recoveries} recoveries, ${b.colliders} colliders, up ${b.climbRate.toFixed(1)} m/s`);
}
const sum = (rs, k) => rs.reduce((t, r) => t + r[k], 0);
console.log(`\n${starts.length} routes of ${SECONDS} s on steep, high ground`);
for (const arm of ['old', 'new']) {
  const r = acc[arm];
  console.log(`  ${arm}:  distance ${sum(r, 'dist').toFixed(0)} m   recoveries ${sum(r, 'recoveries')}   rescues ${sum(r, 'rescues')}` +
    `   NaN ${Math.max(...r.map((q) => q.nan))}   airborne ${sum(r, 'air').toFixed(1)} s   worst climb rate ${Math.max(...r.map((q) => q.climbRate)).toFixed(1)} m/s`);
}
await browser.close();
