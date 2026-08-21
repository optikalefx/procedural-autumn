#!/usr/bin/env node
/**
 * scopetwinkle — measure the twinkle THROUGH THE REAL EYEPIECE, in the units
 * that decide whether a person can see it.
 *
 *   node tools/_scratch/scopetwinkle.mjs --seconds 12
 *
 * Two things this fixes about tools/_scratch/twinkle.mjs, which said the sky
 * was twinkling while the player looking at it said it was not:
 *
 *  1. It measures a POSED camera at fov 18, not the telescope. The eyepiece is
 *     reached through CameraRig.takeCamera, draws a field-stop mask over the
 *     frame, and is the thing being asked about. Measure the feature.
 *  2. It reports a RELATIVE swing — (max-min)/max of a star's contrast. That
 *     number is blind to how bright the star was: a faint star at 0.04 contrast
 *     swinging 20% moves 0.008 in display luma, which nobody alive can see, and
 *     it counts exactly the same as a bright star moving 0.08. Reporting the
 *     median of that over a field that is mostly faint stars is how a sky with
 *     no visible twinkle scores 0.19.
 *
 * So this reports ABSOLUTE display-luma swing, and counts the stars whose swing
 * clears thresholds a viewer could actually notice in a dark frame.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); const v = argv[i + 1];
  return i === -1 ? d : (v && !v.startsWith('--') ? v : true); };
const W = 1600, H = 900;
const SEC = parseFloat(arg('seconds', '12'));
const GAP = parseFloat(arg('gap', '0.25'));
const DIR = resolve(arg('dir', 'shots/_scratch/scopetwinkle'));

const release = await acquire('scopetwinkle');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {},
               set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, Real);
});
await page.goto('http://localhost:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });

// Night first, so the field is up before anything is framed.
await page.evaluate(() => { window.__lighting.hour = 0; window.__lighting.cycleSpeed = 0; });
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1800);
await page.keyboard.down('Space');            // the camp gate: stay parked
await page.waitForTimeout(1500);

const info = await page.evaluate(async () => {
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  if (!s) return null;
  const THREE = window.__THREE;
  const mod = await import('/src/camp/camp_telescope.js');
  const site = await import('/src/camp/camp_site.js');
  const { mulberry32 } = await import('/src/core/MathUtils.js');
  const camp = window.__camp.camps ? window.__camp.camps[window.__camp.camps.length - 1] : window.__camp;
  const props = camp.props ?? window.__camp.props;
  const chairs = props.filter((p) => p.item.kind === 'chair');
  let ax = 0, az = 0;
  for (const c of chairs) { ax += c.item.x - s.x; az += c.item.z - s.z; }
  const seat = chairs.length ? Math.atan2(az, ax) : 0;
  const R = (camp.site ?? window.__camp.site)?.radius ?? 5.8;
  const a = seat + 1.7, r = R * 0.50;
  const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
  const y = window.__world.getHeight(x, z);
  const yaw = Math.atan2(s.x - x, s.z - z);
  const g = mod.buildTelescope(mulberry32(0x51ed270b), { variant: 'reflector', wear: 0.45 });
  g.position.set(x, y, z);
  const q = new THREE.Quaternion();
  site.standOn(window.__world, x, z, yaw, 0.22, q);
  g.quaternion.copy(q);
  (camp.root ?? window.__camp.root).add(g);
  props.push({ obj: g, item: { kind: 'telescope', x, y, z, yaw }, delay: 0 });
  return { x, y, z };
});
if (!info) { console.error('scopetwinkle: no valid site'); await browser.close(); release(); process.exit(2); }

await page.evaluate(() => {
  const camps = window.__camp.camps ?? [];
  window.__camp._focusCamp = camps[camps.length - 1] ?? null;
});
await page.waitForTimeout(600);
const p = await page.evaluate(({ W, H }) => {
  const THREE = window.__THREE, e = window.__engine;
  const camps = window.__camp.camps ?? [window.__camp];
  let prop = null;
  for (const c of camps) for (const q of (c.props ?? [])) if (q.item.kind === 'telescope') prop = q;
  if (!prop) return null;
  const d = prop.obj.userData.telescope;
  const v = new THREE.Vector3(prop.item.x, prop.item.y + (d.eye?.y ?? 0.7) * 0.86, prop.item.z);
  v.project(e.camera);
  return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, behind: v.z > 1 };
}, { W, H });
if (!p || p.behind) { console.error('scopetwinkle: telescope off screen'); await browser.close(); release(); process.exit(2); }

// Enter through the ScopeView's own enter(prop) rather than by clicking.
//
// The click path is already covered by tools/_scratch/scopeview.mjs, and here
// it is a liability: the chase camera framed the telescope at y=1012 on a
// 900-tall viewport, so the mouse landed on nothing and the first run of this
// reported "not in the eyepiece" for a reason that has nothing to do with the
// sky. enter(prop) is the same object the click ends up calling, so the camera,
// the field stop and the fov below are all the real ones.
await page.evaluate(() => {
  const camps = window.__camp.camps ?? [window.__camp];
  let prop = null;
  for (const c of camps) for (const q of (c.props ?? [])) if (q.item.kind === 'telescope') prop = q;
  // enter() wants the telescope GROUP, not the {obj, item} entry the camp
  // keeps it in: it reads prop.userData.telescope and returns silently when
  // that is missing, which is what "not in the eyepiece" meant the first time.
  window.__scopeDbg = { found: !!prop, hasEye: !!prop?.obj?.userData?.telescope?.eye };
  if (prop) window.__camp.scope.enter(prop.obj);
});
console.log('enter dbg: ' + JSON.stringify(await page.evaluate(() => window.__scopeDbg)));
await page.waitForTimeout(1200);

// Sweep up to put sky, not treeline, in the circle.
await page.mouse.move(800, 450);
await page.mouse.down();
for (let i = 0; i < 14; i++) { await page.mouse.move(800 + i * 2, 450 - i * 14); await page.waitForTimeout(30); }
await page.mouse.up();
await page.waitForTimeout(900);

const state = await page.evaluate(() => ({
  active: !!window.__camp.scope?.active, fov: window.__engine.camera.fov,
  mask: document.querySelector('.pa-scope-mask') ? getComputedStyle(document.querySelector('.pa-scope-mask')).opacity : 'no-el',
}));
if (!state.active) { console.error('scopetwinkle: not in the eyepiece ' + JSON.stringify(state)); await browser.close(); release(); process.exit(2); }
console.log(`in the eyepiece, fov ${state.fov.toFixed(1)}`);

mkdirSync(DIR, { recursive: true });
const N = Math.max(2, Math.round(SEC / GAP));
const shots = [];
for (let i = 0; i < N; i++) {
  if (i) await page.waitForTimeout(GAP * 1000);
  const out = `${DIR}/f${String(i).padStart(2, '0')}.png`;
  await page.screenshot({ path: out });
  shots.push(readFileSync(out).toString('base64'));
}
const held = await page.evaluate(() => ({
  active: !!window.__camp.scope?.active, hour: window.__lighting.hour, speed: window.__lighting.cycleSpeed,
}));
if (!held.active || Math.abs(held.hour) > 1e-6 || held.speed !== 0) {
  console.error('[scopetwinkle] the page moved under the capture — ' + JSON.stringify(held));
  await browser.close(); release(); process.exit(2);
}

// Where the eyepiece's own prompt panel is, so it can be cut out of the
// measurement. It sits inside the field stop, and its white lettering is the
// highest local contrast in the frame: the first clean run of this reported the
// twelve "brightest stars" as peak 0.70 with a swing of 0.001, and every one of
// them was a letter in "drag to sweep the sky". UI does not twinkle.
const tipBox = await page.evaluate(() => {
  const el = document.querySelector('.pa-scope-tip');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x0: r.left - 10, y0: r.top - 10, x1: r.right + 10, y1: r.bottom + 10 };
});
console.log('excluding tip panel: ' + JSON.stringify(tipBox));

const res = await page.evaluate(async ({ b64s, tip }) => {
  const lums = [];
  let Wp = 0, Hp = 0;
  for (const b of b64s) {
    const img = new Image(); img.src = 'data:image/png;base64,' + b; await img.decode();
    Wp = img.width; Hp = img.height;
    const c = new OffscreenCanvas(Wp, Hp);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, Wp, Hp).data;
    const l = new Float32Array(Wp * Hp);
    for (let i = 0, n = Wp * Hp; i < n; i++) {
      const j = i * 4;
      l[i] = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
    }
    lums.push(l);
  }
  // Inside the field stop only. The mask is a circle of radius 45.4vmin about
  // the centre; stay well inside it so no measurement is of the mask's edge.
  const cx = Wp / 2, cy = Hp / 2, rad = Math.min(Wp, Hp) * 0.42;
  const l0 = lums[0];
  const ring = (l, x, y) => {
    let s = 0, n = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (Math.abs(dx) === 3 || Math.abs(dy) === 3) { s += l[(y + dy) * Wp + (x + dx)]; n++; }
    }
    return s / n;
  };
  const stars = [];
  for (let y = 4; y < Hp - 4; y++) for (let x = 4; x < Wp - 4; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 > rad * rad) continue;
    if (tip && x >= tip.x0 && x <= tip.x1 && y >= tip.y0 && y <= tip.y1) continue;
    const v = l0[y * Wp + x];
    let lm = true;
    for (let dy = -2; dy <= 2 && lm; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      if (l0[(y + dy) * Wp + (x + dx)] > v) { lm = false; break; }
    }
    if (lm && v - ring(l0, x, y) > 0.012) stars.push([x, y]);
  }
  const rows = [];
  for (const [x, y] of stars) {
    let mn = Infinity, mx = -Infinity, peak0 = 0;
    for (const l of lums) {
      let best = -Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        best = Math.max(best, l[(y + dy) * Wp + (x + dx)] - ring(l, x + dx, y + dy));
      }
      mn = Math.min(mn, best); mx = Math.max(mx, best);
    }
    peak0 = mx;
    rows.push({ peak: peak0, swing: mx - mn });   // ABSOLUTE display luma
  }
  rows.sort((a, b) => a.swing - b.swing);
  const q = (pp) => rows.length ? rows[Math.min(rows.length - 1, Math.floor(pp * rows.length))].swing : 0;
  const over = (t) => rows.filter((r) => r.swing > t).length;
  const byPeak = [...rows].sort((a, b) => b.peak - a.peak).slice(0, 12);
  const vis = rows.filter((r) => r.peak > 0.05);
  const visSw = vis.map((r) => r.swing).sort((a, b) => a - b);
  return {
    n: rows.length, p50: q(0.5), p90: q(0.9), max: q(0.999),
    o02: over(0.02), o05: over(0.05), o10: over(0.10),
    top: byPeak.map((r) => ({ peak: +r.peak.toFixed(3), swing: +r.swing.toFixed(3) })),
    visN: vis.length,
    visP50: visSw.length ? visSw[visSw.length >> 1] : 0,
    visMax: visSw.length ? visSw[visSw.length - 1] : 0,
  };
}, { b64s: shots, tip: tipBox });

console.log(`stars in the field stop: ${res.n}   over ${(N * GAP).toFixed(1)}s`);
console.log(`ABSOLUTE swing (display luma):  p50 ${res.p50.toFixed(4)}   p90 ${res.p90.toFixed(4)}   max ${res.max.toFixed(4)}`);
console.log(`stars swinging  >0.02: ${res.o02}    >0.05: ${res.o05}    >0.10: ${res.o10}`);
console.log(`stars a viewer can actually see (peak>0.05): ${res.visN}   ` +
            `median swing ${res.visP50.toFixed(4)}   max ${res.visMax.toFixed(4)}`);
console.log('brightest 12 (peak / swing):');
console.log('  ' + res.top.map((r) => `${r.peak}/${r.swing}`).join('  '));
console.log(`frames: ${DIR}`);
await browser.close();
release();
