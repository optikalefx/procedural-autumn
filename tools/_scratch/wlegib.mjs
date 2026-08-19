#!/usr/bin/env node
/**
 * Wildlife legibility harness (wildlife author, scratch).
 *
 * `wdrive.mjs` can tell me an animal is geometrically in frame. It cannot tell
 * me whether a human steering a camper would ever notice it. This puts an
 * animal at a measured distance from the eye, in the player's real chase
 * framing — the CameraRig defaults at the 1170x870 viewport — and writes PNGs
 * I have to look at myself.
 *
 *   node tools/_scratch/wlegib.mjs --dist 77 --state live --tag after
 *
 * Several anchors are swept in one browser, because a single framing proves
 * nothing: the first meadow anchor happens to put a maple exactly where the
 * deer wants to stand.
 *
 * --state graze | alert | flee | live
 *   `live` runs the real brains with the camper closing at --speed, which is
 *   the only honest way to see what the player sees at that range.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const DIST = parseFloat(arg('dist', '77'));
const STATE = arg('state', 'live');
const HOUR = parseFloat(arg('hour', '16.7'));
const SPECIES = arg('species', 'deer');
const COUNT = parseInt(arg('count', '3'), 10);
const SPEED = parseFloat(arg('speed', '13'));
const FRAMES = parseInt(arg('frames', '110'), 10);
const W = parseInt(arg('w', '1170'), 10);
const H = parseInt(arg('h', '870'), 10);
const RES = arg('res', '1024');
const TAG = arg('tag', 'x');
const VIEWS = String(arg('views', 'meadow:0,meadow:1,road:0,road:2,forest:0,river:1'))
  .split(',').map((v) => { const [k, i] = v.split(':'); return { k, i: parseInt(i || '0', 10) }; });
const DIR = resolve(arg('dir', `shots/wl/${TAG}`));

await acquire('wlegib');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
// Immunity from other authors saving mid-capture.
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto(`http://localhost:5178?res=${RES}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const SETUP = async (P) => {
  const T = window.__THREE, e = window.__engine, W = window.__world;
  const wl = window.__systems.wildlife;
  window.__forceCamera = true;
  window.__lighting.hour = P.HOUR;
  e.stop();
  const dt = 1 / 60;
  e.clock.getDelta = () => dt;

  const cam = e.camera;
  // ── the player's chase framing (src/vehicle/CameraRig.js defaults) ────────
  //   zoom 19, restPitch(19) = 0.20 + 0.35*((19-5.5)/62.5)^0.7 = 0.2145 rad,
  //   anchor = vehicle + 1.05 + wide*2.4 (wide = (19-16)/52 = 0.0577), fov 52.
  const ZOOM = 19, PITCH = 0.2145, FOV = 52;
  const a = window.__anchorAt(P.ANCHOR, P.INDEX) || { x: 0, z: 0, yaw: 0 };
  const yaw = a.yaw ?? 0;
  const anchorY = W.getHeight(a.x, a.z) + 1.05 + 0.0577 * 2.4;
  const cp = Math.cos(PITCH), sp = Math.sin(PITCH);
  cam.position.set(a.x - Math.sin(yaw) * ZOOM * cp, anchorY + ZOOM * sp, a.z - Math.cos(yaw) * ZOOM * cp);
  cam.lookAt(a.x, anchorY, a.z);
  cam.fov = FOV; cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);

  const ST = { idle: 0, graze: 1, wander: 2, alert: 3, flee: 4 };

  // `debugSpawn` walks its own spot outward until the ground is dry, walkable
  // and clear of trunks, which can carry it twenty metres past what was asked
  // for. The distance is the whole experiment, so the herd is re-planted by
  // hand afterwards at exactly the requested range from the *eye* — the same
  // thing wdrive's `closestApproachMedian` measures.
  const place = (site, cx, cz) => {
    const g = wl.sites.live[site];
    if (!g) return null;
    let i = 0;
    for (const m of g.members) {
      const ang = i * 2.1, r = i === 0 ? 0 : 2.5 + i * 1.6;
      const px = cx + Math.sin(ang) * r, pz = cz + Math.cos(ang) * r;
      i++;
      if (!W.isInBounds(px, pz) || W.getWaterDepth(px, pz) > 0.15) continue;
      m.brain.pos.set(px, W.getHeight(px, pz), pz);
      m.brain.home.set(px, 0, pz);
      m.brain.target.copy(m.brain.pos);
      m.rig.reset(m.brain.pos, m.brain.heading, W);
    }
    const m0 = g.members[0];
    return m0 ? { x: m0.brain.pos.x, y: m0.brain.pos.y, z: m0.brain.pos.z, site } : null;
  };

  // Is anything solid between the eye and the animal? Trees are the reason
  // this exists — the first meadow anchor puts a maple exactly on the sightline
  // and an invisible deer behind a trunk proves nothing about legibility.
  const gap = (p) => {
    const from = cam.position, to = new T.Vector3(p.x, p.y + 0.8, p.z);
    const d = to.clone().sub(from), len = d.length();
    d.normalize();
    for (let t = 0.06; t < 0.985; t += 0.012) {
      const x = from.x + d.x * len * t, y = from.y + d.y * len * t, z = from.z + d.z * len * t;
      if (W.getHeight(x, z) > y + 0.15) return false;
      if (t > 0.15 && wl._treeNear(x, z, 1.8)) return false;
    }
    return true;
  };

  let spawn = null, used = 0;
  // Kept inside the horizontal half-angle (33.3 deg at fov 52, 4:3) so a
  // rejected sightline never pushes the herd out of frame.
  const lat = P.DIST * 0.52;
  const offsets = [0, -0.22, 0.22, -0.44, 0.44, -0.66, 0.66, -0.85, 0.85].map((f) => f * lat);
  for (const off of offsets) {
    wl.debugClear();
    const fx = cam.position.x + Math.sin(yaw) * P.DIST + Math.cos(yaw) * off;
    const fz = cam.position.z + Math.cos(yaw) * P.DIST - Math.sin(yaw) * off;
    const sp0 = wl.debugSpawn(P.SPECIES, {
      x: fx, z: fz, clear: 11,
      count: P.COUNT || undefined,
      state: P.STATE === 'live' ? undefined : ST[P.STATE],
    });
    if (!sp0) continue;
    const sp2 = place(sp0.site, fx, fz) ?? sp0;
    spawn = sp2; used = off;
    if (gap(sp2)) break;
  }
  if (!spawn) return { error: 'no spawn', anchor: P.ANCHOR, index: P.INDEX };

  // The camper is the threat, and it sits ~18.6 m in front of the eye.
  wl.debugThreat(a.x, a.z, P.STATE === 'live' ? P.SPEED : 0);
  for (let i = 0; i < (P.STATE === 'live' ? P.FRAMES : 60); i++) e._loop();

  const out = [];
  for (const s of wl.debugState()) {
    const d = Math.hypot(s.x - cam.position.x, s.z - cam.position.z);
    if (d > 240) continue;
    const v = new T.Vector3(s.x, s.y + 0.75, s.z).project(cam);
    const sx = Math.round((v.x * 0.5 + 0.5) * P.W), sy = Math.round((-v.y * 0.5 + 0.5) * P.H);
    if (v.z > 1 || sx < -40 || sx > P.W + 40) continue;
    out.push({ state: s.state, variant: s.variant, d: +d.toFixed(1),
               px: +((1.5 / d) / (2 * Math.tan((52 * Math.PI / 180) / 2)) * P.H).toFixed(1),
               speed: s.speed, sx, sy });
  }
  out.sort((p, q) => p.d - q.d);
  return { anchor: P.ANCHOR, index: P.INDEX, offx: +used.toFixed(1), animals: out };
};

/**
 * Render the identical frame with every animal hidden.
 *
 * Differencing the two frames is the only instrument here that answers the
 * actual question. It reports exactly which pixels the animal owns, how many
 * there are, and how far they moved the picture — i.e. whether the animal is
 * occluded, how big it really is on screen, and how much it contrasts with the
 * thing it is standing in front of. Everything else is a proxy.
 */
const HIDE = async () => {
  const e = window.__engine, wl = window.__systems.wildlife;
  e.clock.getDelta = () => 0;
  for (const key of wl.keys) {
    for (const per of wl.pool[key]) for (const a of per) if (a.active) a.mesh.visible = false;
  }
  e._loop();
  return true;
};

mkdirSync(DIR, { recursive: true });
const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const report = [];
for (const v of VIEWS) {
  const info = await page.evaluate(SETUP, {
    DIST, STATE, HOUR, SPECIES, COUNT, SPEED, FRAMES, W, H, ANCHOR: v.k, INDEX: v.i,
  });
  const stem = `${DIR}/${v.k}${v.i}-${SPECIES}-${DIST}m`;
  writeFileSync(`${stem}.png`, await page.screenshot({ type: 'png' }));
  await page.evaluate(HIDE);
  writeFileSync(`${stem}.empty.png`, await page.screenshot({ type: 'png' }));

  // How much of the picture does the animal actually own, and by how much did
  // it change it? `pixels` is its true on-screen footprint; `punch` is the mean
  // luma difference over just those pixels, which is the number that decides
  // whether an eye finds it.
  let diff = {};
  try {
    const D = `${stem}.diff.png`;
    sh(`magick "${stem}.png" "${stem}.empty.png" -compose difference -composite -colorspace Gray "${D}"`);
    const box = sh(`magick "${D}" -threshold 6% -format "%@" info:`);
    const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(box);
    const npx = parseInt(sh(`magick "${D}" -threshold 6% -format "%[fx:mean*w*h]" info:`), 10);
    // `punch` is the mean luma difference over just the pixels the animal owns.
    // The masked-mean this used to do through mpr: kept failing on the shell
    // quoting, and swallowed `pixels` with it because it shared the try. The
    // same number falls out of arithmetic: total difference over the whole
    // frame, divided by the count of pixels that carry any of it.
    const total = parseFloat(sh(`magick "${D}" -format "%[fx:mean*w*h]" info:`)) || 0;
    const punch = npx > 0 ? total / npx : 0;
    diff = { pixels: npx, bbox: m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null, punch: +punch.toFixed(4) };
    if (m && +m[1] > 0) {
      sh(`magick "${stem}.png" -stroke red -strokewidth 2 -fill none -draw "rectangle ${+m[3] - 12},${+m[4] - 12} ${+m[3] + +m[1] + 12},${+m[4] + +m[2] + 12}" "${stem}.marked.png"`);
    }
  } catch (err) { diff = { error: String(err.message || err).slice(0, 120) }; }

  report.push({ file: `${stem}.png`, ...info, diff });
}
console.log(JSON.stringify(report, null, 1));
if (errs.length) console.error('page errors:', errs.slice(0, 5));
await browser.close();
