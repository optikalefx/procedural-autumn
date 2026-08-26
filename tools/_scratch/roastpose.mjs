#!/usr/bin/env node
/**
 * roastpose — shoot N candidate compositions of the fireside view in ONE
 * browser session, at the hour that decides the round.
 *
 *   node tools/_scratch/roastpose.mjs --dir shots/roast/r4-pose --hour 20.4
 *
 * `roastshot.mjs` is the contract's critic loop and it is right to be as heavy
 * as it is. It is the wrong instrument for "which of six seats is the shot",
 * because each candidate is an edit, a reload and a four-minute bake, and a
 * capture tool that costs four minutes a guess is a tool nobody guesses with —
 * which is how round 3 shipped a camera inside the fire's stone ring on
 * arithmetic that was internally consistent and wrong.
 *
 * This drives `window.__roast.pose()` instead. One bake, one camp, one
 * marshmallow, six poses, six frames plus a state dump each.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? d : (process.argv[i + 1] ?? true);
};
const DIR = arg('dir', 'shots/roast/r4-pose');
const HOUR = parseFloat(arg('hour', '20.4'));
const RES = 1600;
const URL = `${process.env.AUTUMN_URL || 'http://127.0.0.1:5251'}?res=${RES}&car=camper`;
const DEG = Math.PI / 180;

// ── round 5's finalists ─────────────────────────────────────────────────────
//
// Round 4's candidates carried an `xr` and let a formula pick `right`. These
// carry `right` and `h` outright, because they came out of
// `tools/_scratch/roastocc.mjs --sweep`, which solved `right` for a measured
// screen x and measured what was BEHIND the subject at each. What is being
// compared here is no longer "which seat" — it is which of the twenty-five
// poses that passed the occlusion and stone gates is the photograph.
//
//   r4      the shipped pose, WITH the seat-datum fix, so the A/B isolates the
//           composition change from the datum change.
//   a       the sweep's best on subject size: nothing behind, nothing beside.
//   b       the same numbers on a wider lens from a closer seat — the round-5
//           brief's own direction, and the one where the near stones are least
//           magnified.
//   b2      b, sat up and back a hand's width.
//   c       a longer lens from the middle distance.
//   d       a at 26 degrees, for the wider angle of view at the same seat.
const CAND = [
  { name: 'f',  eye: 1.05, out: 1.30, pitch: 30, fov: 26, near: 0.26, right: 0.1518, h: 0.24 },
  { name: 'f1', eye: 1.05, out: 1.30, pitch: 30, fov: 26, near: 0.24, right: 0.1550, h: 0.24 },
  { name: 'f2', eye: 1.05, out: 1.30, pitch: 30, fov: 24, near: 0.24, right: 0.1420, h: 0.24 },
];

mkdirSync(DIR, { recursive: true });
const release = await acquire('roastpose');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 60000 });

  await page.evaluate(() => {
    const e = window.__engine;
    if (e) { e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; }
  });
  await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);

  const parkAt = await page.evaluate(() => {
    const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
    return { x: p.x, z: p.z };
  });
  await page.waitForTimeout(1600);
  // Latch the brake: the camper's headlights are 68 m of beam at this hour and
  // an undipped one makes every frame here a photograph of a floodlit camp.
  await page.keyboard.down('Space'); await page.waitForTimeout(1000);
  await page.keyboard.up('Space'); await page.waitForTimeout(2400);

  await page.waitForFunction(() => typeof window.__camp?.pitchNear === 'function',
    null, { timeout: 60000, polling: 250 });
  const site = await page.evaluate(({ at }) => {
    const s = window.__camp.pitchNear(at.x, at.z, { instant: true, radius: 14 });
    return s ? { x: s.x, z: s.z, props: window.__camp.props.map((p) => p.item.kind) } : null;
  }, { at: parkAt });
  if (!site) throw new Error('no camp site');
  console.log('camp:', site.props.join(', '));

  const ok = await page.evaluate(() => {
    if (!window.__roast?.enter()) return false;
    window.__roast.setOverlay(false);
    window.__roast.setDoneness(0.55);
    window.__roast.setHeight(0.24);
    window.__roast.setSpin(0);
    window.__roast.setClock(3.0);
    return true;
  });
  if (!ok) throw new Error('__roast.enter() failed — no roaststick, or the surface is missing');
  // The step-in runs for real (see the note on `__roast.enter`), so wait it out
  // — otherwise the first candidate is photographed part-way through the walk,
  // which is not a candidate, it is a different shot.
  await page.waitForFunction(() => (window.__roast.state().t ?? 0) >= 0.999,
    null, { timeout: 15000, polling: 60 });

  const out = [];
  for (const c of CAND) {
    const st = await page.evaluate((p) => {
      const THREE = window.__THREE;
      const cam = window.__roast.view.ctx.camera;
      // Solve `right` for 64% across, so what is compared between candidates is
      // the seat and the lens rather than where the subject happened to fall.
      let right = p.right;
      let f = null;
      for (let k = 0; k < 4; k++) {
        window.__roast.pose({ eye: p.eye, out: p.out, pitch: p.pitch * Math.PI / 180,
          fov: p.fov, near: p.near, right });
        window.__roast.setHeight(p.h);
        window.__roast.setClock(3.0);
        const s = window.__roast.state();
        const m = new THREE.Vector3(s.mallow.x, s.mallow.y, s.mallow.z);
        const dd = m.distanceTo(cam.position);
        const pr = m.clone().project(cam);
        f = { xPct: (pr.x * 0.5 + 0.5) * 100, yPct: (0.5 - pr.y * 0.5) * 100,
          d: dd, frac: (s.mallowR * 2) / (2 * Math.tan(cam.fov * Math.PI / 360) * dd) * 100 };
        if (Math.abs(f.xPct - 64) < 0.3) break;
        right *= (64 - 50) / Math.max(1e-3, f.xPct - 50);
      }
      return { state: window.__roast.state(), f, right };
    }, c);
    await page.waitForTimeout(450);
    const file = `${DIR}/${c.name}.png`;
    await page.screenshot({ path: file });
    const s = st.state;
    console.log(`${c.name.padEnd(5)} fov${c.fov} eye${c.eye} out${c.out} p${c.pitch} h${c.h}` +
      ` right=${st.right.toFixed(4)} | frac=${st.f.frac.toFixed(2)}%` +
      ` at(${st.f.xPct.toFixed(1)},${st.f.yPct.toFixed(1)}) d=${st.f.d.toFixed(3)}` +
      ` clear=${s.clear} rho=${Math.hypot(c.near, st.right).toFixed(3)}` +
      ` seatOverFire=${s.seatOverFire?.toFixed(3)} I=${s.fire.lightI?.toFixed(2)}`);
    out.push({ cand: c, right: st.right, frame: st.f, state: s });
  }
  writeFileSync(`${DIR}/POSE.json`, JSON.stringify({ hour: HOUR, site, cands: out }, null, 1));
  console.log('wrote', DIR);
} finally {
  await browser.close();
  release();
}
