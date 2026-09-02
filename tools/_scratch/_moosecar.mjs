/** The moose next to the camper, framed from a bearing with nothing in it. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = process.env.AUTUMN_URL || 'http://localhost:5178';
const OUT = 'shots/moosescale';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto(`${BASE}/?seed=20261018&car=camper&quality=high`, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await p.evaluate(() => window.__settleStable?.() ?? window.__settle?.(60));

const site = Number(process.argv[2] ?? 1);
const info = await p.evaluate(async ({ site }) => {
  const S = window.__systems, W = window.__world, e = window.__engine, T = window.__THREE;
  S.hud?.journal?.close();
  const j = S.hud?.journal; for (let i = 0; i < 200 && j?._visible; i++) j.update(0.05);
  window.__lighting.hour = 15.4; window.__lighting.cycleSpeed = 0;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  const wl = S.wildlife, T2 = wl.sites, ki = wl.keys.indexOf('moose');
  const idx = [];
  for (let i = 0; i < T2.n; i++) if (T2.spec[i] === ki) idx.push(i);
  const si = idx[site % idx.length];
  const sx = T2.x[si], sz = T2.z[si];
  // Stream in from the side, looking away — the frustum guard.
  const cx = sx + 34, cz = sz + 30;
  window.__vehicleTeleport?.(cx, cz, 0.4);
  e.camera.position.set(cx, W.getHeight(cx, cz) + 3, cz);
  e.camera.lookAt(new T.Vector3(cx + 50, W.getHeight(cx, cz) + 3, cz + 50));
  window.__forceCamera = true;
  return { si, sx, sz };
}, { site });
await p.waitForTimeout(3200);

const shot = await p.evaluate(() => {
  const S = window.__systems, W = window.__world, e = window.__engine, T = window.__THREE;
  const wl = S.wildlife;
  wl.debugThreat(1e5, 1e5, 0);
  const a = wl.pool.moose.flat().find((m) => m.active);
  if (!a) return { n: 0 };
  const P = a.brain.pos;
  // Park the camper on dry, tree-free ground about 9 m from the animal.
  let vx = P.x, vz = P.z, found = false;
  for (let r = 9; r < 22 && !found; r += 2) {
    for (let i = 0; i < 16 && !found; i++) {
      const th = (i / 16) * Math.PI * 2;
      const x = P.x + Math.sin(th) * r, z = P.z + Math.cos(th) * r;
      if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0.05) continue;
      if (W.getSlope(x, z) > 0.22 || wl._treeNear(x, z, 6)) continue;
      vx = x; vz = z; found = true;
    }
  }
  window.__vehicleTeleport?.(vx, vz, 0.3);
  // Broadside to the pair, from a bearing with no trunk on it.
  const mx = (vx + P.x) / 2, mz = (vz + P.z) / 2;
  const base = Math.atan2(P.x - vx, P.z - vz) + Math.PI / 2;
  const d = 30;
  let bx = mx - Math.sin(base) * d, bz = mz - Math.cos(base) * d, best = -1;
  for (let i = 0; i < 24; i++) {
    const y2 = base + (i / 24) * Math.PI * 2;
    const tx = mx - Math.sin(y2) * d, tz = mz - Math.cos(y2) * d;
    if (!W.isInBounds(tx, tz) || W.getWaterDepth(tx, tz) > 0.4) continue;
    let sc = 1;
    for (let s = 0.05; s < 1; s += 0.08) {
      const px = tx + (mx - tx) * s, pz = tz + (mz - tz) * s;
      if (wl._treeNear(px, pz, 4)) { sc -= 0.2; }
    }
    if (wl._treeNear(tx, tz, 7)) sc -= 0.6;
    if (sc > best) { best = sc; bx = tx; bz = tz; }
  }
  e.camera.position.set(bx, W.getHeight(bx, bz) + 3.4, bz);
  e.camera.lookAt(new T.Vector3(mx, W.getHeight(mx, mz) + 2.0, mz));
  e.camera.fov = 42; e.camera.updateProjectionMatrix();
  window.__forceCamera = true;
  e.camera.updateMatrixWorld(true);
  window.dispatchEvent(new Event('resize'));
  const mb = new T.Box3().setFromObject(a.mesh);
  const vb = new T.Box3().setFromObject(S.vehicle.root);
  return { n: 1, apart: +Math.hypot(vx - P.x, vz - P.z).toFixed(1),
           mooseTop: +(mb.max.y - W.getHeight(P.x, P.z)).toFixed(2),
           camperTop: +(vb.max.y - W.getHeight(vx, vz)).toFixed(2),
           gait: a.rig.gaitName };
});
await p.waitForTimeout(1400);
await p.screenshot({ path: `${OUT}/car.png` });
console.log('car', JSON.stringify(shot));
await b.close();
