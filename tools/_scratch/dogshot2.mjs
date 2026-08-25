#!/usr/bin/env node
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5299/?res=768&seed=20261018#steep', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { window.__forceCamera = true; window.__STEEP = true; });
const ok = await page.evaluate(async () => {
  const C = window.__camp, V = window.__vehicle, W = window.__world;
  const spots = [];
  for (let i = 0; i < 400; i++) {
    const a = Math.random() * Math.PI * 2, d = 15 + Math.random() * 120;
    const x = V.position.x + Math.sin(a) * d, z = V.position.z + Math.cos(a) * d;
    if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0.1) continue;
    spots.push({ x, z, s: W.getSlope(x, z) });
  }
  // steep but not cliff: 0.35-0.6 band
  const band = spots.filter((p) => p.s > 0.35 && p.s < 0.6);
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
  if (!camp) return null;
  const dog = camp.dog;
  const t0 = performance.now();
  while (performance.now() - t0 < 120000) {
    await new Promise((r) => requestAnimationFrame(r));
    if (dog.stateName === 'wander' && dog.timer > 0.2) dog.timer = 0.2;
    if (dog.stateName === 'rest') break;
  }
  for (let i = 0; i < 60; i++) await new Promise((r) => requestAnimationFrame(r));
  // camera uphill of the dog: sample gradient, stand up-slope
  const e = 0.5;
  const gx = (W.getHeight(dog.pos.x + e, dog.pos.z) - W.getHeight(dog.pos.x - e, dog.pos.z)) / (2 * e);
  const gz = (W.getHeight(dog.pos.x, dog.pos.z + e) - W.getHeight(dog.pos.x, dog.pos.z - e)) / (2 * e);
  const gl = Math.hypot(gx, gz) || 1;
  const ux = -gx / gl, uz = -gz / gl;   // uphill (descend negative gradient? gradient points uphill: +g is uphill)
  const cx = dog.pos.x + gx / gl * 3.2, cz = dog.pos.z + gz / gl * 3.2;
  const cam = window.__engine.camera;
  cam.position.set(cx, W.getHeight(cx, cz) + 1.6, cz);
  cam.lookAt(dog.pos.x, dog.pos.y + 0.15, dog.pos.z);
  return { state: dog.stateName, slope: +dog.restGround?.slope?.toFixed(2), roll: +dog.restGround?.roll?.toFixed(2) };
});
console.log(JSON.stringify(ok));
await page.waitForTimeout(400);
await page.screenshot({ path: 'tools/_scratch/dogshot2.png' });
await browser.close();
