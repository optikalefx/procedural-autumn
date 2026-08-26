#!/usr/bin/env node
/**
 * The journal, judged the way the critic judges it: in the REAL game, at
 * gameplay framing, through the REAL wiring (`__systems.hud.journal`).
 *
 * Why this exists next to `_jshot.mjs` and `_journal_lab.html`: both of those
 * draw the book on a renderer created with `antialias: true`, and the game's is
 * `antialias: false` (src/core/Engine.js — world AA is SMAA in the post chain).
 * So the lab page CANNOT show the aliasing blocker, and a capture taken there
 * is evidence for a frame nobody will ever see. Everything here goes through
 * the game's own renderer and the game's own HUD.
 *
 *   node tools/_scratch/_jcritic.mjs --dir /tmp/jc --mode beats
 *   node tools/_scratch/_jcritic.mjs --dir /tmp/jc --mode aspect
 *   node tools/_scratch/_jcritic.mjs --dir /tmp/jc --mode model     # posed stills
 *
 * Three traps this respects, each of which has cost somebody a round:
 *  1. Vite's HMR client is neutered before any page script runs — a peer saving
 *     a file mid-capture reloads the page and the run dies with "Execution
 *     context was destroyed" (the stub is lifted from tools/shot.mjs).
 *  2. Chromium is launched on ANGLE/Metal. Without it the game runs under 1 fps
 *     and every state-dependent step silently reads the boot pose while still
 *     returning plausible numbers.
 *  3. The hunt store is read from `localStorage['pa.hunt']`, never through a
 *     dynamic `import()` in an evaluate — Vite stamps `?t=` on hot-reloaded
 *     modules and you get a SECOND instance of the singleton.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };

const dir = arg('dir', '/tmp/jcritic');
const mode = arg('mode', 'beats');
const base = arg('base', 'http://127.0.0.1:5199');
const W = +arg('w', 1600), H = +arg('h', 900);
const AWARD = arg('award', 'waterfall');

mkdirSync(dir, { recursive: true });
await acquire('jcritic');

const errs = [];
const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=metal',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--enable-webgl', '--disable-frame-rate-limit',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return {
        readyState: 3, url, close() {}, send() {},
        addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {},
      };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
  // A clean sheet, set BEFORE any module runs. The alternative — reaching the
  // singleton with a dynamic import() from an evaluate — hands back a SECOND
  // instance whenever Vite has stamped `?t=` on the module.
  try { localStorage.removeItem('pa.hunt'); } catch { /* first load */ }
});

page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (t.includes('VITE_POSTHOG_KEY')) return;
  errs.push('console: ' + t);
});

await page.goto(`${base}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240_000, polling: 250 });
await page.evaluate(() => {
  const e = window.__engine;
  if (!e) return;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
});
await page.waitForFunction(() => window.__systems?.hud?.journal?.ready === true,
  null, { timeout: 120_000, polling: 200 });
await page.waitForTimeout(1500);

/**
 * A stand-in photograph taken the way PhotoMode does it: rendered and READ IN
 * THE SAME TASK. `_jingame.mjs` used to call `toDataURL` from a fresh evaluate,
 * which lands after the browser has cleared the drawing buffer (the context has
 * no `preserveDrawingBuffer`) and hands back a 12 kB fully black PNG. That
 * black photograph was the harness, not the product — see docs/JOURNAL_NOTES.md.
 */
async function grabPhoto() {
  return page.evaluate(() => new Promise((res) => {
    const cv = document.querySelector('canvas#gl');
    const e = window.__engine;
    const prev = e._render ?? null;   // Engine.setRenderCallback writes `_render`
    e.setRenderCallback((dt) => {
      prev?.(dt);
      // Same task as the draw: the buffer is still intact here.
      res(cv.toDataURL('image/jpeg', 0.82));
      e.setRenderCallback(prev);
    });
  }));
}

const shot = async (name) => {
  await page.screenshot({ path: `${dir}/${name}.png` });
  return `${dir}/${name}.png`;
};

const openAward = async (id) => {
  const photo = await grabPhoto();
  await page.evaluate(({ id, photo }) => {
    window.__systems.hud.openJournal({ id, photoDataURL: photo });
  }, { id, photo });
};

const out = [];

if (mode === 'beats') {
  await openAward(AWARD);
  const beats = [['b0_rise', 300], ['b1_cover', 500], ['b2_open', 700], ['b3_seek', 900],
    ['b4_cross', 700], ['b5_photo', 500], ['b6_done', 900], ['b7_rest', 1200]];
  for (const [n, ms] of beats) {
    await page.waitForTimeout(ms);
    out.push(await shot(n));
    const t = await page.evaluate(() => window.__systems.hud.journal._t);
    console.log(n, 'ceremony t =', t.toFixed(2));
  }
  // B6: the progress line. `spec.progress` was ALWAYS right — the bug was that
  // the canvas never got repainted — so the string is worthless as evidence.
  // Leaf back to page 1 and photograph it, and read the pixels of the band the
  // line is painted in as well.
  await page.evaluate(() => { window.__systems.hud.journal.leaf(-1); });
  await page.waitForTimeout(1200);
  out.push(await shot('b8_progress'));
  const prog = await page.evaluate(() => {
    const j = window.__systems.hud.journal;
    const p = j._pages.find((x) => x.spec.progress != null);
    // Straight off the page's own canvas: crop the progress band, then trim it
    // to the ink so the string can be eyeballed as an image if need be.
    const cv = document.createElement('canvas');
    cv.width = 700; cv.height = 60;
    cv.getContext('2d').drawImage(p.canvas, p._x0, 92 + 116, 700, 60, 0, 0, 700, 60);
    return { spec: p.spec.progress, band: cv.toDataURL('image/png').length };
  });
  console.log('progress:', JSON.stringify(prog));
} else if (mode === 'aspect') {
  // B4: the spread must survive a narrow window. The heading is the canary —
  // "Camp Scavenger Hunt" losing its first word is the measured failure.
  await page.evaluate(() => { window.__systems.hud.toggleJournal(); });
  await page.waitForTimeout(2600);
  for (const [w, h] of [[1600, 900], [1200, 900], [900, 1200], [800, 1160], [700, 1520], [1000, 750]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
    const ar = (w / h).toFixed(2);
    out.push(await shot(`ar_${ar}_${w}x${h}`));
    const fit = await page.evaluate(() => {
      const j = window.__systems.hud.journal;
      return { fov: +j.camera.fov.toFixed(2), z: +j.camera.position.z.toFixed(4) };
    });
    console.log(`aspect ${ar} (${w}x${h})`, JSON.stringify(fit));
  }
} else if (mode === 'model') {
  // Static poses, no script: the closed book (B3's slit lives here) and the
  // open spread (B2's spine ridge).
  await page.evaluate(() => {
    const j = window.__systems.hud.journal;
    document.getElementById('pa-hud')?.classList.add('pa-journal');
    // The HUD drives `update(dt)` every frame and, with no script, that walks
    // every pose value back to zero. Replace it with the apply half so a posed
    // still stays posed.
    j.update = () => j._apply();
    window.__jshow = (o) => {
      j._visible = true; j._active = true; j._closing = false; j._script = null;
      Object.assign(j._pose, { lift: 1, scrim: 1, band: 1, leaf: 0, cover: 0 }, o);
      j._apply();
    };
    // Yaw the BOOK, not `_bookRoot`: `_apply` rewrites the root's transform
    // every frame and a yaw written there is gone by the next one.
    window.__jyaw = (y, x = 0) => { j.book.rotation.set(x, y, 0); j._apply(); };
    // Dolly in for a detail plate. The camera never moves in the product, so
    // this is a harness-only lens on a real frame.
    window.__jzoom = (k, dy = 0) => {
      const p = j.camera.position;
      p.set(0, 0.255, 0.600).multiplyScalar(k);
      p.y += dy;
      j.camera.lookAt(0, -0.004, 0.005);
      j.camera.updateMatrixWorld(true);
    };
  });
  // [pose, book yaw, book pitch, camera dolly]
  const poses = [
    ['m0_closed', '{cover:0, band:0}', 0, 0, 1],
    ['m1_closed_hinge', '{cover:0, band:0}', 0.55, 0.05, 0.62],
    ['m2_closed_spine', '{cover:0, band:0}', 1.05, 0, 0.62],
    ['m3_ajar', '{cover:0.45}', 0, 0, 1],
    ['m4_spread', '{cover:1}', 0, 0, 1],
    ['m5_gutter', '{cover:1, leaf:1}', 0, 0, 0.52],
    ['m6_spread_leaf', '{cover:1, leaf:1.5}', 0, 0, 1],
    ['m7_hide', '{cover:0, band:0}', 0, 0, 0.42],
  ];
  for (const [n, o, yaw, pitch, k] of poses) {
    await page.evaluate(({ o, yaw, pitch, k }) => {
      window.__jzoom(k);
      window.__jyaw(yaw, pitch);
      window.__jshow(eval(`(${o})`));
    }, { o, yaw, pitch, k });
    await page.waitForTimeout(320);
    out.push(await shot(n));
  }
}

console.log(errs.length ? 'ERRORS:\n  ' + errs.join('\n  ') : 'no console errors');
console.log(out.join('\n'));
await browser.close();
