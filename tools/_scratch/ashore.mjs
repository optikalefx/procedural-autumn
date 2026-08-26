/**
 * "I can't get out of the kayak" — the step-ashore gate, headless.
 *
 * Spawns a boat, drives its bow hard into a bank, and reports, over time:
 * the physics `beached` flag, the on-screen prompt text, and whether pressing
 * E actually puts the player back in the camper.
 *
 *   node tools/_scratch/ashore.mjs --kind kayak --where river
 *   node tools/_scratch/ashore.mjs --kind canoe --where lake
 *
 * Sim time is NOT wall time headless: every wait is state-based (poll the
 * boat's own published state), never a sleep.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const KIND = arg('kind', 'kayak');
const WHERE = arg('where', 'river');
const RELEASE = arg('release', null) === null ? null : +arg('release');
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5263';
const SEED = process.env.SEED || '20261018';

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
p.on('pageerror', e => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState:3, url, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
        set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype; Object.assign(window.WebSocket, RealWS);
});
console.log('booting…');
await p.goto(`${URL}/?seed=${SEED}&car=camper&res=768`, { timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

// ── pick a site ──────────────────────────────────────────────────────────────
const site = await p.evaluate((where) => {
  const w = window.__world;
  let best = null;
  for (let x = -1200; x <= 1200; x += 16) for (let z = -1200; z <= 1200; z += 16) {
    if (!w.isInBounds(x, z)) continue;
    const riv = w.getRiver(x, z);
    const h = w.getHydro(x, z, {});
    if (where === 'river') {
      if (riv < 0.6 || h.sdf < 3) continue;
      const f = w.getFlow(x, z, {});
      const m = Math.hypot(f.vx, f.vz);
      if (m < 0.4) continue;
      // The bank this boat will be driven into has to still be RIVER, or the
      // test lands in a lakey backwater and measures the lake rules.
      const e = 3, s = (ax, az) => w.getHydro(ax, az, {}).sdf;
      const gx = (s(x + e, z) - s(x - e, z)) / (2 * e);
      const gz = (s(x, z + e) - s(x, z - e)) / (2 * e);
      const gm = Math.hypot(gx, gz) || 1;
      let bx = x, bz = z, bank = null;
      for (let d = 2; d <= 60; d += 2) {
        const px = x - (gx / gm) * d, pz = z - (gz / gm) * d;
        if (!w.isInBounds(px, pz)) break;
        if (s(px, pz) < 1.5) { bx = px; bz = pz; bank = w.getRiver(px, pz); break; }
      }
      if (bank === null || bank < 0.55) continue;
      // …and there has to be dry ground past it, or a correct fix still can't
      // put the camper anywhere.
      let dry = false;
      for (let d = 4; d <= 26 && !dry; d += 2) {
        const px = bx - (gx / gm) * d, pz = bz - (gz / gm) * d;
        if (w.isInBounds(px, pz) && s(px, pz) < -2.5) dry = true;
      }
      if (!dry) continue;
      const score = h.sdf + m * 4 + bank * 10;
      if (!best || score > best.score) best = { x, z, score, sdf: h.sdf, riv, cur: m, bank };
    } else if (where === 'lakesteep') {
      // The quieter pre-existing hole: standing water that stays DEEP right up
      // to the sdf wall, so the hull is held a couple of metres off a steep
      // bank and never grounds. Before this fix that boat could not be stepped
      // out of either.
      if (riv > 0.10) continue;
      if (h.sdf < 6 || h.sdf > 14) continue;
      const e = 3, s2 = (ax, az) => w.getHydro(ax, az, {}).sdf;
      const gx = (s2(x + e, z) - s2(x - e, z)) / (2 * e);
      const gz = (s2(x, z + e) - s2(x, z - e)) / (2 * e);
      const gm = Math.hypot(gx, gz) || 1;
      // Depth at the wall: sample where the sdf reads 1.2 m (SHORE_SDF).
      let wallDepth = null, steep = 0;
      for (let d = 0; d <= 40; d += 1) {
        const px = x - (gx / gm) * d, pz = z - (gz / gm) * d;
        if (!w.isInBounds(px, pz)) break;
        if (s2(px, pz) < 1.2) {
          const lv2 = w._water?.levelAt?.(px, pz);
          wallDepth = lv2 == null ? null : lv2 - w.getHeight(px, pz);
          steep = w.getSlope(px, pz);
          break;
        }
      }
      if (wallDepth == null || wallDepth < 0.9 || steep < 0.45) continue;
      const score = wallDepth * 10 + steep;
      if (!best || score > best.score) best = { x, z, score, sdf: h.sdf, riv, cur: 0, wallDepth, steep };
    } else {
      // Standing water, a short paddle from a bank with land behind it — so
      // the hull actually reaches the shore inside the frame budget.
      if (riv > 0.10) continue;
      if (h.sdf < 8 || h.sdf > 16) continue;
      const lv = w._water?.levelAt?.(x, z);
      if (lv == null || lv - w.getHeight(x, z) < 1.0) continue;
      const e = 3, s2 = (ax, az) => w.getHydro(ax, az, {}).sdf;
      const gx = (s2(x + e, z) - s2(x - e, z)) / (2 * e);
      const gz = (s2(x, z + e) - s2(x, z - e)) / (2 * e);
      const gm = Math.hypot(gx, gz) || 1;
      let dry = false;
      for (let d = 4; d <= 40 && !dry; d += 2) {
        const px = x - (gx / gm) * d, pz = z - (gz / gm) * d;
        if (w.isInBounds(px, pz) && s2(px, pz) < -2.5 && w.getSlope(px, pz) < 0.35) dry = true;
      }
      if (!dry) continue;
      const score = 1000 - h.sdf;
      if (!best || score > best.score) best = { x, z, score, sdf: h.sdf, riv, cur: 0 };
    }
  }
  return best;
}, WHERE);
console.log('site:', JSON.stringify(site));

// ── spawn, board, and steer the bow at the nearest bank ──────────────────────
await p.evaluate(({ x, z, kind, release }) => {
  const bt = window.__boat;
  bt.spawnAt(x, z, { kind });
  bt.board();
  const w = window.__world;
  window.__log = [];
  window.__release = release;
  window.__everBeached = false;
  const tick = () => {
    const st = window.__boat?.state?.().boats?.[0];
    if (st) {
      // Aim at land: the hydro sdf is positive in water, so walk DOWN its
      // gradient. Sample it by finite difference around the hull.
      const e = 3;
      const s = (ax, az) => w.getHydro(ax, az, {}).sdf;
      const gx = (s(st.x + e, st.z) - s(st.x - e, st.z)) / (2 * e);
      const gz = (s(st.x, st.z + e) - s(st.x, st.z - e)) / (2 * e);
      let d = Math.atan2(-gx, -gz) - st.heading;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      // --release: stop paddling once the bow is this close to the sdf wall and
      // COAST into the bank. That is the lake hole pressure-beaching leaves —
      // `_pinT` only grows while a forward stroke is held (`fwd > 0.02`), so a
      // boat that merely drifts against a bank never beaches.
      const near = window.__release !== null && s(st.x, st.z) < window.__release;
      window.__boat.drive(near ? 0 : 1, near ? 0 : Math.max(-1, Math.min(1, d * 1.6)));
      if (st.beached) window.__everBeached = true;
    }
    requestAnimationFrame(tick);
  };
  tick();
}, { ...site, kind: KIND, release: RELEASE });

const snap = () => p.evaluate(() => {
  const s = window.__boat.state();
  const b0 = s.boats[0];
  const el = document.querySelector('.pa-camp-prompt');
  return {
    aboard: s.active, held: s.controlsHeldBy,
    x: +b0.x.toFixed(1), z: +b0.z.toFixed(1),
    sdf: +window.__world.getHydro(b0.x, b0.z, {}).sdf.toFixed(2),
    depth: +b0.depth.toFixed(2), speed: +b0.speed.toFixed(2),
    beached: b0.beached, riverness: +(b0.riverness ?? 0).toFixed(2),
    current: +(b0.current ?? 0).toFixed(2),
    prompt: (el && el.style.opacity !== '0') ? el.textContent.trim() : '',
    everBeached: window.__everBeached,
    made: +(b0.made ?? -1).toFixed(2),
    atBank: window.__boat._atBank ? window.__boat._atBank(window.__boat.boats[0]) : null,
  };
});

// Run a fixed number of SIM frames with the bow held at the bank, sampling the
// gate as we go. Frames, not seconds — sim time is not wall time headless.
const FRAMES = +arg('frames', 1200);
for (let i = 0; i < 8; i++) {
  await p.evaluate((n) => new Promise(r => {
    let k = 0; const f = () => (++k > n ? r() : requestAnimationFrame(f)); f();
  }), Math.round(FRAMES / 8));
  console.log(`  t${i}:`, JSON.stringify(await snap()));
}

const pinned = await snap();
console.log('PINNED AGAINST BANK:', JSON.stringify(pinned));
const SHOT = arg('shot', null);
if (SHOT) { const { writeFileSync } = await import('node:fs');
  writeFileSync(SHOT, await p.screenshot()); console.log('shot:', SHOT); }

// What does the world look like straight off the bow? Both the sdf the physics
// uses and the DRAWN water depth the player sees, so the predicate can be
// built on whichever actually tracks the bank.
const transect = await p.evaluate(() => {
  const w = window.__world;
  const b0 = window.__boat.state().boats[0];
  const fx = Math.sin(b0.heading), fz = Math.cos(b0.heading);
  const lv = (x, z) => { const f = w._water; const v = f?.levelAt ? f.levelAt(x, z) : null;
    return (v === null || v === undefined) ? w.getWaterHeight(x, z) : v; };
  const out = [];
  for (let d = 0; d <= 20; d += 1) {
    const x = b0.x + fx * d, z = b0.z + fz * d;
    if (!w.isInBounds(x, z)) break;
    const l = lv(x, z);
    out.push({ d, sdf: +w.getHydro(x, z, {}).sdf.toFixed(2),
      depth: l == null ? null : +(l - w.getHeight(x, z)).toFixed(2),
      slope: +w.getSlope(x, z).toFixed(2) });
  }
  return out;
});
console.log('BOW TRANSECT:', JSON.stringify(transect));

// ── press E ──────────────────────────────────────────────────────────────────
await p.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e', bubbles: true }));
});
await p.waitForFunction(() => true, null, { timeout: 5000 });
// Give the sim a handful of frames to consume the press.
await p.evaluate(() => new Promise(r => {
  let n = 0; const f = () => (++n > 8 ? r() : requestAnimationFrame(f)); f();
}));
const after = await snap();
console.log('AFTER E:', JSON.stringify(after));

const veh = await p.evaluate(() => {
  const v = window.__game?.systems?.vehicle ?? window.__vehicle;
  return v ? { x: +v.position.x.toFixed(1), z: +v.position.z.toFixed(1) } : null;
});
console.log('camper:', JSON.stringify(veh));

console.log(JSON.stringify({ where: WHERE, kind: KIND,
  beachedAtBank: pinned.beached, promptAtBank: pinned.prompt,
  exited: after.aboard === false, held: after.held }, null, 1));
await b.close();
