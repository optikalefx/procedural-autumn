#!/usr/bin/env node
// Is the shadow map's texel snap actually snapping?
//
// Lighting.update rounds the shadow target to a texel grid in WORLD X and Z.
// The quantity that has to be an integer for a snap to work is the offset
// measured along the shadow CAMERA's own axes, and the shadow camera looks down
// the sun direction, so its right/up vectors are not world X/Z. This walks a
// focus point through the world exactly the way a driving camera does, reads the
// shadow camera's view matrix each step, and prints the offset in texels along
// the light's own axes. An integer means snapped; a fraction means the whole
// depth map slides under the world by that fraction every frame.
//
//   node tools/_scratch/snapprobe.mjs --url http://127.0.0.1:5206
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const URL = arg('url', process.env.AUTUMN_URL || 'http://localhost:5178');
const STEPS = parseInt(arg('steps', '12'), 10);
const STEP_M = parseFloat(arg('step', '0.23'));   // ~14 m/s at 60 fps
const FLATY = argv.includes('--flaty');

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(({ steps, stepM, flaty }) => {
  const THREE = window.__THREE, L = window.__lighting, wd = window.__world;
  const e = window.__engine;
  e.stop();
  // ── THE SHADOW CAMERA'S BASIS IS ONLY CORRECT AFTER A DRAW — 2026-08-22 ──
  //
  // three never touches `sun.shadow.camera` from Lighting.update. The camera is
  // positioned and aimed inside WebGLShadowMap.render, via
  // LightShadow.updateMatrices(light), which happens during a frame. This probe
  // stops the engine and then never draws, so `cam.matrixWorld` — and therefore
  // `right` and `up` — was the basis from whatever the last rendered frame's
  // sun direction happened to be, not the one the row is about.
  //
  // It is not a small error and it scales with the step size, because the whole
  // measurement is a per-step delta projected onto that basis: on the SNAPPED
  // build, at 4 m a step, the stale basis reported right 0.376 / up 0.435 —
  // i.e. worse than the 0.25 this tool calls "random", on code that is in fact
  // snapping exactly. So draw a frame each step and read the basis after it.
  //
  // `_render` is the engine's own render path minus the updaters, so this
  // redraws without letting main.js's own lighting.update(dt, cam.position)
  // overwrite the focus we just set. Same trick as shadowcrawl.mjs's
  // __frozenDraw.
  const draw = () => { if (e._render) e._render(0, e.elapsed); else e.renderer.render(e.scene, e.camera); };
  L.hour = 16.7; L.cycleSpeed = 0;
  const a = window.__cameraAnchors.road();
  const yaw = a.yaw ?? 0;
  const rows = [];
  let prev = null;
  for (let i = 0; i <= steps; i++) {
    const d = i * stepM;
    const x = a.x + Math.sin(yaw) * d, z = a.z + Math.cos(yaw) * d;
    // A chase camera 22 m over the ground — the framing the complaint is about.
    // --flaty holds the focus altitude fixed while X and Z walk. It is the
    // control that separates the two halves of the snap: the target's X and Z
    // are rounded to a texel grid and its Y is not, so if the fractional offset
    // collapses here, the drift is the unsnapped Y.
    const y0 = (window.__probeY ??= wd.getHeight(a.x, a.z) + 22);
    const f = new THREE.Vector3(x, flaty ? y0 : wd.getHeight(x, z) + 22, z);
    L.update(0, f);
    draw();                       // see the note above: the basis needs a frame
    const cam = L.sun.shadow.camera;
    cam.updateMatrixWorld(true);
    const texel = (L.shadowExtent * 2) / L.preset.shadowMapSize;
    // The shadow camera's own right and up in world space.
    const m = cam.matrixWorld.elements;
    const right = new THREE.Vector3(m[0], m[1], m[2]);
    const up = new THREE.Vector3(m[4], m[5], m[6]);
    const t = L.sun.target.position.clone();
    const row = { extent: +L.shadowExtent.toFixed(2), texel: +texel.toFixed(4),
                  nbias: +L.sun.shadow.normalBias.toFixed(4) };
    if (prev) {
      const dv = t.clone().sub(prev.t);
      row.dRight = +(dv.dot(right) / texel).toFixed(3);
      row.dUp = +(dv.dot(up) / texel).toFixed(3);
      row.dExtent = +(L.shadowExtent - prev.e).toFixed(2);
    }
    rows.push(row);
    prev = { t, e: L.shadowExtent };
  }
  window.__engine.start();
  return rows;
}, { steps: STEPS, stepM: STEP_M, flaty: FLATY });

console.log(`focus walked ${STEP_M} m a step (14 m/s at 60 fps), chase framing, h16.7`);
console.log('step  extent   texel   nBias   d(right)  d(up)   dExtent   <- offsets in TEXELS');
out.forEach((r, i) => {
  console.log(`${String(i).padStart(4)}  ${String(r.extent).padStart(6)}  ${String(r.texel).padStart(6)}  ${String(r.nbias).padStart(6)}  ` +
    (r.dRight === undefined ? '' : `${String(r.dRight).padStart(8)}  ${String(r.dUp).padStart(6)}  ${String(r.dExtent).padStart(7)}`));
});
const fr = out.filter((r) => r.dRight !== undefined);
const frac = (v) => Math.abs(v - Math.round(v));
const mR = fr.reduce((a, r) => a + frac(r.dRight), 0) / fr.length;
const mU = fr.reduce((a, r) => a + frac(r.dUp), 0) / fr.length;
console.log(`\nmean |fractional texel| : right ${mR.toFixed(3)}  up ${mU.toFixed(3)}   (0.000 = snapped, 0.25 = random)`);
await browser.close();
