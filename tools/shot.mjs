#!/usr/bin/env node
/**
 * Headless capture harness.
 *
 *   node tools/shot.mjs --out shots/x.png --view valley
 *   node tools/shot.mjs --out shots/x.png --pos 12,40,80 --look 0,20,0 --hour 17
 *   node tools/shot.mjs --all --dir shots/run1
 *
 * Boots the game in headless Chromium with a real GPU-ish backend (SwiftShader
 * fallback), waits for the world bake, poses the camera and writes a PNG.
 * Deterministic: same seed + same view = comparable frames.
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

// ── Canonical camera views. Every critic compares the same framings. ────────
export const VIEWS = {
  // Wide establishing shot over the valley — the "box art" frame.
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  // Eye-level drive shot: what the player actually stares at for hours.
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7 },
  // Down in the meadow, grass in the foreground.
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  // Forest interior — canopy, trunks, dappled light.
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  // River bank, water in frame.
  river:     { anchor: 'river',    height: 3.4, dist: 16,  pitch: -0.12, fov: 54, hour: 16.9 },
  // The tallest waterfall, framed from below.
  waterfall: { anchor: 'waterfall',height: 8,   dist: 46,  pitch: 0.10,  fov: 50, hour: 16.2 },
  // High peaks and aerial perspective.
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  // The vehicle, three-quarter hero framing.
  vehicle:   { anchor: 'vehicle',  height: 2.1, dist: 9,   pitch: -0.06, fov: 44, hour: 17.0 },
  // Golden-hour backlit shot — the money frame for foliage translucency.
  backlit:   { anchor: 'meadow',   height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
  // Dawn cool pass, checks the grade does not fall apart off-golden-hour.
  dawn:      { anchor: 'vista',    height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
};

const OUT_W = parseInt(arg('w', '1600'), 10);
const OUT_H = parseInt(arg('h', '900'), 10);
// --res lowers the heightmap resolution for a much faster world bake (the full
// 1536 bake costs ~25 s). Use it for fast iteration; capture final frames at
// full res. --quality forces a preset instead of auto-detecting.
const RES = arg('res', null);
const QUALITY = arg('quality', null);
const SEED = arg('seed', null);
const params = new URLSearchParams();
if (RES) params.set('res', RES);
if (QUALITY) params.set('quality', QUALITY);
if (SEED) params.set('seed', SEED);
const qs = params.toString();
const URL = arg('url', 'http://localhost:5178') + (qs ? `?${qs}` : '');
const TIMEOUT = parseInt(arg('timeout', '180000'), 10);

async function main() {
await acquire('shot');
  const browser = await chromium.launch({
    args: [
      '--use-gl=angle', '--use-angle=metal',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      '--enable-webgl', '--enable-webgl2-compute-context',
      '--disable-frame-rate-limit',
    ],
  });
  const page = await browser.newPage({
    viewport: { width: OUT_W, height: OUT_H },
    deviceScaleFactor: 1,
  });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: TIMEOUT, polling: 250 });

  const views = has('all')
    ? Object.keys(VIEWS)
    : [arg('view', 'hero')].filter(Boolean);

  const dir = arg('dir', 'shots');
  const results = [];

  for (const name of views) {
    const v = VIEWS[name];
    if (!v && !has('pos')) { console.error(`unknown view: ${name}`); continue; }

    await page.evaluate(async ({ v, name, posStr, lookStr, hourArg }) => {
      const THREE = window.__THREE;
      const e = window.__engine, wd = window.__world;
      const api = window.__cameraAnchors || {};

      const hour = hourArg ? parseFloat(hourArg) : (v ? v.hour : 16.7);
      window.__lighting.hour = hour;
      window.__lighting.cycleSpeed = 0;

      let pos, look;
      if (posStr) {
        const p = posStr.split(',').map(Number);
        const l = (lookStr || '0,0,0').split(',').map(Number);
        pos = new THREE.Vector3(p[0], p[1], p[2]);
        look = new THREE.Vector3(l[0], l[1], l[2]);
      } else {
        const anchor = (api[v.anchor] || api.vista || (() => ({ x: 0, z: 0, yaw: 0 })))();
        let yaw = anchor.yaw ?? 0;
        if (v.faceSun) {
          const sd = window.__lighting.sunDir;
          yaw = Math.atan2(sd.x, sd.z);
        }
        // Stand AT the landmark and look along its yaw. Offsetting backwards
        // reliably buries the camera in whatever hill is behind it.
        const gx = anchor.x, gz = anchor.z;
        const gy = wd.getHeight(gx, gz) + v.height;
        pos = new THREE.Vector3(gx, gy, gz);
        look = new THREE.Vector3(
          gx + Math.sin(yaw) * v.dist,
          gy + Math.tan(v.pitch) * v.dist,
          gz + Math.cos(yaw) * v.dist
        );
      }

      e.camera.fov = v ? v.fov : 50;
      e.camera.updateProjectionMatrix();
      e.camera.position.copy(pos);
      e.camera.lookAt(look);
      window.__forceCamera = true;

      // Let streaming, LOD and any temporal effects settle.
      if (window.__settle) await window.__settle(60);
      void name;
    }, { v, name, posStr: arg('pos'), lookStr: arg('look'), hourArg: arg('hour') });

    await page.waitForTimeout(1400);

    const out = has('all') || !arg('out')
      ? resolve(dir, `${name}.png`)
      : resolve(arg('out'));
    if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    results.push(out);
    console.log(`shot: ${out}`);
  }

  const stats = await page.evaluate(() => ({
    fps: window.__fps ?? null,
    drawCalls: window.__engine?.renderer?.info?.render?.calls ?? null,
    triangles: window.__engine?.renderer?.info?.render?.triangles ?? null,
    textures: window.__engine?.renderer?.info?.memory?.textures ?? null,
  }));
  console.log('stats:', JSON.stringify(stats));
  if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));

  await browser.close();
  return results;
}

main().catch((e) => { console.error(e); process.exit(1); });
