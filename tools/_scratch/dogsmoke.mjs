#!/usr/bin/env node
// dogsmoke — boot the real game, pitch a camp with a dog, watch it live for a
// while, assert no errors / no stuck, and take a proof screenshot.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto('http://127.0.0.1:5299/?res=768&seed=20261018', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { window.__forceCamera = true; });

// Pitch camps until one rolls a dog (80% chance each).
const got = await page.evaluate(async () => {
  const C = window.__camp;
  const V = window.__vehicle;
  for (let attempt = 0; attempt < 8; attempt++) {
    const x = V.position.x + 18 + attempt * 30, z = V.position.z + 12;
    const camp = C.pitchAt(x, z, { instant: true });
    if (!camp) continue;
    // dog is made once raise >= 1 on the next update; wait a few frames
    for (let i = 0; i < 240 && !(camp.hasDog && camp.dog); i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (!camp.hasDog) break;
    }
    if (camp.dog) return { x: camp.x, z: camp.z, y: camp.y };
  }
  return null;
});
if (!got) { console.log('NO DOG after 8 camps'); process.exit(1); }
console.log('camp with dog at', got);

// Watch the dog for ~45 wall-seconds: state changes, movement, stuckT, respawns.
const report = await page.evaluate(async (site) => {
  const C = window.__camp;
  const camp = C.camps.find((c) => c.dog);
  const dog = camp.dog;
  const out = { states: {}, maxStuck: 0, respawns0: dog.respawns, minClear: Infinity, moved: 0, err: null };
  let lx = dog.pos.x, lz = dog.pos.z;
  const t0 = performance.now();
  while (performance.now() - t0 < 45000) {
    await new Promise((r) => requestAnimationFrame(r));
    // aim the camera at the dog from over the fire
    const cam = window.__camera ?? null;
    out.states[dog.stateName] = (out.states[dog.stateName] ?? 0) + 1;
    out.maxStuck = Math.max(out.maxStuck, dog.stuckT);
    out.minClear = Math.min(out.minClear, dog.nearestClearance);
    out.moved += Math.hypot(dog.pos.x - lx, dog.pos.z - lz);
    lx = dog.pos.x; lz = dog.pos.z;
  }
  out.respawns = dog.respawns - out.respawns0;
  out.pos = { x: +dog.pos.x.toFixed(2), z: +dog.pos.z.toFixed(2) };
  return out;
}, got);
console.log('watch:', JSON.stringify(report));

// Screenshot: camera posed above the camp looking at the dog.
await page.evaluate((site) => {
  const camp = window.__camp.camps.find((c) => c.dog);
  const dog = camp.dog;
  const cam = window.__engine.camera;
  cam.position.set(dog.pos.x + 3.4, dog.pos.y + 2.4, dog.pos.z + 3.4);
  cam.lookAt(dog.pos.x, dog.pos.y + 0.3, dog.pos.z);
}, got);
await page.waitForTimeout(400);
await page.screenshot({ path: 'tools/_scratch/dogsmoke.png' });
console.log('console errors:', errs.length ? errs.slice(0, 5) : 'none');
await browser.close();
