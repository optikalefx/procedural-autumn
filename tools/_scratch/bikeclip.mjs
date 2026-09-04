#!/usr/bin/env node
/**
 * Are the wheels in the ground on a climb? Asked of the GAME, side-on.
 *
 * `bikesink.mjs` measures the physics' own height error and is the authority on
 * the cause; this checks the thing actually reported — what the wheels look
 * like — by putting the camera beside the bike on a steep climb and measuring
 * each wheel's lowest point against the terrain under it.
 *
 * The two contributions are separate and both are reported: the FRAME's height
 * error (the lag) and the WHEEL's geometry under a pitched frame, which sinks a
 * circular wheel by wheelR·(1−cos θ) no matter which way the bike points.
 *
 *   node tools/_scratch/bikeclip.mjs [--port 5272]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const PORT = arg('port', '5272');
mkdirSync('review', { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.addInitScript(() => {
  try {
    const k = 'pa.hud';
    const st = JSON.parse(localStorage.getItem(k) ?? '{}') || {};
    st.introSeen = true; st.seenHint = true; st.escSeen = true;
    localStorage.setItem(k, JSON.stringify(st));
  } catch { /* storage unavailable */ }
});
await page.goto(`http://127.0.0.1:${PORT}/?quality=high`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__bike && !!window.__engine, null, { timeout: 60000 });

await page.evaluate(() => {
  const e = window.__engine;
  e.adaptive = false; e.autoQuality = false;
  const DT = 1 / 60; let budget = 0;
  window.__grant = () => { budget += DT; };
  e.clock.getDelta = () => { if (budget <= 1e-9) return 0; budget -= DT; return DT; };
});

// A set of sustained climbs the bike can actually ride up.
const spots = await page.evaluate(() => {
  const W = window.__bike.ctx.world;
  const out = [];
  for (let i = 0; i < 60000 && out.length < 14; i++) {
    const x = (Math.random() * 2 - 1) * 1100, z = (Math.random() * 2 - 1) * 1100;
    const s = W.getSlope(x, z);
    if (s < 0.4 || s > 0.8 || W.getWaterDepth(x, z) > 0.1) continue;
    let bh = 0, bd = -1e9;
    for (let a = 0; a < 24; a++) {
      const h = a / 24 * Math.PI * 2;
      const d = W.getHeight(x + Math.sin(h) * 16, z + Math.cos(h) * 16) - W.getHeight(x, z);
      if (d > bd) { bd = d; bh = h; }
    }
    if (bd < 5) continue;
    out.push({ x, z, h: bh });
  }
  return out;
});
console.log(`[clip] ${spots.length} climbs, each ridden UP then DOWN\n`);

const probe = (s, up) => page.evaluate(([s, up]) => new Promise((res) => {
  const B = window.__bike, W = B.ctx.world, THREE = window.__THREE;
  B.dismount();
  B.parkAt(s.x, s.z, { yaw: up ? s.h : s.h + Math.PI });
  B.mount();
  B.drive(1, 0);
  const p = B.bike.phys;
  const R = B.bike.group.userData.dim?.wheelR ?? 0.35;
  let n = 0;
  const f = () => {
    if (n > 90) {
      const g3 = B.bike.group;
      g3.updateMatrixWorld(true);
      const u = g3.userData;
      const nv = new THREE.Vector3();
      W.getNormal(p.x, p.z, nv, 1.0);
      const deep = [];
      for (const obj of [u.wheels?.front, u.wheels?.rear]) {
        if (!obj) continue;
        const a3 = obj.getWorldPosition(new THREE.Vector3());
        deep.push(R - (a3.y - W.getHeight(a3.x, a3.z)) * nv.y);
      }
      return res({ into: Math.max(...deep), pitch: p.pitch * 180 / Math.PI,
        grade: p.grade, v: Math.abs(p.speed), air: p.airborne });
    }
    window.__grant(); n++;
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
}), [s, up]);

const R = 0.35;
for (const [name, up] of [['riding UP  ', true], ['riding DOWN', false]]) {
  const rows = [];
  for (const s of spots) { const r = await probe(s, up); if (!r.air) rows.push(r); }
  const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / Math.max(1, rows.length);
  const worst = Math.max(...rows.map((r) => r.into));
  console.log(`${name}  n=${String(rows.length).padStart(2)}  pitch ${mean((r) => Math.abs(r.pitch)).toFixed(1)} deg` +
    `  into ground mean ${mean((r) => r.into).toFixed(3)} m  worst ${worst.toFixed(3)} m` +
    `  (${(100 * mean((r) => r.into) / R).toFixed(0)}% of a wheel)`);
}
const out = [];
for (const r of out) console.log(JSON.stringify(r));
// The camera, placed AFTER the last granted frame and never granted over: the
// rig stands down only while `__forceCamera` is raised, and a granted frame with
// it lowered puts the view straight back on the handlebars — which is what the
// first attempt filmed.
// The camera is placed and then the frame is RENDERED DIRECTLY, because the rig
// re-aims the camera on its own loop whether or not the clock granted anything —
// raising `__forceCamera` and waiting for a rAF put the view straight back on
// the handlebars twice. Driving the renderer once, with nothing in between,
// is the only way to get a frame from a camera of our choosing.
await page.evaluate(() => {
  const B = window.__bike, p = B.bike.phys;
  const e = window.__engine;
  // Get off FIRST. While the player is on the bike the rig re-aims the camera
  // from `_mount` on its own loop, so raising `__forceCamera` and rendering
  // immediately still produced the handlebars twice — the rig had already
  // written the camera for this frame. Dismounting stands that down; the bike
  // keeps the pose it settled into because no frame is granted after it.
  B.dismount();
  window.__forceCamera = true;
  document.body.classList.add('pa-capture-hidden');
  const cam = B.ctx.camera;
  const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
  cam.position.set(p.x + rx * 3.4, p.y + 0.75, p.z + rz * 3.4);
  cam.lookAt(p.x, p.y + 0.38, p.z);
  cam.updateMatrixWorld(true);
  const scene = B.ctx.scene ?? e.scene;
  e.renderer.render(scene, cam);
  return { rendered: !!scene };
});
await page.screenshot({ path: 'review/bike-climb.png' });
console.log('[clip] wrote review/bike-climb.png');
await browser.close();
