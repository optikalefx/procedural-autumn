import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5178';
const OUT = process.argv[2] || 'shots/photoboat';
mkdirSync('shots', { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto(`${URL}/?seed=20261018&car=camper&res=768`, { timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
const site = await p.evaluate(() => {
  const w = window.__world; let best = null;
  for (let x = -1200; x <= 1200; x += 16) for (let z = -1200; z <= 1200; z += 16) {
    if (!w.isInBounds(x, z) || w.getRiver(x, z) < 0.5) continue;
    const h = w.getHydro(x, z); if (h.sdf < 3) continue;
    if (!best || h.sdf > best.sdf) best = { x, z, sdf: h.sdf };
  }
  return best;
});
// The first-run journal auto-opens over the frame; shut it before composing.
await p.evaluate(() => window.__systems.hud.journal?.close?.());
await p.evaluate(({ x, z }) => { const bt = window.__boat; bt.spawnAt(x, z, { kind: 'kayak' }); bt.board(); bt.drive(1, 0); }, site);
await p.waitForTimeout(2500);
// The first-run journal auto-opens over the frame. Shut it here — after it has
// actually opened — and wait until it has finished closing.
await p.evaluate(() => window.__systems.hud.journal?.close?.());
await p.waitForFunction(() => !window.__systems.hud.journal?.active, null, { timeout: 30000, polling: 100 });
await p.waitForTimeout(800);
const png = async (n) => writeFileSync(`${OUT}-${n}.png`, await p.screenshot());
await png('1-seat');
await p.evaluate(() => window.__systems.hud.togglePhoto());
await p.waitForTimeout(1200);
await png('2-photo-entry');
// Fly the camera off the boat: orbit up and back, then zoom in — every one of
// these was inert aboard before the fix.
await p.evaluate(() => {
  const r = window.__systems.cameraRig;
  r.freePitch = 0.42; r.freeYaw += 2.1; r.freeDist = 16;
  const ph = window.__systems.hud.photo, el = ph.zoomEl.input;
  el.value = String(Math.min(+el.max, +el.value + 0.30));
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.waitForTimeout(600);
await png('3-composed');
const a = await p.evaluate(() => window.__ctx.camera.position.toArray());
await p.waitForTimeout(4000);
const c = await p.evaluate(() => window.__ctx.camera.position.toArray());
await png('4-four-seconds-later');
console.log('drift over 4 s:', Math.hypot(a[0]-c[0], a[1]-c[1], a[2]-c[2]).toFixed(6), 'm');
await b.close();
