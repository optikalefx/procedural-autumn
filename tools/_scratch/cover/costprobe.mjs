// Time GroundCover's two hot paths directly: one band-0 cell generation, and a
// full repack, at a populated location.
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';
await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)));
await page.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
const out = await page.evaluate(async () => {
  const e = window.__engine, wd = window.__world;
  const X = 1329.85, Z = 1031.67;
  e.camera.position.set(X, wd.getHeight(X, Z) + 1.6, Z);
  e.camera.updateMatrixWorld(true);
  window.__forceCamera = true;
  await window.__settle(400);
  const gc = window.__systems.groundCover;
  const scratch = gc._scratch;
  const cx = Math.floor(X / 48), cz = Math.floor(Z / 48);
  const gen = [];
  for (let k = 0; k < 9; k++) {
    const t = performance.now();
    const n = gc.scatter.generateCell(cx + (k % 3) - 1, cz + ((k / 3) | 0) - 1, 48, 0, scratch, 12200);
    gen.push({ ms: +(performance.now() - t).toFixed(2), n });
  }
  const packs = [];
  for (let k = 0; k < 8; k++) {
    const t = performance.now();
    gc._repack(e.camera.position);
    packs.push(+(performance.now() - t).toFixed(2));
  }
  let far = 0, near = 0;
  for (const c of gc.cells.values()) { far += c.nFar; near += c.nNear; }
  return { gen, packs, instances: gc.stats.instances, cells: gc.cells.size, far, near };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
