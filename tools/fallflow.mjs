#!/usr/bin/env node
/**
 * Which way does the waterfall actually flow?
 *
 * A screenshot pair cannot settle this and neither can looking at it: the
 * curtain's silhouette is static, so the eye is judging a texture that moves a
 * couple of pixels between frames, and "up" and "down" are equally easy to
 * talk yourself into. This measures it.
 *
 *   node tools/fallflow.mjs --url http://127.0.0.1:5205
 *   node tools/fallflow.mjs --view waterfall --t0 4,30,120,300 --dt 0.10
 *   node tools/fallflow.mjs --only WaterfallSheets      # isolate one layer
 *   node tools/fallflow.mjs --selftest                  # check the instrument
 *
 * Method
 * ------
 * 1. Pose to a canonical framing (shot.mjs's own VIEWS table, same anchors).
 * 2. Stop the engine. Render by hand at `elapsed = T0` and `T0 + dt`, running
 *    every updater with **dt = 0** so no integrator advances: the only thing
 *    that differs between the two frames is the wall clock the water shaders
 *    are handed. Clouds, leaves, wind and the sun are bit-identical.
 * 3. Read both back out of the GL buffer, crop to the *interior* of the
 *    projected curtain (its own left and right edges are static vertical
 *    features and would pin the correlation at zero), high-pass along y to
 *    remove the static shading, and cross-correlate over vertical shifts with
 *    a parabolic subpixel fit.
 * 4. Convert pixels to metres with the projection itself — project the fall's
 *    midpoint and that point one metre lower, and measure the screen distance
 *    between them — so the answer is a signed vertical world velocity and not
 *    a number of pixels that depends on the framing.
 *
 * Sign convention: **negative is downward**, i.e. correct. A fall reported at
 * +1.1 m/s is flowing up the cliff at about walking pace.
 *
 * `--selftest` runs the estimator on a synthetic pair made by shifting one
 * captured frame by a known number of rows. An instrument that cannot recover
 * a shift it was handed has no business reporting one it was not.
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
import { VIEWS } from './shot.mjs';
import { POSE_SRC } from './_pose.mjs';
import { writePNG } from './_png.mjs';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const VIEW = arg('view', 'waterfall');
const T0S = String(arg('t0', '6,45,150,420')).split(',').map(Number);
const DT = parseFloat(arg('dt', '0.10'));
const STEPS = parseInt(arg('steps', '6'), 10);      // frames per T0, dt apart
const W = parseInt(arg('w', '900'), 10);
const H = parseInt(arg('h', '900'), 10);
const ONLY = arg('only', null);                     // isolate one mesh by name
const SHIFT = parseInt(arg('shift', '40'), 10);     // max |shift| searched, px
const OUT = arg('out', null);                       // optional ROI strip PNG
// No `res` by default, deliberately. `review/anchors.json` pins camera
// positions resolved against the DEFAULT bake; loading a different resolution
// gives a different terrain, so the pinned `waterfall` anchor lands 700 m from
// the nearest fall and the tool measures an empty hillside. It did exactly
// that on its first run.
const RES = arg('res', null);
// ...and the seed is pinned for the same reason, one level up. WorldConfig's
// SEED is 20262018 while every bake in public/bakes/ is 20261018, so a boot
// with no ?seed misses the cache, bakes a DIFFERENT world live, and puts the
// falls somewhere else entirely — a flow measurement on a fall that no
// canonical framing contains.
const SEED = arg('seed', '20261018');
const qs = new URLSearchParams();
if (RES) qs.set('res', RES);
if (SEED && SEED !== 'none') qs.set('seed', SEED);
const URL = arg('url', process.env.AUTUMN_URL || 'http://localhost:5178')
          + (qs.toString() ? `?${qs}` : '');

const LAYERS = ['WaterfallSheets', 'WaterfallSpray', 'WaterfallBurst',
                'WaterfallMist', 'PlungePools'];

// ── the estimator, in Node so --selftest can drive it with synthetic input ───

/** Vertical high-pass: subtract a box blur along y of radius `r`. */
function highpass(img, r = 9) {
  const { w, h, a } = img;
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= r && y < h; y++) acc += a[y * w + x];
    let n = Math.min(r + 1, h);
    for (let y = 0; y < h; y++) {
      out[y * w + x] = a[y * w + x] - acc / n;
      const add = y + r + 1, drop = y - r;
      if (add < h) { acc += a[add * w + x]; n++; }
      if (drop >= 0) { acc -= a[drop * w + x]; n--; }
    }
  }
  return { w, h, a: out };
}

/**
 * Zero-mean normalised cross-correlation of B against A over vertical shifts.
 * A positive result means B's content sits `s` rows FURTHER DOWN the image
 * than A's, i.e. the texture moved down the screen.
 */
function shiftNCC(A, B, maxShift) {
  const { w, h } = A;
  const scores = [];
  for (let s = -maxShift; s <= maxShift; s++) {
    const y0 = Math.max(0, -s), y1 = Math.min(h, h - s);
    if (y1 - y0 < h * 0.4) { scores.push({ s, r: -2, n: 0 }); continue; }
    let sa = 0, sb = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) { sa += A.a[y * w + x]; sb += B.a[(y + s) * w + x]; n++; }
    }
    const ma = sa / n, mb = sb / n;
    let num = 0, da = 0, db = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const u = A.a[y * w + x] - ma, v = B.a[(y + s) * w + x] - mb;
        num += u * v; da += u * u; db += v * v;
      }
    }
    const r = da > 0 && db > 0 ? num / Math.sqrt(da * db) : -2;
    scores.push({ s, r, n });
  }
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i].r > scores[best].r) best = i;
  let sub = scores[best].s;
  if (best > 0 && best < scores.length - 1) {
    const y0 = scores[best - 1].r, y1 = scores[best].r, y2 = scores[best + 1].r;
    const den = y0 - 2 * y1 + y2;
    if (Math.abs(den) > 1e-9) sub = scores[best].s - 0.5 * (y2 - y0) / den;
  }
  // Second peak, to say how confident the peak is. A texture with a repeating
  // period gives two peaks of nearly equal height and the answer is a coin
  // toss; that has to be visible in the report, not averaged away.
  let second = -2;
  for (const sc of scores) if (Math.abs(sc.s - scores[best].s) > 3) second = Math.max(second, sc.r);
  return { shift: sub, peak: scores[best].r, second, scores };
}

function rms(img) {
  let s = 0;
  for (let i = 0; i < img.a.length; i++) s += img.a[i] * img.a[i];
  return Math.sqrt(s / img.a.length);
}

// ── capture ─────────────────────────────────────────────────────────────────

await acquire('fallflow');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const v = VIEWS[VIEW];
if (!v) { console.error(`no such view: ${VIEW}`); process.exit(1); }
let frozen = null;
if (existsSync('review/anchors.json')) {
  try { frozen = JSON.parse(readFileSync('review/anchors.json', 'utf8')); } catch { frozen = null; }
}

await page.evaluate((hour) => {
  window.__lighting.hour = hour;
  window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
}, v.hour ?? 16.2);
await page.evaluate(new Function('P', POSE_SRC), { v, frozen, dynamic: [] });
await page.evaluate(() => window.__settle?.(60));
await page.waitForTimeout(600);

const cap = await page.evaluate(async (P) => {
  const THREE = window.__THREE;
  const e = window.__engine, wd = window.__world;
  const cam = e.camera;

  if (P.ONLY) {
    for (const n of P.LAYERS) {
      const o = e.scene.getObjectByName(n);
      if (o) o.visible = (n === P.ONLY);
    }
  }
  // Assert the thing being measured is actually in the scene and visible. A
  // disabled system measures beautifully.
  const sheet = e.scene.getObjectByName('WaterfallSheets');
  const alive = !!sheet && sheet.visible && sheet.parent?.visible !== false;

  // ── pick the fall this framing is actually looking at ─────────────────────
  cam.updateMatrixWorld(true);
  const proj = (x, y, z) => {
    const p = new THREE.Vector3(x, y, z).project(cam);
    return { x: (p.x * 0.5 + 0.5) * P.W, y: (-p.y * 0.5 + 0.5) * P.H, z: p.z, w: p.w };
  };
  let pick = null;
  const cands = [];
  const camAt = { x: +cam.position.x.toFixed(1), y: +cam.position.y.toFixed(1),
                  z: +cam.position.z.toFixed(1), n: wd.waterfalls.length };
  for (const wf of wd.waterfalls) {
    const mx = (wf.top[0] + wf.bottom[0]) / 2, mz = (wf.top[2] + wf.bottom[2]) / 2;
    const my = (wf.top[1] + wf.bottom[1]) / 2;
    const s = proj(mx, my, mz);
    const d = cam.position.distanceTo(new THREE.Vector3(mx, my, mz));
    cands.push({ h: +wf.height.toFixed(0), w: +wf.width.toFixed(1), d: +d.toFixed(0),
                 sx: +s.x.toFixed(0), sy: +s.y.toFixed(0), sz: +s.z.toFixed(2) });
    if (s.z < -1 || s.z > 1) continue;
    if (s.x < 0 || s.x > P.W || s.y < 0 || s.y > P.H) continue;
    // Prefer the tall near one in the middle of the frame.
    const score = wf.height / (1 + d * 0.02)
                / (1 + Math.hypot(s.x - P.W / 2, s.y - P.H / 2) / (P.W * 0.5));
    if (!pick || score > pick.score) pick = { wf, score, s, d, mx, my, mz };
  }
  if (!pick) return { error: 'no waterfall in frame', cands, camAt };

  const top = proj(pick.wf.top[0], pick.wf.top[1], pick.wf.top[2]);
  const bot = proj(pick.wf.bottom[0], pick.wf.bottom[1], pick.wf.bottom[2]);
  // Metres of world DROP per pixel of screen, measured through the projection
  // at the fall's own midpoint, so camera pitch and perspective are included.
  const a = proj(pick.mx, pick.my, pick.mz);
  const b = proj(pick.mx, pick.my - 1.0, pick.mz);
  const pxPerMetreDown = b.y - a.y;

  // ROI: the interior of the curtain. Its own silhouette edges are static
  // vertical features; including them pins the correlation at zero shift.
  const halfW = Math.max(2, Math.abs(pick.wf.width * 0.5 * pxPerMetreDown /
                          Math.max(1e-3, 1.0)) * 0.0 + 0);
  const wpx = (() => {
    const l = proj(pick.mx - pick.wf.width * 0.5, pick.my, pick.mz);
    const r = proj(pick.mx + pick.wf.width * 0.5, pick.my, pick.mz);
    return Math.abs(r.x - l.x);
  })();
  void halfW;
  const cx = (top.x + bot.x) / 2;
  // Wide, deliberately: the correlation is restricted to the MOVING columns
  // further down rather than to a guessed centreline. A fall meanders, the
  // sheet is drawn out to 1.25 half-widths and spreads as it falls, and a
  // narrow box centred on the average of the projected lip and foot lands
  // half on rock — which correlates at r 0.9 against itself and reports a
  // waterfall standing perfectly still. That is exactly the shape of failure
  // docs/CRITIC_PROTOCOL.md's table is about, and this tool produced it.
  const rx0 = Math.max(0, Math.round(cx - wpx * 1.00));
  const rx1 = Math.min(P.W, Math.round(cx + wpx * 1.00));
  const yA = Math.min(top.y, bot.y), yB = Math.max(top.y, bot.y);
  // Trim the ends: the lip taper and the plunge are not the curtain.
  const ry0 = Math.max(0, Math.round(yA + (yB - yA) * 0.18));
  const ry1 = Math.min(P.H, Math.round(yA + (yB - yA) * 0.86));
  if (rx1 - rx0 < 4 || ry1 - ry0 < 24) {
    return { error: `curtain too small on screen: ${rx1 - rx0}x${ry1 - ry0} px ` +
                    `(wpx ${wpx.toFixed(1)}, cx ${cx.toFixed(0)}, top ${top.y.toFixed(0)}, ` +
                    `bot ${bot.y.toFixed(0)}, camDist ${pick.d.toFixed(0)})`, cands, camAt };
  }

  // ── render by hand at chosen wall clocks ──────────────────────────────────
  e.stop();
  const canvas = e.renderer.domElement;
  const cw = canvas.width, ch = canvas.height;
  const gl = e.renderer.getContext();
  const buf = new Uint8Array(cw * ch * 4);
  const sx = cw / P.W, sy = ch / P.H;   // devicePixelRatio, if any

  const drawAt = (T) => {
    e.elapsed = T;
    for (const fn of e._updaters) fn(0, e.elapsed);
    for (const fn of e._lateUpdaters) fn(0, e.elapsed);
    if (e._render) e._render(0, e.elapsed); else e.renderer.render(e.scene, e.camera);
  };
  const grab = () => {
    e.renderer.setRenderTarget(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const w = Math.round((rx1 - rx0) * sx), h = Math.round((ry1 - ry0) * sy);
    const a = new Array(w * h);
    for (let y = 0; y < h; y++) {
      // GL origin is bottom-left.
      const gy = ch - 1 - (Math.round(ry0 * sy) + y);
      for (let x = 0; x < w; x++) {
        const o = (gy * cw + Math.round(rx0 * sx) + x) * 4;
        a[y * w + x] = (buf[o] * 0.299 + buf[o + 1] * 0.587 + buf[o + 2] * 0.114);
      }
    }
    return { w, h, a };
  };

  const runs = [];
  for (const T0 of P.T0S) {
    const frames = [];
    for (let k = 0; k < P.STEPS; k++) {
      const T = T0 + k * P.DT;
      drawAt(T);
      // The back buffer is occasionally read empty; re-render rather than
      // reporting a shift measured against a black frame.
      let f = grab(), mean = 0;
      for (let i = 0; i < f.a.length; i++) mean += f.a[i];
      mean /= f.a.length;
      if (mean < 2) { drawAt(T); f = grab(); }
      frames.push(f);
    }
    runs.push({ T0, frames });
  }
  e.start();

  return {
    alive,
    fall: { height: pick.wf.height, width: pick.wf.width, disc: pick.wf.discharge,
            dist: pick.d, topY: pick.wf.top[1], botY: pick.wf.bottom[1] },
    roi: { x0: rx0, x1: rx1, y0: ry0, y1: ry1 },
    pxPerMetreDown, screenTop: top.y, screenBot: bot.y,
    runs,
  };
}, { W, H, T0S, DT, STEPS, ONLY, LAYERS });

await browser.close();

if (cap.error) {
  console.error(`fallflow: ${cap.error}`);
  if (cap.camAt) console.error(`camera at ${JSON.stringify(cap.camAt)}`);
  if (cap.cands) console.error('candidates (h,w,dist,screen x,y,ndc z):\n' +
    cap.cands.map((c) => `  h${c.h} w${c.w} d${c.d}  (${c.sx},${c.sy}) z${c.sz}`).join('\n'));
  process.exit(1);
}
if (!cap.alive) console.error('fallflow: !! WaterfallSheets is not visible — measuring nothing');

// ── report ──────────────────────────────────────────────────────────────────

const f = cap.fall;
console.log(`fallflow  view=${VIEW}  only=${ONLY ?? 'all layers'}`);
console.log(`  fall     ${f.height.toFixed(1)} m tall, ${f.width.toFixed(1)} m wide, ` +
            `discharge ${f.disc.toFixed(2)}, ${f.dist.toFixed(0)} m from camera`);
console.log(`  roi      x ${cap.roi.x0}..${cap.roi.x1}, y ${cap.roi.y0}..${cap.roi.y1} ` +
            `(screen: lip y=${cap.screenTop.toFixed(0)}, foot y=${cap.screenBot.toFixed(0)})`);
console.log(`  scale    ${cap.pxPerMetreDown.toFixed(2)} px of screen per metre of world drop`);
console.log(`  sign     negative m/s = water moving DOWN. positive = flowing up the cliff.`);
console.log('');

const mps = (dyPx) => -(dyPx / cap.pxPerMetreDown) / DT;

/**
 * Keep only the columns that MOVE.
 *
 * The ROI is a box around the fall and a fall does not fill its box: it
 * meanders, it is drawn out to 1.25 half-widths, and it spreads as it falls.
 * Rock inside the box is bit-identical between two hand-rendered frames, so it
 * correlates with itself at r 0.9 at zero shift and outvotes the water — the
 * first run of this tool on the canonical world reported a 94 m waterfall
 * moving at -0.08 m/s with a correlation peak of 0.88, while its own
 * per-third profile showed the middle band at -9 m/s. A clean number about the
 * wrong object.
 *
 * Per column, the temporal RMS across the captured frames IS the water: only
 * the water changed. Keep the columns above a fraction of the strongest, and
 * report how many survived, so a run where nothing moved cannot masquerade as
 * a run where everything is still.
 */
function movingCols(frames, keepFrac = 0.35) {
  const { w, h } = frames[0];
  const rmsCol = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y < h; y++) {
      let m = 0;
      for (const f of frames) m += f.a[y * w + x];
      m /= frames.length;
      for (const f of frames) { const d = f.a[y * w + x] - m; acc += d * d; }
    }
    rmsCol[x] = Math.sqrt(acc / (h * frames.length));
  }
  let peak = 0;
  for (let x = 0; x < w; x++) peak = Math.max(peak, rmsCol[x]);
  const keep = [];
  for (let x = 0; x < w; x++) if (rmsCol[x] >= peak * keepFrac) keep.push(x);
  return { keep, peak };
}

/** Extract only the kept columns, as a narrower image. */
function subCols(fr, keep) {
  const a = new Float32Array(keep.length * fr.h);
  for (let y = 0; y < fr.h; y++)
    for (let i = 0; i < keep.length; i++) a[y * keep.length + i] = fr.a[y * fr.w + keep[i]];
  return { w: keep.length, h: fr.h, a };
}

let allV = [];
for (const run of cap.runs) {
  const sel = movingCols(run.frames);
  if (sel.keep.length < 3) {
    console.log(`  t=${String(run.T0).padStart(5)} s   !! only ${sel.keep.length} moving columns ` +
                `(peak temporal rms ${sel.peak.toFixed(2)}) — nothing in this ROI is animating`);
    continue;
  }
  run.cols = sel;
  const hp = run.frames.map((fr) =>
    highpass({ ...subCols(fr, sel.keep), a: Float32Array.from(subCols(fr, sel.keep).a) }));
  const vs = [], peaks = [];
  for (let k = 1; k < hp.length; k++) {
    const r = shiftNCC(hp[k - 1], hp[k], SHIFT);
    vs.push(mps(r.shift));
    peaks.push(r);
  }
  const med = [...vs].sort((a, b) => a - b)[vs.length >> 1];
  allV.push({ T0: run.T0, med, vs, peaks, contrast: rms(hp[0]) });
  console.log(`  t=${String(run.T0).padStart(5)} s   v_y = ${med >= 0 ? '+' : ''}${med.toFixed(2)} m/s   ` +
              `${med < 0 ? 'DOWN' : 'UP  '}   ` +
              `[${vs.map((x) => (x >= 0 ? '+' : '') + x.toFixed(1)).join(' ')}]  ` +
              `peak r ${peaks.map((p) => p.peak.toFixed(2)).join(' ')}  ` +
              `2nd ${peaks.map((p) => p.second.toFixed(2)).join(' ')}  ` +
              `contrast ${rms(hp[0]).toFixed(1)}  ` +
              `cols ${run.cols.keep.length}/${run.frames[0].w}`);
}
console.log('');
const meds = allV.map((a) => a.med);
const down = meds.filter((m) => m < 0).length;
console.log(`  VERDICT  ${down}/${meds.length} sampled wall clocks flow DOWN.  ` +
            `median over all: ${(meds.sort((a, b) => a - b)[meds.length >> 1]).toFixed(2)} m/s`);

// ── velocity PROFILE down the curtain ───────────────────────────────────────
//
// One shift for the whole strip is a compromise when the flow accelerates, and
// the compromise shows up as a lower correlation peak rather than as a wrong
// answer. Splitting the ROI into thirds and correlating each separately says
// whether the fall is speeding up on its way down, which is the other half of
// "does this read as falling water" — a curtain that translates rigidly reads
// as a scrolling texture whatever direction it scrolls in.
{
  const BANDS = 3;
  const rows = [];
  for (const run of cap.runs) {
    const per = [];
    for (let b = 0; b < BANDS; b++) {
      const vs = [];
      let peak = 0;
      const keep = run.cols?.keep ?? null;
      for (let k = 1; k < run.frames.length; k++) {
        const cut = (fr0) => {
          const fr = keep ? subCols(fr0, keep) : fr0;
          const y0 = Math.floor(fr.h * b / BANDS), y1 = Math.floor(fr.h * (b + 1) / BANDS);
          const a = new Float32Array(fr.w * (y1 - y0));
          for (let y = y0; y < y1; y++)
            for (let x = 0; x < fr.w; x++) a[(y - y0) * fr.w + x] = fr.a[y * fr.w + x];
          return highpass({ w: fr.w, h: y1 - y0, a });
        };
        const r = shiftNCC(cut(run.frames[k - 1]), cut(run.frames[k]), SHIFT);
        vs.push(mps(r.shift)); peak = Math.max(peak, r.peak);
      }
      per.push({ v: [...vs].sort((a, b2) => a - b2)[vs.length >> 1], peak });
    }
    rows.push({ T0: run.T0, per });
  }
  console.log('');
  console.log('  profile (top third / middle / bottom third of the curtain, m/s):');
  for (const r of rows) {
    console.log(`    t=${String(r.T0).padStart(5)} s  ` +
      r.per.map((p) => `${p.v >= 0 ? '+' : ''}${p.v.toFixed(1)} (r ${p.peak.toFixed(2)})`).join('   '));
  }
}

// ── self test ───────────────────────────────────────────────────────────────
if (has('selftest')) {
  const fr = cap.runs[0].frames[0];
  const A = highpass({ w: fr.w, h: fr.h, a: Float32Array.from(fr.a) });
  console.log('\n  selftest — recover a shift the estimator was handed:');
  for (const k of [-7, -3, 0, 3, 7]) {
    const b = new Float32Array(fr.w * fr.h);
    for (let y = 0; y < fr.h; y++) {
      const src = Math.min(fr.h - 1, Math.max(0, y - k));
      for (let x = 0; x < fr.w; x++) b[y * fr.w + x] = A.a[src * fr.w + x];
    }
    const r = shiftNCC(A, { w: fr.w, h: fr.h, a: b }, SHIFT);
    const ok = Math.abs(r.shift - k) < 0.6 ? 'ok  ' : 'FAIL';
    console.log(`    injected ${String(k).padStart(3)} px -> measured ${r.shift.toFixed(2)} px  ` +
                `(r ${r.peak.toFixed(3)})  ${ok}`);
  }
}

// ── optional ROI strip, so the frames can be looked at ──────────────────────
if (OUT) {
  const frames = cap.runs[0].frames;
  const w = frames[0].w, h = frames[0].h, gap = 6;
  const tw = frames.length * (w + gap) - gap;
  const px = new Uint8Array(tw * h * 3).fill(24);
  frames.forEach((fr, i) => {
    const ox = i * (w + gap);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const val = Math.max(0, Math.min(255, Math.round(fr.a[y * w + x])));
        const o = (y * tw + ox + x) * 3;
        px[o] = px[o + 1] = px[o + 2] = val;
      }
    }
  });
  const p = resolve(OUT);
  mkdirSync(dirname(p), { recursive: true });
  writePNG(p, { w: tw, h, px });
  console.log(`\n  strip: ${p}  (${frames.length} frames, ${DT}s apart, t0=${cap.runs[0].T0})`);
}

if (errors.length) console.error(`\n  page errors: ${errors.slice(0, 4).join(' | ')}`);
