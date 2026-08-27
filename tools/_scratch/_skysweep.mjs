#!/usr/bin/env node
/**
 * _skysweep — does the hunt's sky rule fire when it should, and only then?
 *
 *   node tools/_scratch/_skysweep.mjs --dir /tmp/skysweep
 *
 * Four things, in one boot:
 *
 *  1. **Coverage.** Every id in `SKY_OBJECTS` has a row in `hunt_detect`'s
 *     `SKY_ITEM`. That table is the one translation table in the hunt and it
 *     fails silently if the catalogue grows; this is the tripwire its note
 *     promises.
 *  2. **It fires.** The camera aimed dead centre at each of the eight objects,
 *     at every stop of both lenses and the eyepiece, against the item the
 *     detector actually returns. Prints the whole ladder so the boundary can
 *     be read rather than asserted.
 *  3. **It does not fire otherwise, in daylight.** The file's own standing
 *     sweep: 800 random points across the valley at midday, random bearing,
 *     random pitch inside +-0.25 rad, at the play field of view.
 *  4. **It does not fire otherwise, at night, on the long lens.** The
 *     adversarial version, which is the one that matters for these items: 800
 *     random points at 23:00 with a 400 mm lens fitted and the camera pointed
 *     anywhere in the upper hemisphere.
 *
 * GPU args are not optional: without them Chromium runs this game under 1 fps
 * and every state-dependent step silently reads the boot pose.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = resolve(arg('dir', '/tmp/skysweep'));
const N = parseInt(arg('n', '800'), 10);
const SEED = arg('seed', '20261018');
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
console.log('booted\n');

await page.evaluate(() => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  window.__ctx.worldPaused = true;
});

// ── 1 + 2 ────────────────────────────────────────────────────────────────────
const ladder = await page.evaluate(async () => {
  const { detectSubjects, _internals } = await import('/src/game/hunt_detect.js');
  const { SKY_OBJECTS } = await import('/src/game/sky_objects.js');
  const missing = SKY_OBJECTS.filter((o) => !_internals.SKY_ITEM[o.id]).map((o) => o.id);

  window.__lighting.hour = 23.0;
  await window.__settle(20);
  const a = window.__cameraAnchors.vista();
  const cam = window.__ctx.camera;
  cam.position.set(a.x, window.__world.getHeight(a.x, a.z) + 40, a.z);

  const stops = [
    ['wide24', 45.8], ['wide70', 16.5], ['scope18', 18.0], ['scope6', 6.0],
    ['tele200', 5.8], ['tele300', 3.87], ['tele400', 2.9],
  ];
  const rows = [];
  for (const o of SKY_OBJECTS) {
    const md = window.__lighting.computeMoonDir(23.0);
    const d = o.live ? [md.x, md.y, md.z] : [o.dir.x, o.dir.y, o.dir.z];
    const row = { id: o.id, item: _internals.SKY_ITEM[o.id], hits: {} };
    for (const [name, fov] of stops) {
      cam.fov = fov; cam.updateProjectionMatrix();
      cam.lookAt(cam.position.x + d[0] * 1000, cam.position.y + d[1] * 1000, cam.position.z + d[2] * 1000);
      cam.updateMatrixWorld(true);
      const got = detectSubjects(window.__ctx);
      row.hits[name] = got.includes(row.item);
    }
    rows.push(row);
  }

  // And the framing gate, walked off centre at 400 mm on the moon: how far can
  // the subject sit from the middle before it stops being the photograph?
  const md = window.__lighting.computeMoonDir(23.0);
  cam.fov = 2.9; cam.updateProjectionMatrix();
  const off = [];
  for (let k = 0; k <= 20; k++) {
    const tilt = (k / 20) * 2.0;                     // degrees off centre, vertical
    const p = Math.asin(md.y) + tilt * Math.PI / 180;
    const yaw = Math.atan2(md.x, md.z);
    cam.lookAt(cam.position.x + Math.sin(yaw) * Math.cos(p) * 1000,
               cam.position.y + Math.sin(p) * 1000,
               cam.position.z + Math.cos(yaw) * Math.cos(p) * 1000);
    cam.updateMatrixWorld(true);
    off.push({ tilt: +tilt.toFixed(2), hit: detectSubjects(window.__ctx).includes('moon') });
  }
  return { missing, rows, off };
});

console.log('SKY_ITEM coverage:', ladder.missing.length === 0
  ? 'PASS — every catalogue id has a row'
  : `FAIL — no row for ${ladder.missing.join(', ')}`);
console.log('\naimed dead centre, does the item come back?');
console.log('object      item     wide24 wide70 scope18 scope6 tele200 tele300 tele400');
for (const r of ladder.rows) {
  console.log(r.id.padEnd(11), (r.item ?? '-').padEnd(8),
    ['wide24', 'wide70', 'scope18', 'scope6', 'tele200', 'tele300', 'tele400']
      .map((k, i) => (r.hits[k] ? 'yes' : ' . ').padStart([7, 7, 8, 7, 8, 8, 8][i])).join(''));
}
console.log('\nthe moon at 400 mm, walked off centre (frame half-height is 1.45 deg):');
console.log(ladder.off.map((o) => `${o.tilt}${o.hit ? '+' : '-'}`).join(' '));

// ── 3, 4 ─────────────────────────────────────────────────────────────────────
async function sweep(label, { hour, fov, pitchLo, pitchHi, seed }) {
  const res = await page.evaluate(async ({ hour, fov, pitchLo, pitchHi, seed, N }) => {
    const { detectSubjects } = await import('/src/game/hunt_detect.js');
    window.__lighting.hour = hour;
    await window.__settle(20);
    const cam = window.__ctx.camera;
    cam.fov = fov; cam.updateProjectionMatrix();
    // A named, reproducible stream — Math.random would make this unrepeatable.
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const tally = {}, poses = [];
    for (let i = 0; i < N; i++) {
      const x = (rnd() - 0.5) * 3000, z = (rnd() - 0.5) * 3000;
      const g = window.__world.getHeight(x, z);
      if (!Number.isFinite(g)) { i--; continue; }
      cam.position.set(x, g + 1.7, z);
      const yaw = rnd() * Math.PI * 2;
      const pitch = pitchLo + rnd() * (pitchHi - pitchLo);
      cam.lookAt(x + Math.sin(yaw) * Math.cos(pitch) * 100,
                 g + 1.7 + Math.sin(pitch) * 100,
                 z + Math.cos(yaw) * Math.cos(pitch) * 100);
      cam.updateMatrixWorld(true);
      const got = detectSubjects(window.__ctx);
      for (const id of got) tally[id] = (tally[id] ?? 0) + 1;
      if (got.length) poses.push({ x: +x.toFixed(1), z: +z.toFixed(1), yaw: +yaw.toFixed(3), pitch: +pitch.toFixed(3), got });
    }
    return { tally, poses };
  }, { hour, fov, pitchLo, pitchHi, seed, N });
  console.log(`\n${label}: ${N} poses`);
  const keys = Object.keys(res.tally).sort();
  console.log(keys.length ? keys.map((k) => `  ${k}: ${res.tally[k]} (${(100 * res.tally[k] / N).toFixed(1)}%)`).join('\n')
                          : '  nothing at all');
  writeFileSync(resolve(OUT, `${label.replace(/\W+/g, '_')}.json`), JSON.stringify(res, null, 1));
  return res;
}

await sweep('day-midday-fov50', { hour: 12.0, fov: 50, pitchLo: -0.25, pitchHi: 0.25, seed: 12345 });
await sweep('night-2300-fov50', { hour: 23.0, fov: 50, pitchLo: -0.25, pitchHi: 0.25, seed: 999 });
await sweep('night-2300-tele400-anywhere', { hour: 23.0, fov: 2.9, pitchLo: -0.20, pitchHi: 1.35, seed: 4242 });
await sweep('night-2300-tele400-b', { hour: 23.0, fov: 2.9, pitchLo: -0.20, pitchHi: 1.35, seed: 777 });

// ── what it costs ────────────────────────────────────────────────────────────
const cost = await page.evaluate(async () => {
  const { detectSubjects } = await import('/src/game/hunt_detect.js');
  const { SKY_OBJECTS } = await import('/src/game/sky_objects.js');
  const cam = window.__ctx.camera;
  const out = {};
  const time = (label, n = 400) => {
    for (let i = 0; i < 50; i++) detectSubjects(window.__ctx);   // warm
    const t0 = performance.now();
    for (let i = 0; i < n; i++) detectSubjects(window.__ctx);
    out[label] = +((performance.now() - t0) * 1000 / n).toFixed(2);
  };

  // Worst case for the sky branch: night, long lens, aimed at the moon from
  // the valley floor, so the share and edge gates pass and the march runs the
  // full length of the ray.
  window.__lighting.hour = 23.0;
  await window.__settle(20);
  const md = window.__lighting.computeMoonDir(23.0);
  const g = window.__world.getHeight(0, 0);
  cam.position.set(0, g + 1.7, 0);
  cam.fov = 2.9; cam.updateProjectionMatrix();
  cam.lookAt(md.x * 1000, cam.position.y + md.y * 1000, md.z * 1000);
  cam.updateMatrixWorld(true);
  time('night, 400 mm, on the moon (march runs)');

  // Night, long lens, aimed at nothing: eight share tests and no march.
  cam.lookAt(1000, cam.position.y + 900, 0);
  cam.updateMatrixWorld(true);
  time('night, 400 mm, aimed at empty sky');

  // The ordinary case: daylight, play fov. The night gate is one multiply.
  window.__lighting.hour = 12.0;
  await window.__settle(20);
  cam.fov = 50; cam.updateProjectionMatrix();
  cam.lookAt(1000, cam.position.y, 0);
  cam.updateMatrixWorld(true);
  time('midday, play fov (night gate rejects)');
  void SKY_OBJECTS;
  return out;
});
console.log('\ndetectSubjects, microseconds per call, 400 calls after 50 warm:');
for (const [k, v] of Object.entries(cost)) console.log(`  ${k.padEnd(44)} ${v} us`);

console.log('\nwrote', OUT);
await browser.close();
