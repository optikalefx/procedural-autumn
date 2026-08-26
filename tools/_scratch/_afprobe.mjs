// Why is the first frame of photo mode blurry?
//
// Three candidates, all measured here rather than argued about:
//   1. the autofocus lands somewhere wrong,
//   2. it lands right but LATE, and the frames before it are drawn at the seed,
//   3. it lands right and on time, and the DEPTH OF FIELD IS SIMPLY TOO THIN
//      to have anything else in it.
//
// So: sample the seed, sample every frame of the settle, and then sample the
// frame's own depth on a 7x7 grid and report what fraction of it falls inside
// the band `lensInfo()` says is sharp. A blurry picture with a correct focus
// number is candidate 3 and nothing else.
import { chromium } from 'playwright';

const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const HMR = () => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, p);
  };
};

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(HMR);
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0]));
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
await page.waitForTimeout(1500);

// Frame-by-frame through the settle. Hooked before the toggle so frame 0 is
// the first frame photo mode ever draws.
const trace = await page.evaluate(async () => {
  const hud = window.__systems.hud;
  const fx = window.__postfx;
  const rig = window.__systems.cameraRig;
  const rows = [];
  const seed = rig?.freeDist;
  hud.togglePhoto();
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const L = fx.lensInfo?.();
    rows.push({
      i,
      dist: +hud.photo.focus.distance.toFixed(3),
      read: (() => { const d = fx.readDepthAt?.(0.5, 0.5); return d == null ? null : +d.toFixed(3); })(),
      near: L ? +L.near.toFixed(2) : null,
      far: L ? (Number.isFinite(L.far) ? +L.far.toFixed(2) : 'inf') : null,
      f: L?.fStop ?? null,
    });
  }
  return { seed: seed == null ? null : +seed.toFixed(3), rows };
});
console.log('seed (rig.freeDist) =', trace.seed);
for (const r of trace.rows) {
  console.log(`  f${String(r.i).padStart(2)}  focus ${String(r.dist).padStart(8)}  centreDepth ${String(r.read).padStart(9)}` +
              `  band ${String(r.near).padStart(7)} – ${String(r.far).padStart(7)}  f/${r.f}`);
}

// What is actually in the frame, and how much of it the band holds.
const census = await page.evaluate(() => {
  const fx = window.__postfx;
  const L = fx.lensInfo();
  const N = 9;
  const ds = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = fx.readDepthAt((x + 0.5) / N, (y + 0.5) / N);
      ds.push(d == null || !Number.isFinite(d) ? null : d);
    }
  }
  const solid = ds.filter((d) => d != null);
  const inBand = solid.filter((d) => d >= L.near && d <= L.far).length;
  solid.sort((a, b) => a - b);
  return {
    fStop: L.fStop, focus: +L.focus.toFixed(2),
    near: +L.near.toFixed(2), far: Number.isFinite(L.far) ? +L.far.toFixed(2) : 'inf',
    hyperfocal: +L.hyperfocal.toFixed(1), format: +L.format.toFixed(1), focal: L.focal,
    samples: ds.length, sky: ds.length - solid.length, solid: solid.length,
    inBand, pctOfSolidSharp: +(100 * inBand / Math.max(1, solid.length)).toFixed(1),
    depthP10: +solid[Math.floor(solid.length * 0.1)]?.toFixed(2),
    depthMedian: +solid[Math.floor(solid.length * 0.5)]?.toFixed(2),
    depthP90: +solid[Math.floor(solid.length * 0.9)]?.toFixed(2),
  };
});
console.log('\nFRAME CENSUS', JSON.stringify(census, null, 2));

// The same census at every stop the ladder has: which aperture would put the
// scene in focus?
const sweep = await page.evaluate(() => {
  const fx = window.__postfx;
  const focus = window.__systems.hud.photo.focus;
  const N = 9;
  const ds = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = fx.readDepthAt((x + 0.5) / N, (y + 0.5) / N);
      if (d != null && Number.isFinite(d)) ds.push(d);
    }
  }
  const out = [];
  for (const f of [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22]) {
    focus.setAperture(f);
    const L = fx.lensInfo();
    out.push({
      f: L.fStop,
      near: +L.near.toFixed(2),
      far: Number.isFinite(L.far) ? +L.far.toFixed(1) : Infinity,
      pctSharp: +(100 * ds.filter((d) => d >= L.near && d <= L.far).length / ds.length).toFixed(1),
    });
  }
  return out;
});
console.log('\nAPERTURE SWEEP (same frame, same focus)');
for (const r of sweep) {
  console.log(`  f/${String(r.f).padEnd(4)} sharp ${String(r.near).padStart(7)} – ${String(r.far).padStart(8)} m   ${String(r.pctSharp).padStart(5)}% of frame`);
}
await b.close();
