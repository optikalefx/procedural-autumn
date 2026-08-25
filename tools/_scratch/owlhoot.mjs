#!/usr/bin/env node
/**
 * Does the owl actually hoot, and does it stay quiet when there is no owl?
 *
 * Boots the real game with a real audio context, perches an owl beside the
 * listener at night, zeroes the hoot cooldown and watches WildlifeAudio's own
 * call counter. Audio.js swallows a throwing layer and disables it, so the
 * console warning is a failure too — a silent owl and a crashed owl look
 * identical from the outside.
 *
 *   AUTUMN_URL=http://127.0.0.1:5193 node tools/_scratch/owlhoot.mjs
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5193') + '/?car=camper';
await acquire('shot');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
const warns = [];
page.on('console', (m) => { if (/audio|owl/i.test(m.text())) warns.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
page.on('pageerror', (e) => warns.push('pageerror: ' + String(e).slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.keyboard.press('KeyM');
await page.keyboard.press('KeyM');
await page.waitForTimeout(400);

const r = await page.evaluate(async () => {
  window.__lighting.hour = 22; window.__lighting.cycleSpeed = 0;
  await window.__settle(30);
  const tb = window.__systems.wildlife.treeBirds;
  const wa = window.__audio.wildlife;
  const cam = window.__engine.camera.position;

  // No owl anywhere: the clock must NOT fire a call.
  for (const slots of tb.slots) for (const b of slots) if (b.spec.key === 'owl' && b.active) tb._park(b);
  const before = wa.state.calls;
  wa._hootCool = 0;
  await window.__settle(20);
  const noOwl = wa.state.calls - before;

  // Now put one on a tree beside the listener and let the clock come round.
  let p = null;
  for (const [dx, dz] of [[35, 0], [0, 35], [-35, 0], [0, -35], [60, 60]]) {
    p = tb.debugPerchNear(cam.x + dx, cam.z + dz, 'owl');
    if (p) break;
  }
  if (!p) return { err: 'no perch' };
  const b2 = wa.state.calls;
  wa._hootCool = 0;
  await window.__settle(20);
  const withOwl = wa.state.calls - b2;
  return {
    noOwl, withOwl, perch: p,
    cool: wa._hootCool,
    ctx: window.__audio.actx.state,
    nearest: tb.nearestPerched('owl', cam.x, cam.z, 260),
  };
});
console.log(JSON.stringify(r, null, 1));
console.log(warns.length ? 'console: ' + JSON.stringify([...new Set(warns)].slice(0, 6), null, 1) : 'console: clean');
await browser.close();
