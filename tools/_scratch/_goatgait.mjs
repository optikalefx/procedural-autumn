#!/usr/bin/env node
/**
 * Does the goat's walk clip ever get to play?
 *
 * "His walk doesn't seem like it's looping properly." The suspect is the one
 * `glb_rig.js` names in its own header: an animal whose CRUISING speed lands
 * inside the stand->walk handover band plays a permanent crossfade and never
 * shows the clip clean. That was the fox's bug; this asks whether the goat has
 * it, and whether a threat in the picture is what puts it there.
 *
 * Per species, over moving frames:
 *   speedFrac      drive.speed as a fraction of the animal's own cruising walk
 *   walkW          the walk clip's effective weight
 *   walkRate       its timeScale, and how often that sits on the RATE clamp
 *   cleanPct       frames where the walk (or trot/run) carries >= 0.85 weight
 *   blendPct       frames stuck between stand and walk (0.15 <= walkW < 0.85)
 *
 *   AUTUMN_URL=http://127.0.0.1:5188 node tools/_scratch/_goatgait.mjs --threat 30
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '480'));
const SPECS = arg('species', 'goat,deer').split(',');
const SITES = parseInt(arg('sites', '4'), 10);
const THREAT = parseFloat(arg('threat', '0'));

const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5188') + '/?res=768&car=camper';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('ERR', String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(async (P) => {
  const e = window.__engine, wl = window.__systems.wildlife, W = window.__world;
  window.__lighting.cycleSpeed = 0;
  e.stop();
  window.__forceCamera = true;
  const DT = 1 / 30;
  const NM = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol', 'watch', 'climb', 'perch'];
  const res = {};

  for (const SPEC of P.SPECS) {
    const S = wl.sites, ki = wl.keys.indexOf(SPEC);
    const cruise = wl.pool[SPEC][0][0].brain.gait.walk;
    const picks = [];
    for (let i = 0; i < S.n && picks.length < P.SITES; i++) if (S.spec[i] === ki) picks.push(i);
    const per = Math.round(P.SECONDS / P.SITES / DT);

    const H = new Array(20).fill(0);        // speedFrac histogram, 0..2 in 0.1
    const WH = new Array(20).fill(0);       // walk weight histogram
    let frames = 0, moving = 0, clean = 0, blend = 0, rateFloor = 0, rateN = 0;
    let rateSum = 0, gaitName = {}, byState = {};

    for (const si of picks) {
      wl.debugClear();
      if (P.THREAT > 0) wl.debugThreat(S.x[si] + P.THREAT, S.z[si], 0); else wl.debugThreat(null);
      const cx = S.x[si] + 14, cz = S.z[si] + 14, cy = W.getHeight(cx, cz) + 3.2;
      e.camera.position.set(cx, cy, cz);
      e.camera.lookAt(cx + 14, cy, cz + 14);
      e.camera.updateMatrixWorld(true);
      let t = 0;
      for (let s = 0; s < per; s++) {
        t += DT;
        wl.update(DT, t);
        for (const grp of wl.pool[SPEC]) for (const a of grp) {
          if (!a.active) continue;
          const b = a.brain, rig = a.rig;
          if (!rig.act?.walk) continue;
          frames++;
          gaitName[rig.gaitName] = (gaitName[rig.gaitName] || 0) + 1;
          // `rig.scale` is the GLB fit, not the animal's size multiplier — see the
          // note in `_goatturn.mjs`. The speed the Brain was asked for is scaled by
          // `brain._scale`, and that is the only honest denominator here.
          const cr = cruise * b._scale;
          const f = b.speed / cr;
          if (b.speed > 0.05) {
            moving++;
            H[Math.min(19, Math.max(0, Math.floor(f * 10)))]++;
            const ww = rig.act.walk.getEffectiveWeight();
            const tw = rig.act.trot ? rig.act.trot.getEffectiveWeight() : 0;
            const rw = rig.act.run.getEffectiveWeight();
            const loco = Math.max(ww, tw, rw);
            WH[Math.min(19, Math.max(0, Math.floor(ww * 20)))]++;
            if (loco >= 0.85) clean++;
            else if (loco >= 0.15) blend++;
            const ts = rig.act.walk.timeScale;
            rateSum += ts; rateN++;
            if (ts <= 0.601 || ts >= 3.199) rateFloor++;
            const st = NM[b.state];
            const bs = (byState[st] ||= { n: 0, clean: 0, sum: 0 });
            bs.n++; if (loco >= 0.85) bs.clean++; bs.sum += f;
          }
        }
      }
    }
    const pc = (n, d) => +(100 * n / Math.max(d, 1)).toFixed(1);
    res[SPEC] = {
      cruiseWalk: +cruise.toFixed(3),
      frames, movingPct: pc(moving, frames),
      cleanPctOfMoving: pc(clean, moving),
      blendPctOfMoving: pc(blend, moving),
      walkRateMean: +(rateSum / Math.max(rateN, 1)).toFixed(2),
      rateClampedPct: pc(rateFloor, rateN),
      speedFracHist: H.map((n) => pc(n, moving)),
      walkWeightHist: WH.map((n) => pc(n, moving)),
      gaitNamePct: Object.fromEntries(Object.entries(gaitName).map(([k, v]) => [k, pc(v, frames)])),
      byState: Object.fromEntries(Object.entries(byState).map(([k, v]) =>
        [k, { movingFrames: v.n, cleanPct: pc(v.clean, v.n), meanSpeedFrac: +(v.sum / v.n).toFixed(2) }])),
    };
  }
  return res;
}, { SECONDS, SPECS, SITES, THREAT });

console.log(JSON.stringify(out, null, 2));
await browser.close();
