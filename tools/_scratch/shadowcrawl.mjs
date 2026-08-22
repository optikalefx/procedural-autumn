#!/usr/bin/env node
// Does the CAST SHADOW crawl, and which object is moving it?
//
// The trap this tool exists to avoid is the one docs/CRITIC_PROTOCOL.md lists
// five times: differencing two consecutive frames and calling the answer
// "shadow flicker". Consecutive frames of this game differ by every leaf, every
// blade of grass and every ripple, and all of that motion is wanted. A number
// taken off |A_t - A_t+1| is a number about foliage.
//
// So the shadow's own contribution is extracted first. At each step the SAME
// frozen instant is rendered twice — once normally, once with
// `sun.shadow.intensity = 0` — and
//
//     S_t = luma(A_t) - luma(B_t)
//
// is, by construction, what the cast shadow is worth at that pixel: identical
// camera, identical wind phase, identical everything else. Leaves waving in the
// LIT frame appear in both A and B and cancel exactly. The crawl figure is then
//
//     |S_t - S_t+1|
//
// which can only be non-zero if the shadow itself moved.
//
// Two modes, because the two candidate causes need different stimuli:
//
//   --mode wind   camera and shadow focus pinned, only the clock advances.
//                 Anything that moves here is a caster moving in the depth
//                 pass — the leaf cards' windSway/leafFlutter, which
//                 tree_material.js applies in LEAF_DEPTH_VERT as well.
//   --mode move   the clock pinned, the shadow FOCUS walked forward a few
//                 metres a step (Lighting.update's second argument, which is
//                 the only thing in the scene it feeds). The camera does not
//                 move, so the frame is otherwise bit-identical and any delta
//                 is the shadow map re-fitting: the extent ramp, the texel
//                 snap, the biases derived from texel width.
//
// Both report the same three columns so they are directly comparable:
//   shadowPx   % of frame the cast shadow is worth anything at (|S| > 0.02)
//   crawl%     % of FRAME pixels whose S changed by more than --thr
//   crawlIn%   the same count as a share of the shadow's own pixels
// plus `leafRef%`, the naive |B_t - B_t+1| number, which is the measurement
// this tool refuses to report as the answer — it is here so the difference
// between the two is visible in one table.
//
//   node tools/_scratch/shadowcrawl.mjs --url http://127.0.0.1:5206 \
//     --views chase,drive --mode wind --steps 5
//   node tools/_scratch/shadowcrawl.mjs --mode move --step 1.5 \
//     --set '[["as-is","1"],["no leaf cast","window.__noLeafCast()"]]'
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

// Copied, not imported: tools/shot.mjs runs its capture on import. Keep in step
// with the table there.
const VIEWS = {
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  chase:     { anchor: 'road',     height: 22,  dist: 60,  pitch: -0.42, fov: 45, hour: 16.7, standOff: 43 },
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  river:     { anchor: 'river',    height: 6.0, dist: 30,  pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
};

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1280'), 10), H = parseInt(arg('h', '720'), 10);
const RES = arg('res', null);
const NAMES = arg('views', 'chase,drive,meadow').split(',');
const MODE = arg('mode', 'wind');
const STEPS = parseInt(arg('steps', '5'), 10);
const STEP_M = parseFloat(arg('step', '1.5'));
const THR = parseFloat(arg('thr', '0.02'));
const URL = (arg('url', process.env.AUTUMN_URL || 'http://localhost:5178')) + (RES ? `?res=${RES}` : '');
const SETS = JSON.parse(arg('set', '[["as-is","1"]]'));

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    }
    return new R(u, p);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

// Pin the tier and the resolution ladder — a run that walks its own pixel count
// mid-sequence reports a resolution change as shadow crawl.
await page.evaluate(() => {
  const e = window.__engine;
  if (e.adaptive !== undefined) e.adaptive = false;
  if (e._adapt) e._adapt = () => {};
  e.resolutionScale = 1;
  // A convenience the --set strings use.
  window.__noLeafCast = () => {
    const t = window.__systems.trees;
    for (const m of t.meshes) if (m.material === t.leafNear?.mat || m.material === t.leafMid?.mat) m.castShadow = false;
    return 'leaf casting off';
  };
});

const frozen = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};

const pose = async (v) => {
  await page.evaluate(async ({ v, frozen }) => {
    const THREE = window.__THREE, e = window.__engine, wd = window.__world;
    const api = window.__cameraAnchors || {};
    window.__lighting.hour = v.hour;
    window.__lighting.cycleSpeed = 0;
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
    window.__crawlYaw = yaw;
    window.dispatchEvent(new Event('resize'));
  }, { v, frozen });
  // Settle to STABLE, not to a frame count. A world still streaming tiles in
  // produces frame-to-frame differences that have nothing to do with shadows,
  // and this tool's whole output is a frame-to-frame difference. (The engine is
  // stopped for every measured pair as well, so nothing can stream between the
  // two halves of a pair either — but the pose has to start from a settled
  // world or the FIRST pair is of a different scene from the second.)
  await page.evaluate(() => (window.__settleStable ?? window.__settle)?.(1500, 30));
  await page.waitForTimeout(900);
};

const freeze = () => page.evaluate(() => {
  const e = window.__engine;
  e.stop();
  window.__frozenDraw = () => { if (e._render) e._render(0, e.elapsed); else e.renderer.render(e.scene, e.camera); };
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
 * A GROUND mask for this pose, built once per cell while the clock is frozen.
 *
 * Without it the number is mostly about canopy. `drive` is two thirds leaf
 * cards, and a leaf card that moves in the beauty pass samples a different
 * texel of an otherwise perfectly stable shadow map, so it registers as shadow
 * change — true, but it is the canopy simmering, not the ground crawling, and
 * the player's complaint is explicitly about ground seen from a distance.
 *
 * Two extra frozen captures:
 *   noTrees   Trees hidden. A pixel that changes is a tree pixel.
 *   skyOnly   every ground-forming group hidden as well. A pixel that does NOT
 *             change between those two is sky.
 * ground = not a tree pixel AND not sky.
 */
const groundMask = async () => {
  const hide = (names, v) => page.evaluate(({ names, v }) => {
    for (const n of names) { const o = window.__engine.scene.getObjectByName(n); if (o) o.visible = v; }
    window.__frozenDraw(); window.__frozenDraw();
  }, { names, v });
  const GROUND = ['Terrain', 'TerrainApron', 'Grass', 'GroundCover', 'Rocks', 'Water', 'Waterfalls'];
  // The cast shadow is OFF for the whole mask build, and this is the trap that
  // makes the mask worth building carefully. Hiding the trees also removes the
  // shadows they throw, so a ground pixel inside a tree shadow changes when the
  // trees go — and would be classified as canopy. The mask would then exclude
  // precisely the pixels the measurement is about, and report a small, clean,
  // meaningless number.
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
    window.__crawlMask = m;
    let c = 0; for (let k = 0; k < n; k++) c += m[k];
    return +((c / n) * 100).toFixed(1);
  }, { base, noTrees, skyOnly });
};

/**
 * Compare two frozen pairs. Everything is done in the page so the pixels never
 * cross the wire.
 */
const compare = (p0, p1, thr) => page.evaluate(async ({ p0, p1, thr }) => {
  const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
  const px = async (s) => {
    const im = await load(s);
    const c = new OffscreenCanvas(im.width, im.height), g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    return { d: g.getImageData(0, 0, im.width, im.height).data, w: im.width, h: im.height };
  };
  const A0 = await px(p0.a), B0 = await px(p0.b), A1 = await px(p1.a), B1 = await px(p1.b);
  const L = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  const npx = A0.w * A0.h;
  const mask = window.__crawlMask;
  let n = 0, shadowPx = 0, crawl = 0, crawlIn = 0, leaf = 0, sumAbs = 0;
  for (let k = 0; k < npx; k++) {
    if (mask && !mask[k]) continue;          // ground only
    n++;
    const i = k * 4;
    const s0 = L(B0.d, i) - L(A0.d, i);     // positive: the shadow darkens here
    const s1 = L(B1.d, i) - L(A1.d, i);
    const inShadow = s0 > 0.02 || s1 > 0.02;
    if (inShadow) shadowPx++;
    const dS = Math.abs(s1 - s0);
    sumAbs += dS;
    if (dS > thr) { crawl++; if (inShadow) crawlIn++; }
    if (Math.abs(L(B1.d, i) - L(B0.d, i)) > thr) leaf++;
  }
  n = Math.max(n, 1);
  return {
    shadowPct: +((shadowPx / n) * 100).toFixed(2),
    crawlPct: +((crawl / n) * 100).toFixed(2),
    crawlInPct: shadowPx ? +((crawlIn / shadowPx) * 100).toFixed(2) : 0,
    meanDelta: +(sumAbs / n).toFixed(5),
    leafRefPct: +((leaf / n) * 100).toFixed(2),
  };
}, { p0, p1, thr });

console.log(`mode=${MODE} steps=${STEPS} thr=${THR} ${MODE === 'move' ? `step=${STEP_M} m` : 'dt=250 ms'}`);
console.log('All columns are over GROUND pixels only (terrain, grass, cover, rock),');
console.log('never canopy or sky — see groundMask().');
console.log('setting              view      ground%  shadow%   crawl%  crawlIn%  meanD    leafRef%');
for (const [label, js] of SETS) {
  await page.evaluate((s) => eval(s), js);
  for (const name of NAMES) {
    const v = VIEWS[name]; if (!v) { console.log(`  (no view ${name})`); continue; }
    await pose(v);
    await page.evaluate((s) => eval(s), js);   // re-apply: a settle may have overwritten it
    await freeze();
    if (MODE !== 'move') {
      await page.evaluate(() => {
        const u = window.__systems.trees.shared;
        u.uTime.value = window.__crawlT = 20;
        u.uWindStrength.value = 0.45; u.uWindDir.value.set(1, 0, 0);
        window.__frozenDraw(); window.__frozenDraw();
      });
    }
    const gpct = await groundMask();
    const acc = [];
    let prev = await pair();
    for (let s = 1; s <= STEPS; s++) {
      if (MODE === 'move') {
        // Clock frozen. Walk only the shadow focus, which is Lighting.update's
        // second argument and reaches nothing else in the scene.
        await page.evaluate(({ d }) => {
          const c = window.__engine.camera, y = window.__crawlYaw;
          window.__crawlOff = (window.__crawlOff ?? 0) + d;
          const f = c.position.clone();
          f.x += Math.sin(y) * window.__crawlOff;
          f.z += Math.cos(y) * window.__crawlOff;
          window.__lighting.update(0, f);
          window.__frozenDraw();
        }, { d: STEP_M });
      } else {
        // The tree clock, stepped by hand rather than by letting the engine run.
        //
        // Letting it run is what the first version did and the arms were not
        // comparable: `Trees.update` recomputes uWindStrength every frame from
        // a slow gust envelope (0.34 … 0.54, a 1.6x range) and drifts uWindDir,
        // so the second arm of a sweep sees a different wind from the first.
        // Measured: the same "as-is" configuration came back at crawl 2.97% and
        // then, one arm later, the naive leaf-motion control had DOUBLED — on a
        // change that cannot reach it. Pinning strength, direction and the time
        // step makes every arm see the identical gust.
        await page.evaluate(({ dt, str }) => {
          const u = window.__systems.trees.shared;
          u.uTime.value = (window.__crawlT ??= 20) + dt;
          window.__crawlT = u.uTime.value;
          u.uWindStrength.value = 0.45;
          u.uWindDir.value.set(1, 0, 0);
          eval(str);
          window.__frozenDraw(); window.__frozenDraw();
        }, { dt: 0.25, str: js });
      }
      const cur = await pair();
      acc.push(await compare(prev, cur, THR));
      prev = cur;
    }
    const mean = (k) => +(acc.reduce((a, r) => a + r[k], 0) / acc.length).toFixed(3);
    console.log(`${label.padEnd(20)} ${name.padEnd(9)} ${String(gpct).padStart(7)}  ${String(mean('shadowPct')).padStart(7)}  ${String(mean('crawlPct')).padStart(7)}  ${String(mean('crawlInPct')).padStart(8)}  ${String(mean('meanDelta')).padStart(7)}  ${String(mean('leafRefPct')).padStart(8)}`);
    // Reset both walkers so every (setting, view) cell starts from the same
    // wind phase and the same shadow focus.
    await page.evaluate(() => { window.__crawlOff = 0; window.__crawlT = 20; window.__engine.start(); });
  }
}
await browser.close();
