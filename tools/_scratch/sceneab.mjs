// Interleaved A/B of SCENE-side variants at a pinned resolution.
//
// The scene-side twin of postab.mjs, and it exists for the same reason: this
// machine drifts by 2-3x over a couple of minutes, so a block of a few seconds
// per arm measures the drift and not the change. Two 22 s dprtest runs of the
// same build, back to back, came out at 82.6 and 14.6 fps here. Alternating
// fast — a couple of dozen frames per arm, every arm sampled inside every
// minute, each arm compared to the baseline measured in its own cycle — is the
// only thing that has produced a repeatable number on this box.
//
// Adaptive resolution is pinned off, so a cheaper arm cannot silently earn a
// higher resolution and make the comparison measure nothing.
//
// Arms are plain JS evaluated with (E, S, T, L, R, THREE) in scope:
//   E = engine   S = systems   T = terrain   L = lighting   R = renderer
// Every arm is preceded by a reset that restores the visible/castShadow state
// of every object that existed at start, plus the sun's shadow settings.
//
//   node tools/_scratch/sceneab.mjs --w 2560 --h 1400 --dpr 2 --scale 0.55 \
//     --arms "base=::noshadow=L.sun.castShadow=false"
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const W = parseInt(arg('w', '2560'), 10);
const H = parseInt(arg('h', '1400'), 10);
const DPR = parseFloat(arg('dpr', '2'));
const SCALE = parseFloat(arg('scale', '0.55'));
const CYCLES = parseInt(arg('cycles', '20'), 10);
const WARM = parseInt(arg('warm', '10'), 10);
const MEAS = parseInt(arg('meas', '20'), 10);
const RES = arg('res', '1536');
const PORT = arg('port', '5178');
const ARMS = arg('arms', 'base=').split('::').map((s) => {
  const i = s.indexOf('=');
  return { label: s.slice(0, i), js: s.slice(i + 1) };
});

const RESET = `
  E.scene.traverse((o) => {
    const s = window.__snap.get(o.uuid);
    if (!s) return;
    if (o.visible !== s.v) o.visible = s.v;
    if (o.castShadow !== s.c) o.castShadow = s.c;
  });
  if (L && L.sun) {
    L.sun.castShadow = true;
    if (L.sun.shadow.mapSize.x !== window.__snapMap) {
      L.sun.shadow.mapSize.set(window.__snapMap, window.__snapMap);
      if (L.sun.shadow.map) { L.sun.shadow.map.dispose(); L.sun.shadow.map = null; }
    }
  }
`;

await acquire('perf');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
  await page.routeWebSocket(new RegExp(`^wss?://(localhost|127\\.0\\.0\\.1):${PORT}/`), () => {});
  await page.goto(`http://127.0.0.1:${PORT}/?res=${RES}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

  const info = await page.evaluate((scale) => {
    const e = window.__engine;
    e.adaptive = false;
    e.resolutionScale = scale;
    e._applyResolution();

    window.__snap = new Map();
    e.scene.traverse((o) => window.__snap.set(o.uuid, { v: o.visible, c: o.castShadow }));
    window.__snapMap = window.__lighting?.sun?.shadow?.mapSize?.x ?? 0;

    window.__block = ({ js, warm, meas, reset }) => new Promise((res) => {
      // eslint-disable-next-line no-new-func
      new Function('E', 'S', 'T', 'L', 'R', 'THREE', 'window', reset + '\n' + js)(
        e, window.__systems, window.__terrain, window.__lighting, e.renderer, window.__THREE, window);
      const ts = []; let n = 0, last = 0;
      const step = () => {
        const t = performance.now();
        if (n > warm) ts.push(t - last);
        last = t; n++;
        if (ts.length >= meas) { res(ts); return; }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    const input = window.__ctx.input;
    const t0 = performance.now();
    window.__d = true;
    const tick = () => {
      if (!window.__d) return;
      const t = (performance.now() - t0) / 1000;
      input.axes.throttle = 1; input.axes.brake = 0;
      input.axes.steer = Math.sin(t * 0.42) * 0.75;
      requestAnimationFrame(tick);
    };
    tick();

    const c = e.renderer.domElement;
    return { drawingBuffer: [c.width, c.height], megapixels: +((c.width * c.height) / 1e6).toFixed(2),
             shadowMap: window.__snapMap };
  }, SCALE);
  console.error('[sceneab] ' + JSON.stringify(info));

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const perCycle = new Map(ARMS.map((a) => [a.label, []]));
  for (let r = 0; r < CYCLES; r++) {
    const order = r % 2 ? [...ARMS].reverse() : ARMS;
    for (const a of order) {
      const ts = await page.evaluate((o) => window.__block(o), { js: a.js, warm: WARM, meas: MEAS, reset: RESET });
      perCycle.get(a.label).push(med(ts));
    }
    if ((r + 1) % 5 === 0) process.stderr.write(`[sceneab] cycle ${r + 1}/${CYCLES}\n`);
  }

  const base = ARMS[0].label;
  const baseAbs = med(perCycle.get(base));
  console.log(`\n${info.megapixels} MP  ${info.drawingBuffer.join('x')}  shadowMap ${info.shadowMap}  ${CYCLES} cycles x ${MEAS} frames`);
  console.log(`baseline "${base}" median cycle p50 = ${baseAbs.toFixed(2)} ms  (${(1000 / baseAbs).toFixed(1)} fps)`);
  console.log('  ' + 'arm'.padEnd(22) + 'x_base'.padStart(9) + 'iqr'.padStart(9) + 'norm_ms'.padStart(9) + 'd_ms'.padStart(8) + '  d_%');
  for (const a of ARMS) {
    const ratios = perCycle.get(a.label).map((v, i) => v / perCycle.get(base)[i]).sort((x, y) => x - y);
    const rr = med(ratios);
    const iqr = ratios[Math.floor(ratios.length * 0.75)] - ratios[Math.floor(ratios.length * 0.25)];
    console.log('  ' + a.label.padEnd(22) + rr.toFixed(3).padStart(9) + iqr.toFixed(3).padStart(9) +
      (rr * baseAbs).toFixed(2).padStart(9) + ((rr - 1) * baseAbs).toFixed(2).padStart(8) +
      '  ' + ((rr - 1) * 100).toFixed(1) + '%');
  }
} finally {
  await browser.close().catch(() => {});
}
