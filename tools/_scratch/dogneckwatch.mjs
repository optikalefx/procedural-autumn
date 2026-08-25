#!/usr/bin/env node
// dogneckwatch — record the neck EVERY ENGINE FRAME in the live game.
// Wraps dog.update so measurement runs inside the same frame, full rate,
// with the engine's own dt. Reports the worst per-frame neck-pitch steps.
import { chromium } from 'playwright';
const SECONDS = parseFloat(process.argv[2] ?? '90');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
await page.goto('http://127.0.0.1:5299/?res=640&seed=20261018', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { window.__forceCamera = true; });
const out = await page.evaluate(async (SECONDS) => {
  const C = window.__camp, V = window.__vehicle, W = window.__world;
  // moderate slope on purpose — the flat-site test has been clean for hours
  const spots = [];
  for (let i = 0; i < 500; i++) {
    const a = Math.random() * Math.PI * 2, d = 15 + Math.random() * 120;
    const x = V.position.x + Math.sin(a) * d, z = V.position.z + Math.cos(a) * d;
    if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0.1) continue;
    spots.push({ x, z, s: W.getSlope(x, z) });
  }
  const band = spots.filter((p) => p.s > 0.15 && p.s < 0.4);
  band.sort((p, q) => q.s - p.s);
  let camp = null;
  for (let attempt = 0; attempt < 8 && !camp?.dog; attempt++) {
    const c = C.pitchAt(band[attempt].x, band[attempt].z, { instant: true });
    if (!c) continue;
    for (let i = 0; i < 240 && !(c.hasDog && c.dog); i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (!c.hasDog) break;
    }
    if (c.dog) camp = c;
  }
  if (!camp) return { err: 'no dog' };
  const dog = camp.dog;
  const rig = dog.rig;
  const rec = [];   // per engine frame
  const realUpdate = dog.update.bind(dog);
  let prevPitch = null;
  dog.update = (dt, camPos) => {
    const r = realUpdate(dt, camPos);
    // total neck pitch of the solved chain (local x of neck a + b + head),
    // wrapped, plus the carriage delta and drive state
    const a = rig.neck.a.rotation.x, b = rig.neck.b.rotation.x, h = rig.head.rotation.x;
    const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));
    const pitch = wrap(a) + wrap(b) + wrap(h);
    const dp = prevPitch === null ? 0 : (pitch - prevPitch);
    prevPitch = pitch;
    rec.push([+(dp / Math.max(dt, 1e-4)).toFixed(2), +pitch.toFixed(3),
      +rig.carriageDelta.toFixed(3), dog.stateName[0], +dog.heading.toFixed(2), +dog.speed.toFixed(2)]);
    return r;
  };
  const t0 = performance.now();
  while (performance.now() - t0 < SECONDS * 1000) {
    await new Promise((r) => requestAnimationFrame(r));
    if (dog.stateName === 'wander' && dog.timer > 2) dog.timer = 2;
    if (dog.stateName === 'rest' && dog.timer > 3) dog.timer = 3;
  }
  // worst |rate| windows
  const idx = rec.map((r, i) => [Math.abs(r[0]), i]).sort((p, q) => q[0] - p[0]).slice(0, 8);
  const windows = idx.map(([w, i]) => ({
    at: i, peak: rec[i][0],
    series: rec.slice(Math.max(0, i - 6), i + 7).map((r) => r.join('/')),
  }));
  return { frames: rec.length, siteSlope: +band[0].s.toFixed(2), windows: windows.slice(0, 3) };
}, SECONDS);
console.log(JSON.stringify(out, null, 1));
await browser.close();
