#!/usr/bin/env node
/**
 * Isolate the distance-silhouette hide treatment (wildlife author, scratch).
 *
 * `wlegib.mjs` differences a frame against the same frame with the animals
 * hidden, which is the right idea and, in practice, an unusable instrument:
 * the HUD fades in, the grass keeps blowing and the camper's suspension keeps
 * settling between the two renders, so the "animal" pixel count came back as
 * 58 000 in one view and 0 in three others. None of that was the animal.
 *
 * This renders the *identical* frame twice and changes exactly one thing —
 * the four uSil* uniforms — so the only pixels that can differ are hide
 * pixels. It then crops both around the deer and blows them up, because the
 * whole question is what a sixteen-pixel animal looks like and that cannot be
 * answered from a full frame on a screen.
 *
 *   node tools/_scratch/wsil.mjs --dist 77 --anchor meadow --index 0
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIST = parseFloat(arg('dist', '77'));
const HOUR = parseFloat(arg('hour', '16.7'));
const STATE = arg('state', 'alert');
const ANCHOR = arg('anchor', null);   // null = sweep every anchor kind
const INDEX = arg('index', null) === null ? -1 : parseInt(arg('index'), 10);
const CLEAR = parseFloat(arg('clear', '11'));
const argvExtreme = argv.includes('--extreme');
const W = 1170, H = 870;
const TAG = arg('tag', 'sil');
const DIR = resolve(`shots/wl/${TAG}ab`);

await acquire('wsil');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (/vite|token=/.test(String(url)) || String(protocols).includes('vite')) {
      return { readyState: 3, url, addEventListener(){}, removeEventListener(){}, send(){}, close(){},
               set onopen(_){}, set onmessage(_){}, set onclose(_){}, set onerror(_){} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto('http://localhost:5178?res=1024');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const info = await page.evaluate(async (P) => {
  const T = window.__THREE, e = window.__engine, W2 = window.__world;
  const wl = window.__systems.wildlife;
  window.__forceCamera = true;
  window.__lighting.hour = P.HOUR;
  e.stop();
  e.clock.getDelta = () => 1 / 60;

  const cam = e.camera;
  const ZOOM = 19, PITCH = 0.2145, FOV = 52;
  cam.fov = FOV; cam.updateProjectionMatrix();
  const ST = { idle: 0, graze: 1, wander: 2, alert: 3, flee: 4 };

  // Search for a framing that is actually a fair test, instead of trusting one
  // anchor. Three separate things went wrong at fixed anchors and each of them
  // produced a confident "the animal contributed zero pixels": the eye ended up
  // inside a hillside, a rise sat between the eye and the deer, and — after
  // clamping the eye above ground — the look-down angle threw the deer off the
  // top of the frame. So every candidate is checked for all three.
  const place = (a) => {
    const yaw = a.yaw ?? 0;
    const anchorY = W2.getHeight(a.x, a.z) + 1.05 + 0.0577 * 2.4;
    const cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    const ex = a.x - Math.sin(yaw) * ZOOM * cp;
    const ez = a.z - Math.cos(yaw) * ZOOM * cp;
    const ey = anchorY + ZOOM * sp;
    if (ey < W2.getHeight(ex, ez) + 1.6) return null;      // eye underground
    cam.position.set(ex, ey, ez);
    cam.lookAt(a.x, anchorY, a.z);
    cam.updateMatrixWorld(true);
    return { yaw, ey };
  };

  // --anchor/--index pins the search to one place. The automatic sweep is
  // convenient but it has no idea where the boulders are — `getHeight` is
  // terrain only, so it happily picked an alpine rock face and put the deer
  // behind it — so a framing that is known to work beats a clever search.
  const candidates = [];
  const kinds = P.ANCHOR ? [P.ANCHOR] : ['meadow', 'road', 'river', 'forest'];
  const idxs = P.ANCHOR && P.INDEX >= 0 ? [P.INDEX] : [0, 1, 2, 3, 4, 5];
  for (const k of kinds) {
    for (const i of idxs) {
      const a = window.__anchorAt(k, i);
      if (a) candidates.push({ k, i, a });
    }
  }

  const passing = [];
  for (const c of candidates) {
    const fr = place(c.a);
    if (!fr) continue;
    for (const off of [0, -14, 14, -28, 28, -42, 42]) {
      const fx = cam.position.x + Math.sin(fr.yaw) * P.DIST + Math.cos(fr.yaw) * off;
      const fz = cam.position.z + Math.cos(fr.yaw) * P.DIST - Math.sin(fr.yaw) * off;
      if (!W2.isInBounds(fx, fz) || W2.getWaterDepth(fx, fz) > 0.15) continue;
      if (wl._treeNear(fx, fz, P.CLEAR)) continue;

      // Must be in the middle of the picture, not clipped off an edge.
      const gy = W2.getHeight(fx, fz);
      const pv = new T.Vector3(fx, gy + 0.75, fz).project(cam);
      const sx = (pv.x * 0.5 + 0.5) * 1170, sy = (-pv.y * 0.5 + 0.5) * 870;
      if (pv.z > 1 || sx < 180 || sx > 990 || sy < 90 || sy > 780) continue;

      // Nothing solid in the way.
      let blocked = false;
      const ey = cam.position.y, ty = gy + 0.9;
      for (let t = 0.05; t < 0.97; t += 0.01) {
        const mx = cam.position.x + (fx - cam.position.x) * t;
        const mz = cam.position.z + (fz - cam.position.z) * t;
        if (W2.getHeight(mx, mz) > ey + (ty - ey) * t + 0.3) { blocked = true; break; }
        if (t > 0.12 && wl._treeNear(mx, mz, 1.2)) { blocked = true; break; }
      }
      if (blocked) continue;

      wl.debugClear();
      const s0 = wl.debugSpawn('deer', { x: fx, z: fz, clear: P.CLEAR, count: 2, state: ST[P.STATE] });
      if (!s0) continue;
      const g = wl.sites.live[s0.site];
      if (!g) continue;
      let n = 0;
      for (const m of g.members) {
        const px = fx + (n ? 4.5 : 0), pz = fz + (n ? 2.5 : 0); n++;
        m.brain.pos.set(px, W2.getHeight(px, pz), pz);
        m.brain.home.set(px, 0, pz);
        m.rig.reset(m.brain.pos, m.brain.heading, W2);
      }
      passing.push({ anchor: c.k, index: c.i, off, ax: c.a.x, az: c.a.z, fx, fz });
      wl.debugClear();
      break;
    }
  }
  if (!passing.length) return { error: 'no framing passed the checks' };

  // Geometry checks can only rule a framing out, never in: they know nothing
  // about boulders, and a rock face is what the free search picked last time.
  // So Node re-renders each survivor and keeps the first where toggling the
  // hide actually moves pixels — the animal proving its own visibility.
  window.__silApply = (idx) => {
    const c = passing[idx];
    const a2 = window.__anchorAt(c.anchor, c.index);
    place(a2);
    wl.debugClear();
    const s0 = wl.debugSpawn('deer', { x: c.fx, z: c.fz, clear: P.CLEAR, count: 2, state: ST[P.STATE] });
    if (!s0) return null;
    const g = wl.sites.live[s0.site];
    if (!g) return null;
    let n = 0;
    for (const m of g.members) {
      const px = c.fx + (n ? 4.5 : 0), pz = c.fz + (n ? 2.5 : 0); n++;
      m.brain.pos.set(px, W2.getHeight(px, pz), pz);
      m.brain.home.set(px, 0, pz);
      m.rig.reset(m.brain.pos, m.brain.heading, W2);
    }
    wl.debugThreat(a2.x, a2.z, 13);
    e.clock.getDelta = () => 1 / 60;
    for (let i = 0; i < 100; i++) e._loop();
    e.clock.getDelta = () => 0;
    const lead = g.members[0];
    const pp = lead.brain.pos;
    const vv = new T.Vector3(pp.x, pp.y + 0.75, pp.z).project(cam);
    const dd = Math.hypot(pp.x - cam.position.x, pp.z - cam.position.z);
    return { ...c, d: +dd.toFixed(1),
             px: +((1.5 / dd) / (2 * Math.tan((52 * Math.PI / 180) / 2)) * 870).toFixed(1),
             sx: Math.round((vv.x * 0.5 + 0.5) * 1170), sy: Math.round((-vv.y * 0.5 + 0.5) * 870) };
  };

  // Kill the HUD: it fades in on its own schedule, and in the first version of
  // this test it was the thing actually being measured — one view came back
  // with 58 000 "animal" pixels that were entirely the dashboard. Anything
  // that *contains* the renderer's canvas has to stay; hiding the canvas's own
  // wrapper is how this once returned a uniformly black frame.
  const canvas = e.renderer.domElement;
  for (const el of document.querySelectorAll('body *')) {
    if (el === canvas || el.contains(canvas)) continue;
    if (el.closest('canvas')) continue;
    el.style.display = 'none';
  }

  // Every hide material in the scene, so both renders are one code path.
  const mats = [];
  e.scene.traverse((n) => {
    const m = n.material;
    if (m && m.userData && m.userData.uniforms && m.userData.uniforms.uSilDark) mats.push(m.userData.uniforms);
  });
  window.__silMats = mats;
  window.__silSaved = mats.map((u) => ({ n: u.uSilNear.value, f: u.uSilFar.value, d: u.uSilDark.value, l: u.uSilFlat.value }));
  return { mats: mats.length, candidates: passing.length };
}, { DIST, HOUR, STATE, ANCHOR, INDEX, CLEAR, EXTREME: argvExtreme });

if (info.error) { console.log(JSON.stringify(info)); await browser.close(); process.exit(1); }
mkdirSync(DIR, { recursive: true });
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();

const setSil = (mode) => page.evaluate((M) => {
  const e = window.__engine;
  window.__silMats.forEach((u, i) => {
    const s = window.__silSaved[i];
    // 'off' neutralises the treatment, 'on' is what ships, 'black' forces the
    // hide flat black at any range. 'black' is the probe: if it does not move
    // a single pixel then the animal is not on screen, and no amount of
    // staring at a subtle A/B would have told us that.
    u.uSilNear.value = M === 'off' ? 1e9 : M === 'black' ? 0.0 : s.n;
    u.uSilFar.value  = M === 'off' ? 2e9 : M === 'black' ? 1.0 : s.f;
    u.uSilDark.value = M === 'off' ? 1.0 : M === 'black' ? 0.0 : s.d;
    u.uSilFlat.value = M === 'off' ? 0.0 : M === 'black' ? 1.0 : s.l;
  });
  e._loop();
}, mode);

const shot = async (mode, file) => { await setSil(mode); writeFileSync(file, await page.screenshot({ type: 'png' })); };
const changed = (a, b) => Math.round(+sh(`magick "${a}" "${b}" -compose difference -composite -colorspace Gray -threshold 4% -format "%[fx:mean*w*h]" info:`));

let pick = null;
for (let i = 0; i < info.candidates; i++) {
  const c = await page.evaluate((k) => window.__silApply(k), i);
  if (!c) continue;
  await shot('off', `${DIR}/_probeA.png`);
  await shot('black', `${DIR}/_probeB.png`);
  const owns = changed(`${DIR}/_probeA.png`, `${DIR}/_probeB.png`);
  console.error(`  candidate ${i} ${c.anchor}:${c.index} off=${c.off} d=${c.d}m -> ${owns} px owned`);
  if (owns >= 40) { pick = { ...c, owns, idx: i }; break; }
}
if (!pick) { console.log(JSON.stringify({ error: 'no candidate framing showed the animal', candidates: info.candidates })); await browser.close(); process.exit(1); }

await page.evaluate((k) => window.__silApply(k), pick.idx);
await shot('off', `${DIR}/off.png`);
await shot('on', `${DIR}/on.png`);

const CW = 300, CH = 200;
const cx = Math.max(0, Math.min(W - CW, pick.sx - CW / 2));
const cy = Math.max(0, Math.min(H - CH, pick.sy - CH / 2));
for (const k of ['off', 'on']) {
  sh(`magick "${DIR}/${k}.png" -crop ${CW}x${CH}+${cx}+${cy} +repage -filter point -resize 300% "${DIR}/${k}.crop.png"`);
}
sh(`magick "${DIR}/off.crop.png" "${DIR}/on.crop.png" +append "${DIR}/ab.png"`);
console.log(JSON.stringify({ ...pick, crop: { cx, cy },
  changedPixels: changed(`${DIR}/off.png`, `${DIR}/on.png`), ab: `${DIR}/ab.png` }, null, 1));
if (errs.length) console.error('page errors:', errs.slice(0, 4));
await browser.close();
