#!/usr/bin/env node
/**
 * Where does the water the game DRAWS disagree with the water the game KNOWS?
 *
 * Every gameplay system asks `WorldData.getWaterHeight/getWaterDepth`: the
 * camera's boom floor, wildlife spawn rejection, grass and cover scatter,
 * vehicle fording drag and the fording audio. The player judges by the mesh.
 * Any point where the two disagree is a place an animal can stand in a lake.
 *
 * The raw "mesh exists here" test overstates it, and deliberately so: Water.js
 * marks an 8 m lake quad wet if ANY of its 16 baked texels is wet, and then
 * dilates one more ring, so up to ~16 m of mesh legitimately hangs over dry
 * ground where the shader fades it out. What matters is not where the mesh is,
 * it is where the mesh stands ABOVE THE TERRAIN — because that is water the
 * player can see and drive into.
 *
 * So this reports the disagreement banded by how deep the drawn water is, and
 * for every disagreement measures how far it is to the nearest baked wet texel,
 * which separates "the dilation ring, working as designed" from a real hole.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const STEP = parseFloat(arg('step', '8'));

await acquire('waterfloor');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(600);

const out = await p.evaluate(({ STEP }) => {
  const T = window.__THREE, W = window.__world, scene = window.__engine.scene;
  const water = scene.getObjectByName('Water');
  const rc = new T.Raycaster(); rc.far = 4000;
  const down = new T.Vector3(0, -1, 0);

  // Distance in metres from (x,z) to the nearest baked wet texel, searched
  // outward on the raw grid. Bounded: past 40 m the answer is "not the ring".
  const texel = (W.half * 2) / W.res;
  const toGrid = (x, z) => [(x + W.half) / texel, (z + W.half) / texel];
  const wetAt = (gx, gz) => {
    if (gx < 0 || gz < 0 || gx >= W.res || gz >= W.res) return false;
    return W.water[gz * W.res + gx] >= -9000;
  };
  const nearestWet = (x, z) => {
    const [fx, fz] = toGrid(x, z);
    const cx = Math.round(fx), cz = Math.round(fz);
    const MAXR = Math.ceil(40 / texel);
    for (let r = 0; r <= MAXR; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (wetAt(cx + dx, cz + dz)) return r * texel;
        }
      }
    }
    return Infinity;
  };

  // Bands of drawn depth (mesh above terrain), in metres.
  const EDGES = [0.15, 0.5, 1, 2, 4, 8, 1e9];
  const LABEL = ['<0.15', '0.15-0.5', '0.5-1', '1-2', '2-4', '4-8', '8+'];
  const band = (d) => { for (let i = 0; i < EDGES.length; i++) if (d < EDGES[i]) return i; return EDGES.length - 1; };
  const rows = EDGES.map(() => ({ n: 0, nul: 0, high: 0, low: 0, ringNul: 0, farNul: 0 }));
  let drawn = 0, worst = 0, worstAt = null, deepestNull = 0, deepestNullAt = null;
  const holes = [];

  const R = 1400;
  for (let z = -R; z <= R; z += STEP) {
    for (let x = -R; x <= R; x += STEP) {
      rc.set(new T.Vector3(x, 900, z), down);
      const h = rc.intersectObject(water, true)[0];
      if (!h) continue;
      drawn++;
      const terr = W.getHeight(x, z);
      const depth = h.point.y - terr;
      if (depth <= 0) continue;                       // mesh over dry ground: invisible
      const bi = band(depth);
      const row = rows[bi];
      row.n++;
      const wh = W.getWaterHeight(x, z);
      if (wh === null) {
        row.nul++;
        const nw = nearestWet(x, z);
        if (nw <= 16.001) row.ringNul++; else row.farNul++;
        if (depth > deepestNull) {
          deepestNull = depth;
          deepestNullAt = { x, z, mesh: +h.point.y.toFixed(2), terrain: +terr.toFixed(2),
                            depth: +depth.toFixed(1), nearestWetTexel: nw === Infinity ? '>40' : +nw.toFixed(0) };
        }
        if (depth > 2 && holes.length < 10) {
          holes.push({ x, z, depth: +depth.toFixed(1), nearestWetTexel: nw === Infinity ? '>40' : +nw.toFixed(0) });
        }
        continue;
      }
      // Signed, because the two directions mean opposite things. data ABOVE
      // mesh over-reports water (systems refuse ground that is dry); data BELOW
      // mesh under-reports it, which is the direction that puts an animal in a
      // lake and takes the floor out from under the camera.
      const d = wh - h.point.y;
      if (d > 0.5) row.high++;
      else if (d < -0.5) {
        row.low++;
        if (-d > worst) { worst = -d; worstAt = { x, z, dataSays: +wh.toFixed(2), meshIs: +h.point.y.toFixed(2),
                                                  terrain: +terr.toFixed(2) }; }
      }
    }
  }
  const table = rows.map((r, i) => ({ depth_m: LABEL[i], samples: r.n,
                                      nullPct: r.n ? +(100 * r.nul / r.n).toFixed(1) : 0,
                                      nullWithin16m: r.ringNul, nullBeyond16m: r.farNul,
                                      dataAboveMeshPct: r.n ? +(100 * r.high / r.n).toFixed(1) : 0,
                                      dataBelowMeshPct: r.n ? +(100 * r.low / r.n).toFixed(1) : 0 })).filter((r) => r.samples);
  return { stepM: STEP, drawnSamples: drawn, table, worstDataBelowMesh: +worst.toFixed(2), worstAt,
           deepestNull: +deepestNull.toFixed(1), deepestNullAt, holes };
}, { STEP });
console.log(JSON.stringify(out, null, 1));
await b.close();
