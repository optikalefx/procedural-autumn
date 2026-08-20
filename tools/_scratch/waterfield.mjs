#!/usr/bin/env node
/**
 * waterfloor.mjs, re-run against the lake field Water.js now publishes.
 *
 * Two questions, in order:
 *
 *  1. Is the published field actually the mesh? Raycast every sample against
 *     the drawn LakeChunk meshes and compare with `lakeField.levelAt(x, z)`.
 *     If these ever differ by more than float noise the whole premise is void.
 *
 *  2. What does `getWaterHeight` return once it can see that field? The query
 *     under test is the one filed as P1-reply:
 *
 *        const p = <nearest-texel point sample>;      // today's answer
 *        const m = world._lake ? world._lake.levelAt(x, z) : null;
 *        return p === null ? m : (m === null ? p : Math.max(p, m));
 *
 *     Same bands, same 8 m grid, same "mesh above terrain" filter as
 *     waterfloor.mjs, so the two tables are directly comparable.
 *
 * `--query now` reproduces waterfloor.mjs's table instead, for the before/after
 * pair inside one page load (P3: two captures minutes apart are two worlds).
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const STEP = parseFloat(arg('step', '8'));

await acquire('waterfield');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(600);

const out = await p.evaluate(({ STEP }) => {
  const T = window.__THREE, W = window.__world, scene = window.__engine.scene;
  const water = scene.getObjectByName('Water');
  const field = window.__systems?.water?.lakeField;
  if (!field) return { error: 'systems.water.lakeField is not published' };

  const rc = new T.Raycaster(); rc.far = 4000;
  const down = new T.Vector3(0, -1, 0);

  const texel = (W.half * 2) / W.res;
  const toGrid = (x, z) => [(x + W.half) / texel, (z + W.half) / texel];
  const wetAt = (gx, gz) => gx >= 0 && gz >= 0 && gx < W.res && gz < W.res && W.water[gz * W.res + gx] >= -9000;
  const nearestWet = (x, z) => {
    const [fx, fz] = toGrid(x, z);
    const cx = Math.round(fx), cz = Math.round(fz), MAXR = Math.ceil(40 / texel);
    for (let r = 0; r <= MAXR; r++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (wetAt(cx + dx, cz + dz)) return r * texel;
        }
    return Infinity;
  };

  // The query under test.
  const MODE = 'both';
  const ask = (mode, x, z) => {
    const pt = W.getWaterHeight(x, z);
    if (mode === 'now') return pt;
    const m = field.levelAt(x, z);
    if (pt === null) return m;
    if (m === null) return pt;
    return Math.max(pt, m);
  };

  const EDGES = [0.15, 0.5, 1, 2, 4, 8, 1e9];
  const LABEL = ['<0.15', '0.15-0.5', '0.5-1', '1-2', '2-4', '4-8', '8+'];
  const band = (d) => { for (let i = 0; i < EDGES.length; i++) if (d < EDGES[i]) return i; return EDGES.length - 1; };
  const mk = () => ({ rows: EDGES.map(() => ({ n: 0, nul: 0, high: 0, low: 0, ring: 0, far: 0 })),
                      worst: 0, worstAt: null, deepNull: 0, deepNullAt: null });
  const res = { now: mk(), fixed: mk() };

  // field-vs-mesh agreement
  let fieldChecked = 0, fieldMax = 0, fieldMaxAt = null, fieldMissing = 0, fieldExtra = 0;
  // the intentional dry dilation ring: does anything there change?
  let ringDryNow = 0, ringWetNow = 0, ringDryFixed = 0, ringWetFixed = 0;

  const R = 1400;
  for (let z = -R; z <= R; z += STEP) {
    for (let x = -R; x <= R; x += STEP) {
      rc.set(new T.Vector3(x, 900, z), down);
      const hits = rc.intersectObject(water, true);
      const lake = hits.find((h) => h.object.name === 'LakeChunk');
      const fv = field.levelAt(x, z);
      if (lake) {
        if (fv === null) fieldMissing++;
        else { fieldChecked++;
          const e = Math.abs(fv - lake.point.y);
          if (e > fieldMax) { fieldMax = e; fieldMaxAt = { x, z, field: +fv.toFixed(4), mesh: +lake.point.y.toFixed(4) }; } }
      } else if (fv !== null) fieldExtra++;

      const h = hits[0];
      if (!h) continue;
      const terr = W.getHeight(x, z);
      const depth = h.point.y - terr;
      for (const mode of ['now', 'fixed']) {
        const r = res[mode];
        const wh = ask(mode === 'now' ? 'now' : 'fixed', x, z);
        if (depth <= 0) {
          const w = wh !== null && wh - terr > 0;
          if (mode === 'now') { if (w) ringWetNow++; else ringDryNow++; }
          else { if (w) ringWetFixed++; else ringDryFixed++; }
          continue;
        }
        const row = r.rows[band(depth)]; row.n++;
        if (wh === null) {
          row.nul++;
          const nw = nearestWet(x, z);
          if (nw <= 16.001) row.ring++; else row.far++;
          if (depth > r.deepNull) { r.deepNull = +depth.toFixed(1);
            r.deepNullAt = { x, z, mesh: +h.point.y.toFixed(2), terrain: +terr.toFixed(2) }; }
          continue;
        }
        const d = wh - h.point.y;
        if (d > 0.5) row.high++;
        else if (d < -0.5) { row.low++;
          if (-d > r.worst) { r.worst = +(-d).toFixed(2);
            r.worstAt = { x, z, dataSays: +wh.toFixed(2), meshIs: +h.point.y.toFixed(2), terrain: +terr.toFixed(2) }; } }
      }
    }
  }
  const table = (r) => r.rows.map((q, i) => ({ depth_m: LABEL[i], samples: q.n,
    nullPct: q.n ? +(100 * q.nul / q.n).toFixed(1) : 0, nullWithin16m: q.ring, nullBeyond16m: q.far,
    dataAboveMeshPct: q.n ? +(100 * q.high / q.n).toFixed(1) : 0,
    dataBelowMeshPct: q.n ? +(100 * q.low / q.n).toFixed(1) : 0 })).filter((q) => q.samples);
  void MODE;
  return {
    fieldVsMesh: { compared: fieldChecked, worstAbsErr: +fieldMax.toFixed(5), worstAt: fieldMaxAt,
                   meshHitButFieldNull: fieldMissing, fieldSaysWaterButNoMeshHit: fieldExtra },
    dryDilationRing: { before: { dry: ringDryNow, wet: ringWetNow },
                       after: { dry: ringDryFixed, wet: ringWetFixed } },
    before: { table: table(res.now), worstDataBelowMesh: res.now.worst, worstAt: res.now.worstAt,
              deepestNull: res.now.deepNull, deepestNullAt: res.now.deepNullAt },
    after: { table: table(res.fixed), worstDataBelowMesh: res.fixed.worst, worstAt: res.fixed.worstAt,
             deepestNull: res.fixed.deepNull, deepestNullAt: res.fixed.deepNullAt },
  };
}, { STEP });
console.log(JSON.stringify(out, null, 1));
await b.close();
