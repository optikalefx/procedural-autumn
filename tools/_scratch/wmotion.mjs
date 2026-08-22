#!/usr/bin/env node
/**
 * wmotion — does the drawn water surface actually TRAVEL?
 *
 * The round-5 brief quotes a flow correlator that lived in a `flow/` directory
 * which is not in this tree, so this is a rebuild of the same measurement. It
 * is deliberately simpler in one way and stricter in another.
 *
 * STRICTER: it does not let the engine run between frames. It stops the engine,
 * writes `uTime` on the water material DIRECTLY and calls the render path with
 * dt = 0. So the sun, the clouds, the leaves, the LOD and the camera are
 * bit-identical across the whole sequence and the ONLY thing that differs
 * between two frames is the water shader's own clock. The control below proves
 * it: two renders at the same uTime read 0.000 levels of difference.
 *
 * SIMPLER: displacement is measured by integer-shift NCC on luminance with a
 * parabolic sub-pixel refinement, over square patches placed on open water.
 *
 * What it reports, per view:
 *   sd        spatial SD of luminance over the water mask, in 0-255 levels.
 *             This is "how much structure is in the picture at all".
 *   rms(dt)   RMS of |frame(t0+dt) - frame(t0)| over the same mask, same units.
 *   mos       rms(dt) / sd — "moving over static". Two decorrelated draws of a
 *             field with this SD would read sqrt(2) = 1.414 here, so this is
 *             the fraction of the picture that is not nailed to the world.
 *   ncc0      median NCC of a patch against itself at zero shift.
 *   pinned    patches whose PREDICTED screen displacement exceeds 3 px and
 *             whose MEASURED displacement is under 1 px. The prediction is the
 *             shader's own arithmetic — the flow texture decoded exactly as
 *             wFlow does, steered by the same smoothstep, the same speed
 *             polynomial — projected through the live camera.
 *   ang       angle between measured and predicted displacement, degrees, over
 *             the patches that moved at all.
 *   ratio     |measured| / |predicted|.
 *
 * Usage: node tools/_scratch/wmotion.mjs --views river,mouth --dt 1.0
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { readPNG } from '../_pngread.mjs';
import { acquire } from '../_lock.mjs';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const VIEWNAMES = (arg('views', 'river,mouth,backwater')).split(',');
const DTS = (arg('dt', '0.25,1,5')).split(',').map(Number);
const W = 1600, H = 900;
const DIR = arg('dir', 'shots/_wmotion');
const URL = (process.env.AUTUMN_URL || 'http://localhost:5182');
const PATCH = 48;          // px. 72 was too big: `river` draws its channel as a
                           // ribbon 60-100 px wide and 31 of 33 candidate patches
                           // were rejected for containing bank.
const SEARCH = 12;         // px of integer search either way

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
// The SAME pinned anchors shot.mjs uses. Re-resolving them puts the camera
// somewhere else entirely: without this, `mouth` framed 5.5% water against the
// 50.6% the capture harness sees.
const FROZEN = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};

const lum = (im) => {
  const { w, h, px } = im;
  const out = new Float32Array(w * h);
  for (let k = 0, i = 0; k < w * h; k++, i += 3)
    out[k] = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  return out;
};

function ncc(A, B, w, h, x0, y0, n, dx, dy) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, c = 0;
  for (let y = 0; y < n; y++) {
    const ay = y0 + y, by = ay + dy;
    if (by < 0 || by >= h) return -2;
    for (let x = 0; x < n; x++) {
      const ax = x0 + x, bx = ax + dx;
      if (bx < 0 || bx >= w) return -2;
      const a = A[ay * w + ax], b = B[by * w + bx];
      sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; c++;
    }
  }
  const va = saa - sa * sa / c, vb = sbb - sb * sb / c;
  if (va < 1e-6 || vb < 1e-6) return -2;
  return (sab - sa * sb / c) / Math.sqrt(va * vb);
}

function bestShift(A, B, w, h, x0, y0, n) {
  let bx = 0, by = 0, bv = -3;
  for (let dy = -SEARCH; dy <= SEARCH; dy++)
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      const v = ncc(A, B, w, h, x0, y0, n, dx, dy);
      if (v > bv) { bv = v; bx = dx; by = dy; }
    }
  // parabolic refinement on each axis
  const at = (dx, dy) => ncc(A, B, w, h, x0, y0, n, dx, dy);
  const sub = (m, l, r) => {
    const d = l - 2 * m + r;
    return Math.abs(d) < 1e-9 ? 0 : Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / d));
  };
  const fx = sub(bv, at(bx - 1, by), at(bx + 1, by));
  const fy = sub(bv, at(bx, by - 1), at(bx, by + 1));
  return { dx: bx + fx, dy: by + fy, peak: bv, zero: ncc(A, B, w, h, x0, y0, n, 0, 0) };
}

const q = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN;

async function main() {
  await acquire('shot');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  // Vite's HMR client will reload the page under us the moment anything in the
  // tree is touched — and a measurement run edits shaders by definition. Same
  // stub shot.mjs installs.
  await page.addInitScript(() => {
    const RealWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
        return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
                 removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
                 set onerror(_) {}, set onmessage(_) {} };
      }
      return new RealWS(url, protocols);
    };
    window.WebSocket.prototype = RealWS.prototype;
    Object.assign(window.WebSocket, RealWS);
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.evaluate(() => { const e = window.__engine; if (!e) return; e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; });

  const report = [];
  for (const name of VIEWNAMES) {
    const v = VIEWS[name];
    if (!v) { console.error(`no view ${name}`); continue; }

    await page.evaluate(async (P) => {
      const v = P.v;
      const THREE = window.__THREE, e = window.__engine, wd = window.__world;
      const api = window.__cameraAnchors || {};
      window.__engine.start();
      window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
      const anchor = P.frozen[v.anchor] ?? ((v.index && window.__anchorAt) ? window.__anchorAt(v.anchor, v.index)
        : (api[v.anchor] || api.vista)());
      let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
      if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
      const back = v.standOff ?? 0;
      const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
      const gy = wd.getHeight(gx, gz) + v.height;
      const pos = new THREE.Vector3(gx, gy, gz);
      const look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
      const ray = new THREE.Raycaster(); ray.far = 6; const dir = new THREE.Vector3();
      for (let a = 0; a < 6; a++) {
        dir.copy(look).sub(pos).normalize(); ray.set(pos, dir);
        const hits = ray.intersectObjects(e.scene.children, true)
          .filter(h => h.distance > 0.05 && h.object.visible && h.object.name !== 'Sky' && !h.object.isPoints);
        if (!hits.length || hits[0].distance > 3.0) break;
        pos.y += 2.2; pos.addScaledVector(dir, -2.0); look.y += 0.7;
      }
      const g = wd.getHeight(pos.x, pos.z) + 1.4; if (pos.y < g) pos.y = g;
      e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
      e.camera.position.copy(pos); e.camera.lookAt(look);
      window.__forceCamera = true;
      window.dispatchEvent(new Event('resize'));
      if (window.__settleStable) await window.__settleStable(); else await window.__settle?.(60);
      for (const n of ['Trees', 'Grass', 'GroundCover', 'Weather']) {
        const o = e.scene.getObjectByName(n); if (o) o.visible = false;
      }
      await window.__settle?.(30);
    }, { v, frozen: FROZEN });
    await page.waitForTimeout(1200);

    // ── freeze everything but the water clock ────────────────────────────
    const setup = await page.evaluate(() => {
      const e = window.__engine;
      e.stop();
      window.__frozenDraw = () => { if (e._render) e._render(0, e.elapsed); else e.renderer.render(e.scene, e.camera); };
      let u = null;
      e.scene.getObjectByName('Water')?.traverse(o => { if (!u && o.material?.uniforms?.uTime) u = o.material.uniforms; });
      window.__wu = u;
      window.__t0 = u ? u.uTime.value : 0;
      window.__frozenDraw();
      return { found: !!u, t0: window.__t0, wind: u ? [u.uWind.value.x, u.uWind.value.y] : null };
    });
    if (!setup.found) { console.error(`${name}: no water uniforms in frame`); continue; }

    const shot = async (label) => {
      const p = `${DIR}/${name}-${label}.png`;
      await page.screenshot({ path: p });
      return p;
    };
    const setT = async (t) => { await page.evaluate(t => { window.__wu.uTime.value = t; window.__frozenDraw(); }, t); await page.waitForTimeout(60); };

    await setT(setup.t0);
    const f0 = await shot('t0');
    // control: same clock, rendered twice
    await setT(setup.t0);
    const fc = await shot('ctl');
    const frames = {};
    for (const dt of DTS) { await setT(setup.t0 + dt); frames[dt] = await shot(`d${dt}`); }
    // water-hidden twin for the mask
    await page.evaluate(() => { const o = window.__engine.scene.getObjectByName('Water'); if (o) o.visible = false; window.__wu.uTime.value = window.__t0; window.__frozenDraw(); });
    await page.waitForTimeout(120);
    const fnw = await shot('nowater');
    await page.evaluate(() => { const o = window.__engine.scene.getObjectByName('Water'); if (o) o.visible = true; window.__frozenDraw(); });

    // ── patch positions + the shader's own predicted displacement ─────────
    const patchRes = await page.evaluate(({ W, H, PATCH, dts }) => {
      const THREE = window.__THREE, e = window.__engine, wd = window.__world;
      const cam = e.camera;
      const u = window.__wu;
      const wind = new THREE.Vector2(u.uWind.value.x, u.uWind.value.y);
      const R = wd.res, WS = wd.worldSize, texel = WS / R;
      const vX = wd.flowVX, vZ = wd.flowVZ, fQ = wd.flowQ, fT = wd.flowT;
      // Bilinear on the same texel convention wFlow uses:
      //   uv = xz/WS + 0.5 + (1/R)*0.5  ->  sample index i sits at world i*texel - WS/2
      const bil = (arr, x, z) => {
        if (!arr) return 0;
        const fx = (x + WS * 0.5) / texel, fz = (z + WS * 0.5) / texel;
        const x0 = Math.max(0, Math.min(R - 1, Math.floor(fx))), z0 = Math.max(0, Math.min(R - 1, Math.floor(fz)));
        const x1 = Math.min(R - 1, x0 + 1), z1 = Math.min(R - 1, z0 + 1);
        const tx = fx - x0, tz = fz - z0;
        return (arr[z0 * R + x0] * (1 - tx) + arr[z0 * R + x1] * tx) * (1 - tz)
             + (arr[z1 * R + x0] * (1 - tx) + arr[z1 * R + x1] * tx) * tz;
      };
      const proj = (p) => {
        const q = p.clone().project(cam);
        return [(q.x * 0.5 + 0.5) * W, (0.5 - q.y * 0.5) * H];
      };
      const ray = new THREE.Raycaster();
      const out = [];
      const miss = { none: 0, behind: 0 };
      const cols = 24, rows = 14;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const sx = (c + 0.5) / cols * W, sy = (r + 0.5) / rows * H;
        const ndc = new THREE.Vector2(sx / W * 2 - 1, 1 - sy / H * 2);
        ray.setFromCamera(ndc, cam);
        ray.far = 2000;
        const hits = ray.intersectObjects(e.scene.children, true)
          .filter(h => h.object.visible && h.object.name !== 'Sky' && !h.object.isPoints);
        if (!hits.length) { miss.none++; continue; }
        // Nearest WATER hit, and no occlusion test at all. The first version
        // required the water to be hits[0] and got 0 candidates in every
        // framing: the cloud volume is a mesh the ray crosses first, so every
        // water hit read as "behind something". Whether the pixel really shows
        // water is decided on the node side by the water-hidden difference
        // mask, which is the same rule the capture harness uses and cannot be
        // fooled by a transparent proxy geometry.
        const wi = hits.findIndex(h => h.object.name === 'WaterChunk');
        if (wi < 0) { miss[hits[0].object.name] = (miss[hits[0].object.name] || 0) + 1; continue; }
        const P = hits[wi].point.clone();
        // the shader's flow arithmetic, verbatim
        const vx = bil(vX, P.x, P.z), vz = bil(vZ, P.x, P.z);
        const coh = Math.min(1, Math.hypot(vx, vz));
        const disch = bil(fQ, P.x, P.z), turbRaw = bil(fT, P.x, P.z);
        const turb = turbRaw * coh;
        const speed = (0.55 + 4.2 * disch + 3.0 * turb) * coh;
        const wl = Math.hypot(wind.x + 1e-4, wind.y + 1e-4);
        const wdx = (wind.x + 1e-4) / wl, wdy = (wind.y + 1e-4) / wl;
        const vl = Math.max(Math.hypot(vx, vz), 1e-4);
        const vdx = vx / vl, vdy = vz / vl;
        const s = Math.max(0, Math.min(1, (coh - 0.015) / 0.06));
        const steer = s * s * (3 - 2 * s);
        let tx = wdx + (vdx - wdx) * steer + vdx * 0.02;
        let ty = wdy + (vdy - wdy) * steer + vdy * 0.02;
        const tl = Math.max(Math.hypot(tx, ty), 1e-6); tx /= tl; ty /= tl;
        const a = proj(P);
        const pred = {};
        for (const dt of dts) {
          const b = proj(new THREE.Vector3(P.x + tx * speed * dt, P.y, P.z + ty * speed * dt));
          pred[dt] = [b[0] - a[0], b[1] - a[1]];
        }
        out.push({ sx: Math.round(a[0]), sy: Math.round(a[1]), wx: P.x, wz: P.z,
                   range: cam.position.distanceTo(P), coh, disch, speed, pred });
      }
      return { out, miss };
    }, { W, H, PATCH, dts: DTS });

    const patches = patchRes.out;
    console.log(`${name}: ${patches.length} water candidates, misses ${JSON.stringify(patchRes.miss)}`);

    // ── read the images back ─────────────────────────────────────────────
    const I0 = readPNG(f0), IC = readPNG(fc), INW = readPNG(fnw);
    const L0 = lum(I0), LC = lum(IC), LNW = lum(INW);
    const w = I0.w, h = I0.h;
    // Max channel difference, not luminance. `backwater` is a low sun on dark
    // blue water against a dark bank: on luminance the water's own contribution
    // read 10.3% of frame against the capture harness's 43.0%, because the water
    // there changes HUE far more than VALUE. On max-channel it reads 42.6%.
    const mask = new Uint8Array(w * h);
    let mn = 0;
    for (let i = 0; i < w * h; i++) {
      const a = I0.px, b = INW.px, j = i * 3;
      const d = Math.max(Math.abs(a[j] - b[j]), Math.abs(a[j + 1] - b[j + 1]), Math.abs(a[j + 2] - b[j + 2]));
      if (d > 4) { mask[i] = 1; mn++; }
    }
    let s = 0, ss = 0;
    for (let i = 0; i < w * h; i++) if (mask[i]) { s += L0[i]; ss += L0[i] * L0[i]; }
    const sd = Math.sqrt(ss / mn - (s / mn) ** 2);
    const rmsOn = (L) => { let a = 0; for (let i = 0; i < w * h; i++) if (mask[i]) a += (L[i] - L0[i]) ** 2; return Math.sqrt(a / mn); };

    const row = { view: name, maskPct: +(100 * mn / (w * h)).toFixed(2), sd: +sd.toFixed(2), ctl: +rmsOn(LC).toFixed(3), dt: {} };
    for (const dt of DTS) {
      const L = lum(readPNG(frames[dt]));
      const rms = rmsOn(L);
      // patch correlation
      const half = PATCH >> 1;
      const stats = []; const rej = { edge: 0, cov: 0, peak: 0 };
      for (const p of patches) {
        const x0 = p.sx - half, y0 = p.sy - half;
        if (x0 < SEARCH || y0 < SEARCH || x0 + PATCH + SEARCH >= w || y0 + PATCH + SEARCH >= h) { rej.edge++; continue; }
        // require the patch to be genuinely water
        let cov = 0;
        for (let y = y0; y < y0 + PATCH; y++) for (let x = x0; x < x0 + PATCH; x++) if (mask[y * w + x]) cov++;
        if (cov < PATCH * PATCH * 0.90) { rej.cov++; continue; }
        const b = bestShift(L0, L, w, h, x0, y0, PATCH);
        if (b.peak < 0.30) { rej.peak++; continue; }
        const pd = p.pred[dt];
        stats.push({ ...p, meas: [b.dx, b.dy], predv: pd, peak: b.peak, zero: b.zero,
                     mm: Math.hypot(b.dx, b.dy), pm: Math.hypot(pd[0], pd[1]) });
      }
      const usable = stats.filter(s2 => s2.pm > 3.0);
      const pinned = usable.filter(s2 => s2.mm < 1.0);
      const moved = usable.filter(s2 => s2.mm >= 1.0);
      const angs = moved.map(s2 => {
        const d = (s2.meas[0] * s2.predv[0] + s2.meas[1] * s2.predv[1]) / (s2.mm * s2.pm);
        return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
      });
      row.dt[dt] = {
        rms: +rms.toFixed(3), mos: +(rms / sd).toFixed(3),
        patches: stats.length, cand: patches.length, rej, predOver3: usable.length, pinned: pinned.length,
        predP50: patches.length ? +q(patches.map(p2 => Math.hypot(p2.pred[dt][0], p2.pred[dt][1])), 0.5).toFixed(2) : null,
        ncc0: +q(stats.map(s2 => s2.zero), 0.5)?.toFixed(3),
        angP50: angs.length ? +q(angs, 0.5).toFixed(1) : null,
        ratioP50: usable.length ? +q(usable.map(s2 => s2.mm / s2.pm), 0.5).toFixed(3) : null,
      };
    }
    report.push(row);
    console.log(JSON.stringify(row));
  }
  await page.evaluate(() => { window.__frozenDraw = null; window.__engine.start(); });
  await browser.close();
  console.log('\n=== wmotion ===');
  for (const r of report) {
    console.log(`${r.view}  mask ${r.maskPct}%  sd ${r.sd}  control ${r.ctl}`);
    for (const dt of DTS) {
      const d = r.dt[dt];
      console.log(`   dt ${dt}s  rms ${d.rms}  mos ${d.mos}  ncc0 ${d.ncc0}  ` +
                  `pinned ${d.pinned}/${d.predOver3} (of ${d.patches}/${d.cand})  predP50 ${d.predP50}px  ` +
                  `ang ${d.angP50}  ratio ${d.ratioP50}  rej ${JSON.stringify(d.rej)}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
