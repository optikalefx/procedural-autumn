#!/usr/bin/env node
/**
 * _ffaim — can a player who is actually LOOKING for fireflies get the shot?
 *
 *   node tools/_scratch/_ffaim.mjs
 *
 * The other half of `_ffcal.mjs`. That one measures the accident rate over
 * random night poses; this one measures the deliberate one: stand where the
 * hint sends you — a wet meadow, a river bank, the shallows — after dark,
 * frame the ground, and see what `ffCount` says. A threshold that makes the
 * item rare by making it impossible is not the ask.
 *
 * `ffCount` reads the bake and the swarm's uniforms and never the scene, so
 * nothing here needs to render or to stream; `_hab` is converged by calling
 * `Fireflies.update` with a large dt, which is the system's own damping.
 */
import { chromium } from 'playwright';

const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, pr);
  };
});
page.on('pageerror', (e) => console.log('ERR', String(e)));
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });

const rows = await page.evaluate(async () => {
  const { _internals } = await import('/src/game/hunt_detect.js');
  window.__lighting.hour = 21.5; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  await window.__settle(30);
  window.__ctx.worldPaused = true;
  const ff = window.__systems.wildlife.fireflies;
  const cam = window.__ctx.camera;
  cam.fov = 50; cam.updateProjectionMatrix();
  const out = [];
  for (const kind of ['meadow', 'river', 'mouth', 'lake', 'forest']) {
    for (let idx = 0; idx < 6; idx++) {
      let a = null;
      try { a = window.__anchorAt(kind, idx); } catch { a = null; }
      if (!a || !Number.isFinite(a.x)) continue;
      const g = window.__world.getHeight(a.x, a.z);
      if (!Number.isFinite(g)) continue;
      const ests = [];
      for (let b = 0; b < 4; b++) {
        const yaw = (a.yaw ?? 0) + (b / 4) * Math.PI * 2;
        cam.position.set(a.x, g + 1.7, a.z);
        cam.lookAt(a.x + Math.sin(yaw) * 100, g + 1.7 - 15, a.z + Math.cos(yaw) * 100);
        cam.updateMatrixWorld(true);
        for (let k = 0; k < 3; k++) ff.update(4.0, performance.now() / 1000);
        ests.push(_internals.ffCount(_internals.frameOf(window.__ctx), ff));
      }
      out.push({ kind, idx, best: Math.max(...ests), ests: ests.map((v) => +v.toFixed(0)) });
    }
  }
  return out;
});

console.log('deliberate poses — ground framed at pitch ~-8 deg, four bearings a site, 21:30\n');
for (const r of rows) {
  console.log(`${r.kind.padEnd(8)} #${r.idx}  best ${String(Math.round(r.best)).padStart(4)}   [${r.ests.join(', ')}]`);
}
const sites = rows.length;
for (const t of [110, 250, 300, 350, 375, 400, 425]) {
  const n = rows.filter((r) => r.best >= t).length;
  const per = rows.reduce((p, r) => p + r.ests.filter((v) => v >= t).length, 0);
  console.log(`FF_MIN ${String(t).padStart(4)}  sites where SOME bearing clears: ${n}/${sites}` +
              `   bearings that clear: ${per}/${sites * 4}`);
}
await browser.close();
