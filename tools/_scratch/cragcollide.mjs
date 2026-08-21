#!/usr/bin/env node
/**
 * Does a rock high on a mountain get a collider?
 *
 * RockColliders gates on `inst.y + topLocal*sy - inst.groundY >= 0.14`, where
 * `groundY` is the terrain height at the rock's own ORIGIN. On flat ground that
 * is the height the rock stands out of the hill. On a face it is not: the crag
 * anchor deliberately buries the origin (up to size * PLANT_HARD below the
 * centre height) so the uphill half is embedded and the downhill half
 * projects — see RockScatter._place, the 'sag' branch.
 *
 * This harness measures both numbers over steep, high ground:
 *   gate  = what RockColliders computes
 *   real  = the block's top, minus the LOWEST terrain under its own footprint
 *           (the wall height you meet coming at it from downhill)
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const N = parseInt(arg('n', '40'), 10);

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
  const W = window.__world;
  const rocks = window.__systems.rocks;
  const lib = rocks.library;

  const box = {};
  for (const [arch, geoms] of Object.entries(lib)) {
    box[arch] = geoms.map((g) => { if (!g.boundingBox) g.computeBoundingBox(); return g.boundingBox; });
  }

  // Terrain buckets, by the same two numbers the scatter's crag rule uses.
  const buckets = { flat: [], mid: [], steep: [], high: [] };
  let guard = 0;
  while (guard++ < 60000) {
    const x = (Math.random() * 2 - 1) * 1400, z = (Math.random() * 2 - 1) * 1400;
    if (W.getWaterDepth(x, z) > 0.05) continue;
    const s = W.getSlope(x, z), h = W.getHeight(x, z);
    let k = null;
    if (s < 0.35) k = 'flat';
    else if (s < 0.62) k = 'mid';
    else if (h > 95) k = 'high';
    else k = 'steep';
    if (buckets[k].length < N) buckets[k].push({ x, z, s, h });
    if (Object.values(buckets).every((b) => b.length >= N)) break;
  }

  const rows = [];
  for (const [bucket, spots] of Object.entries(buckets)) {
    for (const s of spots) {
      const list = rocks.rocksAround(s.x, s.z, 40, 0.15, []);
      for (const inst of list) {
        const bb = box[inst.arch]?.[inst.variant];
        if (!bb) continue;
        const top = inst.y + bb.max.y * inst.sy;
        const gate = top - inst.groundY;
        // Lowest ground under the block's own plan footprint.
        const rx = Math.max(Math.abs(bb.max.x), Math.abs(bb.min.x)) * inst.sx;
        const rz = Math.max(Math.abs(bb.max.z), Math.abs(bb.min.z)) * inst.sz;
        const r = Math.max(rx, rz);
        let lo = Infinity;
        for (let a = 0; a < 8; a++) {
          const th = (a / 8) * Math.PI * 2;
          for (const f of [0.5, 1.0]) {
            const hh = W.getHeight(inst.x + Math.cos(th) * r * f, inst.z + Math.sin(th) * r * f);
            if (hh < lo) lo = hh;
          }
        }
        lo = Math.min(lo, inst.groundY);
        rows.push({ bucket, arch: inst.arch, size: inst.size, gate, real: top - lo,
                    r, slope: s.s, h: s.h, x: inst.x, z: inst.z, y: inst.y });
      }
    }
  }
  return rows;
}, N);

const MIN = 0.14;
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const order = ['flat', 'mid', 'steep', 'high'];
console.log(`sampled ${N} spots per bucket, rocks within 40 m of each\n`);
console.log('bucket    rocks   gated-out   of those, real height > 1 m   > 2 m   worst real');
for (const b of order) {
  const r = out.filter((o) => o.bucket === b);
  const cut = r.filter((o) => o.gate < MIN);
  const big1 = cut.filter((o) => o.real > 1.0), big2 = cut.filter((o) => o.real > 2.0);
  const worst = cut.length ? Math.max(...cut.map((o) => o.real)) : 0;
  console.log(`${b.padEnd(8)} ${String(r.length).padStart(6)} ${String(cut.length).padStart(9)}  ${String(big1.length).padStart(20)} ${String(big2.length).padStart(7)} ${worst.toFixed(1).padStart(11)} m`);
}
console.log('\nby archetype — rocks the gate drops that are over a metre of exposed rock:');
const byArch = {};
for (const o of out) {
  if (o.gate >= MIN || o.real <= 1.0) continue;
  const e = byArch[o.arch] ??= { n: 0, real: [], gate: [], size: [] };
  e.n++; e.real.push(o.real); e.gate.push(o.gate); e.size.push(o.size);
}
for (const [k, v] of Object.entries(byArch).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k.padEnd(9)} n=${String(v.n).padStart(5)}  real med ${pct(v.real, 0.5).toFixed(1)} max ${Math.max(...v.real).toFixed(1)}  gate med ${pct(v.gate, 0.5).toFixed(1)}  size med ${pct(v.size, 0.5).toFixed(1)}`);
}
const worst = out.filter((o) => o.gate < MIN).sort((a, b) => b.real - a.real).slice(0, 8);
console.log('\nworst offenders (x, z, arch, size, gate, real):');
for (const o of worst) console.log(`  ${o.x.toFixed(0).padStart(6)} ${o.z.toFixed(0).padStart(6)}  ${o.arch.padEnd(8)} size ${o.size.toFixed(1).padStart(5)}  gate ${o.gate.toFixed(1).padStart(6)}  real ${o.real.toFixed(1)}`);
await browser.close();
