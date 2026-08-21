#!/usr/bin/env node
/** Is a cell's big-rock set the same whatever detail floor it is generated at? */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
await page.goto('http://localhost:5178?res=768');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
const out = await page.evaluate(() => {
  const rocks = window.__systems.rocks, W = window.__world;
  const CELL = 64;
  const rows = [];
  let checked = 0;
  for (let i = 0; i < 3000 && checked < 40; i++) {
    const x = (Math.random() * 2 - 1) * 1300, z = (Math.random() * 2 - 1) * 1300;
    if (W.getSlope(x, z) < 0.5) continue;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const a = [], a2 = [], b = [];
    rocks.scatter.generateCell(cx, cz, CELL, 5.0, a);
    rocks.scatter.generateCell(cx, cz, CELL, 5.0, a2);
    rocks.scatter.generateCell(cx, cz, CELL, 0.35, b);
    // determinism control: the same floor twice
    const same = a.length === a2.length && a.every((r, i) => r.x === a2[i].x && r.z === a2[i].z);
    const bigA = a.filter((r) => r.size >= 5), bigB = b.filter((r) => r.size >= 5);
    if (!bigA.length && !bigB.length) continue;
    checked++;
    const key = (r) => `${r.arch}:${Math.round(r.x)},${Math.round(r.z)}`;
    const setB = new Set(bigB.map(key));
    const onlyA = bigA.filter((r) => !setB.has(key(r)));
    // How far is the nearest fine-draw rock of the same archetype?
    const near = onlyA.map((r) => {
      let d = Infinity;
      for (const q of bigB) if (q.arch === r.arch) d = Math.min(d, Math.hypot(q.x - r.x, q.z - r.z));
      return d;
    });
    rows.push({ coarse: bigA.length, fine: bigB.length, onlyInCoarse: onlyA.length, same, near });
  }
  return rows;
});
const t = out.reduce((a, r) => ({ coarse: a.coarse + r.coarse, fine: a.fine + r.fine, only: a.only + r.onlyInCoarse }), { coarse: 0, fine: 0, only: 0 });
console.log(`cells with big rock: ${out.length}`);
console.log(`big rocks at minSize 5.0: ${t.coarse}   at minSize 0.35: ${t.fine}`);
console.log(`present in the coarse draw but MISSING from the fine one: ${t.only}`);
console.log(`same floor generated twice is identical: ${out.every((r) => r.same)}`);
const near = out.flatMap((r) => r.near).filter((d) => isFinite(d)).sort((a, b) => a - b);
if (near.length) {
  const p = (q) => near[Math.min(near.length - 1, Math.floor(near.length * q))];
  console.log(`distance to the nearest same-arch rock in the fine draw: median ${p(0.5).toFixed(1)} m  p90 ${p(0.9).toFixed(1)} m`);
}
await browser.close();
