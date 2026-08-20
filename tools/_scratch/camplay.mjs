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
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const log = [];
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
}), label);

// Park somewhere open, then let the springs settle and the camper stop.
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(2500);
log.push(await snap('parked, no input'));

// Latch the park brake the way a player does: hold Space while stopped.
await page.keyboard.down('Space');
await page.waitForTimeout(900);
log.push(await snap('space held'));
await page.keyboard.up('Space');
await page.waitForTimeout(700);
log.push(await snap('space released — hold should have latched'));

// Aim: move the pointer across the canvas and see the reticle follow.
for (const [x, y] of [[700, 560], [560, 600], [900, 520]]) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(320);
  log.push(await snap(`aim at ${x},${y}`));
}

// A look-drag must NOT place a camp.
await page.mouse.move(700, 500);
await page.mouse.down();
for (let i = 0; i < 8; i++) { await page.mouse.move(700 + i * 14, 500 + i * 3); await page.waitForTimeout(30); }
await page.mouse.up();
await page.waitForTimeout(400);
log.push(await snap('after a look-drag (must still be aiming)'));

await page.screenshot({ path: 'shots/camp/play-aiming.png' });

// A real click must place one.
await page.mouse.move(720, 560);
await page.waitForTimeout(250);
await page.mouse.down();
await page.waitForTimeout(80);
await page.mouse.up();
await page.waitForTimeout(350);
log.push(await snap('just after click'));
await page.waitForTimeout(1600);
log.push(await snap('after the raise'));

await page.screenshot({ path: 'shots/camp/play-pitched.png' });

// Pack up.
await page.keyboard.press('KeyE');
await page.waitForTimeout(1200);
log.push(await snap('after E — packed up'));

console.log(JSON.stringify(log, null, 1));
if (errs.length) console.log('page-errors:', JSON.stringify(errs.slice(0, 8), null, 1));
await browser.close();
