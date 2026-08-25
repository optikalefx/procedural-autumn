#!/usr/bin/env node
// dogfilm — film the dog's first N seconds, camera locked on, and log head
// angular velocity per frame so the film and the numbers line up.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const OUT = 'tools/_scratch/film';
mkdirSync(OUT, { recursive: true });
const SECONDS = parseFloat(process.argv[2] ?? '12');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto('http://127.0.0.1:5299/?res=768&seed=20261018', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { window.__forceCamera = true; });

// pitch a flat camp with a dog, put camera on the dog, return
const ok = await page.evaluate(async () => {
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
  if (!camp) return false;
  const dog = camp.dog;
  const THREE = window.__THREE;
  window.__dogCam = () => {
    // camera on a fixed bearing from the dog, close, at head height
    const cam = window.__engine.camera;
    const a = 2.2;
    cam.position.set(dog.pos.x + Math.sin(a) * 2.2, dog.pos.y + 1.1, dog.pos.z + Math.cos(a) * 2.2);
    cam.lookAt(dog.pos.x, dog.pos.y + 0.35, dog.pos.z);
  };
  const head = dog.inst.byName['head'];
  const q = new THREE.Quaternion(), qp = new THREE.Quaternion();
  head.getWorldQuaternion(qp);
  let engDt = 1 / 60;
  const realUpdate = dog.update.bind(dog);
  dog.update = (dt, camPos) => { engDt = Math.max(1e-4, dt); return realUpdate(dt, camPos); };
  window.__dogW = () => {
    head.getWorldQuaternion(q);
    const w = 2 * Math.acos(Math.min(1, Math.abs(q.dot(qp)))) / engDt;
    qp.copy(q);
    return { w: +w.toFixed(2), st: dog.stateName, spd: +dog.speed.toFixed(2) };
  };
  window.__dogCam();
  return true;
});
if (!ok) { console.log('no dog'); process.exit(1); }

const log = [];
const t0 = Date.now();
let i = 0;
while (Date.now() - t0 < SECONDS * 1000) {
  const m = await page.evaluate(() => { window.__dogCam(); return window.__dogW(); });
  await page.screenshot({ path: `${OUT}/f${String(i).padStart(3, '0')}.png` });
  log.push({ f: i, t: +((Date.now() - t0) / 1000).toFixed(2), ...m });
  i++;
}
console.log(log.map((e) => `${e.f} t${e.t} w${e.w} ${e.st} spd${e.spd}`).join('\n'));
await browser.close();
