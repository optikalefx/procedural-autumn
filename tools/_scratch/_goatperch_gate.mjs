/**
 * The one subject the rock test could plausibly break: a mountain goat that is
 * STANDING ON a boulder, whose perch is between the lens and its feet from
 * every bearing on the compass.
 *
 * Walks the goat's home sites until it finds one where the animal really is up
 * on rock — `perch` below is the distance from the nearest rock's centre in
 * units of that rock's own plan reach, so under 1 means the goat is inside the
 * boulder's footprint — and then sweeps 24 bearings at the far end of the
 * gate's reach, reporting what the terrain march passes and what survives the
 * rocks.
 */
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5178';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

const n = await page.evaluate(() => {
  const wl = window.__ctx.systems.wildlife, S = wl.sites;
  let k = 0;
  for (let i = 0; i < S.n; i++) if (wl.keys[S.spec[i]] === 'goat') k++;
  return k;
});
console.log(`${n} goat sites`);

for (let si = 0; si < Math.min(n, 8); si++) {
  await page.evaluate((si) => {
    const wl = window.__ctx.systems.wildlife, S = wl.sites, c = window.__ctx;
    let k = -1;
    for (let i = 0; i < S.n; i++) {
      if (wl.keys[S.spec[i]] !== 'goat') continue;
      if (++k !== si) continue;
      window.__forceCamera = true;
      window.__vehicleTeleport?.(S.x[i] + 25, S.z[i] + 25, 0);
      c.camera.position.set(S.x[i] + 25, c.world.getHeight(S.x[i] + 25, S.z[i] + 25) + 1.7, S.z[i] + 25);
      c.camera.lookAt(S.x[i], c.world.getHeight(S.x[i], S.z[i]) + 1.5, S.z[i]);
      c.camera.updateMatrixWorld(true);
      return;
    }
  }, si);
  await page.waitForTimeout(9000);

  const r = await page.evaluate(async () => {
    const M = await import('/src/game/hunt_detect.js'), I = M._internals;
    const c = window.__ctx, e = window.__engine, T = window.__THREE;
    e.camera.fov = 50; e.camera.updateProjectionMatrix();
    const wl = c.systems.wildlife, R = c.systems.rocks;
    let a = null, bd = 150 * 150;
    for (const per of wl.pool.goat) for (const m of per) {
      if (!m.active || !m.mesh) continue;
      const d = (m.mesh.position.x - c.camera.position.x) ** 2
              + (m.mesh.position.z - c.camera.position.z) ** 2;
      if (d < bd) { bd = d; a = m; }
    }
    if (!a) return { err: 'no goat awake' };
    const rr = I.meshHeight(a.mesh);
    const P = new T.Vector3(a.mesh.position.x, a.mesh.position.y + rr, a.mesh.position.z);
    let perch = 99, perchTop = 0;
    for (const inst of R.drawnRocksAround(P.x, P.z, 14, 0.4, [])) {
      const q = Math.hypot(inst.x - P.x, inst.z - P.z) / Math.max(0.01, R.reachOf(inst));
      if (q < perch) { perch = q; perchTop = R.topOf(inst); }
    }
    const stand = 0.85 * rr / (I.MIN_SHARE * Math.tan(50 * Math.PI / 360));
    let ground = 0, both = 0;
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2;
      const x = P.x + Math.sin(ang) * stand, z = P.z + Math.cos(ang) * stand;
      if (!c.world.isInBounds(x, z)) continue;
      e.camera.position.set(x, c.world.getHeight(x, z) + 1.7, z);
      e.camera.lookAt(P); e.camera.updateMatrixWorld(true);
      const f = I.frameOf(c);
      if (!I.share(f, P, rr, I.MIN_SHARE, Infinity)) continue;
      if (!I.clearLine(f.world, f.eye, P, rr)) continue;
      ground++;
      if (I.clearRocks(f.rocks, f.eye, P, rr)) both++;
    }
    return { perch: +perch.toFixed(2), stand: +stand.toFixed(1),
             feetOverRock: +(P.y - rr - (perchTop || 0)).toFixed(2), ground, both };
  });
  console.log(r.err ? `site ${si}: ${r.err}`
    : `site ${si}: perch ${r.perch} of the rock's reach, feet ${r.feetOverRock} m `
      + `above its top, stand-off ${r.stand} m — ${r.ground}/24 pass the terrain march, `
      + `${r.both} survive the rocks`);
}
await browser.close();
