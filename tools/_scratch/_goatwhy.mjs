#!/usr/bin/env node
/**
 * Why the goat wanders at two thirds of its own walk.
 *
 * `_goatgait.mjs` measured a goat cruising at 0.62 of the speed its own walk
 * clip was authored for while the deer sits at 1.05, which is what puts the
 * goat permanently inside the stand->walk crossfade. Everything that can hold
 * `Brain.speed` under `wantSpeed` is decomposed here, per WANDER frame:
 *
 *   dh        |wantHeading + avoid - heading|, the error the `facing` brake
 *             reads. A goat that is never pointed where it is going pays this
 *             every frame.
 *   facing    the brake itself
 *   avoid     the probe fan's contribution to dh
 *   targetD   how far the destination is. Short hops are all turn.
 *   scales    brain `_scale` against the rig's, which must agree or the speed
 *             the animal is asked for and the speed its clip plays at are in
 *             two different units.
 *
 *   AUTUMN_URL=http://127.0.0.1:5188 node tools/_scratch/_goatwhy.mjs
 */
import { chromium } from 'playwright';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '400'));
const SPECS = arg('species', 'goat,deer').split(',');
const SITES = parseInt(arg('sites', '4'), 10);

const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5188') + '/?res=768&car=camper';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('ERR', String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(async (P) => {
  const e = window.__engine, wl = window.__systems.wildlife, W = window.__world;
  window.__lighting.cycleSpeed = 0; e.stop(); window.__forceCamera = true;
  const DT = 1 / 30, res = {};
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  for (const SPEC of P.SPECS) {
    const S = wl.sites, ki = wl.keys.indexOf(SPEC);
    const cruise = wl.pool[SPEC][0][0].brain.gait.walk;
    const picks = [];
    for (let i = 0; i < S.n && picks.length < P.SITES; i++) if (S.spec[i] === ki) picks.push(i);
    const per = Math.round(P.SECONDS / P.SITES / DT);
    const A = { n: 0, dh: 0, facing: 0, avoid: 0, want: 0, sp: 0, td: 0, wanderN: 0 };
    const dhH = new Array(10).fill(0);       // |dh| in 0.2 rad bins
    let sMin = 9, sMax = 0, rMin = 9, rMax = 0, hops = [], legN = 0, legSum = 0;
    for (const si of picks) {
      wl.debugClear(); wl.debugThreat(null);
      const cx = S.x[si] + 14, cz = S.z[si] + 14, cy = W.getHeight(cx, cz) + 3.2;
      e.camera.position.set(cx, cy, cz); e.camera.lookAt(cx + 14, cy, cz + 14);
      e.camera.updateMatrixWorld(true);
      const last = new Map();
      let t = 0;
      for (let s = 0; s < per; s++) {
        t += DT; wl.update(DT, t);
        for (const grp of wl.pool[SPEC]) for (const a of grp) {
          if (!a.active) continue;
          const b = a.brain;
          sMin = Math.min(sMin, b._scale); sMax = Math.max(sMax, b._scale);
          rMin = Math.min(rMin, a.rig.scale); rMax = Math.max(rMax, a.rig.scale);
          if (b.state !== 2) { last.delete(b); continue; }   // ST.WANDER
          const td = Math.hypot(b.target.x - b.pos.x, b.target.z - b.pos.z);
          if (!last.has(b)) { hops.push(td); }               // leg length at adoption
          last.set(b, td);
          const dh = Math.abs(wrap(b.wantHeading + b._avoid - b.heading));
          A.n++; A.dh += dh; A.avoid += Math.abs(b._avoid);
          A.facing += 1 - Math.min(1, dh / 1.6) * 0.45;
          A.want += b.wantSpeed / (cruise * b._scale);
          A.sp += b.speed / (cruise * b._scale);
          A.td += td;
          dhH[Math.min(9, Math.floor(dh / 0.2))]++;
          legSum += b.speed * DT; legN++;
        }
      }
    }
    const m = (x) => +(x / Math.max(A.n, 1)).toFixed(3);
    hops.sort((a, b) => a - b);
    res[SPEC] = {
      wanderFrames: A.n,
      meanDhRad: m(A.dh), meanDhDeg: +(m(A.dh) * 180 / Math.PI).toFixed(1),
      meanFacing: m(A.facing),
      meanAvoidRad: m(A.avoid),
      meanWantSpeedFrac: m(A.want),
      meanSpeedFrac: m(A.sp),
      meanTargetDist: m(A.td),
      medianLegLen: +(hops[Math.floor(hops.length / 2)] || 0).toFixed(1),
      legs: hops.length,
      brainScale: [+sMin.toFixed(3), +sMax.toFixed(3)],
      rigScale: [+rMin.toFixed(3), +rMax.toFixed(3)],
      dhHistPct: dhH.map((n) => +(100 * n / Math.max(A.n, 1)).toFixed(1)),
    };
  }
  return res;
}, { SECONDS, SPECS, SITES });
console.log(JSON.stringify(out, null, 2));
await browser.close();
