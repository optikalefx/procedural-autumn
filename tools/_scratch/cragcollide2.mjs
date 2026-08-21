#!/usr/bin/env node
/**
 * Two questions about the same block:
 *
 *  1. Would a gate that used the instance's own stored ground PLANE
 *     (groundY + gradient, which the shader already uses to draw the contact
 *     band) agree with the terrain actually sampled under the footprint? If it
 *     does, the collider gate can be fixed for free — no terrain lookups.
 *  2. `_build` refuses to create a collider whose ORIGIN is within
 *     SPAWN_CLEAR + max(sx,sz) of the camper. For a 12 m block that disc is
 *     ~15 m across, which is bigger than the block: standing beside its face,
 *     clear of the stone, the collider is still held back. How often?
 *
 * Also: with a corrected gate, how many colliders end up inside ADD_R on the
 * kind of ground that has crag on it — the budget question.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const N = parseInt(arg('n', '60'), 10);

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

const out = await page.evaluate(async (N) => {
  const THREE = window.__THREE;
  const W = window.__world;
  const rocks = window.__systems.rocks;
  const lib = rocks.library;
  const ADD_R = 30, MIN = 0.14, SPAWN_CLEAR = 2.9;

  const box = {};
  for (const [arch, geoms] of Object.entries(lib)) {
    box[arch] = geoms.map((g) => { if (!g.boundingBox) g.computeBoundingBox(); return g.boundingBox; });
  }

  // Spots on ground a camper could plausibly be on, biased to where crag is:
  // steep enough to carry it, shallow enough to stand on.
  const spots = [];
  let guard = 0;
  while (spots.length < N && guard++ < 200000) {
    const x = (Math.random() * 2 - 1) * 1400, z = (Math.random() * 2 - 1) * 1400;
    if (W.getWaterDepth(x, z) > 0.05) continue;
    const s = W.getSlope(x, z);
    if (s > 0.85) continue;                       // the camper cannot stand here
    // Only spots that actually have a big block near them.
    const near = rocks.rocksAround(x, z, ADD_R, 3.0, []);
    if (!near.length) continue;
    spots.push({ x, z, s, h: W.getHeight(x, z) });
  }

  const rows = [];
  const budget = [];
  const q = new THREE.Quaternion(), v = new THREE.Vector3();
  for (const s of spots) {
    const list = rocks.rocksAround(s.x, s.z, ADD_R, 0.15, []);
    let nOld = 0, nNew = 0;
    for (const inst of list) {
      const bb = box[inst.arch]?.[inst.variant];
      if (!bb) continue;
      const top = inst.y + bb.max.y * inst.sy;
      const gate = top - inst.groundY;

      const rx = Math.max(Math.abs(bb.max.x), Math.abs(bb.min.x)) * inst.sx;
      const rz = Math.max(Math.abs(bb.max.z), Math.abs(bb.min.z)) * inst.sz;
      const r = Math.max(rx, rz);

      // measured: lowest real terrain under the footprint
      let lo = inst.groundY;
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2;
        for (const f of [0.5, 1.0]) {
          const hh = W.getHeight(inst.x + Math.cos(th) * r * f, inst.z + Math.sin(th) * r * f);
          if (hh < lo) lo = hh;
        }
      }
      const real = top - lo;
      // predicted from the stored plane, no terrain sampling
      const plane = top - (inst.groundY - (Math.abs(inst.groundGX) * rx + Math.abs(inst.groundGZ) * rz));

      if (gate >= MIN) nOld++;
      if (plane >= MIN) nNew++;

      // Is the camper actually clear of the stone? Point-in-local-box, in the
      // rock's own frame, is the cheap conservative answer.
      q.set(inst.qx, inst.qy, inst.qz, inst.qw).invert();
      v.set(s.x - inst.x, 0, s.z - inst.z).applyQuaternion(q);
      const insideX = Math.abs(v.x) <= Math.abs(bb.max.x) * inst.sx + 2.9;
      const insideZ = Math.abs(v.z) <= Math.abs(bb.max.z) * inst.sz + 2.9;
      const overlaps = insideX && insideZ;
      const dOrigin = Math.hypot(s.x - inst.x, s.z - inst.z);
      const heldBack = dOrigin < SPAWN_CLEAR + Math.max(inst.sx, inst.sz);

      rows.push({ arch: inst.arch, size: inst.size, gate, real, plane, r,
                  dOrigin, heldBack, overlaps, slope: s.s, h: s.h });
    }
    budget.push({ old: nOld, neu: nNew, slope: s.s, h: s.h });
  }
  return { rows, budget, spots: spots.length };
}, N);

const MIN = 0.14;
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

console.log(`${out.spots} camper-standable spots that have a >3 m rock within 30 m\n`);

// 1. plane estimator vs measured
const solid = out.rows.filter((o) => o.real > 0.5);
const err = solid.map((o) => o.plane - o.real);
console.log(`plane estimator vs measured, over ${solid.length} rocks that really do stand up:`);
console.log(`  error  p10 ${pct(err, 0.10).toFixed(2)}  median ${pct(err, 0.5).toFixed(2)}  p90 ${pct(err, 0.90).toFixed(2)} m`);
const missOld = solid.filter((o) => o.gate < MIN).length;
const missNew = solid.filter((o) => o.plane < MIN).length;
console.log(`  real rock the CURRENT gate drops: ${missOld} / ${solid.length}`);
console.log(`  real rock a PLANE gate would drop: ${missNew} / ${solid.length}`);
const falseNew = out.rows.filter((o) => o.real <= 0.14 && o.plane >= MIN).length;
console.log(`  buried rock a plane gate would wrongly collide: ${falseNew}`);

// 2. hold-back
const want = out.rows.filter((o) => o.real > 0.5);
const held = want.filter((o) => o.heldBack);
const heldClear = held.filter((o) => !o.overlaps);
console.log(`\nSPAWN_CLEAR hold-back, over ${want.length} rocks that stand up within 30 m:`);
console.log(`  held back: ${held.length}   of those the camper is NOWHERE NEAR: ${heldClear.length}`);
const byArch = {};
for (const o of heldClear) { const e = byArch[o.arch] ??= []; e.push(o.size); }
for (const [k, v] of Object.entries(byArch).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`    ${k.padEnd(9)} n=${String(v.length).padStart(4)}  size med ${pct(v, 0.5).toFixed(1)} max ${Math.max(...v).toFixed(1)}`);
}

// 3. budget
const b = out.budget;
console.log(`\ncolliders inside ADD_R (CAP is 96):`);
console.log(`  today:      median ${pct(b.map(x => x.old), 0.5)}  p90 ${pct(b.map(x => x.old), 0.9)}  max ${Math.max(...b.map(x => x.old))}`);
console.log(`  plane gate: median ${pct(b.map(x => x.neu), 0.5)}  p90 ${pct(b.map(x => x.neu), 0.9)}  max ${Math.max(...b.map(x => x.neu))}`);
await browser.close();
