#!/usr/bin/env node
// dogrest — verify a resting dog sits ON the drawn camp floor, not the field.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto('http://127.0.0.1:5299/?res=768&seed=20261018' + (process.argv[2] === '--steep' ? '#steep' : ''), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { window.__forceCamera = true; window.__STEEP = location.hash === '#steep'; });

const out = await page.evaluate(async () => {
  const C = window.__camp, V = window.__vehicle, W = window.__world;
  // Pitch on the flattest ground nearby, like a player would.
  const spots = [];
  for (let i = 0; i < 400; i++) {
    const a = Math.random() * Math.PI * 2, d = 15 + Math.random() * 120;
    const x = V.position.x + Math.sin(a) * d, z = V.position.z + Math.cos(a) * d;
    if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0.1) continue;
    spots.push({ x, z, s: W.getSlope(x, z) });
  }
  spots.sort((p, q) => (window.__STEEP ? q.s - p.s : p.s - q.s));
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

  // How far apart are the two surfaces across the rest ring?
  let dMin = Infinity, dMax = -Infinity;
  for (let k = 0; k < 64; k++) {
    const a = k / 64 * Math.PI * 2, r = 1.7 + (k % 5) * 0.25;
    const x = camp.x + Math.sin(a) * r, z = camp.z + Math.cos(a) * r;
    const d = camp.ground.surfaceAt(x, z) - W.getHeight(x, z);
    if (d < dMin) dMin = d; if (d > dMax) dMax = d;
  }

  // Hurry the dog into a rest and hold it there.
  const t0 = performance.now();
  while (performance.now() - t0 < 90000) {
    await new Promise((r) => requestAnimationFrame(r));
    if (dog.stateName === 'wander' && dog.timer > 0.2) dog.timer = 0.2;
    if (dog.stateName === 'rest') break;
  }
  if (dog.stateName !== 'rest') return { err: 'never rested', state: dog.stateName };
  for (let i = 0; i < 90; i++) await new Promise((r) => requestAnimationFrame(r));

  return {
    surfaceVsField: { min: +dMin.toFixed(3), max: +dMax.toFixed(3) },
    state: dog.stateName,
    pose: Object.keys({}).length,
    bodyY: +dog.mesh.position.y.toFixed(3),
    dirtY: +camp.ground.surfaceAt(dog.pos.x, dog.pos.z).toFixed(3),
    fieldY: +W.getHeight(dog.pos.x, dog.pos.z).toFixed(3),
    restY: +dog.restGround.y.toFixed(3),
    restPitch: +dog.restGround.pitch.toFixed(2),
    restRoll: +dog.restGround.roll.toFixed(2),
    restSlope: +dog.restGround.slope.toFixed(2),
    relax: +dog.restRelax.toFixed(2),
    siteSlope: +W.getSlope(dog.pos.x, dog.pos.z).toFixed(2),
    dogPos: { x: +dog.pos.x.toFixed(1), z: +dog.pos.z.toFixed(1) },
  };
});
console.log(JSON.stringify(out, null, 1));

await page.evaluate(() => {
  const camp = window.__camp.camps.find((c) => c.dog);
  const dog = camp.dog;
  const cam = window.__engine.camera;
  cam.position.set(dog.pos.x + 2.6, dog.pos.y + 1.5, dog.pos.z + 2.6);
  cam.lookAt(dog.pos.x, dog.pos.y + 0.15, dog.pos.z);
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'tools/_scratch/dogrest.png' });
console.log('pageerrors:', errs.length ? errs : 'none');
await browser.close();
