#!/usr/bin/env node
/**
 * D1, stated as the camera states it: how much of the visible water can the
 * chase boom sit *inside*?
 *
 * `CameraRig` floors every boom sample at `max(getHeight, getWaterHeight ?? -1e9)`
 * — `_clearGround` (191), `_boomFit` (227), `_groundAt` (248), and the
 * `__cameraState` debug surface (96). All four take the max, so over the dry
 * dilation ring the terrain wins and nothing changes; the failure is only ever
 * a floor that lands BELOW a water surface the player can see.
 *
 * `waterfield.mjs` established that `lakeField.levelAt` reproduces the drawn
 * mesh to 0.00000 m over 70,923 raycast samples, so the drawn surface can be
 * read directly here and the whole world swept on a 4 m grid in seconds instead
 * of raycasting for ten minutes.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const STEP = parseFloat(arg('step', '4'));

await acquire('camfloor');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(600);

const out = await p.evaluate(({ STEP }) => {
  const W = window.__world;
  const field = window.__systems?.water?.lakeField;
  if (!field) return { error: 'systems.water.lakeField is not published' };

  const now = (x, z) => W.getWaterHeight(x, z);
  const fixed = (x, z) => {
    const pt = W.getWaterHeight(x, z), m = field.levelAt(x, z);
    if (pt === null) return m;
    if (m === null) return pt;
    return Math.max(pt, m);
  };
  const floor = (q, x, z) => { const w = q(x, z); return Math.max(W.getHeight(x, z), w === null ? -1e9 : w); };

  const r = { standing: 0,
              now: { under: 0, worst: 0, worstAt: null, over1m: 0 },
              fixed: { under: 0, worst: 0, worstAt: null, over1m: 0 } };
  const R = 1400;
  for (let z = -R; z <= R; z += STEP) {
    for (let x = -R; x <= R; x += STEP) {
      const surf = field.levelAt(x, z);
      if (surf === null) continue;
      const terr = W.getHeight(x, z);
      if (surf - terr <= 0) continue;              // the dry dilation ring
      r.standing++;
      for (const k of ['now', 'fixed']) {
        const f = floor(k === 'now' ? now : fixed, x, z);
        const gap = surf - f;                      // >0 ⇒ the boom may sit inside visible water
        if (gap > 1e-6) {
          r[k].under++;
          if (gap > 1) r[k].over1m++;
          if (gap > r[k].worst) { r[k].worst = +gap.toFixed(2);
            r[k].worstAt = { x, z, drawnSurface: +surf.toFixed(2), boomFloor: +f.toFixed(2), terrain: +terr.toFixed(2) }; }
        }
      }
    }
  }
  const pct = (n) => +(100 * n / r.standing).toFixed(2);
  return { stepM: STEP, standingWaterSamples: r.standing,
    before: { boomFloorBelowDrawnSurface: r.now.under, pct: pct(r.now.under),
              deeperThan1m: r.now.over1m, worstMetres: r.now.worst, worstAt: r.now.worstAt },
    after:  { boomFloorBelowDrawnSurface: r.fixed.under, pct: pct(r.fixed.under),
              deeperThan1m: r.fixed.over1m, worstMetres: r.fixed.worst, worstAt: r.fixed.worstAt } };
}, { STEP });
console.log(JSON.stringify(out, null, 1));
await b.close();
