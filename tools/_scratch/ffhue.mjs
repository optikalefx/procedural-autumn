#!/usr/bin/env node
/**
 * Scratch: the HUE census — find every visibly lit firefly in a frame WITHOUT
 * assuming it is already the right colour, and print its composited RGB.
 *
 * ffzoom/ffblink's detector is `g > 90 && g - b > 30`, which is a *green* test:
 * it can only ever find the insects that already pass, and the defect being
 * chased here is dim fireflies coming out pale BLUE. So the finder has to be
 * hue-blind, and a luma-peak finder is not good enough either — moonlit grass
 * sparkle produces hundreds of 6-count peaks and drowns the signal.
 *
 * The instrument that works is a paired frame with the WORLD CLOCK STOPPED:
 *
 *   · `ctx.worldPaused = true` is photo mode's freeze — every system still runs
 *     but with dt 0 and a stopped `worldT`, so every shader-time animation
 *     holds its exact frame. Grass, water, wildlife and the firefly blink all
 *     stand still.
 *   · Frame A is captured with the fireflies in, frame B with `ff.update`
 *     stubbed and the points hidden. Nothing else in the frame can have moved,
 *     so A-B is EXACTLY the light the fireflies added, per pixel, whatever hue
 *     it is.
 *   · Sites are the local maxima of that difference. For each one the report
 *     prints the composited pixel (what the player sees), the background under
 *     it (frame B), and the insect's own contribution.
 *
 * "Visibly lit" is --minadd (default 20/255 on the strongest channel of a 3x3
 * mean). The separation is wide, so the exact value does not matter: a real
 * insect adds 50-240 counts and what is left of the grain after the 3x3 mean
 * tops out at 13.
 *
 * The bar: every visibly lit firefly must composite to R > B.
 *
 *   AUTUMN_URL=http://127.0.0.1:5205 node tools/_scratch/ffhue.mjs \
 *       --view camp,bank --hour 22 --samples 4
 */
import { chromium } from 'playwright';
import { acquire } from './../_lock.mjs';
import { POSE_SRC } from './../_pose.mjs';
import { VIEWS } from './../shot.mjs';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { readPNG } from './../_pngread.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '?seed=' + arg('seed', '20261018');
const views = String(arg('view', 'camp')).split(',');
const hour = Number(arg('hour', '22'));
const dir = arg('dir', 'shots/ff-hue');
const samples = Number(arg('samples', '4'));
const gap = Number(arg('gap', '260'));
const minAdd = Number(arg('minadd', '20'));
const tag = arg('tag', '');
const listAll = argv.includes('--all');

const EXTRA = {
  camp: { anchor: 'meadow', height: 1.7, dist: 8, pitch: -0.06, fov: 60 },
  bank: { anchor: 'mouth', height: 2.0, dist: 14, pitch: -0.10, fov: 60 },
};
const ALL = { ...VIEWS, ...EXTRA };

await acquire('ffhue');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/POSTHOG/.test(m.text())) console.log('CERR', m.text()); });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

let frozen = null;
for (const f of ['review/anchors.json', 'shots/_anchors.json']) {
  if (existsSync(f)) { try { frozen = { ...JSON.parse(readFileSync(f, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ } }
}
const poseFn = new Function('P', POSE_SRC);
mkdirSync(dir, { recursive: true });
await p.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
// --gain/--cut sweep the calibration without an edit (an edit mid-capture is a
// reload, which aborts the run); --noveil/--nobloom/--nograde are the ablations
// that say which pass a stray colour belongs to.
await p.evaluate((o) => {
  const u = window.__systems.wildlife.fireflies?.uniforms ?? {};
  if (o.gain != null && u.uGain) u.uGain.value = o.gain;
  if (o.cut != null && u.uCut) u.uCut.value = o.cut;
  // --hide names OBJECTS in the scene, not systems: the question this answers is
  // "which thing drawn over a firefly is dimming it", and the answer is a
  // normal-blended particle at renderOrder >= 4.
  if (o.hide) {
    const re = new RegExp(o.hide, 'i');
    let n = 0;
    window.__ctx.scene.traverse((ob) => { if (re.test(ob.name || '')) { ob.visible = false; n++; } });
    console.log('hid', n, 'objects matching', o.hide);
  }
  const fx = window.__postfx ?? window.__systems?.postfx;
  if (fx) {
    if (o.noveil && fx.veil) fx.veil.enabled = false;
    if (o.nobloom && fx.bloom) fx.bloom.enabled = false;
    if (o.nograde && fx.grade) fx.grade.uniforms?.get?.('uRodAmount') &&
      (fx.grade.uniforms.get('uRodAmount').value = 0);
  }
}, {
  gain: arg('gain', null) == null ? null : Number(arg('gain')),
  cut: arg('cut', null) == null ? null : Number(arg('cut')),
  hide: arg('hide', null),
  noveil: argv.includes('--noveil'),
  nobloom: argv.includes('--nobloom'),
  nograde: argv.includes('--nograde'),
});

const summary = [];
for (const view of views) {
  await p.evaluate(poseFn, { v: ALL[view], frozen, dynamic: ['vehicle'] });
  await p.evaluate(async () => { if (window.__settleStable) await window.__settleStable(); await window.__settle(400); });

  const rows = [];
  for (let k = 0; k < samples; k++) {
    // let the blink advance, then stop the world
    await p.evaluate(() => { window.__ctx.worldPaused = false; });
    await p.waitForTimeout(k === 0 ? 200 : gap);
    await p.evaluate(async () => { window.__ctx.worldPaused = true; await window.__settle(40); });
    const fa = `${dir}/${view}-h${String(hour).replace('.', 'p')}${tag}-${k}-on.png`;
    const fb = `${dir}/${view}-h${String(hour).replace('.', 'p')}${tag}-${k}-off.png`;
    await p.screenshot({ path: fa });
    await p.evaluate(async () => {
      const ff = window.__systems.wildlife.fireflies;
      if (!ff._saved) ff._saved = ff.update;
      ff.update = () => { ff.points.visible = false; };
      ff.points.visible = false;
      await window.__settle(40);
    });
    await p.screenshot({ path: fb });
    await p.evaluate(async () => {
      const ff = window.__systems.wildlife.fireflies;
      if (ff._saved) { ff.update = ff._saved; ff._saved = null; }
      ff.points.visible = true;
      await window.__settle(6);
    });

    const A = readPNG(fa), B = readPNG(fb);
    const W = A.w, H = A.h;
    // The pair is not perfectly matched, and the mismatch is NOT a global
    // constant: the ground comes back a few counts brighter in one frame than
    // the other while the sky is untouched (the grade's grain runs on wall time
    // and the exposure keeps crawling). A single whole-frame offset therefore
    // leaves half the frame reading as +6 and the census fills with grass. So
    // the baseline is LOCAL — the median of the difference around a ring at
    // radius 7, which is pure drift because an insect is a few pixels across —
    // and it is subtracted per candidate.
    const dif = new Int16Array(W * H * 3);
    const add = new Int16Array(W * H);      // strongest added channel, per pixel
    for (let i = 0, n = W * H; i < n; i++) {
      const j = i * 3;
      const d0 = A.px[j] - B.px[j], d1 = A.px[j + 1] - B.px[j + 1], d2 = A.px[j + 2] - B.px[j + 2];
      dif[j] = d0; dif[j + 1] = d1; dif[j + 2] = d2;
      add[i] = Math.max(d0, d1, d2);
    }
    const ringMedian = (buf, stride, x, y, c) => {
      const v = [];
      for (let a = 0; a < 20; a++) {
        const th = (a / 20) * Math.PI * 2;
        const rx = Math.round(x + Math.cos(th) * 7), ry = Math.round(y + Math.sin(th) * 7);
        if (rx < 0 || ry < 0 || rx >= W || ry >= H) continue;
        v.push(buf[(ry * W + rx) * stride + c]);
      }
      v.sort((p, q) => p - q);
      return v.length ? v[v.length >> 1] : 0;
    };
    // THE GRAIN IS THE OTHER CONTAMINANT, and it is bigger than the signal
    // being looked for. The grade adds `(n - 0.5) * uGrain` in display-linear
    // light off a hash of wall-clock time, so a pair of frames differs by a
    // fresh grain field even with the world stopped — and a fixed linear step
    // on a near-black pixel is a LARGE sRGB step, measured at 15-17 counts on
    // the darkest channel. At minadd 6 the census came back 12,000 "fireflies"
    // whose added light was red-dominant, which is not a colour this shader can
    // emit: it was grain on pixels whose red channel was near zero.
    //
    // Grain is per-pixel independent and an insect covers several pixels, so a
    // 3x3 mean separates them cleanly — it divides the grain by three and
    // leaves a dot alone. Detection runs on the mean; the RGB reported is still
    // the raw pixel, because that is what the player sees.
    const sm = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += add[(y + dy) * W + x + dx];
        sm[y * W + x] = s / 9;
      }
    }
    // local maxima of the added light
    for (let y = 3; y < H - 3; y++) {
      for (let x = 3; x < W - 3; x++) {
        const v = sm[y * W + x];
        if (v < minAdd) continue;
        let isMax = true;
        for (let dy = -3; dy <= 3 && isMax; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            if (!dx && !dy) continue;
            if (sm[(y + dy) * W + (x + dx)] > v) { isMax = false; break; }
          }
        }
        if (!isMax) continue;
        // THE LAKE DOES NOT FREEZE. `worldPaused` stops the world clock, but the
        // water surface's sparkle is still different between the two frames of a
        // pair, so over open water every candidate has a big difference and the
        // mouth anchor came back with 310 "fireflies", ~290 of them a uniform
        // srgb(75,92,144) speck. That is the pair failing to match, not an
        // insect. Where the pair does not match, the whole NEIGHBOURHOOD is
        // noisy — so measure that noise on the ring and require a candidate to
        // stand well clear of it. Real insects add 150-230 counts against a
        // water sparkle floor of 40-55, so the two do not overlap.
        const lift = v - ringMedian(sm, 1, x, y, 0);
        if (lift < minAdd) continue;                             // local drift, not an insect
        let noise = 0;
        {
          const nv = [];
          for (let a = 0; a < 20; a++) {
            const th = (a / 20) * Math.PI * 2;
            const rx = Math.round(x + Math.cos(th) * 7), ry = Math.round(y + Math.sin(th) * 7);
            if (rx < 0 || ry < 0 || rx >= W || ry >= H) continue;
            nv.push(Math.abs(sm[ry * W + rx]));
          }
          nv.sort((p, q) => p - q);
          noise = nv.length ? nv[nv.length >> 1] : 0;
        }
        if (lift < 2.2 * noise) continue;                        // unmatched pair, not an insect
        // The peak of the 3x3 MEAN can sit a pixel off the brightest raw pixel,
        // and a row that reports the wrong pixel of the right insect is a row
        // about nothing. Step to the strongest raw pixel within +/-2 and report
        // that: an insect's colour is the colour of its core.
        let bx = x, by = y, best = -1e9;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const q = add[(y + dy) * W + (x + dx)];
            if (q > best) { best = q; bx = x + dx; by = y + dy; }
          }
        }
        const j = (by * W + bx) * 3;
        const ad = [0, 1, 2].map((c) => dif[j + c] - ringMedian(dif, 3, bx, by, c));
        if (Math.max(...ad) < minAdd) continue;
        if (rows.some((q) => Math.abs(q.x - bx) <= 5 && Math.abs(q.y - by) <= 5)) continue;
        rows.push({
          x: bx, y: by, k,
          rgb: [A.px[j], A.px[j + 1], A.px[j + 2]],
          bg: [A.px[j] - ad[0], A.px[j + 1] - ad[1], A.px[j + 2] - ad[2]],
          add: ad,
          v: Math.max(...ad),
        });
      }
    }
  }
  await p.evaluate(() => { window.__ctx.worldPaused = false; });

  rows.sort((a, b) => b.v - a.v);
  console.log(`\n=== ${view} h${hour}${tag ? ' ' + tag : ''} — ${rows.length} visibly lit fireflies over ${samples} frozen frames (minadd ${minAdd}) ===`);
  console.log('   rank    x    y     composited RGB       background        firefly adds      R-B');
  const bad = rows.filter((q) => q.rgb[0] - q.rgb[2] <= 0);
  rows.forEach((q, i) => {
    const rb = q.rgb[0] - q.rgb[2];
    const show = listAll || i < 14 || i >= rows.length - 10 || rb <= 0;
    if (!show) return;
    console.log(`   ${String(i).padStart(4)} ${String(q.x).padStart(4)} ${String(q.y).padStart(4)}   ` +
      `${q.rgb.map((v) => String(v).padStart(3)).join(',')}   ` +
      `${q.bg.map((v) => String(v).padStart(3)).join(',')}   ` +
      `${q.add.map((v) => String(v).padStart(4)).join(',')}   ` +
      `${String(rb).padStart(4)}${rb > 0 ? '' : ' <<BLUE'}`);
  });
  const third = Math.max(1, Math.ceil(rows.length / 3));
  const mean = (l, k) => (l.length ? Math.round(l.reduce((a, q) => a + q.rgb[k], 0) / l.length) : 0);
  const q1 = rows.slice(0, third), q3 = rows.slice(-third);
  console.log(`   brightest third mean rgb(${mean(q1, 0)},${mean(q1, 1)},${mean(q1, 2)})   ` +
              `dimmest third mean rgb(${mean(q3, 0)},${mean(q3, 1)},${mean(q3, 2)})`);
  console.log(`   VERDICT ${view}: ${bad.length} of ${rows.length} visibly lit fireflies have R <= B` +
              (bad.length ? '  — FAIL' : '  — pass'));
  summary.push(`${view}: ${bad.length}/${rows.length} blue`);
}
console.log('\nSUMMARY ' + summary.join('   |   '));
await b.close();
