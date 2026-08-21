#!/usr/bin/env node
/**
 * Rock collision test.
 *
 * The player asked for two behaviours and they are opposites, so the test has
 * to show both from the same code: a low rock is driven over, a big one stops
 * the camper. This finds real rocks in the world, sorts them by how far they
 * stand out of the ground, and drives at each one from 22 m out on flat-ish
 * ground — then reports, per protrusion band, how many were climbed and how
 * many blocked.
 *
 *   node tools/_scratch/rockdrive.mjs --n 24
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const N = parseInt(arg('n', '24'), 10);
const HEADED = argv.includes('--headed');

const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
        send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=768');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await page.waitForTimeout(1500);

// ── find candidate rocks: park near a random spot, read what streamed in ────
const targets = await page.evaluate(async (want) => {
  const W = window.__world, rocks = window.__systems.rocks, veh = window.__systems.vehicle;
  const tops = {};
  for (const [arch, geoms] of Object.entries(rocks.library)) {
    tops[arch] = geoms.map((g) => { if (!g.boundingBox) g.computeBoundingBox(); return g.boundingBox.max.y; });
  }
  const found = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 0; attempt < 90 && found.length < want * 3; attempt++) {
    const x = (Math.random() * 2 - 1) * 1300, z = (Math.random() * 2 - 1) * 1300;
    if (W.getWaterDepth(x, z) > 0.05 || W.getSlope(x, z) > 0.55) continue;
    veh.phys.teleport(x, z, 0);
    await sleep(700);
    for (const c of rocks.cells.values()) {
      for (const r of c.instances) {
        const d = Math.hypot(r.x - x, r.z - z);
        if (d > 60) continue;
        const prot = r.y + (tops[r.arch]?.[r.variant] ?? 1) * r.sy - r.groundY;
        if (prot < 0.15) continue;
        found.push({ x: r.x, z: r.z, prot, size: r.size, arch: r.arch,
          reach: Math.max(r.sx, r.sz) });
      }
    }
  }
  // One per spot: dedupe and spread across the protrusion range.
  const seen = new Set();
  const uniq = found.filter((f) => {
    const k = `${Math.round(f.x)},${Math.round(f.z)}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  uniq.sort((a, b) => a.prot - b.prot);
  const out = [];
  for (let i = 0; i < want && uniq.length; i++) {
    out.push(uniq[Math.min(uniq.length - 1, Math.round(i * (uniq.length - 1) / Math.max(1, want - 1)))]);
  }
  return out;
}, N);

console.log(`found ${targets.length} target rocks`);

// ── drive at each one ───────────────────────────────────────────────────────
const results = [];
for (const t of targets) {
  // Approach from the flattest bearing, so the run measures the rock and not
  // the hill it sits on.
  const setup = await page.evaluate((T) => {
    const W = window.__world, veh = window.__systems.vehicle;
    let best = null;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const sx = T.x + Math.cos(a) * 22, sz = T.z + Math.sin(a) * 22;
      if (!W.isInBounds(sx, sz)) continue;
      if (W.getWaterDepth(sx, sz) > 0.05) continue;
      // Sample the whole approach lane, not just its start.
      let worst = 0, wet = 0, drop = 0;
      const h0 = W.getHeight(sx, sz);
      for (let s = 0; s <= 1.0; s += 0.1) {
        const px = sx + (T.x - sx) * s, pz = sz + (T.z - sz) * s;
        worst = Math.max(worst, W.getSlope(px, pz));
        wet = Math.max(wet, W.getWaterDepth(px, pz));
        drop = Math.max(drop, Math.abs(W.getHeight(px, pz) - h0));
      }
      if (wet > 0.05) continue;
      const score = worst + drop * 0.15;
      if (!best || score < best.score) best = { x: sx, z: sz, a, score, worst, drop };
    }
    if (!best) return null;
    // Heading: +Z is forward, so yaw = atan2(dx, dz) toward the rock.
    const yaw = Math.atan2(T.x - best.x, T.z - best.z);
    veh.phys.teleport(best.x, best.z, yaw);
    return { ...best, yaw, groundAtRock: W.getHeight(T.x, T.z) };
  }, t);
  if (!setup) { continue; }

  await page.waitForTimeout(900);          // let the rock colliders stream in
  const before = await page.evaluate(() => window.__vehicleState());
  await page.keyboard.down('KeyW');
  const track = [];
  for (let i = 0; i < 46; i++) {           // ~5.5 s
    await page.waitForTimeout(120);
    track.push(await page.evaluate(() => window.__vehicleState()));
  }
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(400);

  const last = track[track.length - 1];
  const dist = Math.hypot(last.x - before.x, last.z - before.z);
  // How close the camper's centre got to the rock's centre, and how high it
  // rose above the ground under the rock.
  let closest = Infinity, lift = -Infinity;
  for (const s of track) {
    closest = Math.min(closest, Math.hypot(s.x - t.x, s.z - t.z));
    lift = Math.max(lift, s.y - setup.groundAtRock);
  }
  const state = await page.evaluate(() => window.__vehicleState());
  results.push({ ...t, dist, closest, lift, recoveries: state.recoveries,
    colliders: state.rockColliders, approachSlope: setup.worst });
  process.stdout.write('.');
}
console.log('');

// ── report ─────────────────────────────────────────────────────────────────
// "Climbed" = the camper's centre passed over the rock's own footprint.
// "Blocked" = it got within a chassis length and stopped short.
const band = (p) => (p < 0.35 ? '0.15–0.35' : p < 0.60 ? '0.35–0.60'
  : p < 1.00 ? '0.60–1.00' : p < 2.0 ? '1.00–2.00' : '2.00+');
const bands = {};
for (const r of results) {
  const b = (bands[band(r.prot)] ??= { n: 0, over: 0, blocked: 0, dists: [] });
  b.n++;
  const over = r.closest < r.reach * 0.9;
  if (over) b.over++; else b.blocked++;
  b.dists.push(r.dist);
}
console.log('\nprotrusion    n   drove over   blocked   median run (m)');
for (const k of ['0.15–0.35', '0.35–0.60', '0.60–1.00', '1.00–2.00', '2.00+']) {
  const b = bands[k];
  if (!b) continue;
  b.dists.sort((a, c) => a - c);
  console.log(`  ${k.padEnd(11)} ${String(b.n).padStart(2)}   ${String(b.over).padStart(9)}   ${String(b.blocked).padStart(7)}   ${b.dists[b.dists.length >> 1].toFixed(1)}`);
}
console.log('\nper rock:');
for (const r of results.sort((a, b) => a.prot - b.prot)) {
  console.log(`  ${r.arch.padEnd(9)} prot ${r.prot.toFixed(2).padStart(6)}  reach ${r.reach.toFixed(2)}  ran ${r.dist.toFixed(1).padStart(5)} m  closest ${r.closest.toFixed(2).padStart(6)}  lift ${r.lift.toFixed(2).padStart(6)}  cols ${r.colliders}  rec ${r.recoveries}`);
}
if (errors.length) console.log('\nPAGE ERRORS:', errors.slice(0, 8));
await browser.close();
