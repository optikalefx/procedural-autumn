// Sunlit-vs-shaded separation on IDENTICAL albedo.
//
// Captures the same posed view twice — once normally, once with the sun's cast
// shadow switched off (shadow.intensity = 0) — and compares the two frames at
// the pixels that changed. Those pixels are, by construction, the same surface
// with the same albedo under the same camera; the only difference is whether a
// cast shadow lands on them. So mean(lit) - mean(shaded) over that set is the
// separation the reference plates are measured against, with no albedo,
// weather or framing variance mixed in.
//
// ── WHY THIS FILE WAS REWRITTEN — 2026-08-22 ────────────────────────────────
//
// The version that set shadow.intensity = 0.44 had two holes, and both of them
// inflate the "shaded" side of the ratio it exists to report:
//
//   1. It let the engine RUN between the shadow-on and the shadow-off grab
//      (two __settle calls and ~1.5 s of wall clock). Every leaf card and grass
//      blade moved in between, so the per-pixel "lift" it sorts on is partly
//      foliage motion, and the most-shadowed decile fills up with pixels where
//      a leaf simply moved. Fix: freeze() — the engine is stopped and the SAME
//      instant is drawn twice, so the only difference between the two frames is
//      the shadow. Copied from tools/_scratch/shadowcrawl.mjs, which was built
//      around exactly this cancellation.
//   2. It had NO GROUND MASK — it took the lower 70% of the frame, which on
//      `hero` and `peaks` is mostly sky and distant massif. Fix: groundMask(),
//      also from shadowcrawl: terrain, grass, cover, rock and water only, built
//      with the cast shadow forced OFF so that ground inside a tree shadow is
//      not misfiled as canopy.
//
// Frozen and masked, the numbers move by up to 0.16 (`hero` 0.829 -> 0.667) and
// `hero`'s separation was out by a factor of two (0.099 -> 0.210). 0.44 still
// lands where the note in Lighting.js wants it, but do not quote the old table.
//
//   node tools/_scratch/sepdiag.mjs --views chase,drive,meadow --w 1280 --h 720
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const VIEWS = {
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  chase:     { anchor: 'road',     height: 22,  dist: 60,  pitch: -0.42, fov: 45, hour: 16.7, standOff: 43 },
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  river:     { anchor: 'river',    height: 6.0, dist: 30,  pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  waterfall: { anchor: 'waterfall',height: 11,  dist: 58,  pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  backlit:   { anchor: 'meadow',   height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
};

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1280'), 10), H = parseInt(arg('h', '720'), 10);
const RES = arg('res', null);
const NAMES = (arg('views', 'chase,drive,meadow')).split(',');

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
// --url, because a worktree runs its own dev server on its own port and this
// tool used to be pinned to 5178.
const URL = arg('url', process.env.AUTUMN_URL || 'http://localhost:5178');
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):\d+\/.*(token|vite)/, () => {});
await page.goto(URL + (RES ? `?res=${RES}` : ''), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

// Pin the tier and the resolution ladder — a run that walks its own pixel count
// mid-sequence is comparing two different renders.
await page.evaluate(() => {
  const e = window.__engine;
  if (e.adaptive !== undefined) e.adaptive = false;
  if (e._adapt) e._adapt = () => {};
  e.resolutionScale = 1;
});

const frozen = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};

const pose = async (v) => {
  await page.evaluate(async ({ v, frozen }) => {
    const THREE = window.__THREE, e = window.__engine, wd = window.__world;
    const api = window.__cameraAnchors || {};
    window.__lighting.hour = v.hour;
    window.__lighting.cycleSpeed = 0;
    window.__atmosphere.params.cloudShadow = 0;
    const anchor = frozen[v.anchor] ?? ((v.index && window.__anchorAt) ? window.__anchorAt(v.anchor, v.index) : (api[v.anchor] || api.vista)());
    let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
    if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
    const back = v.standOff ?? 0;
    const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
    const gy = wd.getHeight(gx, gz) + v.height;
    const pos = new THREE.Vector3(gx, gy, gz);
    const look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
    const g = wd.getHeight(pos.x, pos.z) + 1.4; if (pos.y < g) pos.y = g;
    e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
    e.camera.position.copy(pos); e.camera.lookAt(look);
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
  }, { v, frozen });
  // Settle to STABLE, not to a frame count: a world still streaming tiles in is
  // a different scene between one arm and the next.
  await page.evaluate(() => (window.__settleStable ?? window.__settle)?.(1500, 30));
  await page.waitForTimeout(900);
};

/** Stop the engine and pin the tree clock, so every arm sees one instant. */
const freeze = () => page.evaluate(() => {
  const e = window.__engine;
  e.stop();
  window.__frozenDraw = () => { if (e._render) e._render(0, e.elapsed); else e.renderer.render(e.scene, e.camera); };
  const u = window.__systems.trees.shared;
  u.uTime.value = 20;
  u.uWindStrength.value = 0.45; u.uWindDir.value.set(1, 0, 0);
  window.__frozenDraw(); window.__frozenDraw();
});

/** One frozen instant, captured with the cast shadow on and then off. */
const pair = async () => {
  await page.evaluate(() => window.__frozenDraw());
  const a = (await page.screenshot()).toString('base64');
  const keep = await page.evaluate(() => {
    const s = window.__lighting.sun.shadow, k = s.intensity;
    s.intensity = 0; window.__frozenDraw(); window.__frozenDraw(); return k;
  });
  const b = (await page.screenshot()).toString('base64');
  await page.evaluate((k) => { window.__lighting.sun.shadow.intensity = k; window.__frozenDraw(); }, keep);
  return { a, b };
};

/**
 * A GROUND mask for this pose. Identical to shadowcrawl.mjs's — including the
 * trap it documents: the mask is built with the cast shadow OFF, because hiding
 * the trees also removes the shadows they throw, and a ground pixel inside a
 * tree shadow would otherwise be classified as canopy and excluded. That would
 * drop precisely the pixels this measurement is about.
 */
const groundMask = async () => {
  const hide = (names, v) => page.evaluate(({ names, v }) => {
    for (const n of names) { const o = window.__engine.scene.getObjectByName(n); if (o) o.visible = v; }
    window.__frozenDraw(); window.__frozenDraw();
  }, { names, v });
  const GROUND = ['Terrain', 'TerrainApron', 'Grass', 'GroundCover', 'Rocks', 'Water', 'Waterfalls'];
  const keepI = await page.evaluate(() => {
    const s = window.__lighting.sun.shadow, k = s.intensity;
    s.intensity = 0; window.__frozenDraw(); window.__frozenDraw(); return k;
  });
  const base = (await page.screenshot()).toString('base64');
  await hide(['Trees'], false);
  const noTrees = (await page.screenshot()).toString('base64');
  await hide(GROUND, false);
  const skyOnly = (await page.screenshot()).toString('base64');
  await hide(GROUND, true); await hide(['Trees'], true);
  await page.evaluate((k) => { window.__lighting.sun.shadow.intensity = k; window.__frozenDraw(); }, keepI);
  return page.evaluate(async ({ base, noTrees, skyOnly }) => {
    const px = async (s) => {
      const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode();
      const c = new OffscreenCanvas(i.width, i.height), g = c.getContext('2d');
      g.drawImage(i, 0, 0);
      return { d: g.getImageData(0, 0, i.width, i.height).data, w: i.width, h: i.height };
    };
    const A = await px(base), T = await px(noTrees), S = await px(skyOnly);
    const n = A.w * A.h, m = new Uint8Array(n);
    const D = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    for (let k = 0; k < n; k++) {
      const i = k * 4;
      m[k] = (D(A.d, T.d, i) < 8 && D(T.d, S.d, i) > 8) ? 1 : 0;
    }
    window.__sepMask = m;
    let c = 0; for (let k = 0; k < n; k++) c += m[k];
    return +((c / n) * 100).toFixed(1);
  }, { base, noTrees, skyOnly });
};

const compare = async (p) => page.evaluate(async ({ a, b }) => {
  const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
  const ia = await load(a), ib = await load(b);
  const c = new OffscreenCanvas(ia.width, ia.height), g = c.getContext('2d');
  g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, ia.width, ia.height).data;
  g.clearRect(0, 0, ia.width, ia.height);
  g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, ia.width, ia.height).data;
  const L = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  const mask = window.__sepMask;
  // GROUND pixels only. No frame crop: the mask already excludes sky, canopy
  // and anything that is not terrain, grass, cover, rock or water.
  const lifts = [];
  const npx = ia.width * ia.height;
  for (let k = 0; k < npx; k++) {
    if (mask && !mask[k]) continue;
    const i = k * 4;
    lifts.push([L(db, i) - L(da, i), i]);
  }
  if (!lifts.length) return null;
  lifts.sort((p, q) => q[0] - p[0]);
  // The most-shadowed decile: real cast shadow, not penumbra. With the clock
  // frozen this decile is genuinely the deepest shade rather than the pixels
  // that happened to move.
  const n = Math.max(1, Math.floor(lifts.length * 0.10));
  let sumSh = 0, sumLit = 0, cr = 0, cg = 0, cb = 0;
  for (let k = 0; k < n; k++) {
    const i = lifts[k][1];
    sumSh += L(da, i); sumLit += L(db, i);
    cr += da[i]; cg += da[i + 1]; cb += da[i + 2];
  }
  const mx = Math.max(cr, cg, cb) / n, mn = Math.min(cr, cg, cb) / n;
  return {
    px: n,
    shaded: +(sumSh / n).toFixed(3),
    unshadowed: +(sumLit / n).toFixed(3),
    sep: +((sumLit - sumSh) / n).toFixed(3),
    ratio: +(sumSh / sumLit).toFixed(3),
    shadedHex: '#' + [cr / n, cg / n, cb / n].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''),
    shadedChroma: +((mx - mn) / 255).toFixed(3),
    medianLift: +lifts[Math.floor(lifts.length * 0.5)][0].toFixed(3),
  };
}, p);

// --set '[["label","js"],...]' runs the whole view list once per setting, in
// one page load. Settings are applied cumulatively, in order.
const SETS = JSON.parse(arg('set', '[["as-is","1"]]'));

console.log('All rows are over GROUND pixels only, at a FROZEN instant — see the header.');
console.log('setting        view       ground%  shaded  unshadowed  ratio  separation  shaded colour  chroma');
for (const [label, js] of SETS) {
  await page.evaluate((s) => eval(s), js);
  for (const name of NAMES) {
    const v = VIEWS[name]; if (!v) { console.log(`  (no view ${name})`); continue; }
    await pose(v);
    await page.evaluate((s) => eval(s), js);   // re-apply: a settle may have overwritten it
    await freeze();
    const gpct = await groundMask();
    const r = await compare(await pair());
    if (!r) { console.log(`${label.padEnd(14)} ${name.padEnd(10)} (no ground pixels)`); }
    else {
      console.log(`${label.padEnd(14)} ${name.padEnd(10)} ${String(gpct).padStart(7)}  ${String(r.shaded).padEnd(6)}  ${String(r.unshadowed).padEnd(10)}  ${String(r.ratio).padEnd(5)}  ${String(r.sep).padEnd(10)}  ${r.shadedHex}        ${r.shadedChroma}`);
    }
    await page.evaluate(() => window.__engine.start());
  }
}
await browser.close();
