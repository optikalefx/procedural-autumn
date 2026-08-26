#!/usr/bin/env node
/**
 * roastocc — measure what is BETWEEN the lens and the marshmallow, and how much
 * of the fireside frame is stone.
 *
 *   node tools/_scratch/roastocc.mjs --hour 20.4
 *   node tools/_scratch/roastocc.mjs --sweep         # pose sweep, no frames
 *
 * The player's report on round 4 was "I could never see the roasting, there was
 * something blocking my view every time, looked like a rock of the fire maybe".
 * Nothing in the harness could have caught that: every assertion it makes is
 * about the SUBJECT (how big, how bright, in frame), and none about the volume
 * in front of it. This is the instrument for the volume in front of it.
 *
 * Three measurements, all by raycast against the real scene rather than by
 * eye:
 *
 *  · occlusion — a bundle of rays from the eye to the marshmallow's silhouette,
 *    reporting anything hit before it. Fraction blocked, and by what.
 *  · stone coverage — a grid of rays through the frame, classified by what they
 *    hit, split top half / bottom half.
 *  · the pit — the fire group's own y against the terrain around it, which is
 *    the "every height in this file is low by the pit's depth" hypothesis.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? d : (process.argv[i + 1] ?? true);
};
const DIR = arg('dir', 'shots/roast/r5-diag');
const HOUR = parseFloat(arg('hour', '20.4'));
const SWEEP = process.argv.includes('--sweep');
const AB = process.argv.includes('--ab');
const BAND = process.argv.includes('--band');
const RES = 1600;
const URL = `${process.env.AUTUMN_URL || 'http://127.0.0.1:5251'}?res=${RES}&car=camper`;
const DEG = Math.PI / 180;

mkdirSync(DIR, { recursive: true });
const release = await acquire('roastocc');
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
    window.__roast.setDoneness(0.55);
    window.__roast.setHeight(0.24);
    window.__roast.setSpin(0);
    window.__roast.setClock(3.0);
    return true;
  });
  if (!ok) throw new Error('__roast.enter() failed');
  await page.waitForFunction(() => (window.__roast.state().t ?? 0) >= 0.999,
    null, { timeout: 15000, polling: 60 });

  // ── the probe, installed in the page so a sweep can call it per candidate ──
  await page.evaluate(() => {
    const THREE = window.__THREE ?? window.THREE;
    const V = window.__roast.view;
    const rc = new THREE.Raycaster();
    rc.far = 40;
    const cam = V.ctx.camera;
    const scene = V.ctx.scene;

    const nameOf = (o) => {
      for (let n = o; n; n = n.parent) if (n.name) return n.name;
      return '(unnamed)';
    };
    // The sky dome, the cloud volume and the fire's own additive shells are not
    // geometry a marshmallow can hide behind. Everything else is.
    const SOFT = /cloud|sky|star|moon|sun|aurora|rain|snow|fog|haze|flame|smoke|spark|ember|glow|roast_held|vig/i;
    window.__nameOf = nameOf;
    window.__SOFT = SOFT;

    window.__occ = {
      /** What the ray eye->p hits before it gets there. */
      hits(p, pad = 0) {
        const o = new THREE.Vector3().copy(cam.position);
        const d = new THREE.Vector3().copy(p).sub(o);
        const L = d.length();
        d.divideScalar(L);
        rc.set(o, d);
        rc.far = Math.max(0.01, L - pad);
        const hs = rc.intersectObject(scene, true);
        return hs.map((h) => ({ n: nameOf(h.object), d: h.distance }));
      },
      /** The 13-point silhouette bundle, in world space. */
      bundle() {
        const st = V.state();
        const m = new THREE.Vector3(st.mallow.x, st.mallow.y, st.mallow.z);
        const R = st.mallowR;
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
        const rt = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
        const pts = [m.clone()];
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          pts.push(m.clone()
            .addScaledVector(rt, Math.cos(a) * R * 0.85)
            .addScaledVector(up, Math.sin(a) * R * 0.85));
        }
        return { pts, m, R };
      },
      /** Fraction of the silhouette blocked, and the first blocker. */
      occlusion() {
        const { pts, R } = window.__occ.bundle();
        let blocked = 0; const by = {};
        for (const p of pts) {
          const solid = window.__occ.hits(p, R * 1.1).filter((x) => !SOFT.test(x.n));
          if (solid.length) { blocked++; by[solid[0].n] = (by[solid[0].n] ?? 0) + 1; }
        }
        return { frac: blocked / pts.length, n: pts.length, by };
      },
      /**
       * What is BEHIND the marshmallow — the other half of "I could never see
       * the roasting". A pale subject in front of a lit cobble of the same
       * value is as unreadable as one behind it.
       */
      backdrop() {
        const { pts, m, R } = window.__occ.bundle();
        const tally = {};
        for (const p of pts) {
          const d = new THREE.Vector3().copy(p).sub(cam.position).normalize();
          rc.set(new THREE.Vector3().copy(p).addScaledVector(d, R * 1.6), d);
          rc.far = 120;
          const solid = rc.intersectObject(scene, true).filter((x) => !SOFT.test(nameOf(x.object)));
          const k = solid.length ? nameOf(solid[0].object) : '(open)';
          tally[k] = (tally[k] ?? 0) + 1;
        }
        const n = pts.length;
        return { stone: +((tally.fire_stone ?? 0) / n).toFixed(3),
          ground: +((tally.camp_ground ?? 0) / n).toFixed(3),
          open: +((tally['(open)'] ?? 0) / n).toFixed(3), tally };
      },
      /** Stone as a fraction of each horizontal band of the frame. */
      bands(nx = 24, ny = 18) {
        const ndc = new THREE.Vector2();
        const rows = [];
        for (let j = 0; j < ny; j++) {
          let stone = 0;
          for (let i = 0; i < nx; i++) {
            ndc.set((i + 0.5) / nx * 2 - 1, 1 - (j + 0.5) / ny * 2);
            rc.far = 200;
            rc.setFromCamera(ndc, cam);
            const solid = rc.intersectObject(scene, true).filter((x) => !SOFT.test(nameOf(x.object)));
            if (solid.length && nameOf(solid[0].object) === 'fire_stone') stone++;
          }
          rows.push(stone / nx);
        }
        const seg = (a, b) => {
          let s = 0; for (let j = a; j < b; j++) s += rows[j];
          return +(s / Math.max(1, b - a)).toFixed(3);
        };
        const t = Math.round(ny / 3);
        return { top: seg(0, t), mid: seg(t, 2 * t), bot: seg(2 * t, ny),
          rows: rows.map((r) => +r.toFixed(2)) };
      },
      /**
       * Stone in the marshmallow's own NEIGHBOURHOOD — a box six radii across
       * centred on the subject. `backdrop` answers "is it in front of a rock";
       * this answers "is there a rock beside it", which is nearer to what the
       * player was describing.
       */
      neighbourhood(k = 3.0, n = 11) {
        const st = V.state();
        const m = new THREE.Vector3(st.mallow.x, st.mallow.y, st.mallow.z);
        const p = m.clone().project(cam);
        const d = m.distanceTo(cam.position);
        const half = st.mallowR * k / (Math.tan(cam.fov * Math.PI / 360) * d);
        const ndc = new THREE.Vector2();
        let stone = 0, tot = 0;
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            ndc.set(p.x + (i / (n - 1) * 2 - 1) * half / (cam.aspect > 1 ? cam.aspect : 1),
              p.y + (j / (n - 1) * 2 - 1) * half);
            if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
            rc.far = 200;
            rc.setFromCamera(ndc, cam);
            const solid = rc.intersectObject(scene, true).filter((x) => !SOFT.test(nameOf(x.object)));
            tot++;
            if (solid.length && nameOf(solid[0].object) === 'fire_stone') stone++;
          }
        }
        return tot ? +(stone / tot).toFixed(3) : 0;
      },
      /** Where the flame column and the horizon land, in percent of frame height. */
      landmarks() {
        const st = V.state();
        const f = new THREE.Vector3(st.fire.x, st.fire.y, st.fire.z);
        const yOf = (v) => +((0.5 - v.clone().project(cam).y * 0.5) * 100).toFixed(1);
        const tip = f.clone(); tip.y += 0.80;
        const base = f.clone();
        // The horizon: a point at eye height, far away along the view bearing.
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        fwd.y = 0; fwd.normalize();
        const hz = cam.position.clone().addScaledVector(fwd, 400);
        return { flameTip: yOf(tip), flameBase: yOf(base), horizon: yOf(hz) };
      },
      /** Where the marshmallow lands on screen, and how big. */
      frame() {
        const st = V.state();
        const m = new THREE.Vector3(st.mallow.x, st.mallow.y, st.mallow.z);
        const p = m.clone().project(cam);
        const d = m.distanceTo(cam.position);
        const frac = (st.mallowR * 2) / (2 * Math.tan(cam.fov * Math.PI / 360) * d);
        return { xPct: +((p.x * 0.5 + 0.5) * 100).toFixed(1), yPct: +((0.5 - p.y * 0.5) * 100).toFixed(1),
          d: +d.toFixed(3), frac: +(frac * 100).toFixed(2) };
      },
      /** The pit-depth question, answered against the terrain. */
      pit() {
        const st = V.state();
        const camp = V.camp;
        const fg = camp?.fire?.group?.position;
        const T = window.__terrain;
        const h = (x, z) => {
          for (const f of ['heightAt', 'sampleHeight', 'height', 'groundY', 'at']) {
            if (typeof T?.[f] === 'function') { const v = T[f](x, z); if (Number.isFinite(v)) return v; }
            if (typeof T?.[f] === 'function') { const v = T[f](x, z); if (Number.isFinite(v?.y)) return v.y; }
          }
          return NaN;
        };
        const fx = fg?.x ?? camp?.x, fz = fg?.z ?? camp?.z;
        // A ray straight DOWN from well above the seat, to find the real
        // surface the camper stands on, and the same over the fire.
        const down = (x, z) => {
          rc.far = 60;
          rc.set(new THREE.Vector3(x, (camp?.y ?? 0) + 12, z), new THREE.Vector3(0, -1, 0));
          const hs = rc.intersectObject(scene, true)
            .filter((o) => !SOFT.test(nameOf(o.object)));
          return hs.length ? { y: +( (camp?.y ?? 0) + 12 - hs[0].distance).toFixed(3), n: nameOf(hs[0].object) } : null;
        };
        const b = V._bearing;
        const seatX = fx + Math.sin(b) * 1.55, seatZ = fz + Math.cos(b) * 1.55;
        // Ground height on a rose around the fire: a PIT shows as every bearing
        // sitting above the fire's origin by about the same amount, a SLOPE as
        // one side up and the other down.
        const rose = {};
        for (const r of [1.0, 1.55, 2.5]) {
          const row = [];
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            const g = down(fx + Math.sin(a) * r, fz + Math.cos(a) * r);
            row.push(g ? +(g.y - fg.y).toFixed(3) : null);
          }
          rose[`r${r}`] = row;
        }
        return {
          campY: camp?.y, fireY: fg?.y,
          downFire: down(fx, fz), downSeat: down(seatX, seatZ),
          seatGroundOverFire: down(seatX, seatZ) ? +(down(seatX, seatZ).y - fg.y).toFixed(3) : null,
          rose,
          eyeY: st.eye.y, mallowY: st.mallow.y,
        };
      },
      all() {
        return { pose: window.__roast.state().pose, frame: window.__occ.frame(),
          occ: window.__occ.occlusion(), pit: window.__occ.pit() };
      },
    };
    return true;
  });

  const base = await page.evaluate(() => ({ ...window.__occ.all(), bands: window.__occ.bands(), back: window.__occ.backdrop(), marks: window.__occ.landmarks() }));
  console.log('── ROUND 4 POSE ──');
  console.log(JSON.stringify(base, null, 1));

  if (BAND) {
    // The height control, measured at the SHIPPED pose: where each rung of the
    // contract's 0.10-0.50 band lands in the frame, and whether it is whole.
    const rows = await page.evaluate(() => {
      const out = [];
      for (const h of [0.10, 0.18, 0.24, 0.32, 0.40, 0.50]) {
        window.__roast.setHeight(h);
        window.__roast.setClock(3.0);
        const f = window.__occ.frame();
        const st = window.__roast.state();
        out.push({ h, y: f.yPct, x: f.xPct, frac: f.frac, clear: st.clear,
          back: window.__occ.backdrop().tally });
      }
      window.__roast.setHeight(0.24);
      return out;
    });
    for (const r of rows) console.log(`h=${r.h.toFixed(2)}  y=${r.y}%  x=${r.x}%  ` +
      `frac=${r.frac}%  top=${(r.y - r.frac / 2).toFixed(1)}%  bottom=${(r.y + r.frac / 2).toFixed(1)}%  ` +
      `clear=${r.clear}  back=${JSON.stringify(r.back)}`);
  }

  if (AB) {
    // The round-4 pose against the round-5 pose, at THE SAME SEAT, so the two
    // sets of numbers differ by the composition and by nothing else. Both are
    // measured under the round-5 seat datum, which is the only way to compare
    // them at all: the datum fix moves the round-4 pose too.
    const POSES = {
      r4: { eye: 1.12, out: 1.55, pitch: 22, fov: 20, near: 0.24, right: 0.126, h: 0.24 },
      r5: { eye: 1.05, out: 1.30, aim: 0.456, fov: 24, near: 0.24, right: 0.142, h: 0.24 },
    };
    // Eight bearings round the fire. The camp the harness pitches has no chairs
    // at all, so `_chooseSeat` falls back to "the side you were looking from" —
    // which is every side. This is the test that matters anyway: does the
    // composition survive the ground the seat lands on.
    const N = 8;
    for (let si = 0; si < N; si++) {
    await page.evaluate((k) => {
      const V = window.__roast.view;
      V._bearing = (k / 8) * Math.PI * 2;
      V._measureSeatY();
    }, si);
    for (const [name, c] of Object.entries(POSES)) {
      const r = await page.evaluate((p) => {
        const q = { eye: p.eye, out: p.out, fov: p.fov, near: p.near, right: p.right };
        if (Number.isFinite(p.aim)) q.aim = p.aim; else q.pitch = p.pitch * Math.PI / 180;
        window.__roast.pose(q);
        window.__roast.setHeight(p.h);
        window.__roast.setClock(3.0);
        return { st: window.__roast.state(), f: window.__occ.frame(),
          back: window.__occ.backdrop(), near9: window.__occ.neighbourhood(3.0, 9),
          bands: window.__occ.bands(20, 15), marks: window.__occ.landmarks() };
      }, c);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${DIR}/ab-${name}-seat${si}.png` });
      console.log(`b${si} ${name}: y=${r.f.yPct}% x=${r.f.xPct}% frac=${r.f.frac}% ` +
        `pitch=${(r.st.pitch * 180 / Math.PI).toFixed(1)} ` +
        `seatOverFire=${r.st.seatOverFire.toFixed(3)} clear=${r.st.clear} ` +
        `back=${JSON.stringify(r.back.tally)} beside=${r.near9} ` +
        `stone T/M/B=${r.bands.top}/${r.bands.mid}/${r.bands.bot}`);
      writeFileSync(`${DIR}/ab-${name}-seat${si}.json`, JSON.stringify(r, null, 1));
    }
    }
  }

  if (SWEEP) {
    // ── round 5's grid ──────────────────────────────────────────────────────
    //
    // Round 4 swept the SEAT and nothing else, and every candidate it looked at
    // put the marshmallow at the same place in the frame. That is exactly the
    // variable the player's complaint is about, so this sweeps it: `xAt` is a
    // target screen x that `right` is solved for, and `h` is the height control
    // — the two knobs that decide WHAT IS BEHIND the subject, which is a
    // different question from where the seat is.
    const CAND = [];
    for (const eye of [1.05, 1.15, 1.25])
      for (const out of [1.10, 1.30, 1.50])
        for (const pitch of [22, 26, 30, 34])
          for (const fov of [22, 26, 30])
            for (const xAt of [52, 58, 64])
              for (const h of [0.24, 0.36])
                CAND.push({ eye, out, pitch, fov, near: 0.26, xAt, h });
    console.log('sweep candidates:', CAND.length);
    const rows = [];
    const CHUNK = 60;
    for (let i = 0; i < CAND.length; i += CHUNK) {
      const part = await page.evaluate((cands) => {
        const DEG = Math.PI / 180;
        const res = [];
        for (const c of cands) {
          // `right` is SOLVED for, not guessed: three secant steps against the
          // measured screen x, so a candidate lands where it was asked to.
          let right = 0.24 * Math.tan(c.fov * DEG / 2) * (c.out - c.near);
          let f = null;
          for (let k = 0; k < 4; k++) {
            window.__roast.pose({ eye: c.eye, out: c.out, pitch: c.pitch * DEG,
              fov: c.fov, near: c.near, right });
            window.__roast.setHeight(c.h);
            window.__roast.setClock(3.0);
            f = window.__occ.frame();
            if (Math.abs(f.xPct - c.xAt) < 0.4) break;
            right *= (c.xAt - 50) / Math.max(1e-3, f.xPct - 50);
          }
          const st = window.__roast.state();      // the view's OWN assertion
          const b = window.__occ.backdrop();
          const L = window.__occ.landmarks();
          res.push({ ...c, right: +right.toFixed(4), ...f,
            clear: st.clear, blockedFrac: st.blockedFrac, blockedBy: st.blockedBy,
            seatOverFire: +st.seatOverFire.toFixed(3),
            backStone: b.stone, backOpen: b.open, near9: window.__occ.neighbourhood(3.0, 7),
            flameTip: L.flameTip, flameBase: L.flameBase,
            rho: +Math.hypot(c.near, right).toFixed(3) });
        }
        return res;
      }, CAND.slice(i, i + CHUNK));
      rows.push(...part);
      process.stdout.write(`  ${rows.length}/${CAND.length}\r`);
    }

    // ── the gates ──────────────────────────────────────────────────────────
    //  clear      nothing opaque between the lens and the subject
    //  readable   >= 8% of frame height, no stone behind it, little beside it
    //  placed     off both the bottom and the top edge by a whole subject
    //  fire       the flame's tip in frame and ABOVE the subject, its base
    //             below the subject: the marshmallow is IN the fire's picture
    const gate = (r) => r.clear && r.frac >= 8.0 && r.backStone <= 0.08 && r.near9 <= 0.12
      && r.yPct > 34 && r.yPct < 74
      && r.flameTip > 0 && r.flameTip < r.yPct - 8 && r.flameBase > r.yPct + 8;
    const pass = rows.filter(gate);
    console.log(`\nsweep ${rows.length}: clear ${rows.filter((r) => r.clear).length}` +
      `  frac>=8 ${rows.filter((r) => r.frac >= 8).length}` +
      `  no-stone-behind ${rows.filter((r) => r.backStone <= 0.08).length}` +
      `  no-stone-beside ${rows.filter((r) => r.near9 <= 0.12).length}  PASS ${pass.length}`);

    const rank = (pass.length ? pass : rows.filter((r) => r.clear && r.frac >= 8 && r.backStone <= 0.16))
      .sort((a, b) => (b.frac - b.near9 * 20) - (a.frac - a.near9 * 20)).slice(0, 30);
    const finals = await page.evaluate((cands) => {
      const DEG = Math.PI / 180;
      return cands.map((c) => {
        window.__roast.pose({ eye: c.eye, out: c.out, pitch: c.pitch * DEG,
          fov: c.fov, near: c.near, right: c.right });
        window.__roast.setHeight(c.h);
        window.__roast.setClock(3.0);
        const bd = window.__occ.bands(16, 12);
        return { ...c, stoneTop: bd.top, stoneMid: bd.mid, stoneBot: bd.bot, rows: bd.rows };
      });
    }, rank);
    writeFileSync(`${DIR}/sweep.json`, JSON.stringify({ rows, finals }, null, 1));

    const line = (r) => `eye${r.eye} out${r.out.toFixed(2)} p${r.pitch} fov${r.fov} ` +
      `h${r.h} right${r.right} | d${r.d} frac${r.frac}% at (${r.xPct},${r.yPct}) ` +
      `clear:${r.clear} back${r.backStone} beside${r.near9} flame ${r.flameTip}->${r.flameBase} ` +
      `stone T${r.stoneTop}/M${r.stoneMid}/B${r.stoneBot} rho${r.rho}`;
    for (const r of finals) console.log(line(r));
  }
} finally {
  await browser.close();
  release();
}
