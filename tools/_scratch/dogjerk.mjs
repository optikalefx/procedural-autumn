#!/usr/bin/env node
// dogjerk — in-game head angular velocity probe, from spawn through settle/rise.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
await page.goto('http://127.0.0.1:5299/?res=640&seed=20261018', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { window.__forceCamera = true; });
const out = await page.evaluate(async () => {
  const C = window.__camp, V = window.__vehicle, W = window.__world;
  const spots = [];
  for (let i = 0; i < 400; i++) {
    const a = Math.random() * Math.PI * 2, d = 15 + Math.random() * 120;
    const x = V.position.x + Math.sin(a) * d, z = V.position.z + Math.cos(a) * d;
    if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0.1) continue;
    spots.push({ x, z, s: W.getSlope(x, z) });
  }
  spots.sort((p, q) => p.s - q.s);
  let camp = null;
  for (let attempt = 0; attempt < 8 && !camp?.dog; attempt++) {
    const c = C.pitchAt(spots[attempt].x, spots[attempt].z, { instant: true });
    if (!c) continue;
    for (let i = 0; i < 240 && !(c.hasDog && c.dog); i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (!c.hasDog) break;
    }
    if (c.dog) camp = c;
  }
  if (!camp) return { err: 'no dog' };
  const dog = camp.dog;
  // Measure with the ENGINE's dt for the frame, not rAF-to-rAF wall time —
  // the two disagree enough to fake or hide spikes.
  let engDt = 1 / 60;
  const realUpdate = dog.update.bind(dog);
  dog.update = (dt, camPos) => { engDt = Math.max(1e-4, dt); return realUpdate(dt, camPos); };
  const THREE = window.__THREE;
  const head = dog.inst.byName['head'];
  const q = new THREE.Quaternion(), qp = new THREE.Quaternion();
  head.getWorldQuaternion(qp);
  const spikes = [];
  let frames = 0, sawStates = {};
  let last = performance.now();
  const t0 = performance.now();
  // Speed the loop through a full settle+rise: clamp wander and rest timers.
  while (performance.now() - t0 < 75000) {
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    const dt = engDt;
    last = now;
    if (dog.stateName === 'wander' && dog.timer > 1.5) dog.timer = 1.5;
    if (dog.stateName === 'rest' && dog.timer > 2) dog.timer = 2;
    head.getWorldQuaternion(q);
    const w = 2 * Math.acos(Math.min(1, Math.abs(q.dot(qp)))) / dt;
    qp.copy(q);
    frames++;
    sawStates[dog.stateName] = (sawStates[dog.stateName] ?? 0) + 1;
    if (frames > 5 && w > 3.5) {
      spikes.push({
        t: +((now - t0) / 1000).toFixed(1), w: +w.toFixed(1), dt: +dt.toFixed(3),
        st: dog.stateName, bl: +dog.blend.toFixed(2), hbl: +dog.headBlend.toFixed(2),
        spd: +dog.speed.toFixed(2), pose: dog.pose ? 'Y' : '-',
      });
    }
  }
  spikes.sort((a, b) => b.w - a.w);
  return { frames, sawStates, nSpikes: spikes.length, top: spikes.slice(0, 15) };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
