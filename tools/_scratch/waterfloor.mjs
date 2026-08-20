#!/usr/bin/env node
/**
 * Does the camera's water floor cover the water the player can see?
 *
 * CameraRig floors every boom sample at `max(getHeight, getWaterHeight ?? -1e9)`,
 * so the camera can only submerge where `getWaterHeight` comes back null under a
 * surface that is nevertheless being drawn. This raycasts the RENDERED water
 * meshes straight down over a grid and compares each hit against what
 * `getWaterHeight` says at the same point — a disagreement is a hole in the
 * clamp, and holes are where D1 lives.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

await acquire('waterfloor');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(600);

const out = await p.evaluate(() => {
  const T = window.__THREE, W = window.__world, scene = window.__engine.scene;
  const water = scene.getObjectByName('Water');
  const rc = new T.Raycaster(); rc.far = 4000;
  const down = new T.Vector3(0, -1, 0);
  let drawn = 0, agree = 0, nul = 0, mismatch = 0, worst = 0, worstAt = null;
  let maxSink = 0, sinkAt = null;
  const sinkHist = new Array(10).fill(0);
  const nulls = [];
  const STEP = 16, R = 1400;
  for (let z = -R; z <= R; z += STEP) {
    for (let x = -R; x <= R; x += STEP) {
      rc.set(new T.Vector3(x, 900, z), down);
      const h = rc.intersectObject(water, true)[0];
      if (!h) continue;
      drawn++;
      const wh = W.getWaterHeight(x, z);
      if (wh === null) {
        nul++;
        const terrain = W.getHeight(x, z);
        const sink = h.point.y - terrain;
        if (sink > maxSink) { maxSink = sink; sinkAt = { x, z, meshY: +h.point.y.toFixed(2), terrain: +terrain.toFixed(2) }; }
        sinkHist[Math.min(9, Math.max(0, Math.floor(sink)))]++;
        if (nulls.length < 8) nulls.push({ x, z, meshY: +h.point.y.toFixed(2), terrain: +terrain.toFixed(2) });
        continue;
      }
      const d = Math.abs(wh - h.point.y);
      if (d > 0.5) { mismatch++; if (d > worst) { worst = d; worstAt = { x, z, wh: +wh.toFixed(2), mesh: +h.point.y.toFixed(2) }; } }
      else agree++;
    }
  }
  const kinds = {};
  for (const c of water.children) kinds[c.name || c.type] = (kinds[c.name || c.type] || 0) + 1;
  return { drawn, agree, nul, mismatch, worst: +worst.toFixed(2), worstAt, nulls,
           nullFrac: +(nul / Math.max(1, drawn)).toFixed(4),
           // How deep the camera could get: at a null texel the clamp uses
           // terrain only, so the drop from the drawn surface to the bed is the
           // whole of the unprotected range.
           maxSink: +maxSink.toFixed(1), sinkAt,
           sinkHistMetres: sinkHist,
           waterKids: kinds };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
