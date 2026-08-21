#!/usr/bin/env node
/**
 * Parked at a camp, is the placement affordance actually gone?
 *
 * The player's complaint was that standing at their own camp, the pointer was
 * still offering to build another one — so the ring, the prompt and the pitch
 * all had to be checked, not just the ring. And then the opposite: driving away
 * has to give all three back, or the fix is a regression wearing a fix's hat.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) return { readyState: 3, url: u, protocol: '', addEventListener() {}, removeEventListener() {}, send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    return new Real(u, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 220)));
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const snap = (label) => page.evaluate((l) => {
  const c = window.__camp, v = window.__systems.vehicle;
  const home = c._homeCamp(v);
  return {
    label: l,
    camps: c.camps.length,
    atCamp: !!home,
    nearestM: c.camps.length ? +Math.min(...c.camps.map((k) =>
      Math.hypot(v.position.x - k.x, v.position.z - k.z))).toFixed(1) : -1,
    ringVisible: !!(c.reticle?.mesh?.visible && c.reticle._fade > 0.01),
    fade: +(c.reticle?._fade ?? -1).toFixed(3),
    suppress: !!c._suppressAim,
    state: c.state,
    aimOk: !!c._aim.ok,
    // The VISIBLE prompt. `CampPrompt.set('')` hides the element by opacity and
    // deliberately leaves its innerHTML alone, so reading textContent reports
    // the last thing it ever said — this test spent a run insisting that
    // "E pack up this camp" was showing at every pointer position when the
    // element was invisible at five of them.
    prompt: getComputedStyle(c.prompt.el).opacity === '0' ? '' : c.prompt.el.textContent.trim(),
  };
}, label);

const log = [];
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(2500);

// Latch the park brake the way a player does.
await page.keyboard.down('Space'); await page.waitForTimeout(900);
await page.keyboard.up('Space');   await page.waitForTimeout(700);
await page.mouse.move(700, 555); await page.waitForTimeout(400);
log.push(await snap('parked, no camp yet — ring SHOULD show'));

// Build one. With E rather than a click: a click has to be told apart from a
// camera look-drag and from the camper itself, and this test is not about that.
await page.keyboard.press('KeyE');
await page.waitForTimeout(2500);
log.push(await snap('camp built, still parked here — ring should be GONE'));

// Sweep the pointer around: none of it should offer to build.
let offered = 0, neutral = 0, packable = 0;
// Project the camp itself to a screen point, so one sample is guaranteed to be
// pointing straight at it.
const campPx = await page.evaluate(() => {
  const c = window.__camp.camps[0], cam = window.__engine.camera;
  const p = new window.__THREE.Vector3(c.x, c.y + 0.3, c.z).project(cam);
  return { x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight, z: p.z };
});
const spots = [[420, 600], [980, 520], [700, 470], [1150, 640], [300, 700]];
if (campPx.z < 1) spots.push([Math.round(campPx.x), Math.round(campPx.y)]);
for (const [x, y] of spots) {
  await page.mouse.move(x, y); await page.waitForTimeout(260);
  const s = await snap(`aim ${x},${y}`);
  if (s.ringVisible || /make camp/i.test(s.prompt)) offered++;
  if (s.prompt === '') neutral++;
  if (/pack up/i.test(s.prompt)) packable++;
  log.push(s);
}

await page.mouse.move(300, 700); await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/camp/near-neutral.png' });
if (campPx.z < 1) {
  await page.mouse.move(Math.round(campPx.x), Math.round(campPx.y));
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shots/camp/near-oncamp.png' });
}

// E on open ground should explain itself rather than doing nothing silently.
await page.mouse.move(420, 600); await page.waitForTimeout(250);
await page.keyboard.press('KeyE'); await page.waitForTimeout(400);
const toast = await page.evaluate(() => document.querySelector('.pa-toast')?.textContent?.trim() ?? '');
log.push({ ...(await snap('after E on open ground')), toast });

// Drive well clear, park again: the affordance must come back.
await page.evaluate(() => {
  const c = window.__camp.camps[0], v = window.__systems.vehicle;
  const a = Math.atan2(v.position.z - c.z, v.position.x - c.x);
  window.__vehicleTeleport?.(c.x + Math.cos(a) * 55, c.z + Math.sin(a) * 55, 0.9);
});
await page.waitForTimeout(2600);
await page.keyboard.down('Space'); await page.waitForTimeout(900); await page.keyboard.up('Space');
await page.waitForTimeout(700);
await page.mouse.move(700, 560); await page.waitForTimeout(500);
log.push(await snap('parked 55 m away — ring should be BACK'));

for (const e of log) {
  console.log(`${e.label.padEnd(46)} camps=${e.camps} atCamp=${String(e.atCamp).padEnd(5)} ` +
              `nearest=${String(e.nearestM).padStart(6)}m ring=${String(e.ringVisible).padEnd(5)} ` +
              `aimOk=${String(e.aimOk).padEnd(5)} suppress=${String(e.suppress).padEnd(5)} ` +
              `fade=${e.fade} prompt=${JSON.stringify(e.prompt)}` +
              (e.toast !== undefined ? ` toast=${JSON.stringify(e.toast)}` : ''));
}
console.log(`\nwhile parked at camp — offered to build: ${offered} (want 0)`);
console.log(`                       neutral (no prompt): ${neutral} (want most)`);
console.log(`                       pack-up offered:     ${packable} (want >=1, on the camp)`);
if (errs.length) console.log('page-errors:', errs.slice(0, 3));
await browser.close();
