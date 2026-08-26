#!/usr/bin/env node
/**
 * Leaning in on one entry: does the click land, does the move read, and how big
 * is the row when it gets there.
 *
 *   node tools/_scratch/_jstudy.mjs --dir /tmp/jstudy
 *   node tools/_scratch/_jstudy.mjs --dir /tmp/jstudy --w 700 --h 1520   # phone
 *
 * Same three rules as `_jcritic.mjs`, for the same reasons:
 *  1. the REAL game on the REAL renderer. `_journal_lab.html` and `_jshot.mjs`
 *     both build their context with `antialias: true` and the game's is false,
 *     so neither can show what this actually looks like;
 *  2. Vite's HMR client neutered before any page script runs;
 *  3. Chromium on ANGLE/Metal, or the game runs under 1 fps and every
 *     state-dependent step silently reads the boot pose.
 *
 * It prefers `window.__systems.hud.journal` — the real wiring — and falls back
 * to constructing a Journal against `window.__ctx` and chaining it behind
 * `postfx.render` itself, which is what `_jingame.mjs` does. The fallback is
 * not cosmetic: while a peer is mid-change in `src/ui/`, `HUD.init` can throw
 * and take `hud.journal` with it, and the journal is still perfectly testable.
 *
 * The clicks are REAL pointer events at coordinates computed by projecting the
 * print's own slot through the journal's camera — i.e. the capture exercises
 * `_rowAt`'s picking, not a direct call to `study()`.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const dir = arg('dir', '/tmp/jstudy');
const base = arg('base', 'http://127.0.0.1:5199');
const W = +arg('w', 1600), H = +arg('h', 900);
// Which photographed row to click, as an index into the list printed below.
// The default is the last, which is on the RIGHT-hand page; 0 is on the left,
// and the two go through different meshes (`pageRight` / `pageLeft`) and
// different u-flips, so both are worth a run.
const PICK = arg('pick', null);

mkdirSync(dir, { recursive: true });
await acquire('jstudy');

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
  // ── the sheet is SEEDED, not awarded ────────────────────────────────────
  // Written straight into `localStorage['pa.hunt']` before any module runs,
  // which is the rule `_jcritic.mjs`'s header states and which cost this
  // harness two runs to relearn: reaching `hunt` with a dynamic `import()` from
  // an evaluate hands back a SECOND instance of the singleton whenever Vite has
  // stamped `?t=` on the module — and it always has, mid-edit. Every award went
  // into that second store and the book, reading the first one, came up empty.
  //
  // Four items, on two facing pages, so the pick has to choose between them.
  // The stand-in print is generated here rather than captured, because this
  // runs before there is a frame to capture: a 96x72 gradient is enough to see
  // that a print is a print at study framing, and `hunt_store` only requires
  // that it starts with `data:`.
  try {
    localStorage.removeItem('pa.hunt');
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 72;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 96, 72);
    grd.addColorStop(0, '#e8b25a'); grd.addColorStop(0.6, '#4d6b3f'); grd.addColorStop(1, '#243248');
    g.fillStyle = grd; g.fillRect(0, 0, 96, 72);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 5; i++) g.fillRect(8 + i * 17, 40 + (i % 3) * 6, 10, 22);
    const photo = cv.toDataURL('image/jpeg', 0.8);
    const at = Date.now();
    const items = {};
    for (const id of ['deer', 'squirrel', 'raccoon', 'bear']) items[id] = { at, photo };
    localStorage.setItem('pa.hunt', JSON.stringify({ v: 1, items }));
  } catch { /* first load */ }
});

page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (t.includes('VITE_POSTHOG_KEY')) return;
  if (t.includes('[system:hud]')) return;          // a peer's in-progress HUD
  errs.push('console: ' + t);
});

await page.goto(`${base}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240_000, polling: 250 });
await page.evaluate(() => {
  const e = window.__engine;
  if (e) { e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; }
  // Pause the world before anything is measured off a frame.
  if (window.__ctx) window.__ctx.worldPaused = true;
});
await page.waitForTimeout(1200);

// A stand-in photograph, rendered and read IN THE SAME TASK. Read from a fresh
// evaluate the drawing buffer has already been cleared and it comes back a
// fully black JPEG — see docs/JOURNAL_NOTES.md 6.
const photo = await page.evaluate(() => new Promise((res) => {
  const cv = document.querySelector('canvas#gl');
  const e = window.__engine;
  const prev = e._render ?? null;
  e.setRenderCallback((dt) => {
    prev?.(dt);
    res(cv.toDataURL('image/jpeg', 0.82));
    e.setRenderCallback(prev);
  });
}));
console.log('stand-in photo bytes:', photo.length);

const wiring = await page.evaluate(async (photo) => {
  const hudJ = window.__systems?.hud?.journal;
  if (hudJ) { window.__j = hudJ; }
  else {
    const M = await import('/src/journal/Journal.js');
    const j = window.__j = new M.Journal(window.__ctx);
    const fx = window.__postfx, e = window.__engine;
    e.setRenderCallback((dt) => { fx.render(dt); j.update(dt); j.render(e.renderer); });
  }
  return { real: !!hudJ };
}, photo);
console.log('wiring:', JSON.stringify(wiring));

// The book has to be READY before the store is touched. `Journal` subscribes to
// `hunt.onChange` at the very end of `_prepare`, and that subscription is the
// only thing that sets `_storeDirty` — award before it exists and `open()` has
// no reason to repaint, so every row comes up un-struck with no print on it and
// there is nothing to click. Two runs were lost to this.
await page.waitForFunction(() => window.__j?.ready === true, null, { timeout: 120_000, polling: 200 });
await page.evaluate(() => window.__j.open());
await page.waitForTimeout(3200);

const shot = async (n) => { await page.screenshot({ path: `${dir}/${n}.png` }); return `${dir}/${n}.png`; };
const out = [await shot('s0_spread')];

/**
 * Where a row's print is on screen, and how big its whole row is — both read
 * through `samplePage`, the same function the picking uses, so this measures
 * the surface that is actually being clicked rather than a second model of it.
 * `w`/`h` are the screen bounding box as a fraction of the viewport, which is
 * the pair `STUDY_ZOOM` is tuned on.
 */
const rows = await page.evaluate(async ({ W, H }) => {
  // `three` is a bare specifier and Vite only rewrites those in modules it
  // transforms — an evaluate is not one, so it cannot be imported here. The
  // journal already holds scratch vectors of the right classes; clone those.
  const { samplePage } = await import('/src/journal/journal_model.js');
  const j = window.__j;
  const s = Math.round(j._pose.leaf);
  const v = j._from.clone();
  const project = (mesh, u, vv) => {
    if (!samplePage(mesh, u, vv, v)) return null;
    v.project(j.camera);
    return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
  };
  const boxOf = (mesh, b) => {
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
      .map(([sx, sy]) => project(mesh, b.u + sx * b.w / 2, b.v + sy * b.h / 2));
    if (pts.some((p) => !p)) return null;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return {
      cx: +((Math.min(...xs) + Math.max(...xs)) / 2).toFixed(1),
      cy: +((Math.min(...ys) + Math.max(...ys)) / 2).toFixed(1),
      w: +((Math.max(...xs) - Math.min(...xs)) / W).toFixed(3),
      h: +((Math.max(...ys) - Math.min(...ys)) / H).toFixed(3),
    };
  };
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
        slot: boxOf(mesh, p.slotUV(r)), row_box: boxOf(mesh, p.rowUV(r)),
      });
    }
  }
  return out;
}, { W, H });

if (!rows.length) {
  console.log('debug:', JSON.stringify(await page.evaluate(() => {
    const j = window.__j;
    return {
      leaf: j._pose.leaf, cover: j._pose.cover, sheets: j._sheets,
      storeDirty: j._storeDirty,
      pages: j._pages.map((p, i) => ({
        i, kind: p.spec.kind, verso: p.spec.verso,
        rows: (p.spec.rows ?? []).map((r) => `${r.id}:${r.done ? 'done' : '-'}:${r.photo ? 'photo' : '-'}`),
      })),
      vis: { L: j._J.pageLeft.visible, R: j._J.pageRight.visible },
    };
  }), null, 1));
}
console.log('photographed rows on this spread:');
for (const r of rows) {
  console.log(`  ${r.id.padEnd(14)} page ${r.page} row ${r.row}` +
    `  print at (${r.slot.cx}, ${r.slot.cy})  ${r.slot.w}x${r.slot.h} of frame` +
    `  row ${r.row_box.w}x${r.row_box.h}`);
}
if (!rows.length) { console.error('no photographed rows found — nothing to click'); process.exit(1); }

// ── the click, and the move ─────────────────────────────────────────────────
const target = rows[PICK == null ? rows.length - 1 : (+PICK % rows.length)];
console.log(`clicking the print on "${target.id}" at (${target.slot.cx}, ${target.slot.cy})`);
await page.mouse.move(target.slot.cx, target.slot.cy);
await page.waitForTimeout(120);
const cursor = await page.evaluate(() => document.querySelector('canvas#gl').style.cursor);
console.log('cursor over the print:', JSON.stringify(cursor));
out.push(await shot('s1_hover'));

await page.mouse.down(); await page.mouse.up();
for (const [n, ms] of [['s2_lean_100ms', 100], ['s3_lean_220ms', 120], ['s4_leaned', 500]]) {
  await page.waitForTimeout(ms);
  out.push(await shot(n));
}

const framed = await page.evaluate(async ({ W, H }) => {
  const { samplePage } = await import('/src/journal/journal_model.js');
  const j = window.__j;
  const S = j._study;
  const mesh = S.verso ? j._J.pageLeft : j._J.pageRight;
  const v = j._from.clone();
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    samplePage(mesh, S.u + sx * S.w / 2, S.v + sy * S.h / 2, v);
    v.project(j.camera);
    return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
  });
  const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
  return {
    studyK: +j._studyK.toFixed(3),
    rowW: +((Math.max(...xs) - Math.min(...xs)) / W).toFixed(3),
    rowH: +((Math.max(...ys) - Math.min(...ys)) / H).toFixed(3),
    cx: +(((Math.min(...xs) + Math.max(...xs)) / 2) / W).toFixed(3),
    cy: +(((Math.min(...ys) + Math.max(...ys)) / 2) / H).toFixed(3),
    // How far off face-on the page still is, in degrees: the angle between the
    // page's normal and the direction from the camera to the row.
    tilt: (() => {
      const n = j._from.clone().set(0, 0, 1)
        .applyQuaternion(mesh.getWorldQuaternion(j._q0.clone()));
      const c = j._from.clone();
      samplePage(mesh, S.u, S.v, c);
      const d = c.clone().sub(j.camera.position).normalize();
      return +((Math.acos(Math.abs(n.dot(d))) * 180) / Math.PI).toFixed(1);
    })(),
  };
}, { W, H });
console.log('leaned in:', JSON.stringify(framed));

// Click again — anywhere — and it goes back.
await page.mouse.move(W * 0.5, H * 0.5);
await page.waitForTimeout(80);
console.log('cursor while leaning:',
  JSON.stringify(await page.evaluate(() => document.querySelector('canvas#gl').style.cursor)));
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(160);
out.push(await shot('s5_back_160ms'));
await page.waitForTimeout(500);
out.push(await shot('s6_spread_again'));
console.log('after the second click, studyK =',
  await page.evaluate(() => window.__j._studyK));

// Escape backs out one level at a time: spread, then shut.
await page.mouse.move(target.slot.cx, target.slot.cy);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(600);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const afterEsc = await page.evaluate(() => ({ k: window.__j._studyK, active: window.__j.active }));
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
const afterEsc2 = await page.evaluate(() => ({ k: window.__j._studyK, active: window.__j.active }));
console.log('escape once:', JSON.stringify(afterEsc), ' twice:', JSON.stringify(afterEsc2));
out.push(await shot('s7_closed'));
console.log('cursor after close:',
  JSON.stringify(await page.evaluate(() => document.querySelector('canvas#gl').style.cursor)));

console.log(errs.length ? 'ERRORS:\n  ' + errs.join('\n  ') : 'no console errors');
console.log(out.join('\n'));
await browser.close();
