#!/usr/bin/env node
/**
 * TREES: interleaved within-one-page-load A/B, plus a rect probe and a species
 * census. One page load, one world bake, one camera pose — then N labelled
 * variants captured back to back.
 *
 * Two captures of this project taken 34 minutes apart differed in 50% of pixels
 * with only one system changed, so a before/after taken as two separate process
 * runs proves nothing about a subtle shading term. Everything here happens
 * inside one `page` so the only thing that differs between frames is the
 * snippet named on the command line.
 *
 *   node tools/_scratch/tab.mjs --view backlit --res 768 \
 *     --step base:'' --step off:'window.__trees.shared.uTransStrength.value=0' \
 *     --step base2:'window.__trees.shared.uTransStrength.value=1.9' \
 *     --dir shots/trees/ab
 *
 * `--rect x,y,w,h:name` (fractional, repeatable) prints mean sRGB + luma for
 * that rect on every step, which is how a claim like "the tip is 12% brighter"
 * gets checked rather than asserted.
 *
 * `--census` prints the species mix by distance band around the camera.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const VIEWS = {
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  river:     { anchor: 'river',    height: 6.0, dist: 30,  pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  waterfall: { anchor: 'waterfall',height: 11,  dist: 58,  pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  backlit:   { anchor: 'meadow',   height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
};

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const many = (n) => argv.reduce((a, v, i) => (v === `--${n}` ? [...a, argv[i + 1]] : a), []);
const has = (n) => argv.includes(`--${n}`);

const steps = many('step').map((s) => {
  const i = s.indexOf(':');
  return i === -1 ? { name: s, js: '' } : { name: s.slice(0, i), js: s.slice(i + 1) };
});
if (!steps.length) steps.push({ name: 'base', js: '' });

const rects = many('rect').map((s) => {
  const [nums, name] = s.split(':');
  const [x, y, w, h] = nums.split(',').map(Number);
  return { x, y, w, h, name: name || nums };
});

const VIEW = arg('view', 'backlit');
const DIR = arg('dir', 'shots/trees/ab');
const W = +arg('w', 1280), H = +arg('h', 720);

await acquire('tab');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 300)));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
// Neuter Vite's HMR client, exactly as shot.mjs does. Without it, saving any
// source file mid-run reloads the page, which wipes window.__hold and makes
// every step after the save silently measure the base build. It cost me one
// full sweep before this was here.
await p.addInitScript(() => {
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
await p.goto(`http://localhost:5178/?res=${arg('res', '768')}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

// Pose once, using shot.mjs's frozen anchors and its near-field clearing pass,
// so a frame from here is the same framing as the archive's. Every step below
// re-uses this exact camera.
const frozen = JSON.parse(readFileSync('review/anchors.json', 'utf8'));
const posed = await p.evaluate(async ({ v, hour, frozen }) => {
  const THREE = window.__THREE, e = window.__engine, wd = window.__world;
  window.__lighting.hour = hour ? parseFloat(hour) : v.hour;
  window.__lighting.cycleSpeed = 0;
  const a = frozen[v.anchor] || window.__anchorAt(v.anchor, v.index || 0);
  let yaw = (a.yaw ?? 0) + (v.yawOffset ?? 0);
  if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
  const back = v.standOff ?? 0;
  const gx = a.x - Math.sin(yaw) * back, gz = a.z - Math.cos(yaw) * back;
  const gy = wd.getHeight(gx, gz) + v.height;
  const pos = new THREE.Vector3(gx, gy, gz);
  const look = new THREE.Vector3(
    gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);

  const ray = new THREE.Raycaster(); ray.far = 6;
  const dir = new THREE.Vector3();
  for (let attempt = 0; attempt < 6; attempt++) {
    dir.copy(look).sub(pos).normalize();
    ray.set(pos, dir);
    const hits = ray.intersectObjects(e.scene.children, true)
      .filter((h) => h.distance > 0.05 && h.object.visible && h.object.name !== 'Sky' && !h.object.isPoints);
    if (!hits.length || hits[0].distance > 3.0) break;
    pos.y += 2.2; pos.addScaledVector(dir, -2.0); look.y += 0.7;
  }
  const g = wd.getHeight(pos.x, pos.z) + 1.4;
  if (pos.y < g) pos.y = g;

  e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
  e.camera.position.copy(pos);
  e.camera.lookAt(look);
  window.__forceCamera = true;
  window.dispatchEvent(new Event('resize'));
  await window.__settle(60);
  const sd = window.__lighting.sunDir;
  const sc = window.__systems.trees.shared.uSunColor.value;
  return { cam: e.camera.position.toArray(), yaw, sun: [sd.x, sd.y, sd.z], sunColor: [sc.r, sc.g, sc.b] };
}, { v: VIEWS[VIEW], hour: arg('hour'), frozen });
console.log('posed:', JSON.stringify(posed));

if (has('census')) {
  const c = await p.evaluate(() => {
    const T = window.__systems.trees.trees, e = window.__engine, cam = e.camera.position;
    const keys = ['birch', 'aspen', 'maple', 'oak', 'spruce'];
    const bands = [[0, 40], [40, 90], [90, 200], [200, 600]];
    // In-frustum only. A census over the full disc counts the stand behind the
    // camera, which is not what the frame shows.
    const fwd = new window.__THREE.Vector3();
    e.camera.getWorldDirection(fwd);
    const halfAng = Math.atan(Math.tan((e.camera.fov * Math.PI / 180) * 0.5) * e.camera.aspect) + 0.10;
    const cosHalf = Math.cos(halfAng);
    const fl = Math.hypot(fwd.x, fwd.z) || 1;
    const fx = fwd.x / fl, fz = fwd.z / fl;
    const out = {};
    for (const [lo, hi] of bands) {
      const row = new Array(keys.length).fill(0);
      for (let i = 0; i < T.n; i++) {
        const dx = T.px[i] - cam.x, dz = T.pz[i] - cam.z;
        const d = Math.hypot(dx, dz);
        if (d < lo || d >= hi) continue;
        if ((dx * fx + dz * fz) / d < cosHalf) continue;
        row[T.pspec[i]]++;
      }
      const tot = row.reduce((a, b) => a + b, 0) || 1;
      out[`${lo}-${hi}m`] = Object.fromEntries(
        keys.map((k, j) => [k, `${row[j]} (${(row[j] / tot * 100).toFixed(0)}%)`]));
    }
    return out;
  });
  console.log('census:', JSON.stringify(c, null, 1));
}

// Trees.update() rewrites uTransStrength (and may rewrite others) every frame
// from the sun's elevation, so a step that simply assigns a shared uniform is
// undone before the next screenshot — an earlier run of this tool reported a
// transmission-off control that was byte-identical to the base for exactly that
// reason. window.__hold is re-applied after every update, so a step writes
//   window.__hold.uTransStrength = 0
// and it stays written.
await p.evaluate(() => {
  const t = window.__systems.trees;
  window.__hold = {};
  const orig = t.update.bind(t);
  t.update = (a, b) => {
    orig(a, b);
    for (const k in window.__hold) if (t.shared[k]) t.shared[k].value = window.__hold[k];
  };
});

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

for (const s of steps) {
  if (s.js) await p.evaluate((js) => { (new Function(js))(); }, s.js);
  await p.evaluate(async () => { await window.__settle(24); });
  await p.waitForTimeout(350);
  const out = resolve(`${DIR}/${s.name}.png`);
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
  const png = await p.screenshot({ path: out });
  if (rects.length) {
    // Measured from the PNG the run actually wrote, in node, so the number and
    // the picture can never disagree.
    const vals = await p.evaluate(async ({ rects, b64 }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return rects.map((r) => {
        const x = Math.round(r.x * img.width), y = Math.round(r.y * img.height);
        const w = Math.max(1, Math.round(r.w * img.width)), h = Math.max(1, Math.round(r.h * img.height));
        const d = g.getImageData(x, y, w, h).data;
        let R = 0, G = 0, B = 0, n = 0, mx = -1, mxpx = null;
        for (let i = 0; i < d.length; i += 4) {
          R += d[i]; G += d[i + 1]; B += d[i + 2]; n++;
          const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          if (L > mx) { mx = L; mxpx = [d[i], d[i + 1], d[i + 2]]; }
        }
        R /= n; G /= n; B /= n;
        return {
          name: r.name,
          srgb: [Math.round(R), Math.round(G), Math.round(B)],
          luma: +((0.2126 * R + 0.7152 * G + 0.0722 * B) / 255).toFixed(4),
          maxL: +(mx / 255).toFixed(4), maxpx: mxpx,
        };
      });
    }, { rects, b64: png.toString('base64') });
    console.log(`${s.name.padEnd(14)}`, vals.map(
      (v) => `${v.name}=(${v.srgb.join(',')}) L${v.luma} max${v.maxL}`).join('  '));
  } else {
    console.log('shot:', out);
  }
}

console.log('stats:', JSON.stringify(await p.evaluate(() => ({
  fps: window.__fps,
  tris: window.__engine.renderer.info.render.triangles,
  calls: window.__engine.renderer.info.render.calls,
}))));
await b.close();
