#!/usr/bin/env node
/**
 * Scratch: the "does it touch daylight at all" test, and the honest form of it.
 *
 * Poses once, then captures the SAME frame twice in ONE page load — once with
 * the firefly points in the scene, once with them removed — and diffs the two
 * byte for byte. Identical means the system cannot be affecting the daylight
 * frame, which is a stronger claim than "I could not see any dots".
 *
 *   AUTUMN_URL=http://127.0.0.1:5199 node tools/_scratch/ffday.mjs --hours 16.6,19.4,22
 */
import { chromium } from 'playwright';
import { acquire } from './../_lock.mjs';
import { POSE_SRC } from './../_pose.mjs';
import { VIEWS } from './../shot.mjs';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { readPNG } from './../_pngread.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '?seed=' + arg('seed', '20261018');
const view = arg('view', 'camp');
const hours = String(arg('hours', '16.6')).split(',').map(Number);
const dir = arg('dir', 'shots/ff-day');

const EXTRA = { camp: { anchor: 'meadow', height: 1.7, dist: 8, pitch: -0.06, fov: 60 } };
const ALL = { ...VIEWS, ...EXTRA };

await acquire('ffday');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/POSTHOG/.test(m.text())) console.log('CERR', m.text()); });
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
  if (existsSync(f)) { try { frozen = { ...JSON.parse(readFileSync(f, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ } }
}
const poseFn = new Function('P', POSE_SRC);
mkdirSync(dir, { recursive: true });

// A pixel diff cannot answer "did it draw": the grass, the water and the
// wildlife all animate between two consecutive screenshots, so every frame
// differs from every other by millions of subpixels whatever this system does.
// Count the object's own draws instead — three calls onBeforeRender once per
// object per render pass, so zero over a hundred frames is proof it never
// reached the GPU.
await p.evaluate(() => {
  const ff = window.__systems.wildlife.fireflies;
  window.__ffDraws = 0;
  ff.points.onBeforeRender = () => { window.__ffDraws++; };
});

for (const hour of hours) {
  await p.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
  await p.evaluate(poseFn, { v: ALL[view], frozen, dynamic: ['vehicle'] });
  await p.evaluate(async () => { if (window.__settleStable) await window.__settleStable(); });
  const r = await p.evaluate(async () => {
    window.__ffDraws = 0;
    await window.__settle(100);
    const ff = window.__systems.wildlife.fireflies;
    return {
      draws: window.__ffDraws,
      visible: ff.points.visible,
      op: ff.uniforms.uOpacity.value,
      dens: ff.uniforms.uDensity.value,
      night: window.__lighting.constructor ? undefined : undefined,
    };
  });
  const tag = String(hour).replace('.', 'p');
  if (arg('shoot', null)) await p.screenshot({ path: `${dir}/${view}-h${tag}.png` });
  console.log(`h${String(hour).padEnd(5)} draws-in-100-frames ${String(r.draws).padStart(4)}  visible=${r.visible}  opacity=${r.op.toFixed(3)}  density=${r.dens.toFixed(3)}`);
}
await b.close();
