#!/usr/bin/env node
/**
 * scopeview — drive the telescope's eyepiece view the way a player would.
 *
 *   node tools/_scratch/scopeview.mjs --dir shots/camp/scope/view
 *
 * The model can be judged from screenshots; the INTERACTION cannot. This pitches
 * a camp, puts a telescope in it, moves the real mouse over the telescope,
 * clicks it, drags to sweep the sky, and presses Escape — through the game's own
 * input path rather than by calling `ScopeView.enter()` — and photographs every
 * stage. If the click does not land, or the mask does not appear, or Escape does
 * not get the player out, this is what says so.
 *
 * `window.__forceCamera` is deliberately NOT set: the whole point is that the
 * camera rig is live and the view has to take it away through `takeCamera`.
 * That also means the eyepiece mask is visible in these frames, which it is not
 * in any other capture in this project — the mask hides itself under
 * `__forceCamera` exactly like the rest of the HUD.
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
const DIR = arg('dir', 'shots/camp/scope/view');
const VARIANT = arg('variant', 'reflector');
const W = 1600, H = 900;

const release = await acquire('scopeview');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
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

await page.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });

await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1800);

// Hold the parking brake, and KEEP holding it.
//
// This is not harness noise, it is the feature's own gate: `Camp.update` only
// calls `_interact` while `veh.brakeHold` is true, so every camp affordance —
// the placement reticle, `E` to pack up, and the telescope prompt — exists only
// while the player is parked. The first run of this script found no prompt and
// no click for exactly that reason, which is the harness being wrong rather
// than the feature.
//
// Held by pressing the real handbrake key rather than by writing `brakeHold`,
// because `Vehicle.update` recomputes it from `axes.handbrake` every frame and
// would clear anything set from outside on the very next one.
await page.keyboard.down('Space');
await page.waitForTimeout(1500);

// Pitch a camp and force a telescope into it, then park the camper beside the
// scope so the "parked at this camp" gate the prompt is behind is satisfied.
const info = await page.evaluate(async ({ variant }) => {
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  if (!s) return null;
  const THREE = window.__THREE;
  const mod = await import('/src/camp/camp_telescope.js');
  const site = await import('/src/camp/camp_site.js');
  const { mulberry32 } = await import('/src/core/MathUtils.js');
  const camp = window.__camp.camps ? window.__camp.camps[window.__camp.camps.length - 1] : window.__camp;
  const props = camp.props ?? window.__camp.props;
  const chairs = props.filter((p) => p.item.kind === 'chair');
  let ax = 0, az = 0;
  for (const c of chairs) { ax += c.item.x - s.x; az += c.item.z - s.z; }
  const seat = chairs.length ? Math.atan2(az, ax) : 0;
  const R = (camp.site ?? window.__camp.site)?.radius ?? 5.8;
  const a = seat + 1.7, r = R * 0.50;
  const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
  const y = window.__world.getHeight(x, z);
  const yaw = Math.atan2(s.x - x, s.z - z);
  const g = mod.buildTelescope(mulberry32(0x51ed270b), { variant, wear: 0.45 });
  g.position.set(x, y, z);
  const q = new THREE.Quaternion();
  site.standOn(window.__world, x, z, yaw, 0.22, q);
  g.quaternion.copy(q);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  (camp.root ?? window.__camp.root).add(g);
  props.push({ obj: g, item: { kind: 'telescope', x, y, z, yaw }, delay: 0 });
  return { x, y, z, eyeY: g.userData.telescope.eye.y };
}, { variant: VARIANT });

if (!info) { console.error('scopeview: no valid site'); await browser.close(); release(); process.exit(2); }
mkdirSync(resolve(DIR), { recursive: true });

const shot = async (name) => {
  await page.screenshot({ path: resolve(DIR, `${name}.png`) });
  console.log(`shot: ${name}`);
};

// Where is the telescope on screen? Project it, then move the real mouse there.
const project = async () => page.evaluate(({ W, H }) => {
  const THREE = window.__THREE, e = window.__engine;
  const camps = window.__camp.camps ?? [window.__camp];
  let prop = null;
  for (const c of camps) for (const p of (c.props ?? [])) if (p.item.kind === 'telescope') prop = p;
  if (!prop) return null;
  const d = prop.obj.userData.telescope;
  const v = new THREE.Vector3(prop.item.x, prop.item.y + (d.eye?.y ?? 0.7) * 0.86, prop.item.z);
  v.project(e.camera);
  return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, behind: v.z > 1 };
}, { W, H });

await page.waitForTimeout(1200);
await shot('00-camp');

let p = await project();
if (!p || p.behind || p.x < 0 || p.x > W || p.y < 0 || p.y > H) {
  console.log(`scopeview: telescope is off screen at ${JSON.stringify(p)} — ` +
              'the chase camera is not looking at it. Nudging the view.');
}
console.log(`telescope on screen at ${p ? `${p.x.toFixed(0)},${p.y.toFixed(0)}` : 'nowhere'}`);

// ── the focus gate, negative case first ───────────────────────────────────
//
// The eyepiece is only offered while the camera is looking at the CAMP. With
// focus on the camper the same pointer over the same telescope must produce
// nothing — otherwise one click would both swing the focus and drop the player
// inside a telescope, which is two moves for one input.
await page.mouse.move(p.x, p.y);
await page.waitForTimeout(700);
const denied = await page.evaluate(() => {
  window.__camp._focusCamp = null;          // camera on the camper
  return null;
});
await page.waitForTimeout(500);
const noPrompt = await page.evaluate(() =>
  document.querySelector('.pa-camp-prompt')?.textContent?.trim() ?? '');
console.log(`focus on camper -> prompt: "${noPrompt}"` +
  (noPrompt.includes('telescope') ? '   <-- GATE FAILED' : '   gate holds'));
await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
await page.waitForTimeout(500);
const enteredAnyway = await page.evaluate(() => !!window.__camp.scope?.active);
console.log(`focus on camper -> click entered the eyepiece: ${enteredAnyway}` +
  (enteredAnyway ? '   <-- GATE FAILED' : '   gate holds'));
void denied;

// Hand focus back to the camp, the way clicking the camp does.
await page.evaluate(() => {
  const camps = window.__camp.camps ?? [];
  window.__camp._focusCamp = camps[camps.length - 1] ?? null;
});
await page.waitForTimeout(600);
await page.mouse.move(p.x + 1, p.y);
await page.waitForTimeout(700);
await shot('01-hover');
const prompt = await page.evaluate(() =>
  document.querySelector('.pa-camp-prompt')?.textContent ?? '(no prompt element)');
console.log(`focus on camp   -> prompt: "${prompt}"`);

// Click it.
await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
await page.waitForTimeout(300);
await shot('02-entering');
await page.waitForTimeout(900);
await shot('03-eyepiece');
const state = await page.evaluate(() => ({
  active: !!window.__camp.scope?.active,
  fov: window.__engine.camera.fov,
  tip: document.querySelector('.pa-scope-tip')?.textContent ?? '',
  hudHidden: !!window.__forceCamera,
  mask: parseFloat(getComputedStyle(document.querySelector('.pa-scope-mask')).opacity),
}));
console.log(`in the eyepiece: ${JSON.stringify(state)}`);

// Drag upward to sweep toward the zenith.
await page.mouse.move(p.x, p.y);
await page.mouse.down();
// UP. Dragging the mouse down sweeps the view down — the first run of this
// script dragged down, photographed a treeline, and called the frame
// "swept-up", which is the harness lying about what it tested.
for (let i = 0; i < 14; i++) { await page.mouse.move(p.x + i * 6, p.y - i * 14); await page.waitForTimeout(30); }
await page.mouse.up();
await page.waitForTimeout(600);
await shot('04-swept-up');

// Wheel: magnify.
await page.mouse.wheel(0, -600);
await page.waitForTimeout(700);
await shot('05-magnified');
const zoom = await page.evaluate(() => window.__engine.camera.fov);
console.log(`fov after wheel: ${zoom.toFixed(1)}`);

// Night, so the sky has something in it — and specifically a night when the
// MOON IS UP, which is the payoff this whole feature is for. The first run
// picked 23.2 out of the air, got a moon 90 degrees below the horizon, and
// photographed an empty circle. So: ask the sky which hour has one.
//
// Sampled through REAL FRAMES, not by calling `Lighting.update` by hand. The
// first attempt drove the update directly in a tight loop and read moonElev
// back as -1 at every hour, which is the value the record is initialised to —
// the hour is consumed by the engine's own update, and a hand call with a
// guessed signature simply did not run.
let best = { hour: 22.5, elev: -1, stars: 0 };
for (const h of [20.5, 21.5, 22.5, 23.5, 0.5, 1.5, 2.5, 3.5, 4.5]) {
  await page.evaluate((hh) => { window.__lighting.hour = hh; window.__lighting.cycleSpeed = 0; }, h);
  await page.waitForTimeout(420);
  const st = await page.evaluate(() => {
    // Read the record off the SKY, not by importing Lighting.js again.
    //
    // A dynamic `import('/src/render/Lighting.js')` from the page console gets
    // Vite's un-suffixed URL, which is a DIFFERENT module instance from the
    // `?t=…` one the app loaded — so `SKY_STATE` came back at its initial
    // values (moonElev -1, starAmount 0) at every hour sampled, and the search
    // dutifully reported that this world has no moon. Sky.js copies the live
    // record into its own uniforms every frame, and those are reachable.
    const u = window.__sky?.uniforms;
    if (!u) return { elev: -1, stars: 0, mi: 0, why: 'no sky uniforms' };
    return {
      elev: u.uMoonDir?.value?.y ?? -1,
      stars: u.uStarAmount?.value ?? 0,
      mi: u.uMoonDiscI?.value ?? 0,
    };
  });
  if (st.elev > 0.15 && st.elev < 0.95 && st.stars > best.stars * 0.9
      && st.elev * st.stars > best.elev * best.stars) best = { hour: h, ...st };
}
await page.evaluate((hh) => { window.__lighting.hour = hh; window.__lighting.cycleSpeed = 0; },
                    best.hour);
console.log(`night hour chosen: ${JSON.stringify(best)}`);
await page.waitForTimeout(1600);
await shot('06-night-sky');

// Point it at the moon, magnified — the payoff shot. The moon's direction is
// live in the sky system's own state, so aim at it rather than hunting.
const moon = await page.evaluate(() => {
  const u = window.__sky?.uniforms;
  const d = u?.uMoonDir?.value;
  if (!d) return null;
  const yaw = Math.atan2(-d.x, -d.z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
  const v = window.__camp.scope;
  if (!v?.active) return null;
  v.yaw = yaw; v.pitch = Math.max(-0.10, Math.min(1.40, pitch));
  v.fovTarget = 7.5;
  return { yaw, pitch, up: d.y > 0 };
});
console.log(`moon: ${moon ? JSON.stringify(moon) : 'sky state not reachable'}`);
if (moon?.up) { await page.waitForTimeout(1500); await shot('06b-moon'); }

// Escape: back out.
await page.keyboard.press('Escape');
await page.waitForTimeout(220);
await shot('07-leaving');
await page.waitForTimeout(700);
await shot('08-back-out');
const after = await page.evaluate(() => ({
  active: !!window.__camp.scope?.active,
  fov: window.__engine.camera.fov,
  mask: parseFloat(getComputedStyle(document.querySelector('.pa-scope-mask')).opacity),
  propVisible: (() => {
    const camps = window.__camp.camps ?? [window.__camp];
    for (const c of camps) for (const q of (c.props ?? []))
      if (q.item.kind === 'telescope') return q.obj.visible;
    return null;
  })(),
}));
console.log(`after Escape: ${JSON.stringify(after)}`);

if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));
await browser.close();
release();
