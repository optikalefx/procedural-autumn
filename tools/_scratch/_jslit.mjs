#!/usr/bin/env node
/**
 * Who owns the bright line down the front hinge of the closed book?
 *
 * Guessing from a screenshot is how the last three "obvious" journal bugs got
 * mis-diagnosed. This hides one mesh at a time in the real scene and reports
 * the mean luma of a thin column across the joint, so the answer is a number.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const base = arg('base', 'http://127.0.0.1:5199');

await acquire('jslit');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await page.goto(`${base}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240_000, polling: 250 });
await page.waitForFunction(() => window.__systems?.hud?.journal?.ready === true, null, { timeout: 120_000 });
await page.waitForTimeout(1200);

const rows = await page.evaluate(async () => {
  const j = window.__systems.hud.journal;
  const J = j._J;
  document.getElementById('pa-hud')?.classList.add('pa-journal');
  j.update = () => j._apply();
  j._visible = true; j._active = true; j._closing = false; j._script = null;
  Object.assign(j._pose, { lift: 1, scrim: 1, band: 0, leaf: 0, cover: 0 });
  j._apply();

  const cv = document.querySelector('canvas#gl');
  const rd = window.__engine.renderer;
  const gl = rd.getContext();
  const px = new Uint8Array(4);
  // A column of samples straight across the joint, read from the framebuffer
  // in the SAME task as the draw. Reading after the frame gets a cleared
  // buffer — that is the black-photograph trap one layer down.
  const scanFrame = () => new Promise((res) => {
    const prev = window.__engine._render;
    window.__engine.setRenderCallback((dt) => {
      prev?.(dt);
      const out = [];
      const H = gl.drawingBufferHeight;
      // MAX down the column, not the mean. The slit is one pixel wide and
      // BROKEN — it is an aliasing artefact — so averaging 20 rows dilutes it
      // into the noise and reports "no slit" on a frame that plainly has one.
      for (let x = 600; x < 700; x++) {
        let best = 0, rgb = [0, 0, 0];
        for (let y = 260; y < 740; y += 3) {
          gl.readPixels(x, H - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const l = (px[0] * 0.299 + px[1] * 0.587 + px[2] * 0.114) / 255;
          if (l > best) { best = l; rgb = [px[0], px[1], px[2]]; }
        }
        out.push([x, best, rgb]);
      }
      window.__engine.setRenderCallback(prev);
      res(out);
    });
  });

  const parts = {
    all: [],
    'no spine': [J.spine],
    'no front skin': [J.frontPivot.children[0]],
    'no front board': [J.frontPivot.children[1]],
    'no endpapers': [J.frontEndpaper, J.backEndpaper],
    'no headbands': j.book.userData.journal.root.children.filter((o) => o.material === J.mats.headband),
  };
  const res = {};
  for (const [name, hide] of Object.entries(parts)) {
    for (const m of hide) m.visible = false;
    const scan = await scanFrame();
    for (const m of hide) m.visible = true;
    // The brightest column in the strip, and where it is.
    let top = [0, 0, [0, 0, 0]];
    for (const r of scan) if (r[1] > top[1]) top = r;
    res[name] = { peakX: top[0], peakLuma: +top[1].toFixed(3), rgb: top[2],
      profile: scan.filter((r) => r[0] >= 630 && r[0] <= 665)
        .map(([x, v]) => `${x}:${v.toFixed(2)}`).join(' ') };
  }
  return res;
});
console.log(JSON.stringify(rows, null, 2));
await browser.close();
