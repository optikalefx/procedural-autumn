#!/usr/bin/env node
/**
 * Sky / weather motion strip.
 *
 * Particles, shafts and drifting cloud cannot be judged from a still. A single
 * frame tells you a leaf exists; it cannot tell you whether the leaf tumbles
 * the way it slips, whether the drift has a direction, or whether motes crawl
 * in a visible lattice. This steps the real simulation at a fixed timestep from
 * a *fixed* camera and writes one PNG per step, so a whole second of air can be
 * read at once and compared between rounds.
 *
 *   node tools/skystrip.mjs --view drive --frames 6 --step 14
 *   node tools/skystrip.mjs --view forest --hour 16.9 --fov 34 --dir shots/sky/s
 *   node tools/sheet.mjs --dir shots/sky/s --out shots/sky/s.png --cols 3 --cell 620
 *
 * The camera is deliberately *not* tracked or moved between frames: anything
 * that is actually moving must move against a still background, which is the
 * only honest test of drift direction and speed.
 *
 * Frames go out through `page.screenshot` rather than `gl.readPixels`, because
 * the raw back buffer comes back dark and grainy compared with what the
 * compositor actually shows — and a strip you cannot trust the tone of is
 * worse than no strip.
 *
 * The view table is duplicated from shot.mjs rather than imported, because
 * importing shot.mjs runs its capture immediately.
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VIEWS = {
  hero:      { anchor: 'vista',  height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7 },
  meadow:    { anchor: 'meadow', height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  forest:    { anchor: 'forest', height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  backlit:   { anchor: 'meadow', height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
  dawn:      { anchor: 'vista',  height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
};

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const VIEW = arg('view', 'drive');
const FRAMES = parseInt(arg('frames', '6'), 10);
const STEP = parseInt(arg('step', '14'), 10);      // sim frames between tiles
const DT = parseFloat(arg('dt', String(1 / 60)));
const TW = parseInt(arg('w', '900'), 10);
const TH = parseInt(arg('h', '520'), 10);
const RES = arg('res', '640');
const HOUR = arg('hour', null);
const FOV = arg('fov', null);
const DIR = resolve(arg('dir', `shots/sky/strip-${VIEW}`));
const URL = `${arg('url', 'http://localhost:5178')}?res=${RES}`;

await acquire('skystrip');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: TW, height: TH }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

// Reuse the frozen anchors so a strip frames the same place shot.mjs does.
let frozen = null;
try { frozen = JSON.parse(readFileSync('shots/_anchors.json', 'utf8')); } catch { /* none yet */ }

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

await page.evaluate((P) => {
  const e = window.__engine, W = window.__world;
  const v = P.VIEW;
  window.__lighting.hour = P.HOUR ?? v.hour;
  window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;

  const api = window.__cameraAnchors || {};
  const anchor = (P.frozen && P.frozen[v.anchor]) || (api[v.anchor] || api.vista)();
  let yaw = anchor.yaw ?? 0;
  if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
  const gx = anchor.x, gz = anchor.z;
  const gy = W.getHeight(gx, gz) + v.height;
  e.camera.fov = P.FOV ?? v.fov;
  e.camera.updateProjectionMatrix();
  e.camera.position.set(gx, gy, gz);
  e.camera.lookAt(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);

  // Fixed-step driving, so a strip is identical on a fast and a slow machine.
  e.stop();
  e.clock.getDelta = () => P.DT;
  window.__stepSim = (n) => { for (let i = 0; i < n; i++) e._loop(); };
  // Settle streaming, LOD and the particle pools before the first tile, or the
  // strip measures the spawn ramp instead of the steady state.
  window.__stepSim(200);
}, { VIEW: VIEWS[VIEW] ?? VIEWS.drive, DT,
     HOUR: HOUR ? parseFloat(HOUR) : null, FOV: FOV ? parseFloat(FOV) : null, frozen });

mkdirSync(DIR, { recursive: true });
for (let f = 0; f < FRAMES; f++) {
  const info = await page.evaluate((n) => {
    window.__stepSim(n);
    const w = window.__systems.weather;
    const e = window.__engine;
    return {
      leaves: w?.leaves?.liveCount ?? -1,
      shafts: w?.shafts?.count ?? -1,
      wind: +(w?.wind?.speed ?? 0).toFixed(2),
      calls: e.renderer.info.render.calls,
      tris: e.renderer.info.render.triangles,
    };
  }, f === 0 ? 1 : STEP);
  // One rAF so the compositor picks up the frame we just rendered by hand.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const t = (f * STEP * DT).toFixed(2);
  await page.screenshot({ path: `${DIR}/f${String(f).padStart(2, '0')}.png` });
  console.log(`  f${f}  t+${t}s  leaves ${info.leaves}  shafts ${info.shafts}  ` +
              `wind ${info.wind}m/s  calls ${info.calls}  tris ${info.tris}`);
}
console.log(`strip: ${DIR}`);
if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 6), null, 1));
await browser.close();
