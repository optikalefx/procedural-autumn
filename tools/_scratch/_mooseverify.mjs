/** Size, the quarry pin at range, and rock clearance — all three, one boot. */
import { chromium } from 'playwright';
const BASE = process.env.AUTUMN_URL || 'http://localhost:5178';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 900, height: 600 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
p.on('console', (m) => { const t = m.text(); if (/glb_rig\] moose|home sites/.test(t)) console.log(t.slice(0, 260)); });
await p.goto(`${BASE}/?seed=20261018&car=camper`, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

console.log(JSON.stringify(await p.evaluate(async () => {
  const T = window.__THREE, S = window.__systems, W = window.__world;
  const { SPECIES } = await import('/src/wildlife/animal_species.js');
  // The camper's real height above the road, from the built model.
  const veh = S.vehicle;
  const box = new T.Box3().setFromObject(veh.group ?? veh.mesh ?? veh.root);
  const ground = W.getHeight(veh.position.x, veh.position.z);
  return {
    camperRoof: +(box.max.y - ground).toFixed(2),
    mooseGait: SPECIES.moose.gait,
    height: SPECIES.moose.glb.height,
  };
}), null, 1));

// The quarry pin, from the far corner of the map and from the middle.
console.log('quarry pin:', JSON.stringify(await p.evaluate(() => {
  const wl = window.__systems.wildlife;
  const out = [];
  for (const [x, z] of [[1512, -1512], [0, 0], [-1400, 1400], [1400, 1400]]) {
    const hit = wl.nearestHint(x, z, 'moose');
    out.push({ from: [x, z], pin: hit ? { x: Math.round(hit.x), z: Math.round(hit.z), dist: Math.round(hit.dist) } : null });
  }
  return out;
}), null, 1));

// Rock clearance: soak each site and check nothing ends up inside a boulder.
console.log('rock soak:', JSON.stringify(await p.evaluate(async () => {
  const S = window.__systems, W = window.__world, R = S.rocks;
  const wl = S.wildlife;
  const T = wl.sites, ki = wl.keys.indexOf('moose');
  const res = [];
  for (let i = 0; i < T.n; i++) {
    if (T.spec[i] !== ki) continue;
    const sx = T.x[i], sz = T.z[i];
    // Was the home itself put on a rock?
    const hits = [];
    R.rocksAround(sx, sz, 16, 0, hits);
    const pad = 1.4;
    const onRock = hits.filter((r) => r.size >= 0.8
      && Math.hypot(r.x - sx, r.z - sz) < R.reachOf(r) + pad);
    res.push({ site: i, homeInRock: onRock.length });
  }
  return res;
}), null, 1));
await b.close();
