/**
 * The paw print on the compass strip, posed.
 *
 * Spawns a deer inside its hint band, then drives the compass at the paw's own
 * bearing so the pin renders centred and at full opacity — the strip fades and
 * edge-clamps anything behind the player, which is correct in play and useless
 * for looking at the glyph.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { writeFileSync } from 'node:fs';
await acquire('pawshot');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 2 });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (/[?&]token=|vite-hmr|__vite/.test(String(u))) return { readyState: 3, close(){}, send(){}, addEventListener(){}, removeEventListener(){} };
    return new R(u, pr);
  };
});
await p.goto((process.env.AUTUMN_URL) + '?res=1024&car=camper');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });
await p.evaluate(() => window.__settle?.(60));
const info = await p.evaluate((dist) => {
  const ctx = window.__ctx, wl = ctx.systems.wildlife, hud = ctx.systems.hud;
  const here = hud._anchor(ctx.camera.position);
  wl.debugClear();
  wl.debugSpawn('deer', { x: here.x + dist, z: here.z + dist * 0.25 });
  hud._refreshMarks(ctx.camera.position);
  const paw = hud.marks.find((m) => m.kind === 'paw');
  if (!paw) return { error: 'no paw' };
  // Freeze the HUD's own per-frame pull so the posed heading survives to the
  // screenshot, then drive the strip at the paw's bearing.
  hud.update = () => {};
  hud.compass.update(paw.bearing, hud.marks);
  return { dist: +paw.dist.toFixed(1), bearing: +paw.bearing.toFixed(1), noLabel: paw.noLabel,
           kinds: hud.marks.map((m) => m.kind) };
}, parseFloat(process.argv[3] || '95'));
writeFileSync(process.argv[2], await p.screenshot({ type: 'png' }));
console.log(JSON.stringify(info));
await b.close();
