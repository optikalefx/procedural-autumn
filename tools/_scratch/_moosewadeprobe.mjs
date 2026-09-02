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
    const cx = sites.x[i] + 30, cz = sites.z[i] + 26;
    window.__vehicleTeleport?.(cx, cz, 0.4);
    e.camera.position.set(cx, W.getHeight(cx, cz) + 3, cz);
    e.camera.lookAt(new T.Vector3(cx + 50, W.getHeight(cx, cz) + 3, cz + 50));
    window.__forceCamera = true;
    await new Promise((r) => setTimeout(r, 2600));
    const a = wl.pool.moose.flat().find((m) => m.active);
    if (!a) { res.push({ site: i, live: false }); continue; }
    wl.debugThreat(1e5, 1e5, 0);
    const B = a.brain;
    const R = S.rocks;
    let maxDepth = 0, targets = [], last = -1, homeD = +W.getWaterDepth(B.home.x, B.home.z).toFixed(2);
    let worstRock = 0;
    for (let k = 0; k < 120 * 30; k++) {
      wl.update(1 / 30, 0);
      const d = W.getWaterDepth(B.pos.x, B.pos.z);
      if (d > maxDepth) maxDepth = d;
      if (k % 15 === 0) {
        const hits = [];
        R.rocksAround(B.pos.x, B.pos.z, 14, 0, hits);
        for (const r of hits) {
          if (r.size < 0.8) continue;
          const pen = R.reachOf(r) - Math.hypot(r.x - B.pos.x, r.z - B.pos.z);
          if (pen > worstRock) worstRock = pen;
        }
      }
      if (B.state === 2 && last !== 2) {
        targets.push(+W.getWaterDepth(B.target.x, B.target.z).toFixed(2));
      }
      last = B.state;
    }
    res.push({ site: i, homeDepth: homeD, maxDepthReached: +maxDepth.toFixed(2),
               wanders: targets.length,
               wetTargets: targets.filter((t) => t > 0.15).length,
               targetDepths: targets.slice(0, 14),
               worstRockOverlap: +worstRock.toFixed(2),
               pinned: +(B._pinned ?? 0).toFixed(1),
               wanderRadius: B.cfg.wanderRadius, wade: B.cfg.wade });
  }
  return res;
}), null, 1));
await b.close();
