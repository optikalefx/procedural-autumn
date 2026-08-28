#!/usr/bin/env node
/**
 * Open the journal over the REAL game, on this worktree's server.
 *
 * Nothing constructs a Journal yet — the integrator does that after this lands —
 * so this stands in for the wiring: it imports the module, hangs a Journal off
 * `window.__ctx`, chains its `render` behind `postfx.render`, and drives
 * `update` from the same callback.
 *
 * What it is actually checking, and none of it can be checked in the lab page:
 *
 *  · `buildEnvMap` against the game's own renderer, mid-boot;
 *  · that the overlay draws OVER the finished post chain rather than under it;
 *  · that `render()` puts every renderer flag back — the frame AFTER the
 *    journal closes has to be identical to the frame before it opened, and the
 *    two captures here are the check;
 *  · no console errors from a module the game has never loaded before.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const dir = arg('dir', '/tmp/jingame');
const w = +arg('w', 1600), h = +arg('h', 900);

mkdirSync(dir, { recursive: true });
const errs = [];
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => { errs.push('pageerror: ' + e.message); });
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (t.includes('VITE_POSTHOG_KEY')) return;        // known, unrelated
  errs.push('console: ' + t);
});

await page.goto('http://127.0.0.1:5199/?seed=20261018&car=camper', { waitUntil: 'load', timeout: 180_000 });
await page.waitForFunction('window.__ctx && window.__postfx && window.__engine', null, { timeout: 240_000 });
await page.waitForTimeout(6000);

await page.screenshot({ path: `${dir}/0_before.png` });

await page.evaluate(async () => {
  const J = await import('/src/journal/Journal.js');
  const j = window.__j = new J.Journal(window.__ctx);
  const fx = window.__postfx;
  window.__engine.setRenderCallback((dt) => {
    fx.render(dt);
    j.update(dt);
    j.render(window.__engine.renderer);
  });
});

// ── the black photograph was THIS, and nothing in the product ──────────────
// This line used to be `document.querySelector('canvas#gl').toDataURL(...)`
// sitting at the bottom of the evaluate above — i.e. run from a task that is
// NOT the one that drew the frame. The context has no `preserveDrawingBuffer`,
// so by then the drawing buffer has been cleared and what comes back is a
// 12,435-byte fully black JPEG with a mean luma of 0.0. Every capture the
// harness produced showed a black print taped into the book, and it was read
// as a bug in the journal for a whole round.
//
// `PhotoMode.capture()` never had the problem because it renders and reads in
// the SAME task; measured against the real path, 4,246,826 bytes and a mean
// luma of 114.6. So: hook the render callback, read inside it, put the
// callback back. Same rule as `readPixels` — if you did not draw it in this
// task, it is not there.
await page.evaluate(() => new Promise((res) => {
  const cv = document.querySelector('canvas#gl');
  const e = window.__engine;
  const prev = e._render ?? null;               // setRenderCallback writes `_render`
  e.setRenderCallback((dt) => {
    prev?.(dt);
    window.__shot = cv.toDataURL('image/jpeg', 0.8);
    e.setRenderCallback(prev);
    res();
  });
}));
console.log('stand-in photo bytes:', await page.evaluate(() => window.__shot.length));
await page.waitForTimeout(500);
await page.screenshot({ path: `${dir}/1_wired.png` });

await page.evaluate(() => window.__j.open({ award: { id: 'waterfall', photoDataURL: window.__shot } }));
for (const [name, ms] of [['2_rise', 400], ['3_open', 900], ['4_cross', 900], ['5_done', 1400]]) {
  await page.waitForTimeout(ms);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

await page.evaluate(() => window.__j.close());
await page.waitForTimeout(1200);
await page.screenshot({ path: `${dir}/6_after.png` });

const state = await page.evaluate(() => {
  const r = window.__engine.renderer;
  return {
    autoClear: r.autoClear, target: r.getRenderTarget() === null,
    scissorTest: r.getScissorTest(), toneMapping: r.toneMapping,
    shadow: r.shadowMap.enabled,
    active: window.__j.active, wantsInput: window.__j.wantsInput,
    cues: window.__cues,
    fps: Math.round(1000 / (window.__engine._dtSmooth * 1000 || 1)),
  };
});
console.log('renderer state after close:', JSON.stringify(state));
console.log(errs.length ? 'ERRORS:\n  ' + errs.join('\n  ') : 'no console errors');
console.log('frames in', dir);
await browser.close();
