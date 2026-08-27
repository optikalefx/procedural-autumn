#!/usr/bin/env node
/**
 * _skyshots — how big is a planet in a photograph, really?
 *
 *   node tools/_scratch/_skyshots.mjs --dir /tmp/skyshots
 *
 * The hunt's sky items cannot answer to `MIN_SHARE`: you cannot walk closer to
 * Jupiter, so the only variable a photographer has is the focal length. This
 * measures what each of the eight objects in `src/game/sky_objects.js` actually
 * puts on a 1080-line frame at every stop of the two lenses and the eyepiece,
 * so the thresholds in `hunt_detect.js` come from frames rather than from
 * arithmetic.
 *
 * It measures the way `hunt_detect.js`'s header says everything in this feature
 * is measured — render the same pose TWICE, with the subject drawn and not
 * drawn, and take the changed pixels. Here "not drawn" is the sky's own
 * visibility uniforms zeroed (`uStarAmount`, `uMilkyWay`, `uMoonDiscI`,
 * `uMoonHaloI`), which is exactly the gate the shader itself draws the planets,
 * the galaxies and the moon behind. The world is paused for both frames.
 *
 * GPU args are not optional: without them Chromium runs this game under 1 fps
 * and every state-dependent step silently reads the boot pose.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPNG } from '../_pngread.mjs';
import { SKY_OBJECTS } from '../../src/game/sky_objects.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = resolve(arg('dir', '/tmp/skyshots'));
const HOUR = parseFloat(arg('hour', '23.0'));
const SEED = arg('seed', '20261018');
const W = 1920, H = 1080;
mkdirSync(OUT, { recursive: true });

// The instruments a player can point at the sky, as vertical field of view in
// degrees. The lens numbers are `cameraFovForFocal` at 16:9 (src/photo/
// lens_models.js); the eyepiece numbers are ScopeView's FOV_REST and FOV_MIN.
const STOPS = [
  { id: 'wide24',   fov: 45.8, note: '24 mm, the wide lens wide open' },
  { id: 'wide70',   fov: 16.5, note: '70 mm, the wide lens at its longest' },
  { id: 'scope18',  fov: 18.0, note: 'the eyepiece at rest' },
  { id: 'scope6',   fov: 6.0,  note: 'the eyepiece fully zoomed' },
  { id: 'tele200',  fov: 5.8,  note: '200 mm, the long lens wide' },
  { id: 'tele300',  fov: 3.87, note: '300 mm' },
  { id: 'tele400',  fov: 2.9,  note: '400 mm, the long lens at its longest' },
];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

// Neuter Vite's HMR client before any page script runs — peers edit this tree
// and a save would reload the page mid-run. Same stub as tools/shot.mjs.
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {},
               addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
});
page.on('pageerror', (e) => console.log('  [page error]', String(e)));

await page.goto(`${URL}/?seed=${SEED}&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
console.log('booted');

const setup = await page.evaluate(async ({ hour }) => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  window.__lighting.hour = hour;
  window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  window.__ctx.worldPaused = true;
  const hudRoot = window.__systems.hud?.root;
  if (hudRoot) hudRoot.style.display = 'none';

  // Stand on a high vista so nothing terrestrial is in the way, and look up.
  const a = window.__cameraAnchors.vista();
  const cam = window.__ctx.camera;
  cam.position.set(a.x, window.__world.getHeight(a.x, a.z) + 40, a.z);

  // The sky's own draw gate, patched once so a toggle survives the RAF loop:
  // Sky.update() rewrites these uniforms from SKY_STATE every frame.
  const sky = window.__sky;
  if (!sky.__killPatched) {
    const orig = sky.update.bind(sky);
    sky.update = (...args) => {
      orig(...args);
      if (window.__skyKill) {
        sky.uniforms.uStarAmount.value = 0;
        sky.uniforms.uMilkyWay.value = 0;
        sky.uniforms.uMoonDiscI.value = 0;
        sky.uniforms.uMoonHaloI.value = 0;
      }
    };
    sky.__killPatched = true;
  }
  window.__skyKill = false;
  await window.__settle(30);
  const md = window.__lighting.computeMoonDir(hour);
  return {
    moonDir: [md.x, md.y, md.z],
    eye: cam.position.toArray(),
  };
}, { hour: HOUR });
console.log('posed at', setup.eye.map((v) => v.toFixed(1)).join(', '),
            '  moonDir', setup.moonDir.map((v) => v.toFixed(3)).join(', '));

// Every SKY_STATE scalar that decides whether any of this is drawn, over the
// clock. Printed rather than assumed — the night gate is picked off this table.
const clock = await page.evaluate(async () => {
  const rows = [];
  const L = window.__lighting;
  const keep = L.hour;
  for (let h = 15; h <= 30.01; h += 0.25) {
    L.hour = h % 24;
    await window.__settle(2);
    // SKY_STATE is a module export, not on window: read it off the Sky's own
    // uniforms, which are written from it every frame.
    const u = window.__sky.uniforms;
    rows.push({
      hour: +(h % 24).toFixed(2),
      starAmount: +u.uStarAmount.value.toFixed(4),
      milkyWay: +u.uMilkyWay.value.toFixed(4),
      nightF: +u.uNightF.value.toFixed(4),
      moonDiscI: +u.uMoonDiscI.value.toFixed(4),
      cover: +(window.__systems.clouds?.uniforms?.uCover?.value ?? -1).toFixed(4),
    });
  }
  L.hour = keep;
  await window.__settle(4);
  return rows;
});
writeFileSync(resolve(OUT, 'clock.json'), JSON.stringify(clock, null, 1));
console.log('\nhour  starAmt  star^3   nightF  moonDisc  uCover');
for (const r of clock) {
  console.log(String(r.hour).padStart(5),
    r.starAmount.toFixed(4).padStart(8),
    (r.starAmount ** 3).toFixed(4).padStart(7),
    r.nightF.toFixed(3).padStart(8),
    r.moonDiscI.toFixed(4).padStart(9),
    r.cover.toFixed(4).padStart(7));
}

// ── the ladder ───────────────────────────────────────────────────────────────

/** Largest connected blob of changed pixels, and its bounding box. */
function blob(a, b, thresh = 10) {
  const { w, h, px: da } = a;
  const db = b.px;
  const on = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    const d = Math.abs(da[p] - db[p]) + Math.abs(da[p + 1] - db[p + 1]) + Math.abs(da[p + 2] - db[p + 2]);
    if (d > thresh) on[i] = 1;
  }
  let best = null;
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!on[i]) continue;
    let sp = 0, area = 0;
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    stack[sp++] = i; on[i] = 0;
    while (sp) {
      const j = stack[--sp];
      const x = j % w, y = (j / w) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && on[j - 1]) { on[j - 1] = 0; stack[sp++] = j - 1; }
      if (x < w - 1 && on[j + 1]) { on[j + 1] = 0; stack[sp++] = j + 1; }
      if (y > 0 && on[j - w]) { on[j - w] = 0; stack[sp++] = j - w; }
      if (y < h - 1 && on[j + w]) { on[j + w] = 0; stack[sp++] = j + w; }
    }
    if (!best || area > best.area) best = { area, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  return best ?? { area: 0, w: 0, h: 0 };
}

const rows = [];
for (const o of SKY_OBJECTS) {
  const dir = o.live ? setup.moonDir : [o.dir.x, o.dir.y, o.dir.z];
  for (const st of STOPS) {
    await page.evaluate(async ({ dir, fov }) => {
      const cam = window.__ctx.camera;
      cam.fov = fov;
      cam.updateProjectionMatrix();
      cam.lookAt(cam.position.x + dir[0] * 1000,
                 cam.position.y + dir[1] * 1000,
                 cam.position.z + dir[2] * 1000);
      cam.updateMatrixWorld(true);
      window.__skyKill = false;
      await window.__settle(6);
    }, { dir, fov: st.fov });
    const on = resolve(OUT, `${o.id}-${st.id}.png`);
    await page.screenshot({ path: on });
    await page.evaluate(async () => { window.__skyKill = true; await window.__settle(6); });
    const offP = resolve(OUT, `_off.png`);
    await page.screenshot({ path: offP });
    const bl = blob(readPNG(on), readPNG(offP));
    // Only the CENTRE half of the frame, so the star field elsewhere cannot be
    // mistaken for the subject. The subject is aimed at dead centre.
    const share = (2 * o.rad) / st.fov;
    rows.push({ id: o.id, stop: st.id, fov: st.fov, share: +share.toFixed(4),
                px: Math.round(share * 1080), blobArea: bl.area, blobW: bl.w, blobH: bl.h });
    console.log(`${o.id.padEnd(10)} ${st.id.padEnd(9)} fov ${String(st.fov).padStart(5)}  ` +
                `share ${share.toFixed(4)}  predicted ${String(Math.round(share * 1080)).padStart(5)} px  ` +
                `blob ${String(bl.area).padStart(7)} px  ${bl.w}x${bl.h}`);
  }
}
writeFileSync(resolve(OUT, 'rows.json'), JSON.stringify(rows, null, 1));
console.log('\nwrote', OUT);
await browser.close();
