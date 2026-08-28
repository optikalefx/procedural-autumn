#!/usr/bin/env node
/**
 * _ffcal — how many fireflies are actually in the picture?
 *
 *   node tools/_scratch/_ffcal.mjs --dir /tmp/ffcal --n 36
 *   node tools/_scratch/_ffcal.mjs --rate 400          (rate only, no frames)
 *
 * `hunt_detect.js`'s `FF_MIN` is a threshold on an ESTIMATE of the population
 * drawing in frame, and the only thing that makes such a threshold honest is a
 * measured relation between that estimate and the flashes a person can point
 * at in the photograph. The file's header carried exactly that calibration and
 * carried it with a disclaimer: the frames and the counting script "lived in a
 * scratch directory that is not in this checkout". This is that calibration,
 * re-shot, in the checkout.
 *
 * ── how a flash is counted ──────────────────────────────────────────────────
 *
 * Not by hunting a colour. The same way every other size in this feature is
 * measured: render the pose TWICE, once with `Fireflies.points` visible and
 * once hidden, and take the connected components of changed pixels. The world
 * is paused for both frames or the wind moves every blade of grass between
 * them and the largest changed blob is the meadow.
 *
 * ── two populations, and why the settling differs ───────────────────────────
 *
 * `--n` poses are FILMED, so they are teleported and then left to settle with
 * `__settleStable`: chunk streaming, grass and the swarm's own damped habitat
 * (`_hab`, a 1.5 s time constant) all have to arrive before the frame means
 * anything. That is seconds a pose and it is why the filmed set is small.
 *
 * `--rate` poses are only COUNTED, and `ffCount` reads the bake and the
 * uniforms and never the scene, so they need no streaming — only `_hab`, which
 * is converged by calling the system's own `update` three times with a large
 * dt rather than by waiting. That makes a 400-pose rate sweep cheap and it is
 * exact for the estimator, which is the thing `FF_MIN` is a threshold on.
 *
 * GPU args are not optional: without them Chromium runs this game under 1 fps
 * and every state-dependent step silently reads the boot pose.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPNG } from '../_pngread.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = resolve(arg('dir', '/tmp/ffcal'));
const N = parseInt(arg('n', '36'), 10);
const RATE = parseInt(arg('rate', '400'), 10);
const HOUR = parseFloat(arg('hour', '21.5'));
const SEED = arg('seed', '20261018');
const RSEED = parseInt(arg('rseed', '20260826'), 10);
const LO = parseFloat(arg('lo', '20'));
const HI = parseFloat(arg('hi', '1e9'));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {},
               addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
});
page.on('pageerror', (e) => console.log('  [page error]', String(e)));
await page.goto(`${URL}/?seed=${SEED}&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
console.log('booted');

await page.evaluate(async ({ hour }) => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  window.__lighting.hour = hour;
  window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  const hudRoot = window.__systems.hud?.root;
  if (hudRoot) hudRoot.style.display = 'none';

  // Hiding the swarm by setting `points.visible = false` DOES NOT HOLD, and it
  // cost a whole run to notice. `Fireflies.update` re-derives that flag from
  // its two ramps every frame, and a paused world still calls every system's
  // update with dt 0 — so the flag is back before the next screenshot and the
  // "off" frame is identical to the "on" one. (Measured: max channel-sum
  // difference 32, which is the post chain's own dither, and not one pixel of
  // firefly.) So the toggle is patched into the system's own update, once, the
  // same way `_skyshots.mjs` patches the sky's.
  const ff0 = window.__systems.wildlife?.fireflies;
  if (ff0 && !ff0.__hidePatched) {
    const orig = ff0.update.bind(ff0);
    ff0.update = (...a) => { orig(...a); if (window.__ffHide && ff0.points) ff0.points.visible = false; };
    ff0.__hidePatched = true;
  }
  window.__ffHide = false;
  await window.__settle(30);
}, { hour: HOUR });

/** Connected components of changed pixels, with their areas. */
function flashes(a, b, thresh = 60, minArea = 2) {
  const { w, h, px: da } = a; const db = b.px;
  const on = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    const d = Math.abs(da[p] - db[p]) + Math.abs(da[p + 1] - db[p + 1]) + Math.abs(da[p + 2] - db[p + 2]);
    if (d > thresh) on[i] = 1;
  }
  const stack = new Int32Array(w * h);
  let n = 0, total = 0, biggest = 0;
  for (let i = 0; i < w * h; i++) {
    if (!on[i]) continue;
    let sp = 0, area = 0;
    stack[sp++] = i; on[i] = 0;
    while (sp) {
      const j = stack[--sp];
      const x = j % w, y = (j / w) | 0;
      area++;
      if (x > 0 && on[j - 1]) { on[j - 1] = 0; stack[sp++] = j - 1; }
      if (x < w - 1 && on[j + 1]) { on[j + 1] = 0; stack[sp++] = j + 1; }
      if (y > 0 && on[j - w]) { on[j - w] = 0; stack[sp++] = j - w; }
      if (y < h - 1 && on[j + w]) { on[j + w] = 0; stack[sp++] = j + w; }
    }
    total += area;
    if (area > biggest) biggest = area;
    if (area >= minArea) n++;
  }
  return { flashes: n, litPx: total, biggest };
}

// ── the rate sweep ───────────────────────────────────────────────────────────
const rate = await page.evaluate(async ({ RATE, RSEED }) => {
  const { detectSubjects, _internals } = await import('/src/game/hunt_detect.js');
  const ff = window.__systems.wildlife?.fireflies;
  const cam = window.__ctx.camera;
  window.__ctx.worldPaused = true;
  cam.fov = 50; cam.updateProjectionMatrix();
  let s = RSEED >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const rows = [];
  for (let i = 0; i < RATE; i++) {
    const x = (rnd() - 0.5) * 3000, z = (rnd() - 0.5) * 3000;
    const g = window.__world.getHeight(x, z);
    if (!Number.isFinite(g)) { i--; continue; }
    cam.position.set(x, g + 1.7, z);
    const yaw = rnd() * Math.PI * 2;
    const pitch = -0.25 + rnd() * 0.5;
    cam.lookAt(x + Math.sin(yaw) * Math.cos(pitch) * 100,
               g + 1.7 + Math.sin(pitch) * 100,
               z + Math.cos(yaw) * Math.cos(pitch) * 100);
    cam.updateMatrixWorld(true);
    // Converge the damped habitat through the system's own code.
    for (let k = 0; k < 3; k++) ff?.update?.(4.0, performance.now() / 1000);
    const est = _internals.ffCount(_internals.frameOf(window.__ctx), ff);
    rows.push({ x: +x.toFixed(1), z: +z.toFixed(1), yaw: +yaw.toFixed(3),
                pitch: +pitch.toFixed(3), est: +est.toFixed(1),
                hit: detectSubjects(window.__ctx).includes('fireflies') });
  }
  return rows;
}, { RATE, RSEED });
writeFileSync(resolve(OUT, 'rate.json'), JSON.stringify(rate, null, 1));

const ests = rate.map((r) => r.est).sort((a, b) => a - b);
const q = (p) => ests[Math.min(ests.length - 1, Math.floor(p * ests.length))];
console.log(`\nrate sweep: ${rate.length} random night poses at ${HOUR}, play fov, pitch +-0.25`);
console.log('  est quantiles  p50', q(0.5).toFixed(1), ' p75', q(0.75).toFixed(1),
            ' p80', q(0.80).toFixed(1), ' p90', q(0.90).toFixed(1),
            ' p95', q(0.95).toFixed(1), ' max', ests[ests.length - 1].toFixed(1));
for (const t of [110, 150, 200, 250, 280, 300, 320, 340, 360, 380, 400, 420, 450, 500]) {
  const n = rate.filter((r) => r.est >= t).length;
  console.log(`  FF_MIN ${String(t).padStart(4)}  ->  ${String(n).padStart(3)} of ${rate.length}  (${(100 * n / rate.length).toFixed(1)}%)`);
}
console.log('  detector agrees with est at the live FF_MIN:',
  rate.filter((r) => r.hit).length, 'credited');

// ── the filmed calibration ───────────────────────────────────────────────────
console.log(`\nfilming ${N} poses (settled) — est against flashes actually in the frame`);
const rows = [];
// Draw the filmed set from the same stream, but keep only poses with SOME
// swarm: a pose whose estimate is zero teaches nothing about the boundary, and
// the boundary is what is being set. The zero poses are already counted, in
// the rate table above.
const cand = rate.filter((r) => r.est >= LO && r.est <= HI);
const pick = [];
for (let i = 0; i < N && cand.length; i++) pick.push(cand[Math.floor((i / N) * cand.length)]);
for (let i = 0; i < pick.length; i++) {
  const p = pick[i];
  const info = await page.evaluate(async ({ p }) => {
    const { _internals } = await import('/src/game/hunt_detect.js');
    const ff = window.__systems.wildlife?.fireflies;
    const cam = window.__ctx.camera;
    window.__ctx.worldPaused = false;
    cam.fov = 50; cam.updateProjectionMatrix();
    const g = window.__world.getHeight(p.x, p.z);
    cam.position.set(p.x, g + 1.7, p.z);
    cam.lookAt(p.x + Math.sin(p.yaw) * Math.cos(p.pitch) * 100,
               g + 1.7 + Math.sin(p.pitch) * 100,
               p.z + Math.cos(p.yaw) * Math.cos(p.pitch) * 100);
    cam.updateMatrixWorld(true);
    await window.__settleStable(900, 24);
    await window.__settle(240);
    window.__ctx.worldPaused = true;
    cam.updateMatrixWorld(true);
    return { est: _internals.ffCount(_internals.frameOf(window.__ctx), ff),
             visible: !!ff?.points?.visible,
             density: ff?.uniforms?.uDensity?.value ?? -1,
             opacity: ff?.uniforms?.uOpacity?.value ?? -1 };
  }, { p });
  const on = resolve(OUT, `p${String(i).padStart(2, '0')}-on.png`);
  const off = resolve(OUT, `p${String(i).padStart(2, '0')}-off.png`);
  await page.screenshot({ path: on });
  await page.evaluate(async () => {
    window.__ffHide = true;
    const ff = window.__systems.wildlife?.fireflies;
    if (ff?.points) ff.points.visible = false;
    await window.__settle(6);
  });
  await page.screenshot({ path: off });
  await page.evaluate(async () => {
    window.__ffHide = false;
    const ff = window.__systems.wildlife?.fireflies;
    if (ff?.points) ff.points.visible = true;
    await window.__settle(4);
  });
  const f = flashes(readPNG(on), readPNG(off));
  rows.push({ i, ...p, estSettled: +info.est.toFixed(1), density: +info.density.toFixed(3),
              ...f, on });
  console.log(`  p${String(i).padStart(2, '0')}  est ${String(Math.round(info.est)).padStart(5)}` +
              `  hab ${info.density.toFixed(2)}  flashes ${String(f.flashes).padStart(4)}` +
              `  lit px ${String(f.litPx).padStart(6)}`);
}
writeFileSync(resolve(OUT, 'filmed.json'), JSON.stringify(rows, null, 1));
console.log('\nwrote', OUT);
await browser.close();
