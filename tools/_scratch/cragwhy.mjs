#!/usr/bin/env node
/**
 * Park the camper on high, steep ground, let the world stream in, and then ask
 * of every rock the STREAMER is actually drawing within collider range: does it
 * have a collider, and if not, which rule dropped it.
 *
 * Only live cells are read — probing the scatter directly is not a fair test,
 * because a cell generated at a different detail floor is a different draw.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const N = parseInt(arg('n', '24'), 10);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
// Immune to a peer saving a file mid-run — same stub as drive.mjs. Without it
// a vite reload lands in the middle of the walk and every global goes away.
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

const spots = await page.evaluate((N) => {
  const W = window.__world;
  const out = { flat: [], mountain: [] };
  let guard = 0;
  while (guard++ < 200000 && (out.flat.length < N || out.mountain.length < N)) {
    const x = (Math.random() * 2 - 1) * 1300, z = (Math.random() * 2 - 1) * 1300;
    if (W.getWaterDepth(x, z) > 0.05) continue;
    const s = W.getSlope(x, z), h = W.getHeight(x, z);
    if (s > 0.75) continue;                       // has to be standable
    if (s < 0.30 && h < 80) { if (out.flat.length < N) out.flat.push({ x, z, s, h }); }
    else if (h > 110 || s > 0.5) { if (out.mountain.length < N) out.mountain.push({ x, z, s, h }); }
  }
  return out;
}, N);

const tally = {};
const rows = [];
for (const [band, list] of Object.entries(spots)) {
  for (const s of list) {
    await page.evaluate((S) => { window.__vehicleTeleport(S.x, S.z, 0); }, s);
    await page.waitForTimeout(2000);
    // Drive a few metres and stop. The collider set is only rescanned on
    // travel, so a reading taken standing still measures the streamer's
    // latency rather than the rules under test.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1600);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(1400);
    const r = await page.evaluate((BAND) => {
      const RC = window.__vehicle.phys.rocks, rocks = window.__systems.rocks;
      const st = window.__vehicleState();
      const tops = {};
      for (const [a, gs] of Object.entries(rocks.library)) {
        tops[a] = gs.map((g) => { if (!g.boundingBox) g.computeBoundingBox(); return g.boundingBox.max.y; });
      }
      const out = [];
      const seen = new Set();
      for (const c of rocks.cells.values()) {
        for (const inst of c.instances) {
          const d = Math.hypot(inst.x - st.x, inst.z - st.z);
          if (d > 30) continue;
          const key = `${Math.round(inst.x * 4)},${Math.round(inst.z * 4)},${inst.arch}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const top = inst.y + tops[inst.arch][inst.variant] * inst.sy;
          const gate = top - inst.groundY;
          const rx = Math.abs(inst.sx), rz = Math.abs(inst.sz);
          // how far it really stands out, from the stored ground plane
          const real = top - (inst.groundY - (Math.abs(inst.groundGX) * rx + Math.abs(inst.groundGZ) * rz));
          const reach = Math.max(inst.sx, inst.sz);
          out.push({ band: BAND, arch: inst.arch, size: inst.size, d, gate, real,
            live: RC.live.has(key), hull: !!RC._hull(inst.arch, inst.variant),
            held: d < 2.9 + reach });
        }
      }
      return out;
    }, band);
    rows.push(...r);
  }
}

const MIN = 0.14;
const classify = (o) => {
  if (o.live) return 'has a collider';
  if (!o.hull) return 'no hull for the variant';
  if (o.gate < MIN && o.real < MIN) return 'correctly skipped: buried';
  if (o.gate < MIN) return 'GATED OUT though it stands up';
  if (o.held) return 'held back by SPAWN_CLEAR';
  return 'wanted but not built (queue/cap)';
};
console.log(`\nrocks within 30 m of a parked camper, by ground:\n`);
for (const band of ['flat', 'mountain']) {
  const r = rows.filter((o) => o.band === band);
  const t = {};
  for (const o of r) { const k = classify(o); (t[k] ??= []).push(o); }
  console.log(`${band}  (${r.length} rocks)`);
  for (const [k, v] of Object.entries(t).sort((a, b) => b[1].length - a[1].length)) {
    const big = v.filter((o) => o.real > 1.0);
    console.log(`   ${String(v.length).padStart(4)}  ${k.padEnd(34)}` +
      (k.startsWith('correctly') ? '' : `  of which ${big.length} stand over a metre proud`));
  }
  const missed = r.filter((o) => classify(o) === 'GATED OUT though it stands up');
  if (missed.length) {
    missed.sort((a, b) => b.real - a.real);
    console.log(`   worst missed: ` + missed.slice(0, 4).map((o) => `${o.arch} ${o.size.toFixed(1)} m (stands ${o.real.toFixed(1)} m)`).join(', '));
  }
  console.log('');
}
await browser.close();
