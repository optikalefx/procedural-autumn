// TERMINATOR STATISTICS — the shadowed fraction and the lit/shade ratio.
//
// sepdiag.mjs answers "how deep is the deepest decile of shade". This answers
// the other half, which is the one the golden-hour complaint is actually about:
// HOW MUCH of the ground is in cast shadow, and how far below the lit ground
// does it sit. A frame where three quarters of the ground is nominally shadowed
// at 88% of the lit value has no terminator at all — there is no lit/shade
// pattern, just a uniformly bright field.
//
// Method is sepdiag's, unchanged and for its reasons: freeze the engine so the
// same instant is drawn twice, build the ground mask with the cast shadow OFF
// so ground inside a tree shadow is not misfiled as canopy, and take the
// per-pixel LIFT (shadow-off minus shadow-on) as the classifier. A ground pixel
// is SHADOWED when its lift clears the threshold; everything else is LIT.
//
//   node tools/_scratch/termstat.mjs --views meadow,drive --hours 12.5,18.25 \
//        --url http://127.0.0.1:5321 --seed 20261018
//
// --set '[["label","js"],...]' runs the whole matrix once per setting in one
// page load, exactly as sepdiag does.
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const VIEWS = {
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, standOff: 16 },
  chase:     { anchor: 'road',     height: 22,  dist: 60,  pitch: -0.42, fov: 45, standOff: 43 },
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58 },
  river:     { anchor: 'river',    height: 6.0, dist: 30,  pitch: -0.18, fov: 54, yawOffset: 0.42, index: 3 },
  sunlow:    { anchor: 'meadow',   height: 2.0, dist: 10,  pitch: 0.05,  fov: 56, faceSun: true },
};

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1280'), 10), H = parseInt(arg('h', '720'), 10);
const RES = arg('res', null), SEED = arg('seed', null);
const NAMES = (arg('views', 'meadow')).split(',');
const HOURS = (arg('hours', '18.25')).split(',').map(Number);
const THRESH = parseFloat(arg('thresh', '0.012'));

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
const qp = new URLSearchParams();
if (RES) qp.set('res', RES);
if (SEED) qp.set('seed', SEED);
const q = qp.toString();
const URL = arg('url', process.env.AUTUMN_URL || 'http://localhost:5178') + (q ? '?' + q : '');
console.log('# url', URL);
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):\d+\/.*(token|vite)/, () => {});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

await page.evaluate(() => {
  const e = window.__engine;
  if (e.adaptive !== undefined) e.adaptive = false;
  if (e._adapt) e._adapt = () => {};
  e.resolutionScale = 1;
});

const frozen = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};

const pose = async (v, hour) => {
  await page.evaluate(async ({ v, frozen, hour }) => {
    const THREE = window.__THREE, e = window.__engine, wd = window.__world;
    const api = window.__cameraAnchors || {};
    window.__lighting.hour = hour;
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
  }, { v, frozen, hour });
  await page.evaluate(() => (window.__settleStable ?? window.__settle)?.(1500, 30));
  await page.waitForTimeout(900);
};

const freeze = () => page.evaluate(() => {
  const e = window.__engine;
  e.stop();
  window.__frozenDraw = () => { if (e._render) e._render(0, e.elapsed); else e.renderer.render(e.scene, e.camera); };
  const u = window.__systems.trees.shared;
  u.uTime.value = 20;
  u.uWindStrength.value = 0.45; u.uWindDir.value.set(1, 0, 0);
  window.__frozenDraw(); window.__frozenDraw();
});

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

const stats = async (p, thresh) => page.evaluate(async ({ a, b, thresh }) => {
  const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
  const ia = await load(a), ib = await load(b);
  const c = new OffscreenCanvas(ia.width, ia.height), g = c.getContext('2d');
  g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, ia.width, ia.height).data;
  g.clearRect(0, 0, ia.width, ia.height);
  g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, ia.width, ia.height).data;
  const L = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  const mask = window.__sepMask;
  const npx = ia.width * ia.height;
  let nSh = 0, nLit = 0, sSh = 0, sLit = 0, nG = 0;
  let shR = 0, shG = 0, shB = 0, ltR = 0, ltG = 0, ltB = 0;
  for (let k = 0; k < npx; k++) {
    if (mask && !mask[k]) continue;
    const i = k * 4;
    nG++;
    const lift = L(db, i) - L(da, i);
    if (lift > thresh) { nSh++; sSh += L(da, i); shR += da[i]; shG += da[i + 1]; shB += da[i + 2]; }
    else { nLit++; sLit += L(da, i); ltR += da[i]; ltG += da[i + 1]; ltB += da[i + 2]; }
  }
  if (!nG) return null;
  const mSh = nSh ? sSh / nSh : 0, mLit = nLit ? sLit / nLit : 0;
  const hex = (r, gg, bb, n) => n ? '#' + [r / n, gg / n, bb / n].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') : '-';
  const chroma = (r, gg, bb, n) => n ? +((Math.max(r, gg, bb) - Math.min(r, gg, bb)) / n / 255).toFixed(3) : 0;
  return {
    shadFrac: +((nSh / nG) * 100).toFixed(1),
    shaded: +mSh.toFixed(3),
    lit: +mLit.toFixed(3),
    ratio: mLit ? +(mSh / mLit).toFixed(3) : 0,
    litOverShade: mSh ? +(mLit / mSh).toFixed(3) : 0,
    shadeHex: hex(shR, shG, shB, nSh), shadeChroma: chroma(shR, shG, shB, nSh),
    litHex: hex(ltR, ltG, ltB, nLit), litChroma: chroma(ltR, ltG, ltB, nLit),
  };
}, { ...p, thresh });

const SETS = JSON.parse(arg('set', '[["as-is","1"]]'));
console.log(`GROUND pixels only, frozen instant. A pixel is SHADOWED when its shadow-lift > ${THRESH}.`);
console.log('setting        view    hour   grnd%  shad%   shaded  lit     shade/lit  lit/shade  shadeHex  shChr  litHex   ltChr');
for (const [label, js] of SETS) {
  await page.evaluate((s) => eval(s), js);
  for (const name of NAMES) {
    const v = VIEWS[name]; if (!v) { console.log(`  (no view ${name})`); continue; }
    for (const hour of HOURS) {
      await pose(v, hour);
      await page.evaluate((s) => eval(s), js);
      await freeze();
      const gpct = await groundMask();
      const r = await stats(await pair(), THRESH);
      if (!r) console.log(`${label.padEnd(14)} ${name.padEnd(7)} ${String(hour).padEnd(6)} (no ground pixels)`);
      else console.log(
        `${label.padEnd(14)} ${name.padEnd(7)} ${String(hour).padEnd(6)} ${String(gpct).padStart(5)}  ` +
        `${String(r.shadFrac).padStart(5)}  ${String(r.shaded).padEnd(6)}  ${String(r.lit).padEnd(6)}  ` +
        `${String(r.ratio).padEnd(9)}  ${String(r.litOverShade).padEnd(9)}  ${r.shadeHex}   ${String(r.shadeChroma).padEnd(5)}  ${r.litHex}  ${r.litChroma}`);
      await page.evaluate(() => window.__engine.start());
    }
  }
}
await browser.close();
