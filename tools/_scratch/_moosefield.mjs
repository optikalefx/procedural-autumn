/** The moose where it actually lives: teleport to each river site and shoot it. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = process.env.AUTUMN_URL || 'http://localhost:5178';
const OUT = 'shots/moosefield';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto(`${BASE}/?seed=20261018&car=camper&quality=high`, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await p.evaluate(() => window.__settleStable?.() ?? window.__settle?.(60));

const sites = await p.evaluate(() => {
  const S = window.__systems, W = window.__world, e = window.__engine;
  S.hud?.journal?.close();
  const j = S.hud?.journal; for (let i = 0; i < 200 && j?._visible; i++) j.update(0.05);
  window.__lighting.hour = 16.4; window.__lighting.cycleSpeed = 0;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  const wl = S.wildlife, T = wl.sites, ki = wl.keys.indexOf('moose');
  const out = [];
  for (let i = 0; i < T.n; i++) if (T.spec[i] === ki) {
    out.push({ i, x: T.x[i], z: T.z[i], depth: W.getWaterDepth(T.x[i], T.z[i]),
               h: W.getHeight(T.x[i], T.z[i]), lineLen: T.lines[i]?.length ?? 0 });
  }
  return out;
});
console.log('sites', JSON.stringify(sites.map((s) => ({ ...s, x: +s.x.toFixed(0), z: +s.z.toFixed(0), depth: +s.depth.toFixed(2), h: +s.h.toFixed(0) })), null, 1));

for (const s of sites) {
  // Nothing may appear inside the player's view — `_activate` has a frustum
  // guard — so a camera parked ON the site keeps it asleep forever. Teleport,
  // look AWAY while it streams in, then turn round. The first cut of this
  // pointed straight at the site and reported "no moose here" three times.
  await p.evaluate(({ s }) => {
    const S = window.__systems, W = window.__world, e = window.__engine, T = window.__THREE;
    const cx = s.x + 26, cz = s.z + 22;
    window.__vehicleTeleport?.(cx, cz, 0.4);
    e.camera.position.set(cx, W.getHeight(cx, cz) + 3.0, cz);
    e.camera.lookAt(new T.Vector3(cx + 40, W.getHeight(cx, cz) + 3.0, cz + 40));
    e.camera.fov = 45; e.camera.updateProjectionMatrix();
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
  }, { s });
  await p.waitForTimeout(4000);
  const shot = await p.evaluate(() => {
    const S = window.__systems, W = window.__world, e = window.__engine, T = window.__THREE;
    const live = S.wildlife.pool.moose.flat().filter((m) => m.active);
    if (!live.length) return { n: 0 };
    const a = live[0];
    const yaw = a.brain.heading + Math.PI / 2;
    const d = 15;
    const cx = a.brain.pos.x - Math.sin(yaw) * d, cz = a.brain.pos.z - Math.cos(yaw) * d;
    e.camera.position.set(cx, W.getHeight(cx, cz) + 2.6, cz);
    e.camera.lookAt(new T.Vector3(a.brain.pos.x, a.brain.pos.y + 1.3, a.brain.pos.z));
    e.camera.updateMatrixWorld(true);
    return { n: live.length, state: a.brain.state, gait: a.rig.gaitName,
             variant: a.rig.proto?.variant?.name,
             depth: +W.getWaterDepth(a.brain.pos.x, a.brain.pos.z).toFixed(3),
             fromHome: +Math.hypot(a.brain.pos.x - a.brain.home.x, a.brain.pos.z - a.brain.home.z).toFixed(1),
             speed: +a.brain.speed.toFixed(2) };
  });
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/site_${s.i}.png` });
  console.log(` site ${s.i} ->`, JSON.stringify(shot));
}
await b.close();
