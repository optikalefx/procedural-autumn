// Interleaved A/B of post-chain variants at a PINNED resolution.
//
// THE MEASUREMENT PROBLEM THIS SOLVES. This machine is shared: another author's
// headless captures and the player's own Chrome are on it, and its throughput
// drifts by 2-3x over a couple of minutes. Blocks of a few seconds per arm
// therefore measure the drift, not the change — an arm can come out "slower"
// than a strictly-cheaper arm purely by landing in a bad minute.
//
// Two things that look like the answer and are not:
//   * gputime.mjs's per-pass TIME_ELAPSED spans. The fixed cost of a span on
//     this driver is enormous — the HDR sanity blit, one full-screen read and
//     write, measures 13 ms there, which is physically impossible. Its per-pass
//     shares are indicative; its absolutes are not.
//   * one TIME_ELAPSED span around the whole frame. Measured 151 ms/frame while
//     wall clock said 26 ms, i.e. it is counting time the GPU spent scheduling
//     other clients. Under contention it is no better than wall clock.
//
// What works is alternating FAST — a couple of dozen frames per arm — so every
// arm samples the same minute, and comparing each arm to the baseline measured
// in its own cycle. Drift then cancels instead of accumulating.
//
// Adaptive resolution is switched OFF and the scale pinned, so every arm draws
// exactly the same number of pixels; otherwise a cheaper arm silently earns a
// higher resolution and the comparison measures nothing.
//
//   node tools/_scratch/postab.mjs --w 2560 --h 1400 --dpr 2 --scale 0.55 \
//     --arms "base=::noao=P.ao.enabled=false"
//
// Every arm is prefixed with a reset, so arms are independent. Arms that force
// a shader recompile (anything touching ao.configuration.aoSamples, or the
// effect list) need a longer --warm than ones that only flip a boolean.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const W = parseInt(arg('w', '2560'), 10);
const H = parseInt(arg('h', '1400'), 10);
const DPR = parseFloat(arg('dpr', '2'));
const SCALE = parseFloat(arg('scale', '0.55'));
const CYCLES = parseInt(arg('cycles', '24'), 10);
const WARM = parseInt(arg('warm', '10'), 10);
const MEAS = parseInt(arg('meas', '20'), 10);
const RES = arg('res', '1536');
const PORT = arg('port', '5178');
const ARMS = arg('arms', 'base=').split('::').map((s) => {
  const i = s.indexOf('=');
  return { label: s.slice(0, i), js: s.slice(i + 1) };
});

// Restores the shipped chain before each arm applies its own change.
const RESET = `
  if (P.ao) {
    P.ao.enabled = true;
    const c = P.ao.configuration, d = window.__aoDefaults;
    for (const k in d) if (c[k] !== d[k]) c[k] = d[k];
  }
  P.sanity.enabled = true;
  if (P.dof) { P.dof.resolution.height = window.__dofH; P.dof.bokehScale = window.__dofBokeh; }
  window.__rebuild(window.__defaultEffects);
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
    const e = window.__engine, P = window.__ctx.postfx;
    e.adaptive = false;
    e.resolutionScale = scale;
    e._applyResolution();

    if (P.ao) {
      const c = P.ao.configuration;
      window.__aoDefaults = {
        aoSamples: c.aoSamples, denoiseSamples: c.denoiseSamples,
        denoiseIterations: c.denoiseIterations, denoiseRadius: c.denoiseRadius,
        depthAwareUpsampling: c.depthAwareUpsampling, halfRes: c.halfRes,
      };
    }
    if (P.dof) { window.__dofH = P.dof.resolution.height; window.__dofBokeh = P.dof.bokehScale; }

    // Rebuild the merged EffectPass from a name list.
    window.__defaultEffects = P.mainPass.effects.map((x) => x.name);
    window.__rebuild = (names) => {
      const cur = P.mainPass.effects.map((x) => x.name);
      if (cur.length === names.length && cur.every((n, i) => n === names[i])) return;
      const pool = {};
      for (const k of ['dof', 'bloom', 'tone', 'vignette', 'grade', 'smaa']) {
        if (P[k]) pool[P[k].name] = P[k];
      }
      const eff = names.map((n) => pool[n]).filter(Boolean);
      // setEffects + recompile, NOT a new pass: EffectPass.dispose() disposes
      // the effects themselves, which are shared with PostFX.
      P.mainPass.setEffects(eff);
      P.mainPass.recompile();
      P.mainPass.initialize(window.__engine.renderer, false, window.__THREE.HalfFloatType);
    };

    // One measurement block: apply the arm, burn `warm` frames, time `meas`.
    window.__block = ({ js, warm, meas, reset }) => new Promise((res) => {
      // eslint-disable-next-line no-new-func
      new Function('P', 'window', 'THREE', reset + '\n' + js)(P, window, window.__THREE);
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

    // Drive, so the measurement covers a moving scene like the player's.
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

    const c = window.__engine.renderer.domElement;
    return {
      effects: window.__defaultEffects,
      drawingBuffer: [c.width, c.height],
      megapixels: +((c.width * c.height) / 1e6).toFixed(2),
    };
  }, SCALE);
  console.error('[postab] ' + JSON.stringify(info));

  const med = (arr) => { const s = [...arr].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const perCycle = new Map(ARMS.map((a) => [a.label, []]));
  for (let r = 0; r < CYCLES; r++) {
    // Alternate direction so an arm's position in the cycle does not correlate
    // with the drift.
    const order = r % 2 ? [...ARMS].reverse() : ARMS;
    for (const a of order) {
      const ts = await page.evaluate((o) => window.__block(o),
        { js: a.js, warm: WARM, meas: MEAS, reset: RESET });
      perCycle.get(a.label).push(med(ts));
    }
    if ((r + 1) % 4 === 0) process.stderr.write(`[postab] cycle ${r + 1}/${CYCLES}\n`);
  }

  const baseLabel = ARMS[0].label;
  const baseAbs = med(perCycle.get(baseLabel));
  console.log(`\n${info.megapixels} MP  ${info.drawingBuffer.join('x')}  ${CYCLES} cycles x ${MEAS} frames (warm ${WARM})`);
  console.log(`baseline "${baseLabel}" median cycle p50 = ${baseAbs.toFixed(2)} ms  (${(1000 / baseAbs).toFixed(1)} fps)`);
  console.log('  ' + 'arm'.padEnd(22) + 'x_base'.padStart(9) + 'iqr'.padStart(9) + 'norm_ms'.padStart(9) + 'd_ms'.padStart(8) + '  d_%');
  for (const a of ARMS) {
    const ratios = perCycle.get(a.label).map((v, i) => v / perCycle.get(baseLabel)[i]).sort((x, y) => x - y);
    const rr = med(ratios);
    const iqr = ratios[Math.floor(ratios.length * 0.75)] - ratios[Math.floor(ratios.length * 0.25)];
    console.log('  ' + a.label.padEnd(22) + rr.toFixed(3).padStart(9) + iqr.toFixed(3).padStart(9) +
      (rr * baseAbs).toFixed(2).padStart(9) + ((rr - 1) * baseAbs).toFixed(2).padStart(8) +
      '  ' + ((rr - 1) * 100).toFixed(1) + '%');
  }
} finally {
  await browser.close().catch(() => {});
}
