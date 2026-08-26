#!/usr/bin/env node
/**
 * roastback — the round-6 instrument: is there anything BEHIND the marshmallow
 * that looks like it, at every seat, before and after the per-seat solve.
 *
 *   node tools/_scratch/roastback.mjs --hour 20.4
 *   node tools/_scratch/roastback.mjs --hour 12.0 --shots
 *
 * Round 5 closed with the defect named: `right` is a constant and the stone
 * ring is not, and at three of eight bearings 13 of 13 backdrop rays land on
 * `fire_stone`. This measures the same eight seats two ways at once:
 *
 *  · the ROUND-5 measurement, by name — `__occ.backdrop()`, ray classification,
 *    kept so the two rounds' tables are comparable;
 *  · the ROUND-6 measurement, by VALUE — `__roast.measure()`, which draws the
 *    frame off-screen and asks how many stops of linear luma the subject wins
 *    its own outline by. That is the one the fix is judged on: a cobble in
 *    shadow is a fine backdrop and the flame's core is a terrible one, and
 *    neither of those is in the name.
 *
 * BEFORE is the authored seed pinned in place (`pose({right, near})` pins);
 * AFTER is `__roast.solveHold()`. Same seat, same camp, same hour.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? d : (process.argv[i + 1] ?? true);
};
const DIR = arg('dir', 'shots/roast/r6-diag');
const HOUR = parseFloat(arg('hour', '20.4'));
const SHOTS = process.argv.includes('--shots');
const DONE = parseFloat(arg('done', '0.55'));
const N = parseInt(arg('seats', '8'), 10);
const RES = 1600;
const URL = `${process.env.AUTUMN_URL || 'http://127.0.0.1:5251'}?res=${RES}&car=camper`;

mkdirSync(DIR, { recursive: true });
const release = await acquire('roastback');
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
  await page.keyboard.down('Space'); await page.waitForTimeout(1000);
  await page.keyboard.up('Space'); await page.waitForTimeout(2400);

  await page.waitForFunction(() => typeof window.__camp?.pitchNear === 'function',
    null, { timeout: 60000, polling: 250 });
  const site = await page.evaluate(({ at }) => {
    const s = window.__camp.pitchNear(at.x, at.z, { instant: true, radius: 14 });
    return s ? { x: s.x, y: s.y, z: s.z } : null;
  }, { at: parkAt });
  if (!site) throw new Error('no camp site');

  const ok = await page.evaluate(() => {
    if (!window.__roast?.enter()) return false;
    window.__roast.setOverlay(false);
    window.__roast.setHeight(0.24);
    window.__roast.setSpin(0);
    window.__roast.setClock(3.0);
    return true;
  });
  if (!ok) throw new Error('__roast.enter() failed');
  await page.waitForFunction(() => (window.__roast.state().t ?? 0) >= 0.999,
    null, { timeout: 15000, polling: 60 });

  // The round-5 name-tally probe, so the two tables can be read side by side.
  await page.evaluate(() => {
    const THREE = window.__THREE ?? window.THREE;
    const V = window.__roast.view;
    const rc = new THREE.Raycaster();
    const cam = V.ctx.camera;
    const scene = V.ctx.scene;
    const nameOf = (o) => { for (let n = o; n; n = n.parent) if (n.name) return n.name; return '(unnamed)'; };
    const SOFT = /cloud|sky|star|moon|sun|aurora|rain|snow|fog|haze|flame|smoke|spark|ember|glow|roast_held|vig/i;
    window.__occ = {
      bundle() {
        const st = V.state();
        const m = new THREE.Vector3(st.mallow.x, st.mallow.y, st.mallow.z);
        const R = st.mallowR;
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
        const rt = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
        const pts = [m.clone()];
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          pts.push(m.clone().addScaledVector(rt, Math.cos(a) * R * 0.85)
            .addScaledVector(up, Math.sin(a) * R * 0.85));
        }
        return { pts, m, R };
      },
      backdrop() {
        const { pts, R } = window.__occ.bundle();
        const tally = {};
        for (const p of pts) {
          const d = new THREE.Vector3().copy(p).sub(cam.position).normalize();
          rc.set(new THREE.Vector3().copy(p).addScaledVector(d, R * 1.6), d);
          rc.far = 120;
          const solid = rc.intersectObject(scene, true).filter((x) => !SOFT.test(nameOf(x.object)));
          const k = solid.length ? nameOf(solid[0].object) : '(open)';
          tally[k] = (tally[k] ?? 0) + 1;
        }
        return { stone: +((tally.fire_stone ?? 0) / pts.length).toFixed(3), tally };
      },
      frame() {
        const st = V.state();
        const m = new THREE.Vector3(st.mallow.x, st.mallow.y, st.mallow.z);
        const p = m.clone().project(cam);
        const d = m.distanceTo(cam.position);
        const frac = (st.mallowR * 2) / (2 * Math.tan(cam.fov * Math.PI / 360) * d);
        return { xPct: +((p.x * 0.5 + 0.5) * 100).toFixed(1), yPct: +((0.5 - p.y * 0.5) * 100).toFixed(1),
          d: +d.toFixed(3), frac: +(frac * 100).toFixed(2) };
      },
    };
    return true;
  });

  const rows = [];
  for (let si = 0; si < N; si++) {
    await page.evaluate((k) => {
      const V = window.__roast.view;
      V._bearing = (k / 8) * Math.PI * 2;
      V._measureSeatY();
      V._repose();
    }, si);

    const r = await page.evaluate(async ({ done }) => {
      const out = {};
      // ── BEFORE: the authored seed, pinned so nothing solves under it ──────
      window.__roast.pose({ right: 0.142, near: 0.24 });
      window.__roast.setDoneness(done);
      window.__roast.setHeight(0.24);
      window.__roast.setClock(3.0);
      const sweep = () => {
        const o = {};
        for (const k of [0, 0.35, 0.55, 0.8, 1.0]) {
          window.__roast.setDoneness(k); window.__roast.setHeight(0.24); window.__roast.setClock(3.0);
          o['d' + k] = window.__roast.measure();
        }
        window.__roast.setDoneness(done); window.__roast.setHeight(0.24); window.__roast.setClock(3.0);
        return o;
      };
      out.before = {
        st: window.__roast.state(), back: window.__occ.backdrop(),
        f: window.__occ.frame(), m: window.__roast.measure(), sweep: sweep(),
      };
      // ── AFTER: solved raw, exactly as the game solves it on entry, then
      //    judged at the harness's doneness. ─────────────────────────────────
      window.__roast.setDoneness(0);
      window.__roast.solveHold();
      window.__roast.setDoneness(done);
      window.__roast.setHeight(0.24);
      window.__roast.setClock(3.0);
      out.after = {
        st: window.__roast.state(), back: window.__occ.backdrop(),
        f: window.__occ.frame(), cands: window.__roast.holdCandidates(),
        m: window.__roast.measure(), sweep: sweep(),
      };
      return out;
    }, { done: DONE });

    const line = (tag, o) => `  ${tag} right=${o.st.hold.right.toFixed(3)} near=${o.st.hold.near.toFixed(3)} ` +
      `rho=${Math.hypot(o.st.hold.near, o.st.hold.right).toFixed(4)} | ` +
      `x=${o.f.xPct}% y=${o.f.yPct}% frac=${o.f.frac}% clear=${o.st.clear} | ` +
      `VALUE distinct=${o.m?.distinct} margin=${o.m?.margin} lost=${o.m?.lost} ` +
      `subj=${o.m?.subject} behind=${o.m?.behind} | NAME ${JSON.stringify(o.back.tally)}`;
    console.log(`b${si}  seatOverFire=${r.before.st.seatOverFire.toFixed(3)} ` +
      `pitch=${(r.before.st.pitch * 180 / Math.PI).toFixed(1)}`);
    console.log(line('BEFORE', r.before));
    console.log('    toast sweep BEFORE ' + Object.entries(r.before.sweep).map(([k, v]) =>
      `${k}: subj=${v.subject} m=${v.margin} lost=${v.lost}`).join(' | '));
    console.log(line(' AFTER', r.after));
    console.log('    toast sweep AFTER  ' + Object.entries(r.after.sweep).map(([k, v]) =>
      `${k}: subj=${v.subject} m=${v.margin} lost=${v.lost}`).join(' | '));
    rows.push({ seat: si, ...r });

    if (SHOTS) {
      for (const [tag, which] of [['before', 'before'], ['after', 'after']]) {
        await page.evaluate(({ w, done }) => {
          if (w === 'before') window.__roast.pose({ right: 0.142, near: 0.24 });
          else { window.__roast.setDoneness(0); window.__roast.solveHold(); }
          window.__roast.setDoneness(done);
          window.__roast.setHeight(0.24);
          window.__roast.setClock(3.0);
        }, { w: which, done: DONE });
        await page.waitForTimeout(220);
        await page.screenshot({ path: `${DIR}/h${HOUR}-seat${si}-${tag}.png` });
      }
    }
  }

  writeFileSync(`${DIR}/back-h${HOUR}.json`, JSON.stringify(rows, null, 1));

  // ── the summary the report quotes ────────────────────────────────────────
  const tally = (k, f) => rows.filter(f).length;
  console.log(`\nhour ${HOUR}, ${rows.length} seats, doneness ${DONE}`);
  console.log(`  stone-behind (round-5 metric)   before ${tally(0, (r) => r.before.back.stone >= 0.5)}` +
    `  after ${tally(0, (r) => r.after.back.stone >= 0.5)}`);
  console.log(`  distinct (round-6 metric)       before ${tally(0, (r) => r.before.m?.distinct)}` +
    `  after ${tally(0, (r) => r.after.m?.distinct)}`);
  console.log(`  clear                           before ${tally(0, (r) => r.before.st.clear)}` +
    `  after ${tally(0, (r) => r.after.st.clear)}`);
  const mm = (sel) => rows.map(sel).sort((a, b) => a - b);
  console.log(`  margin (stops), before ${JSON.stringify(mm((r) => r.before.m?.margin))}`);
  console.log(`  margin (stops), after  ${JSON.stringify(mm((r) => r.after.m?.margin))}`);
  console.log(`  frac%, after           ${JSON.stringify(mm((r) => r.after.f.frac))}`);
  console.log(`  rho, after             ${JSON.stringify([...new Set(rows.map((r) =>
    +Math.hypot(r.after.st.hold.near, r.after.st.hold.right).toFixed(4)))])}`);
} finally {
  await browser.close();
  release();
}
