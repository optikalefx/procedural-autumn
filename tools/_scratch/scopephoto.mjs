#!/usr/bin/env node
/**
 * scopephoto — pressing F at the eyepiece.
 *
 *   node tools/_scratch/scopephoto.mjs --dir shots/camp/scope/photo
 *
 * The bug this exists for: stepping into photo mode from inside the telescope
 * played the eyepiece's step-back — a third of a second of zooming out to the
 * pose the player came from — and then cut straight back to the eyepiece,
 * because `CameraRig.enterFree` had already been posed there on the way in.
 *
 * A screenshot cannot see that. What sees it is the camera's own position
 * sampled every frame across the transition: the fix is exactly the claim that
 * it does not move. So this pitches a camp with a telescope in it, clicks the
 * eyepiece through the game's own input path, records the pose, presses F, and
 * traces position and fov for the second and a half either side.
 *
 * Setup (teleport, brake, camp, telescope, focus gate) is lifted from
 * `scopeview.mjs`, which is the harness that proved the view itself.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const DIR = arg('dir', 'shots/camp/scope/photo');
const URL = arg('url', 'http://localhost:5178/?res=768&car=camper');
const W = 1600, H = 900;

const release = await acquire('scopephoto');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
// Deafen Vite's HMR socket. Anything written under the project root while this
// is running — including this file — otherwise reloads the page mid-trace and
// the run dies with "execution context was destroyed". Same stub scopeview.mjs
// carries, for the same reason.
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {},
               set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });

await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1800);
await page.keyboard.down('Space');          // the parking brake, held — see scopeview.mjs
await page.waitForTimeout(1500);

const info = await page.evaluate(async () => {
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  if (!s) return null;
  const THREE = window.__THREE;
  const mod = await import('/src/camp/camp_telescope.js');
  const site = await import('/src/camp/camp_site.js');
  const { mulberry32 } = await import('/src/core/MathUtils.js');
  const camp = window.__camp.camps[window.__camp.camps.length - 1];
  const chairs = camp.props.filter((p) => p.item.kind === 'chair');
  let ax = 0, az = 0;
  for (const c of chairs) { ax += c.item.x - s.x; az += c.item.z - s.z; }
  const seat = chairs.length ? Math.atan2(az, ax) : 0;
  const R = camp.site?.radius ?? 5.8;
  const a = seat + 1.7, r = R * 0.50;
  const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
  const y = window.__world.getHeight(x, z);
  const yaw = Math.atan2(s.x - x, s.z - z);
  const g = mod.buildTelescope(mulberry32(0x51ed270b), { variant: 'reflector', wear: 0.45 });
  g.position.set(x, y, z);
  const q = new THREE.Quaternion();
  site.standOn(window.__world, x, z, yaw, 0.22, q);
  g.quaternion.copy(q);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  camp.root.add(g);
  camp.props.push({ obj: g, item: { kind: 'telescope', x, y, z, yaw }, delay: 0 });
  window.__camp._focusCamp = camp;
  return { x, y, z };
});
if (!info) { console.error('scopephoto: no valid site'); await browser.close(); release(); process.exit(2); }
mkdirSync(resolve(DIR), { recursive: true });
const shot = async (n) => { await page.screenshot({ path: resolve(DIR, `${n}.png`) }); };

// Night, so the eyepiece has a sky in it and the frames are worth looking at.
await page.evaluate(() => { window.__lighting.hour = 21.8; window.__lighting.cycleSpeed = 0; });
await page.waitForTimeout(1200);

// Where the telescope is ON SCREEN, right now.
//
// Re-projected in a loop rather than once: handing the focus to the camp
// swings the chase camera over the next second or so, and a point projected
// before that swing is 35 px off the tripod by the time the click lands — which
// is how the first run of this harness clicked on grass and reported that the
// eyepiece could not be entered. `_scopeUnderPointer` is the same test the
// prompt is behind, so ask it directly instead of guessing from the picture.
const project = () => page.evaluate(({ W, H }) => {
  const THREE = window.__THREE, c = window.__camp;
  let prop = null;
  for (const cc of c.camps) for (const q of cc.props) if (q.item.kind === 'telescope') prop = q;
  if (!prop) return null;
  const d = prop.obj.userData.telescope;
  const v = new THREE.Vector3(prop.item.x, prop.item.y + (d.eye?.y ?? 0.7) * 0.86, prop.item.z);
  v.project(c.ctx.camera);
  return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, behind: v.z > 1 };
}, { W, H });

// Hand the camera's focus to the camp. The eyepiece is only offered while the
// camp — not the camper — is what the player is looking at.
await page.evaluate(() => {
  window.__camp._focusCamp = window.__camp.camps[window.__camp.camps.length - 1];
});
await page.waitForTimeout(1400);

let p = null, onIt = false;
for (let i = 0; i < 8 && !onIt; i++) {
  p = await project();
  if (!p || p.behind) { await page.waitForTimeout(400); continue; }
  await page.mouse.move(p.x, p.y + (i % 2));      // a real move, every time
  await page.waitForTimeout(320);
  onIt = await page.evaluate(() => !!window.__camp._scopeUnderPointer());
}
console.log(`telescope at ${p ? `${p.x.toFixed(0)},${p.y.toFixed(0)}` : '?'} — pointer on it: ${onIt}`);
console.log('prompt: ' + await page.evaluate(() =>
  document.querySelector('.pa-camp-prompt')?.textContent?.trim() ?? '(none)'));

await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
await page.waitForTimeout(1400);
if (!await page.evaluate(() => !!window.__camp.scope?.active)) {
  console.error('scopephoto: the click did not enter the eyepiece — nothing below is testing anything');
  await shot('00-FAILED');
  await browser.close(); release(); process.exit(3);
}
await shot('00-eyepiece');

const state = () => page.evaluate(() => {
  const cam = window.__engine.camera;
  const rig = window.__systems.cameraRig;
  const sc = window.__camp.scope;
  let prop = null;
  for (const c of window.__camp.camps) for (const q of c.props) if (q.item.kind === 'telescope') prop = q;
  return {
    scopeActive: !!sc?.active, handedOff: !!sc?._handedOff, propVisible: prop?.obj.visible ?? null,
    photo: !!window.__systems.hud?.photo?.active, mode: rig?.mode,
    fov: +cam.fov.toFixed(2), pos: [cam.position.x, cam.position.y, cam.position.z],
    mask: parseFloat(getComputedStyle(document.querySelector('.pa-scope-mask')).opacity),
    railVisible: !!document.querySelector('.pa-photo-frame.pa-open'),
  };
});
const at = await state();
console.log(`at the eyepiece: ${JSON.stringify({ ...at, pos: at.pos.map((n) => +n.toFixed(3)) })}`);

// Trace every frame across the F press.
await page.evaluate(() => {
  window.__trace = [];
  const cam = window.__engine.camera;
  const t0 = performance.now();
  const tick = () => {
    window.__trace.push([+(performance.now() - t0).toFixed(1),
      cam.position.x, cam.position.y, cam.position.z, cam.fov]);
    if (window.__trace.length < 400) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(120);
await page.keyboard.press('f');
await page.waitForTimeout(160); await shot('01-f+0.16s');
await page.waitForTimeout(240); await shot('02-f+0.40s');
await page.waitForTimeout(600); await shot('03-f+1.0s');
await page.waitForTimeout(500);

const trace = await page.evaluate(() => window.__trace);
const eye = at.pos;
let far = 0, farT = 0, fovLo = 1e9, fovHi = 0;
for (const [t, x, y, z, f] of trace) {
  const d = Math.hypot(x - eye[0], y - eye[1], z - eye[2]);
  if (d > far) { far = d; farT = t; }
  fovLo = Math.min(fovLo, f); fovHi = Math.max(fovHi, f);
}
console.log(`frames traced: ${trace.length}`);
console.log(`camera travel from the eyepiece pose: max ${far.toFixed(4)} m at t=${farT} ms`);
console.log(`fov over the transition: ${fovLo.toFixed(2)} .. ${fovHi.toFixed(2)}`);
console.log('trace (every 6th frame): ' + trace.filter((_, i) => i % 6 === 0).map(
  ([t, x, y, z, f]) => `${t}ms d=${Math.hypot(x - eye[0], y - eye[1], z - eye[2]).toFixed(3)} fov=${f.toFixed(1)}`,
).join('\n  '));

const inPhoto = await state();
console.log(`in photo mode: ${JSON.stringify({ ...inPhoto, pos: inPhoto.pos.map((n) => +n.toFixed(3)) })}`);

// Step the free camera back off the eyepiece: the telescope has to come back.
await page.mouse.move(W / 2, H / 2);
await page.mouse.wheel(0, 900);
await page.waitForTimeout(900);
await shot('04-stepped-back');
const back = await state();
console.log(`after stepping back: ${JSON.stringify({ ...back, pos: back.pos.map((n) => +n.toFixed(3)) })}`);

// And out again.
await page.keyboard.press('f');
await page.waitForTimeout(1200);
await shot('05-out');
const out = await state();
console.log(`after leaving photo mode: ${JSON.stringify({ ...out, pos: out.pos.map((n) => +n.toFixed(3)) })}`);

if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));
await browser.close();
release();
