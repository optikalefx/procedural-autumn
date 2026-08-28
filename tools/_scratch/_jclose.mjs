#!/usr/bin/env node
/**
 * The second zoom level — the print at 80% of the screen — and the one question
 * it exists to answer: HOW MANY SOURCE PIXELS ARE BEING STRETCHED OVER HOW MANY
 * SCREEN PIXELS.
 *
 *   node tools/_scratch/_jclose.mjs --dir /tmp/jclose
 *   node tools/_scratch/_jclose.mjs --dir /tmp/jclose --dpr 2
 *   node tools/_scratch/_jclose.mjs --dir /tmp/jclose --w 700 --h 1520   # phone
 *   node tools/_scratch/_jclose.mjs --dir /tmp/jclose --nopatch          # the A/B
 *
 * Three rules inherited from `_jcritic.mjs` / `_jstudy.mjs`, each of which cost
 * somebody a round:
 *  1. the REAL game on the REAL renderer — `_journal_lab.html` and `_jshot.mjs`
 *     build their context with `antialias: true` and the game's is false;
 *  2. Vite's HMR client neutered before any page script runs, or a peer's save
 *     reloads the page mid-run;
 *  3. Chromium on ANGLE/Metal, or the game runs under 1 fps and every
 *     state-dependent step silently reads the boot pose.
 *
 * ── and one rule of its own ────────────────────────────────────────────────
 * **The print in the book is a REAL PHOTOGRAPH taken by this game**, not the
 * gradient stand-in `_jstudy.mjs` seeds. The whole measurement is about what a
 * photograph looks like when it is magnified, and a synthetic bar chart has no
 * grain, no foliage and no JPEG ringing to lose. So this harness renders a
 * frame of the valley, puts it through `hunt_store`'s own `makeThumb` (512 px,
 * q 0.72 — the exact pipeline the shutter uses), writes it to
 * `localStorage['pa.hunt']` and RELOADS, so the book is built from a real sheet
 * the way it is on a returning player's second session.
 *
 * The frame is read INSIDE the render callback. From a fresh evaluate the
 * drawing buffer has already been presented and cleared and it comes back a
 * fully black JPEG — docs/JOURNAL_NOTES.md 6.
 *
 * The clicks are REAL pointer events at coordinates projected through the
 * journal's own camera, so the capture exercises `_rowAt` / `_onStudiedPrint`
 * and not a direct call to `study()`.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const has = (k) => argv.includes(`--${k}`);
const dir = arg('dir', '/tmp/jclose');
const base = arg('base', process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199');
const W = +arg('w', 1600), H = +arg('h', 900);
const DPR = +arg('dpr', 1);
const PICK = arg('pick', null);
const NOPATCH = has('nopatch');

mkdirSync(dir, { recursive: true });
await acquire('jclose');
const tag = NOPATCH ? 'nopatch_' : '';

const errs = [];
const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=metal',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--enable-webgl', '--disable-frame-rate-limit',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: DPR,
});
const page = await ctx.newPage();

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
});

page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (t.includes('VITE_POSTHOG_KEY')) return;
  errs.push('console: ' + t);
});

const boot = async () => {
  await page.goto(`${base}/?seed=20261018&car=camper`,
    { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => window.__ready === true, null,
    { timeout: 240_000, polling: 250 });
  await page.evaluate(() => {
    const e = window.__engine;
    if (e) { e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; }
    if (window.__ctx) window.__ctx.worldPaused = true;
  });
  await page.waitForTimeout(1200);
};

await boot();

// ── a real photograph, through the real downscale ───────────────────────────
const frame = await page.evaluate(() => new Promise((res) => {
  const cv = document.querySelector('canvas#gl');
  const e = window.__engine;
  const prev = e._render ?? null;
  e.setRenderCallback((dt) => {
    prev?.(dt);
    res({ url: cv.toDataURL('image/png'), w: cv.width, h: cv.height });
    e.setRenderCallback(prev);
  });
}));
console.log(`captured frame: ${frame.w}x${frame.h}, ${frame.url.length} bytes of PNG`);

const seeded = await page.evaluate(async (frame) => {
  // `makeThumb` is a pure function; the singleton trap that costs a run is
  // reaching `hunt` itself through a dynamic import (Vite's `?t=` hands back a
  // SECOND store). The sheet is written straight to localStorage instead.
  const { makeThumb, THUMB_MAX, THUMB_QUALITY } = await import('/src/game/hunt_store.js');
  const img = new Image();
  await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = frame.url; });
  const photo = makeThumb(img);
  const t = new Image();
  await new Promise((r) => { t.onload = r; t.src = photo; });
  const at = Date.now();
  const items = {};
  for (const id of ['deer', 'squirrel', 'raccoon', 'bear']) items[id] = { at, photo };
  localStorage.setItem('pa.hunt', JSON.stringify({ v: 1, items }));
  return { bytes: photo.length, w: t.width, h: t.height, THUMB_MAX, THUMB_QUALITY };
}, frame);
console.log(`stored print: ${seeded.w}x${seeded.h}, ${seeded.bytes} bytes ` +
            `(THUMB_MAX ${seeded.THUMB_MAX}, q ${seeded.THUMB_QUALITY})`);

// Reload so the book is built from the sheet rather than repainted into it.
await boot();

// ── open with the KEY, not with journal.open() ──────────────────────────────
// `journal.open()` bypasses `HUD.toggleJournal`, which is what puts the
// `pa-journal` class on and takes the driving chrome off the screen. A capture
// taken that way has a compass over the page and is a harness artifact.
await page.waitForFunction(() => window.__systems?.hud?.journal?.ready === true,
  null, { timeout: 120_000, polling: 200 });
await page.evaluate(async () => {
  window.__j = window.__systems.hud.journal;
  const M = await import('/src/journal/journal_model.js');
  window.__samplePage = M.samplePage;
});
if (NOPATCH) {
  // The A/B: the same click with the high-resolution patch defeated, so the
  // close look shows what the PAGE TEXTURE holds and nothing else.
  await page.evaluate(() => { window.__j._detailShow = function () { this._detailHide(); }; });
  console.log('detail patch DISABLED for this run');
}
await page.keyboard.press('j');
await page.waitForTimeout(3400);
console.log('journal active:', await page.evaluate(() => window.__j.active));

const shot = async (n) => {
  const p = `${dir}/${tag}${n}.png`;
  await page.screenshot({ path: p });
  return p;
};
const out = [await shot('c0_spread')];

/** Read the photographed rows on the open spread, with their screen boxes. */
const readRows = () => page.evaluate(async ({ W, H }) => {
  const { samplePage } = await import('/src/journal/journal_model.js');
  const j = window.__j;
  const v = j._from.clone();
  const boxOf = (mesh, b) => {
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      if (!samplePage(mesh, b.u + sx * b.w / 2, b.v + sy * b.h / 2, v)) return null;
      v.project(j.camera);
      return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
    });
    if (pts.some((p) => !p)) return null;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return {
      x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
      cx: +((Math.min(...xs) + Math.max(...xs)) / 2).toFixed(1),
      cy: +((Math.min(...ys) + Math.max(...ys)) / 2).toFixed(1),
      w: +((Math.max(...xs) - Math.min(...xs)) / W).toFixed(4),
      h: +((Math.max(...ys) - Math.min(...ys)) / H).toFixed(4),
    };
  };
  const s = Math.round(j._pose.leaf);
  const out = [];
  for (const idx of [2 * s - 1, 2 * s]) {
    const p = j._pages[idx];
    if (!p?.spec?.rows?.length) continue;
    const mesh = p.spec.verso ? j._J.pageLeft : j._J.pageRight;
    if (!mesh?.visible) continue;
    for (let r = 0; r < p.spec.rows.length; r++) {
      if (!p.spec.rows[r].done || !p.spec.rows[r].photo) continue;
      out.push({
        page: idx, row: r, id: p.spec.rows[r].id,
        src: p.spec.rows[r].photo.width,
        slot: boxOf(mesh, p.slotUV(r)), row_box: boxOf(mesh, p.rowUV(r)),
      });
    }
  }
  return out;
}, { W, H });

const found = await readRows();
if (!found.length) { console.error('no photographed rows on this spread'); process.exit(1); }
console.log('photographed rows:');
for (const r of found) {
  console.log(`  ${r.id.padEnd(10)} page ${r.page} row ${r.row}  source ${r.src}px  ` +
    `print ${r.slot.w}x${r.slot.h} of frame at (${r.slot.cx}, ${r.slot.cy})`);
}

/**
 * What the player is actually looking at.
 *
 * The emulsion is `cardW - 20` = 220 of the slot's 252 page pixels wide, so its
 * share of the print's screen box is 220/252. That is the rectangle the stored
 * photograph is stretched across, and the ratio of its width in DEVICE pixels
 * to the source's width is the honest magnification.
 */
const state = () => page.evaluate(async ({ W, H, DPR }) => {
  const { samplePage } = await import('/src/journal/journal_model.js');
  const j = window.__j;
  const S = j._study;
  if (!S) return { level: j.zoomLevel, k: j._studyK };
  const mesh = S.verso ? j._J.pageLeft : j._J.pageRight;
  const v = j._from.clone();
  const box = (b) => {
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      samplePage(mesh, b.u + sx * b.w / 2, b.v + sy * b.h / 2, v);
      v.project(j.camera);
      return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
    });
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    return {
      x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
      w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
    };
  };
  const slot = box(S.slot), row = box(S);
  const page = j._pages[S.page];
  const src = page.spec.rows[S.row].photo?.width ?? 0;
  const emulsionCss = slot.w * (220 / 252);
  return {
    level: j.zoomLevel,
    k: +j._studyK.toFixed(3),
    closeZ: +j._closeZ.toFixed(3),
    zoomNow: +j._zoomNow.toFixed(3),
    printW: +(slot.w / W).toFixed(4), printH: +(slot.h / H).toFixed(4),
    printCx: +((slot.x0 + slot.x1) / 2 / W).toFixed(3),
    printCy: +((slot.y0 + slot.y1) / 2 / H).toFixed(3),
    rowW: +(row.w / W).toFixed(4), rowH: +(row.h / H).toFixed(4),
    clip: {
      left: +slot.x0.toFixed(0), right: +(W - slot.x1).toFixed(0),
      top: +slot.y0.toFixed(0), bottom: +(H - slot.y1).toFixed(0),
    },
    // The magnification, both ways round.
    src,
    emulsionCss: +emulsionCss.toFixed(0),
    emulsionDevice: +(emulsionCss * DPR).toFixed(0),
    pageTexels: 220,
    fromPageTexture: +((emulsionCss * DPR) / 220).toFixed(2),
    fromSource: src ? +((emulsionCss * DPR) / src).toFixed(2) : null,
    detail: j._detail?.visible ? (j._detailInfo ?? null) : null,
    patchUp: !!j._detail?.visible,
    // What a 1:1 view would need from the store, which is the number the
    // integrator asked for.
    wantSrc: Math.round(emulsionCss * DPR),
    clipRect: { x: slot.x0, y: slot.y0, w: slot.w, h: slot.h },
  };
}, { W, H, DPR });

// ── level 1: the lean ───────────────────────────────────────────────────────
const target = found[PICK == null ? found.length - 1 : (+PICK % found.length)];
console.log(`\nclicking "${target.id}" at (${target.slot.cx}, ${target.slot.cy})`);
await page.mouse.move(target.slot.cx, target.slot.cy);
await page.waitForTimeout(120);
console.log('cursor over the print:',
  JSON.stringify(await page.evaluate(() => document.querySelector('canvas#gl').style.cursor)));
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(700);
out.push(await shot('c1_lean'));
const s1 = await state();
console.log('level 1 (lean):', JSON.stringify(s1));

// ── level 2: the close look ─────────────────────────────────────────────────
// NOT the middle of the frame. Leaning in centres the ROW, and a landscape
// print sits beside its line rather than over it — measured here, the print's
// centre is at 0.70 of the width while the row's is at 0.50. Clicking the
// middle of the screen is clicking the sentence, which correctly backs out one
// level, and cost this harness a run.
await page.mouse.move(s1.printCx * W, s1.printCy * H);
await page.waitForTimeout(120);
console.log('cursor on the print while leaning:',
  JSON.stringify(await page.evaluate(() => document.querySelector('canvas#gl').style.cursor)));
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(40);
out.push(await shot('c2_closing_mid'));
await page.waitForTimeout(700);
out.push(await shot('c3_close'));
const s2 = await state();
console.log('level 2 (close):', JSON.stringify(s2));

// ── the patch, in detail ────────────────────────────────────────────────────
// It is a quad the size of a hand held a millimetre off a page that is itself
// being sampled every frame, so when it goes wrong it goes invisible, and
// "invisible" has four different causes worth telling apart: an empty canvas,
// a quad off screen, a quad the wrong size, and a quad the depth test threw
// away because the lift went the wrong way down the page's normal.
const patch = await page.evaluate(({ W, H }) => {
  const j = window.__j;
  const m = j._detail;
  if (!m) return { mesh: null };
  const cv = j._detailTex?.image ?? null;
  let cover = null;
  if (cv) {
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let opaque = 0, any = 0, lum = 0;
    for (let i = 0; i < d.length; i += 4 * 37) {         // sparse probe
      any++;
      if (d[i + 3] > 250) { opaque++; lum += (d[i] + d[i + 1] + d[i + 2]) / 3; }
    }
    cover = {
      size: `${cv.width}x${cv.height}`,
      opaqueFrac: +(opaque / any).toFixed(3),
      meanLuma: opaque ? +(lum / opaque).toFixed(1) : 0,
    };
  }
  const p = m.position.clone().project(j.camera);
  // Where the placement thinks the print is, term by term.
  const S = j._study;
  const mesh = S.verso ? j._J.pageLeft : j._J.pageRight;
  const raw = j._from.clone();
  window.__samplePage(mesh, S.slot.u, S.slot.v, raw);

  const terms = {
    off: j._studyOff.toArray().map((v) => +v.toFixed(4)),
    root: j._bookRoot.position.toArray().map((v) => +v.toFixed(4)),
    rawSlot: raw.toArray().map((v) => +v.toFixed(4)),
    rawPlusOff: raw.clone().add(j._studyOff).toArray().map((v) => +v.toFixed(4)),
    uvPatch: j._detailUV, uvSlot: S.slot,
  };
  // Which way the page's normal points relative to the camera, at the patch.
  const n = m.getWorldDirection(j._from.clone());
  const toCam = j.camera.position.clone().sub(m.position).normalize();
  return {
    visible: m.visible,
    hasMap: !!m.material.map,
    pos: m.position.toArray().map((v) => +v.toFixed(4)),
    scale: [m.scale.x, m.scale.y].map((v) => +v.toFixed(4)),
    screen: [+((p.x * 0.5 + 0.5) * W).toFixed(0), +((-p.y * 0.5 + 0.5) * H).toFixed(0), +p.z.toFixed(4)],
    normalDotToCamera: +n.dot(toCam).toFixed(3),
    canvas: cover,
    terms,
  };
}, { W, H });
console.log('patch:', JSON.stringify(patch));

// Does it hold still? The scale is SOLVED every frame, so an oscillation would
// be a shimmer rather than an error message.
const settle = await page.evaluate(() => new Promise((res) => {
  const j = window.__j;
  const seen = [];
  let n = 0;
  const tick = () => {
    seen.push(+j._closeZ.toFixed(4));
    if (++n < 8) requestAnimationFrame(tick); else res(seen);
  };
  requestAnimationFrame(tick);
}));
console.log('closeZ over 8 frames:', JSON.stringify(settle));

// ── what the patch costs, with the raster FORCED ────────────────────────────
// Chromium defers 2D canvas raster, so a `performance.now()` either side of a
// draw measures command recording and nothing else — the trap
// docs/JOURNAL_NOTES.md 9 corrected a whole table for. `getImageData` on one
// pixel drains the queue; the probe itself costs about 2.3 ms on this machine
// and is measured here rather than assumed.
const cost = await page.evaluate(() => {
  const j = window.__j;
  const S = j._study;
  const p = j._pages[S.page];
  const flush = (cv) => cv.getContext('2d').getImageData(0, 0, 1, 1);
  const probe = document.createElement('canvas');
  probe.width = probe.height = 8;
  probe.getContext('2d').fillRect(0, 0, 8, 8);
  const t0 = performance.now(); flush(probe); const tProbe = performance.now() - t0;

  const t1 = performance.now();
  const patch = p.printPatch(S.row, 4.7);
  flush(patch.canvas);
  const tPatch = performance.now() - t1;

  const t2 = performance.now();
  p.paint();
  flush(p.canvas);
  const tPaint = performance.now() - t2;

  return {
    probeMs: +tProbe.toFixed(2),
    patchMs: +tPatch.toFixed(2),
    repaintMs: +tPaint.toFixed(2),
    patchPx: `${patch.canvas.width}x${patch.canvas.height}`,
    patchMB: +((patch.canvas.width * patch.canvas.height * 4) / 1e6).toFixed(1),
  };
});
console.log('cost (raster forced):', JSON.stringify(cost));

// A 1:1 crop of the print, so the upscale can be judged rather than described.
if (s2.clipRect) {
  const c = s2.clipRect;
  const clip = {
    x: Math.max(0, c.x), y: Math.max(0, c.y),
    width: Math.min(W - Math.max(0, c.x), c.w), height: Math.min(H - Math.max(0, c.y), c.h),
  };
  await page.screenshot({ path: `${dir}/${tag}c4_print_crop.png`, clip });
  out.push(`${dir}/${tag}c4_print_crop.png`);
  // And the middle of it, cropped tight, where the JPEG has nowhere to hide.
  await page.screenshot({
    path: `${dir}/${tag}c5_print_detail.png`,
    clip: {
      x: Math.max(0, clip.x + clip.width * 0.30), y: Math.max(0, clip.y + clip.height * 0.24),
      width: Math.min(420, clip.width * 0.40), height: Math.min(300, clip.height * 0.40),
    },
  });
  out.push(`${dir}/${tag}c5_print_detail.png`);
}

// ── back out, one level at a time ───────────────────────────────────────────
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
const e1 = await page.evaluate(() => ({ level: window.__j.zoomLevel, k: +window.__j._studyK.toFixed(2), active: window.__j.active }));
out.push(await shot('c6_escape_once'));
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
const e2 = await page.evaluate(() => ({ level: window.__j.zoomLevel, k: +window.__j._studyK.toFixed(2), active: window.__j.active }));
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
const e3 = await page.evaluate(() => ({ level: window.__j.zoomLevel, active: window.__j.active, visible: window.__j.visible }));
console.log('\nescape ladder:', JSON.stringify(e1), JSON.stringify(e2), JSON.stringify(e3));

// The leaf must have its own print back once the patch is down.
const restored = await page.evaluate(() => {
  const j = window.__j;
  return {
    detailFor: j._detailFor ?? null,
    hidden: j._pages.flatMap((p) => (p.spec.rows ?? []).filter((r) => r.hidePrint).map((r) => r.id)),
  };
});
console.log('after backing out:', JSON.stringify(restored));

// ── shut the book FROM the close look ───────────────────────────────────────
// The keys back out one level at a time, so this path only happens when the
// integrator calls `close()` — from the HUD toggle, or from a click on the book
// lying on the camp table. It is the one way a leaf could be left with its
// print hidden forever, so it is checked rather than reasoned about.
await page.keyboard.press('j');
await page.waitForTimeout(3200);
await page.mouse.move(target.slot.cx, target.slot.cy);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(600);
await page.mouse.move(s1.printCx * W, s1.printCy * H);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(600);
const beforeClose = await page.evaluate(() => window.__j.zoomLevel);
await page.evaluate(() => window.__j.close());
await page.waitForTimeout(900);
const afterClose = await page.evaluate(() => {
  const j = window.__j;
  return {
    level: j.zoomLevel, active: j.active, visible: j.visible,
    detailFor: j._detailFor ?? null, detailVisible: !!j._detail?.visible,
    hidden: j._pages.flatMap((p) => (p.spec.rows ?? []).filter((r) => r.hidePrint).map((r) => r.id)),
  };
});
console.log(`close() from level ${beforeClose}:`, JSON.stringify(afterClose));

console.log(errs.length ? '\nERRORS:\n  ' + errs.join('\n  ') : '\nno console errors');
console.log(out.join('\n'));
await browser.close();
