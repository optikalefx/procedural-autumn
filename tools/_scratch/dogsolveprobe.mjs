#!/usr/bin/env node
// dogsolveprobe — log the neck solve's actual inputs each engine frame around a snap.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
await page.goto('http://127.0.0.1:5299/?res=640&seed=20261018', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { window.__forceCamera = true; });
const out = await page.evaluate(async () => {
  const C = window.__camp, V = window.__vehicle, W = window.__world;
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
  const THREE = window.__THREE;
  const bv = new THREE.Vector3(), mm = new THREE.Matrix4();
  const rec = [];
  const realUpdate = dog.update.bind(dog);
  let prevPitch = null;
  const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));
  dog.update = (dt, camPos) => {
    const r = realUpdate(dt, camPos);
    // recompute the chest-frame target the way _poseHead did this frame
    bv.copy(rig.headTarget);
    rig.mesh.localToWorld(bv);
    mm.copy(rig.chest.matrixWorld).invert();
    bv.applyMatrix4(mm);
    const fz = Math.hypot(bv.x, bv.z) * Math.sign(bv.z || 1);
    const dy = bv.y - rig.neck.a.position.y, dz = fz - rig.neck.a.position.z;
    const rawElev = Math.atan2(dy, dz);
    const pitch = wrap(rig.neck.a.rotation.x) + wrap(rig.neck.b.rotation.x) + wrap(rig.head.rotation.x);
    const dp = prevPitch === null ? 0 : Math.abs(pitch - prevPitch);
    prevPitch = pitch;
    rec.push({
      dp: +dp.toFixed(3), pitch: +pitch.toFixed(3),
      rawElev: +rawElev.toFixed(3), corr: +(rawElev - rig.carriageDelta).toFixed(3),
      delta: +rig.carriageDelta.toFixed(3), bz: +bv.z.toFixed(3),
      hi: +(-rig.restAng + 0.55).toFixed(2),
    });
    return r;
  };
  const t0 = performance.now();
  while (performance.now() - t0 < 60000) {
    await new Promise((r) => requestAnimationFrame(r));
    if (dog.stateName === 'wander' && dog.timer > 2) dog.timer = 2;
  }
  const worst = rec.map((r, i) => [r.dp, i]).sort((p, q) => q[0] - p[0])[0];
  const i = worst[1];
  return { frames: rec.length, window: rec.slice(Math.max(0, i - 8), i + 6) };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
