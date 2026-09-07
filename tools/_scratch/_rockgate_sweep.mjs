/**
 * What the rock test costs the animals that live among rock.
 *
 * The goat stands ON a boulder and the ram on the bench beside one, so they
 * are where an occlusion test that does not know the difference between a
 * perch and a wall does its damage. For each species this spawns one, then
 * from 24 bearings at a stand-off the gate comfortably passes, prints the
 * verdict with the rock test and without it (the terrain march alone, which is
 * what shipped). A bearing that changes is a photograph the new test refuses;
 * the question is whether the rock is between you and the animal or under it.
 */
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5178';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

for (const key of ['goat', 'ram', 'deer', 'bear', 'rabbit']) {
  // Stand the camera on one of this species' own home sites, so a goat is
  // judged on a crag rather than wherever `debugSpawn` walked it to.
  const site = await page.evaluate((key) => {
    const wl = window.__ctx.systems.wildlife, S = wl.sites, c = window.__ctx;
    for (let i = 0; i < S.n; i++) {
      if (wl.keys[S.spec[i]] !== key) continue;
      window.__forceCamera = true;
      window.__vehicleTeleport?.(S.x[i] + 25, S.z[i] + 25, 0);
      c.camera.position.set(S.x[i] + 25, c.world.getHeight(S.x[i] + 25, S.z[i] + 25) + 1.7, S.z[i] + 25);
      c.camera.lookAt(S.x[i], c.world.getHeight(S.x[i], S.z[i]) + 1.5, S.z[i]);
      c.camera.updateMatrixWorld(true);
      return { x: S.x[i], z: S.z[i] };
    }
    return null;
  }, key);
  if (site) await page.waitForTimeout(14000);

  const r = await page.evaluate(async (key) => {
    const M = await import('/src/game/hunt_detect.js'), I = M._internals;
    const c = window.__ctx, e = window.__engine, T = window.__THREE;
    window.__forceCamera = true;
    e.camera.fov = 50; e.camera.updateProjectionMatrix();
    const wl = c.systems.wildlife;
    let a = null, bd = 150 * 150;
    for (const per of wl.pool[key]) for (const m of per) {
      if (!m.active || !m.mesh) continue;
      const d = (m.mesh.position.x - c.camera.position.x) ** 2
              + (m.mesh.position.z - c.camera.position.z) ** 2;
      if (d < bd) { bd = d; a = m; }
    }
    if (!a) return { key, err: 'nothing awake within 150 m' };
    const rr = I.meshHeight(a.mesh);
    const P = new T.Vector3(a.mesh.position.x, a.mesh.position.y + rr, a.mesh.position.z);
    // Just inside the gate's reach — the far end of it, where a rock has room
    // to get between the lens and the animal. Half of it is under `clearRocks`'
    // own six-metre floor and would prove nothing.
    const stand = 0.85 * rr / (I.MIN_SHARE * Math.tan(50 * Math.PI / 360));
    let both = 0, groundOnly = 0, lost = 0; const blames = [];
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2;
      const x = P.x + Math.sin(ang) * stand, z = P.z + Math.cos(ang) * stand;
      if (!c.world.isInBounds(x, z)) continue;
      e.camera.position.set(x, c.world.getHeight(x, z) + 1.7, z);
      e.camera.lookAt(P); e.camera.updateMatrixWorld(true);
      const f = I.frameOf(c);
      if (!I.share(f, P, rr, I.MIN_SHARE, Infinity)) continue;
      const g = I.clearLine(f.world, f.eye, P, rr);
      const k = I.clearRocks(f.rocks, f.eye, P, rr);
      if (g) groundOnly++;
      if (g && k) both++;
      else if (g) {
        lost++;
        // Which rock did it, and is the animal standing on that rock? A
        // refusal by the animal's own perch is the bug this test is for.
        const hits = c.systems.rocks.drawnRocksAround(
          (f.eye.x + P.x) / 2, (f.eye.z + P.z) / 2,
          Math.hypot(P.x - f.eye.x, P.z - f.eye.z) / 2 + 16, 0, []);
        let worst = null;
        for (const inst of hits) {
          if (inst.size < 0.4) continue;
          const re = c.systems.rocks.reachOf(inst);
          const dSub = Math.hypot(inst.x - P.x, inst.z - P.z);
          const t = Math.max(0, Math.min(1, ((inst.x - f.eye.x) * (P.x - f.eye.x)
            + (inst.z - f.eye.z) * (P.z - f.eye.z)) / ((P.x - f.eye.x) ** 2 + (P.z - f.eye.z) ** 2)));
          const px = f.eye.x + (P.x - f.eye.x) * t - inst.x;
          const pz = f.eye.z + (P.z - f.eye.z) * t - inst.z;
          if (Math.hypot(px, pz) > re * 0.8 || dSub < re * 0.8) continue;
          const top = c.systems.rocks.topOf(inst);
          const y = f.eye.y + ((P.y + rr * 0.6) - f.eye.y) * t;
          if (top > y + 0.75 && (!worst || top - y > worst.over)) {
            worst = { over: +(top - y).toFixed(2), top: +top.toFixed(2),
                      reach: +re.toFixed(2), dSub: +dSub.toFixed(1), t: +t.toFixed(2) };
          }
        }
        blames.push({ bearing: Math.round(ang * 180 / Math.PI), ...worst });
      }
    }
    return { key, h: +(rr * 2).toFixed(2), stand: +stand.toFixed(1), groundOnly, both, lost,
             perchR: +(c.systems.rocks.drawnRocksAround(P.x, P.z, 8, 0.4, [])
               .map((i) => Math.hypot(i.x - P.x, i.z - P.z) / Math.max(0.01, c.systems.rocks.reachOf(i)))
               .reduce((m, v) => Math.min(m, v), 9)).toFixed(2), blames };
  }, key);
  console.log(r.err ? `${r.key}: ${r.err}`
    : `${r.key.padEnd(7)} height ${r.h} m, stand-off ${r.stand} m: `
      + `${r.groundOnly}/24 bearings passed the terrain march, ${r.both} still pass with rocks `
      + `(${r.lost} refused by a rock); nearest rock centre is `
      + `${r.perchR} of its own reach away\n   ` + r.blames.map((b) =>
          `${b.bearing}deg: rock top ${b.top}, ${b.over} m above the ray, `
          + `reach ${b.reach}, ${b.dSub} m from the animal, at t=${b.t}`).join('\n   '));
}
await browser.close();
