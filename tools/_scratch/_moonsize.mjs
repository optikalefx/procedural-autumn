#!/usr/bin/env node
/**
 * _moonsize — how big is the moon on the WIDE lens, stop by stop?
 *
 *   node tools/_scratch/_moonsize.mjs --dir /tmp/moonsize
 *
 * `_skyshots.mjs` measured the eight sky objects at the seven stops that
 * bracket the whole instrument set, which is what the original `SKY_MIN`
 * thresholds were read off. It does not answer the question this run asks,
 * because it only samples the wide lens at its two ENDS (24 and 70 mm) and the
 * shot in question — a night landscape with a moon in it, the composition the
 * user asked to have credited — sits in the middle of that zoom ring, around
 * 35-40 mm.
 *
 * So this walks the 24-70 in nine steps at a fixed pose, and for each one
 * reports three things side by side:
 *
 *   · the share `hunt_detect.skyObjects` computes  (2·rad / vfov)
 *   · a measured pixel height, by the same subject-on / subject-off difference
 *     `_skyshots` uses — here with the moon's two uniforms zeroed and the stars
 *     left alone, so every changed pixel belongs to the subject
 *   · whether `detectSubjects` actually returns 'moon' for that frame
 *
 * The third column is the point: it is the real detector on a real frame, not
 * the arithmetic re-derived in a harness, so it moves when the threshold moves.
 *
 * **What the measured column is, exactly.** `moon.js` draws a disc inside a
 * halo "several times the width of the disc", and the halo is bright — at a
 * difference threshold of 90 the blob is the halo's core, not the body, and it
 * runs a steady **3.30-3.37x** the predicted disc across the eight rungs from
 * 28 mm up. That constant ratio is what this column is for: the thing on screen
 * scales exactly with `2·rad / vfov`, which is what "the share arithmetic and
 * the frames agree" means in `hunt_detect.js`'s header.
 *
 * The 24 mm rung is off that line — 4.88x — and I do not have a confirmed
 * cause, so it is reported rather than explained. The likeliest one is the
 * post chain: removing the moon from a 50 deg field changes the frame's
 * average brightness more than removing it from a 33 deg field, and a
 * difference measure cannot tell an exposure shift from a subject. It does not
 * affect the gate, which never looks at a pixel.
 *
 * The DISC has no difference threshold that isolates it — the crescent's lit
 * limb is near-white and its earthshine body sits a few levels above sky — so
 * it was measured off a luma profile straight through the centre of
 * `moon-38mm.png` instead, where the body's edge is a clean step (133 -> 238 on
 * the lit limb, 147 -> 133 on the dark one): **67 px against a predicted 65**,
 * which is the 3% the header claims for this angular range.
 *
 * The pose is deliberately NOT dead centre. The moon is offset to ride about
 * two thirds up the frame with terrain along the bottom, because that is the
 * photograph being argued about, and because centring it would leave `EDGE`
 * untested.
 *
 * `--aspect` because the gate is a share of frame HEIGHT, so the window's
 * shape moves it: the same lens is a bigger share in a letterbox. Default is
 * 1.60, the shape of the user's screenshot; pass 1.7778 for the 16:9 the
 * `hunt_detect.js` header quotes all its numbers in.
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
const OUT = resolve(arg('dir', '/tmp/moonsize'));
const HOUR = parseFloat(arg('hour', '23.0'));
const SEED = arg('seed', '20261018');
const ASPECT = parseFloat(arg('aspect', '1.60'));
const H = parseInt(arg('h', '1080'), 10);
const W = Math.round(H * ASPECT);
// Where in the frame the moon should sit, as a fraction of half the frame
// height above centre. 0.62 puts it on the upper third with room to spare
// inside EDGE (0.84), which is where it is in the photograph.
const RIDE = parseFloat(arg('ride', '0.62'));
const MM = (arg('mm', '24,28,32,35,38,42,50,60,70')).split(',').map(Number);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

// Neuter Vite's HMR client before any page script runs — peers edit this tree
// and a save would reload the page mid-run. Same stub as tools/shot.mjs.
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

// Mark the journal intro as already seen, BEFORE the app reads its store.
// `HUD.maybeShowIntro` auto-opens the book on a first run, it draws after the
// post chain so hiding the HUD root does not touch it, and Playwright hands
// every run a fresh profile — so every run is a first run. Closing it from the
// setup step is a race that this harness lost one run in two: the book had not
// opened yet when setup ran, and nine frames came back with a title leaf across
// the sky. Latch the flag instead of racing the timer.
await page.addInitScript(() => {
  try {
    const K = 'pa.hud';
    const s = JSON.parse(localStorage.getItem(K) || '{}');
    s.introSeen = true; s.seenHint = true;
    localStorage.setItem(K, JSON.stringify(s));
  } catch { /* a first run with no storage is the case this is fixing */ }
});
page.on('pageerror', (e) => console.log('  [page error]', String(e)));

await page.goto(`${URL}/?seed=${SEED}&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
console.log('booted');

const setup = await page.evaluate(async ({ hour }) => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  window.__lighting.hour = hour;
  window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  window.__ctx.worldPaused = true;
  const hudRoot = window.__systems.hud?.root;
  if (hudRoot) hudRoot.style.display = 'none';

  // The journal auto-opens on a first run and it is drawn AFTER the post chain
  // (main.js: "The journal draws AFTER the post chain"), so hiding the HUD root
  // does not touch it — the first version of this harness photographed nine
  // frames of the title leaf. Put it down and wait for the 0.46 s animation to
  // finish, because `active` drops on the frame close() is called and
  // `visible` is the one that says the book has left the screen.
  const journal = window.__systems.hud?.journal;
  if (journal?.active || journal?.visible) {
    journal.close();
    for (let i = 0; i < 120 && journal.visible; i++) await window.__settle(2);
  }

  // Stand on a vista, a little above the trees, so the moon has clear sky and
  // the bottom of the frame still has ground in it.
  const a = window.__cameraAnchors.vista();
  const cam = window.__ctx.camera;
  cam.position.set(a.x, window.__world.getHeight(a.x, a.z) + 25, a.z);

  // The sky's own draw gate, patched once so a toggle survives the RAF loop:
  // Sky.update() rewrites these uniforms from SKY_STATE every frame.
  const sky = window.__sky;
  if (!sky.__killPatched) {
    const orig = sky.update.bind(sky);
    sky.update = (...args) => {
      orig(...args);
      // The MOON only, not the whole night sky. `_skyshots` zeroes
      // `uStarAmount` and `uMilkyWay` here too, and its own comment promises a
      // centre crop that its `blob()` never actually applies — so on a wide
      // frame the largest changed region it finds is the star field, not the
      // subject. Measured that way the moon reads 120 px at 24 mm against a
      // predicted 43, and saturates at 184 px from 42 mm up, which is the
      // Milky Way rather than anything the gate is about. Killing the two moon
      // uniforms alone leaves the stars identical in both frames, so every
      // changed pixel belongs to the subject.
      if (window.__skyKill) {
        sky.uniforms.uMoonDiscI.value = 0;
        sky.uniforms.uMoonHaloI.value = 0;
      }
    };
    sky.__killPatched = true;
  }
  window.__skyKill = false;

  // The real modules, not a copy of their arithmetic.
  window.__LM = await import('/src/photo/lens_models.js');
  window.__HD = await import('/src/game/hunt_detect.js');

  await window.__settle(30);
  const md = window.__lighting.computeMoonDir(hour);
  return {
    moonDir: [md.x, md.y, md.z],
    eye: cam.position.toArray(),
    skyMin: window.__HD._internals.SKY_MIN,
    starCube: window.__sky.uniforms.uStarAmount.value ** 3,
  };
}, { hour: HOUR });

console.log('posed at', setup.eye.map((v) => v.toFixed(1)).join(', '),
            ' moonDir', setup.moonDir.map((v) => v.toFixed(3)).join(', '),
            ' starAmount^3', setup.starCube.toFixed(3));
console.log('SKY_MIN in force:', JSON.stringify(setup.skyMin));
console.log(`viewport ${W}x${H}  aspect ${ASPECT}\n`);

/** Largest connected blob of changed pixels, and its bounding box. */
function blob(a, b, thresh = 10) {
  const { w, h, px: da } = a;
  const db = b.px;
  const on = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    const d = Math.abs(da[p] - db[p]) + Math.abs(da[p + 1] - db[p + 1]) + Math.abs(da[p + 2] - db[p + 2]);
    if (d > thresh) on[i] = 1;
  }
  let best = null;
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!on[i]) continue;
    let sp = 0, area = 0;
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    stack[sp++] = i; on[i] = 0;
    while (sp) {
      const j = stack[--sp];
      const x = j % w, y = (j / w) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && on[j - 1]) { on[j - 1] = 0; stack[sp++] = j - 1; }
      if (x < w - 1 && on[j + 1]) { on[j + 1] = 0; stack[sp++] = j + 1; }
      if (y > 0 && on[j - w]) { on[j - w] = 0; stack[sp++] = j - w; }
      if (y < h - 1 && on[j + w]) { on[j + w] = 0; stack[sp++] = j + w; }
    }
    if (!best || area > best.area) best = { area, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  return best ?? { area: 0, w: 0, h: 0 };
}

const rows = [];
console.log('  mm   vfov    share   pred px   halo px  ratio   glow   ndc.y   detectSubjects');
for (const mm of MM) {
  const st = await page.evaluate(async ({ dir, mm, aspect, ride }) => {
    const cam = window.__ctx.camera;
    cam.fov = window.__LM.cameraFovForFocal(mm, aspect);
    cam.updateProjectionMatrix();
    cam.lookAt(cam.position.x + dir[0] * 1000,
               cam.position.y + dir[1] * 1000,
               cam.position.z + dir[2] * 1000);
    // Pitch down so the moon rides high in the frame instead of dead centre.
    const half = cam.fov * Math.PI / 360;
    cam.rotateX(-Math.atan(ride * Math.tan(half)));
    cam.updateMatrixWorld(true);
    window.__skyKill = false;
    await window.__settle(6);

    // Where the moon actually landed, in NDC, by the detector's own maths.
    const THREE = window.__THREE;
    const v = new THREE.Vector3(dir[0], dir[1], dir[2])
      .transformDirection(cam.matrixWorldInverse)
      .applyMatrix4(cam.projectionMatrix);
    return { fov: cam.fov, ndcX: v.x, ndcY: v.y };
  }, { dir: setup.moonDir, mm, aspect: ASPECT, ride: RIDE });

  const onP = resolve(OUT, `moon-${mm}mm.png`);
  await page.screenshot({ path: onP });
  const hits = await page.evaluate(() => window.__HD.detectSubjects(window.__ctx));
  await page.evaluate(async () => { window.__skyKill = true; await window.__settle(6); });
  const offP = resolve(OUT, '_off.png');
  await page.screenshot({ path: offP });
  // Two thresholds: the disc is near-white against a dark sky, the halo is a
  // few levels of lift around it. 10 catches both, 90 is the disc alone — and
  // the disc is what `rad` describes and what the gate is a promise about.
  const A = readPNG(onP), B = readPNG(offP);
  const bl = blob(A, B, 90);      // the halo's core — see the header
  const glow = blob(A, B, 10);    // the halo out to where it meets the sky

  const share = (2 * 1.0) / st.fov;              // SKY_OBJECTS moon rad = 1.0 deg
  rows.push({ mm, fov: +st.fov.toFixed(2), share: +share.toFixed(4),
              predPx: Math.round(share * H), haloH: bl.h, haloW: bl.w,
              glowH: glow.h, ratio: +(bl.h / (share * H)).toFixed(2),
              ndcY: +st.ndcY.toFixed(3), hits });
  console.log(`${String(mm).padStart(4)}  ${st.fov.toFixed(1).padStart(5)}  ` +
              `${share.toFixed(4)}  ${String(Math.round(share * H)).padStart(6)}  ` +
              `${String(bl.h).padStart(6)}  ${(bl.h / (share * H)).toFixed(2)}x  ` +
              `${String(glow.h).padStart(5)}  ${st.ndcY.toFixed(3).padStart(6)}   ` +
              `${hits.includes('moon') ? 'MOON' : '—   '}  [${hits.join(' ')}]`);
}
writeFileSync(resolve(OUT, 'rows.json'), JSON.stringify({ aspect: ASPECT, H, skyMin: setup.skyMin, rows }, null, 1));
console.log('\nwrote', OUT);
await browser.close();
