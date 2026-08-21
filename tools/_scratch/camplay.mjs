#!/usr/bin/env node
/**
 * Drive the camp through the PLAYER's path, not the harness's.
 *
 * `campshot.mjs` calls `__camp.pitchAt()` on purpose — a capture harness that
 * has to synthesise a handbrake and a click breaks whenever the input mapping
 * is touched. The cost of that decision is that the whole interaction is
 * untested by every capture in the round: latch the park brake, watch the
 * reticle, move the aim, click, watch it raise. This drives exactly that.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(String(e)));
// Six peers are saving files all round. A Vite reload part-way through a
// scripted interaction destroys the page and every assertion after it — this
// harness spent one run reporting that window.__camp did not exist.
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) {
      return { readyState: 3, url: u, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(u, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const log = [];
// Print as we go. This script died mid-run twice with its whole log buffered
// for the end, which told me nothing about where it had got to.
const say = (e) => {
  console.log(`STEP ${String(e.label).padEnd(46)} camps=${e.camps} state=${e.state} ` +
              `pack=${e.packTarget} reason=${JSON.stringify(String(e.reason ?? '').slice(0, 28))}`);
  return e;
};
const snap = (label) => page.evaluate((l) => ({
  label: l,
  state: window.__camp.state,
  aim: { ...window.__camp._aim },
  brakeHold: window.__systems.vehicle.brakeHold,
  reticleVisible: window.__camp.reticle.mesh.visible,
  reticleFade: +window.__camp.reticle._fade.toFixed(3),
  prompt: window.__camp.prompt.el.textContent,
  promptShown: window.__camp.prompt.el.style.opacity,
  raise: +window.__camp.raise.toFixed(2),
  props: window.__camp.props.length,
  camps: window.__camp.camps.length,
  packTarget: !!window.__camp._packTarget,
  reason: window.__camp._aim.reason,
  focusCamp: !!window.__camp._focusCamp,
  // How far the camera's subject is from the camper: ~0 means it is looking at
  // the car, ~the site distance means it has drifted to the fire.
  subjOffCar: +(window.__systems.cameraRig?.subject
    ? window.__systems.cameraRig.subject.distanceTo(window.__systems.vehicle.position) : -1).toFixed(2),
}), label);

// Park somewhere open, then let the springs settle and the camper stop.
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(2500);
log.push(say(await snap('parked, no input')));

// Latch the park brake the way a player does: hold Space while stopped.
await page.keyboard.down('Space');
await page.waitForTimeout(900);
log.push(say(await snap('space held')));
await page.keyboard.up('Space');
await page.waitForTimeout(700);
log.push(say(await snap('space released — hold should have latched')));

// Aim: move the pointer across the canvas and see the reticle follow.
for (const [x, y] of [[700, 560], [560, 600], [900, 520]]) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(320);
  log.push(say(await snap(`aim at ${x},${y}`)));
}

// A look-drag must NOT place a camp.
await page.mouse.move(700, 500);
await page.mouse.down();
for (let i = 0; i < 8; i++) { await page.mouse.move(700 + i * 14, 500 + i * 3); await page.waitForTimeout(30); }
await page.mouse.up();
await page.waitForTimeout(400);
log.push(say(await snap('after a look-drag (must still be aiming)')));

await page.screenshot({ path: 'shots/camp/play-aiming.png' });

// A real click must place one — on OPEN GROUND. The fixed (720,560) this used
// to click is squarely on the camper in the chase framing, so once Camp learned
// to tell a click on the camper from a click past it, this test was faithfully
// clicking the car and then reporting that camps could not be made.
let clicked = null;
for (const [x, y] of [[980, 600], [430, 610], [1080, 520], [330, 540], [720, 660]]) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(240);
  const st = await page.evaluate(() => ({
    ok: window.__camp._aim.ok, onCar: window.__camp._pointerOnCamper(),
  }));
  if (!st.ok || st.onCar) continue;
  await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
  clicked = [x, y];
  break;
}
console.log('clicked open ground at', JSON.stringify(clicked));
await page.waitForTimeout(350);
log.push(say(await snap('just after click')));
await page.waitForTimeout(1600);
log.push(say(await snap('after the raise')));

await page.screenshot({ path: 'shots/camp/play-pitched.png' });

// Pack up.
// The camera should have walked over to the fire by now.
await page.waitForTimeout(2200);
log.push(say(await snap('2 s after the raise — camera should be on the fire')));
await page.screenshot({ path: 'shots/camp/play-focus-fire.png' });

// Clicking the camper takes focus back.
const carPx = await page.evaluate(() => {
  const v = window.__systems.vehicle, c = window.__engine.camera;
  const p = v.position.clone(); p.y += 1.0; p.project(c);
  return { x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight, z: p.z };
});
console.log('carPx', JSON.stringify(carPx));
if (carPx.z < 1) {
  await page.mouse.move(carPx.x, carPx.y);
  await page.waitForTimeout(220);
  await page.mouse.down(); await page.waitForTimeout(70); await page.mouse.up();
  await page.waitForTimeout(2200);
  console.log('focusProbe', JSON.stringify(await page.evaluate(() => {
    const c = window.__camp, v = window.__systems.vehicle;
    return {
      click: c._click, justPitched: c._justPitched, speed: +v.speed.toFixed(2),
      throttle: window.__ctx.input.axes.throttle,
      onCar: c._pointerOnCamper(),
      camps: c.camps.length,
      mouse: { x: +window.__ctx.input.mouse.x.toFixed(3), y: +window.__ctx.input.mouse.y.toFixed(3) },
    };
  })));
  log.push(say(await snap('after clicking the camper')));
  await page.screenshot({ path: 'shots/camp/play-focus-car.png' });
} else {
  log.push({ label: 'camper is off-screen; click test skipped', state: '-', aim: {}, props: -1, raise: -1 });
}

// ── a SECOND camp, without packing the first up ─────────────────────────────
// The player: "if I forget to pack up camp, I can't make a new camp elsewhere."
await page.evaluate(() => {
  const v = window.__systems.vehicle;
  window.__vehicleTeleport?.(v.position.x + 46, v.position.z + 20, 1.1);
});
await page.waitForTimeout(2600);
await page.keyboard.down('Space');
await page.waitForTimeout(900);
await page.keyboard.up('Space');
await page.waitForTimeout(600);
log.push(say(await snap('parked somewhere new — first camp must still stand')));

for (const [x, y] of [[980, 600], [430, 610], [1080, 520], [330, 540], [720, 660]]) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(240);
  const st = await page.evaluate(() => ({
    ok: window.__camp._aim.ok, onCar: window.__camp._pointerOnCamper(),
  }));
  if (!st.ok || st.onCar) continue;
  await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
  break;
}
await page.waitForTimeout(1900);
log.push(say(await snap('after making a SECOND camp')));
await page.screenshot({ path: 'shots/camp/play-two-camps.png' });

// Pointing at a camp is how you pack it up — no mode, no menu.
const campPx = await page.evaluate(() => {
  const cs = window.__camp.camps;
  const c = cs[cs.length - 1];
  if (!c) return null;
  const p = new window.__THREE.Vector3(c.x, c.y + 0.4, c.z).project(window.__engine.camera);
  return { x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight, z: p.z };
});
if (campPx && campPx.z < 1) {
  await page.mouse.move(campPx.x, campPx.y);
  await page.waitForTimeout(320);
  log.push(say(await snap('pointing at the newest camp')));
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(1500);
  log.push(say(await snap('after E — that camp packed up, the other stays')));
} else {
  console.log('camp off-screen; pack-up-by-pointing not exercised');
}

console.log(JSON.stringify(log, null, 1));
if (errs.length) console.log('page-errors:', JSON.stringify(errs.slice(0, 8), null, 1));
await browser.close();
