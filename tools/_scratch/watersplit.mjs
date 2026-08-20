#!/usr/bin/env node
/**
 * waterfloor.mjs, split by WHICH water mesh the ray hit.
 *
 * P1 attributes the whole disagreement to `_buildLakes`'s 8 m coarsening and
 * dilation ring. `waterfloor.mjs` raycasts `scene.getObjectByName('Water')`
 * recursively, which is the whole group: LakeChunk AND RiverChunk. An offline
 * analytic replica of the lake surface alone reproduces 58 k of the 71 k drawn
 * samples and neither of the two worst cases, so before changing _buildLakes
 * this asks the browser which mesh is actually under each bad sample.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const STEP = parseFloat(arg('step', '8'));

await acquire('watersplit');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(600);

const out = await p.evaluate(({ STEP }) => {
  const T = window.__THREE, W = window.__world, scene = window.__engine.scene;
  const water = scene.getObjectByName('Water');
  const kinds = new Map();
  water.traverse((o) => { if (o.isMesh) kinds.set(o.name, (kinds.get(o.name) || 0) + 1); });
  const rc = new T.Raycaster(); rc.far = 4000;
  const down = new T.Vector3(0, -1, 0);

  const stats = {};
  const row = (k) => (stats[k] ??= { n: 0, standing: 0, nul: 0, deepNull: 0, deepNullAt: null,
                                     worstLow: 0, worstLowAt: null, low: 0, high: 0 });

  const R = 1400;
  for (let z = -R; z <= R; z += STEP) {
    for (let x = -R; x <= R; x += STEP) {
      rc.set(new T.Vector3(x, 900, z), down);
      const h = rc.intersectObject(water, true)[0];
      if (!h) continue;
      const k = h.object.name || '(unnamed)';
      const r = row(k); r.n++;
      const terr = W.getHeight(x, z);
      const depth = h.point.y - terr;
      if (depth <= 0) continue;
      r.standing++;
      const wh = W.getWaterHeight(x, z);
      if (wh === null) {
        r.nul++;
        if (depth > r.deepNull) { r.deepNull = +depth.toFixed(1);
          r.deepNullAt = { x, z, mesh: +h.point.y.toFixed(2), terrain: +terr.toFixed(2) }; }
        continue;
      }
      const d = wh - h.point.y;
      if (d > 0.5) r.high++;
      else if (d < -0.5) { r.low++;
        if (-d > r.worstLow) { r.worstLow = +(-d).toFixed(2);
          r.worstLowAt = { x, z, dataSays: +wh.toFixed(2), meshIs: +h.point.y.toFixed(2), terrain: +terr.toFixed(2) }; } }
    }
  }
  return { meshCounts: [...kinds], stats };
}, { STEP });
console.log(JSON.stringify(out, null, 1));
await b.close();
