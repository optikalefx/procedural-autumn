/** A spooked moose at its real river site: does rock avoidance ever pin it? */
import { chromium } from 'playwright';
const BASE = process.env.AUTUMN_URL || 'http://localhost:5178';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto(`${BASE}/?seed=20261018&car=camper`, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
console.log(JSON.stringify(await p.evaluate(async () => {
  const S = window.__systems, W = window.__world, wl = S.wildlife, e = window.__engine, T = window.__THREE;
  const sites = wl.sites, ki = wl.keys.indexOf('moose');
  const res = [];
  for (let i = 0; i < sites.n; i++) {
    if (sites.spec[i] !== ki) continue;
    const cx = sites.x[i] + 34, cz = sites.z[i] + 30;
    window.__vehicleTeleport?.(cx, cz, 0.4);
    e.camera.position.set(cx, W.getHeight(cx, cz) + 3, cz);
    e.camera.lookAt(new T.Vector3(cx + 50, W.getHeight(cx, cz) + 3, cz + 50));
    window.__forceCamera = true;
    await new Promise((r) => setTimeout(r, 2800));
    const a = wl.pool.moose.flat().find((m) => m.active);
    if (!a) { res.push({ site: i, live: false }); continue; }
    const B = a.brain;
    // Chase it: the threat teleports beside the animal every few seconds, the
    // way the pen's `spook` mode does, but on the real riverbank with the real
    // boulders in it.
    let maxPin = 0, worstRock = 0, states = new Set(), gaits = new Set(), maxD = 0;
    const R = S.rocks;
    for (let k = 0; k < 120 * 30; k++) {
      if (k % (30 * 6) === 0) {
        const th = (k / 180) * 1.7;
        wl.debugThreat(B.pos.x + Math.sin(th) * 16, B.pos.z + Math.cos(th) * 16, 0);
      }
      wl.update(1 / 30, 0);
      maxPin = Math.max(maxPin, B._pinned ?? 0);
      if (k % 15) continue;
      states.add(B.state); gaits.add(a.rig.gaitName);
      maxD = Math.max(maxD, W.getWaterDepth(B.pos.x, B.pos.z));
      const hits = [];
      R.rocksAround(B.pos.x, B.pos.z, 14, 0, hits);
      for (const r of hits) {
        if (r.size < 0.8) continue;
        const pen = R.reachOf(r) - Math.hypot(r.x - B.pos.x, r.z - B.pos.z);
        if (pen > worstRock) worstRock = pen;
      }
    }
    res.push({ site: i, maxPinned: +maxPin.toFixed(1), worstRockOverlap: +worstRock.toFixed(2),
               maxDepth: +maxD.toFixed(2), states: [...states].sort(), gaits: [...gaits].sort() });
  }
  return res;
}), null, 1));
await b.close();
