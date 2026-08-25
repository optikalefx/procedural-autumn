#!/usr/bin/env node
/**
 * Scratch: pose like tod.mjs, then dump the firefly system's own state plus the
 * world queries that feed it. Answers "is it dark, is it absent, or is it
 * broken" without guessing from a black frame.
 *
 *   AUTUMN_URL=http://127.0.0.1:5199 node tools/_scratch/ffprobe.mjs --views camp --hours 22
 */
import { chromium } from 'playwright';
import { acquire } from './../_lock.mjs';
import { POSE_SRC } from './../_pose.mjs';
import { VIEWS } from './../shot.mjs';
import { existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '?seed=' + arg('seed', '20261018');
const views = String(arg('views', 'camp')).split(',');
const hours = String(arg('hours', '22')).split(',').map(Number);

const EXTRA = {
  camp: { anchor: 'meadow', height: 1.7, dist: 8, pitch: -0.06, fov: 60 },
  bank: { anchor: 'mouth', height: 2.0, dist: 14, pitch: -0.10, fov: 60 },
  ridge: { anchor: 'peak', height: 90, dist: 380, pitch: 0.02, fov: 48 },
};
const ALL = { ...VIEWS, ...EXTRA };

await acquire('ffprobe');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text()); });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

let frozen = null;
for (const f of ['review/anchors.json', 'shots/_anchors.json']) {
  if (existsSync(f)) { try { frozen = { ...JSON.parse(readFileSync(f, 'utf8')), ...(frozen ?? {}) }; } catch {} }
}
const poseFn = new Function('P', POSE_SRC);

for (const name of views) {
  const v = ALL[name];
  for (const hour of hours) {
    await p.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
    await p.evaluate(poseFn, { v, frozen, dynamic: ['vehicle'] });
    await p.evaluate(async () => { if (window.__settleStable) await window.__settleStable(); await window.__settle(400); });
    const r = await p.evaluate(() => {
      const ff = window.__systems?.wildlife?.fireflies;
      const W = window.__world, c = window.__ctx.camera.position;
      const u = ff?.uniforms ?? {};
      const info = window.__ctx.renderer.info.render;
      return {
        exists: !!ff, n: ff?.n, visible: ff?.points?.visible,
        opacity: u.uOpacity?.value, density: u.uDensity?.value,
        pixelScale: u.uPixelScale?.value,
        night: window.__sky ? undefined : undefined,
        cam: [Math.round(c.x), Math.round(c.y), Math.round(c.z)],
        moisture: W.getMoisture(c.x, c.z), slope: W.getSlope(c.x, c.z),
        height: W.getHeight(c.x, c.z), distWater: W.getDistToWater(c.x, c.z),
        river: W.getRiver(c.x, c.z),
        calls: info.calls, tris: info.triangles,
      };
    });
    console.log(name, 'h' + hour, JSON.stringify(r));
  }
}
await b.close();
