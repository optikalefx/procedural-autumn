#!/usr/bin/env node
/**
 * Water time-of-day sweep. One page load, many (view, hour) frames.
 *
 *   node tools/_scratch/wsweep.mjs --views forest,peaks,river --hours 7.4,12,16.7,18.6 \
 *        --dir shots/water/sweep --res 768
 *
 * Reads the frozen anchors in shots/_anchors.json and never writes them, so it
 * cannot drift another author's framings. Same capture-slot semaphore as
 * shot.mjs.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
// Copied from tools/shot.mjs — importing it would run its main().
const VIEWS = {
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, standOff: 16 },
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58 },
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60 },
  river:     { anchor: 'river',    height: 5.2, dist: 26,  pitch: -0.16, fov: 54, yawOffset: 0.42 },
  waterfall: { anchor: 'waterfall',height: 11,  dist: 58,  pitch: 0.08,  fov: 50, yawOffset: -0.55 },
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42 },
  backlit:   { anchor: 'meadow',   height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, faceSun: true },
  dawn:      { anchor: 'vista',    height: 48,  dist: 130, pitch: -0.13, fov: 46 },
  // Water-only framings: the canonical anchors never look at a fall close up.
  // Frames whatever the biggest fall in the *current* bake is, resolved in the
  // page. The frozen anchors point at a world that has since been re-baked.
  fallauto: { auto: 'fall', fov: 50 },
  // Stands on the bank of the largest open water in the current bake and looks
  // across it: the 2 m and 40 m reads in one frame.
  lakeauto: { auto: 'lake', fov: 55 },
  fallA:  { pos: [-600, 19, 662], look: [-645, 45, 618], fov: 55 },
  fallB:  { pos: [-585, 26, 640], look: [-648, 44, 618], fov: 50 },
  fallC:  { pos: [-600, 34, 690], look: [-650, 46, 617], fov: 45 },
  fallD:  { pos: [-560, 30, 618], look: [-650, 45, 617], fov: 42 },
  lakeedge:  { anchor: 'forest',   height: 1.7, dist: 9,   pitch: -0.22, fov: 55 },
};
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const OUT_W = parseInt(arg('w', '1280'), 10);
const OUT_H = parseInt(arg('h', '720'), 10);
const RES = arg('res', '768');
const DIR = arg('dir', 'shots/water/sweep');
const views = String(arg('views', 'forest,peaks,river,waterfall')).split(',');
const hours = String(arg('hours', '7.4,12,16.7,18.6')).split(',').map(Number);
const EVAL = arg('eval', null);
// --variants "label=js;label2=js2" : run the whole sweep once per variant,
// applying the js before capture. Cheaper than one page load per isolation.
const VARIANTS = arg('variants', null);
const URL = `http://localhost:5178?res=${RES}`;

await acquire('shot');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--enable-webgl', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: OUT_W, height: OUT_H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

let frozen = {};
if (existsSync('shots/_anchors.json')) {
  try { frozen = JSON.parse(readFileSync('shots/_anchors.json', 'utf8')); } catch { frozen = {}; }
}
mkdirSync(resolve(DIR), { recursive: true });

if (EVAL) await page.evaluate((src) => eval(src), EVAL);

const variants = VARIANTS
  ? String(VARIANTS).split(';').map((s) => { const i = s.indexOf('='); return { label: s.slice(0, i), js: s.slice(i + 1) }; })
  : [{ label: '', js: null }];

for (const variant of variants) {
for (const name of views) {
  const v = VIEWS[name];
  if (!v) { console.error(`unknown view ${name}`); continue; }
  if (process.argv.includes('--live')) v.live = true;
  for (const hour of hours) {
   for (let attempt = 0; attempt < 4; attempt++) {
    try {
    await page.waitForFunction(() => window.__ready === true &&
      (document.getElementById('loader')?.classList.contains('hidden') ?? true) &&
      (window.__engine?.renderer?.info?.render?.calls ?? 0) > 10,
      null, { timeout: 300000, polling: 250 });
    await page.evaluate(async ({ v, hour, frozen }) => {
      const THREE = window.__THREE, e = window.__engine, wd = window.__world;
      const api = window.__cameraAnchors || {};
      window.__lighting.hour = hour;
      window.__lighting.cycleSpeed = 0;
      if (v.auto === 'lake') {
        // Coarse scan for the wettest neighbourhood, then walk to its shore.
        const H = 1600, STEP = 40;
        let best = null;
        for (let z = -H; z <= H; z += STEP) {
          for (let x = -H; x <= H; x += STEP) {
            let n = 0;
            for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
              if (wd.getWaterDepth(x + dx * STEP, z + dz * STEP) > 1.2) n++;
            }
            if (!best || n > best.n) best = { x, z, n };
          }
        }
        const c = best;
        let bx = c.x, bz = c.z;
        for (let r = 0; r < 60; r++) {
          const nx = c.x + r * 12, nz = c.z;
          if (wd.getWaterHeight(nx, nz) === null) { bx = nx + 4; bz = nz; break; }
        }
        const gy = wd.getHeight(bx, bz);
        v.pos = [bx, gy + 1.8, bz];
        v.look = [c.x, gy + 1.0, c.z];
      }
      if (v.auto === 'fall') {
        const list = [...wd.waterfalls].sort((a, b) => (b.height * b.discharge) - (a.height * a.discharge));
        const f = list[0];
        const mx = (f.top[0] + f.bottom[0]) * 0.5, mz = (f.top[2] + f.bottom[2]) * 0.5;
        const my = (f.top[1] + f.bottom[1]) * 0.5;
        // Stand off perpendicular to the fall's own run, at ~1.3x its height.
        const dx = f.bottom[0] - f.top[0], dz = f.bottom[2] - f.top[2];
        const hl = Math.hypot(dx, dz) || 1;
        const px = -dz / hl, pz = dx / hl;
        const D = Math.max(45, f.height * 1.3);
        for (const sgn of [1, -1]) {
          const cx = mx + px * D * sgn, cz = mz + pz * D * sgn;
          const g = wd.getHeight(cx, cz);
          if (g < my + f.height * 0.35) {
            v.pos = [cx, Math.max(g + 4, f.bottom[1] + 6), cz];
            v.look = [mx, my, mz];
            break;
          }
        }
        if (!v.pos) { v.pos = [mx + px * D, f.bottom[1] + 10, mz + pz * D]; v.look = [mx, my, mz]; }
      }
      if (v.pos) {
        e.camera.fov = v.fov;
        e.camera.updateProjectionMatrix();
        e.camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
        e.camera.lookAt(v.look[0], v.look[1], v.look[2]);
        window.__forceCamera = true;
        window.dispatchEvent(new Event('resize'));
        if (window.__settle) await window.__settle(50);
        return;
      }
      const anchor = (v.live ? null : frozen[v.anchor]) ?? (api[v.anchor] || api.vista)();
      let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
      if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
      const back = v.standOff ?? 0;
      const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
      const gy = wd.getHeight(gx, gz) + v.height;
      const pos = new THREE.Vector3(gx, gy, gz);
      const look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist,
                                     gy + Math.tan(v.pitch) * v.dist,
                                     gz + Math.cos(yaw) * v.dist);
      e.camera.fov = v.fov;
      e.camera.updateProjectionMatrix();
      e.camera.position.copy(pos);
      e.camera.lookAt(look);
      window.__forceCamera = true;
      window.dispatchEvent(new Event('resize'));
      if (window.__settle) await window.__settle(50);
    }, { v, hour, frozen });
    if (variant.js) await page.evaluate((src) => eval(src), variant.js);
    await page.waitForTimeout(700);
    const out = resolve(DIR, `${name}-h${String(hour).replace('.', '_')}${variant.label ? '-' + variant.label : ''}.png`);
    await page.screenshot({ path: out });
    console.log('shot:', out);
    break;
    } catch (e) {
      console.error(`[wsweep] ${name} h${hour} retry ${attempt + 1}: ${String(e).slice(0, 90)}`);
      await page.waitForTimeout(1500);
    }
   }
  }
}
}
if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 6)));
await browser.close();
