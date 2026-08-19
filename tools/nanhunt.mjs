// Hunt non-finite pixels in the scene HDR buffer WHILE DRIVING, and attribute
// them to a system.
//
// Why this exists when nansweep.mjs already scans for non-finite HDR pixels:
// nansweep poses a canonical camera, lets the world settle, and then samples.
// A settled frame is the one condition under which this defect does not fire.
// Streaming, LOD hand-over, instance re-uploads and wind phase only advance
// while the camper is moving, so the camera has to be moving too.
//
// On a hit it does not stop at "there was a NaN": it re-renders the identical
// frame with one system hidden at a time and re-reads the buffer, because
// hiding the object is the only test that proves which system drew it. A
// material override only proves one material path is uninvolved.
//
// Exit code is 1 if any non-finite pixel was seen, so this can gate a build.
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);

const PORT = arg('port', '5178');
const SECONDS = parseFloat(arg('seconds', '60'));
const RES = arg('res', '768');
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
const QUALITY = arg('quality', null);
const BISECT = !has('nobisect');

await acquire('nanhunt');
// --headed runs the full browser rendering path (real compositor, real GPU
// process) instead of the stripped-down old headless one. The window is parked
// far off-screen and never brought to front: this machine belongs to somebody,
// and a capture tool that pops a Chrome window onto their desktop every time it
// runs is not one anybody will keep running.
const browser = await chromium.launch({ headless: !has('headed'), args: [
  '--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization', '--disable-frame-rate-limit',
  ...(has('headed') ? [`--window-position=-4000,-4000`, `--window-size=${W},${H}`] : [])] });
// Every exit path closes the browser. Orphaned Chromiums have been left behind
// in this project before, and an orphaned headed one holds a window open.
const closeBrowser = async () => { try { await browser.close(); } catch { /* already gone */ } };
process.on('exit', () => { browser.close().catch(() => {}); });
process.on('SIGINT', async () => { await closeBrowser(); process.exit(130); });
process.on('SIGTERM', async () => { await closeBrowser(); process.exit(143); });
let out;
try {
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(new RegExp(`^wss?://(localhost|127\\.0\\.0\\.1):${PORT}/`), () => {});
const q = new URLSearchParams({ res: RES }); if (QUALITY) q.set('quality', QUALITY);
await page.goto(`http://127.0.0.1:${PORT}/?${q}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.waitForTimeout(1500);

const pre = arg('eval', null);
if (pre) await page.evaluate((src) => eval(src), pre);

out = await page.evaluate(async ({ SECONDS, BISECT }) => {
  const e = window.__engine, ctx = window.__ctx, r = e.renderer, pf = ctx.postfx;
  const S = window.__systems ?? ctx.systems ?? {};
  const input = ctx.input;

  // Sample UPSTREAM of the HDR sanity pass.
  //
  // This is not optional and it is easy to get wrong: composer.inputBuffer
  // after a full render holds the sanitised buffer, so with the guard on, this
  // tool reports a clean run even when a material is emitting NaN on every
  // frame — verified, 0/943 with the camper bug deliberately reintroduced. The
  // guard's job is to stop a source becoming a black square; this tool's job is
  // to find the source. Leaving it on would turn the regression test into a
  // test of the guard.
  const hadSanity = pf.sanity ? pf.sanity.enabled : null;
  if (pf.sanity) pf.sanity.enabled = false;

  // Half-float: exponent all ones is Inf or NaN. This is the cause the black
  // square is the symptom of, so it is what gets counted.
  const nonFinite = (buf) => {
    let bad = 0, at = null;
    for (let i = 0; i < buf.length; i++) {
      if (((buf[i] >> 10) & 0x1f) === 0x1f) { bad++; if (!at) { const p = i >> 2; at = [p % 0xffff, i]; } }
    }
    return { bad, at };
  };

  const rt = () => pf.composer.inputBuffer;
  let buf = null, bw = 0, bh = 0;
  const read = () => {
    const t = rt(); if (t.width !== bw || t.height !== bh) { bw = t.width; bh = t.height; buf = new Uint16Array(bw * bh * 4); }
    r.readRenderTargetPixels(t, 0, 0, bw, bh, buf);
    let bad = 0, fx = -1, fy = -1;
    for (let i = 0; i < buf.length; i++) {
      if (((buf[i] >> 10) & 0x1f) === 0x1f) { bad++; if (fx < 0) { const p = i >> 2; fx = p % bw; fy = (p / bw) | 0; } }
    }
    return { bad, fx, fy };
  };
  void nonFinite;

  const candidates = () => [
    ['grass', S.grass?.group],
    ['groundCover', S.groundCover?.group],
    ['trees (all)', S.trees?.group],
    ['tree impostors', S.trees?.farMesh],
    ['rocks', S.rocks?.group],
    ['terrain', ctx.terrain?.group],
    ['water', S.water?.group ?? e.scene.getObjectByName('Water')],
    ['waterfalls', S.waterfalls?.group],
    ['clouds', S.clouds?.group],
    ['sky', ctx.sky?.mesh ?? e.scene.getObjectByName('Sky')],
    ['weather.leaves', S.weather?.leaves?.mesh],
    ['weather.motes', S.weather?.motes?.points],
    ['weather.shafts', S.weather?.shafts?.mesh ?? S.weather?.shafts?.group],
    ['weather.ground', S.weather?.ground?.mesh ?? S.weather?.ground?.group],
    ['wildlife', S.wildlife?.group],
    ['birds', S.wildlife?.birds?.group],
    ['vehicle rig', S.vehicle?.group ?? e.scene.getObjectByName('vehicleRig')],
    ['vehicle FX', e.scene.getObjectByName('vehicleParticles')],
    ['tyre tracks', e.scene.getObjectByName('tyreTracks')],
  ];

  const P = { n: 0, hits: 0, worst: 0, events: [], t0: performance.now() };
  window.__nanDrive = true;
  const tick = () => {
    if (!window.__nanDrive) return;
    const t = (performance.now() - P.t0) / 1000;
    input.axes.throttle = 1; input.axes.brake = 0; input.axes.steer = Math.sin(t * 0.42) * 0.75;
    requestAnimationFrame(tick);
  };
  tick();

  await new Promise((resolve) => {
    const step = () => {
      const a = read();
      P.n++;
      if (a.bad) {
        P.hits++; if (a.bad > P.worst) P.worst = a.bad;
        const ev = { t: +((performance.now() - P.t0) / 1000).toFixed(1), bad: a.bad, at: [a.fx, a.fy],
          cam: [+e.camera.position.x.toFixed(1), +e.camera.position.y.toFixed(1), +e.camera.position.z.toFixed(1)],
          trials: [] };
        if (BISECT && P.events.length < 6) {
          // Does it survive an identical re-render? If not, it is transient and
          // hiding things proves nothing about this particular hit.
          pf.render(0.016);
          const again = read();
          ev.reproduced = again.bad > 0;
          if (again.bad > 0) {
            for (const [label, obj] of candidates()) {
              if (!obj) { ev.trials.push([label, 'not found']); continue; }
              const was = obj.visible; obj.visible = false;
              pf.render(0.016);
              const v = read();
              obj.visible = was;
              ev.trials.push([label, v.bad ? `still ${v.bad}` : 'GONE']);
            }
            pf.render(0.016);
          }
        }
        if (P.events.length < 6) P.events.push(ev);
      }
      if ((performance.now() - P.t0) / 1000 >= SECONDS) { resolve(); return; }
      requestAnimationFrame(step);
    };
    step();
  });
  window.__nanDrive = false;
  if (pf.sanity && hadSanity !== null) pf.sanity.enabled = hadSanity;
  return { n: P.n, hits: P.hits, worst: P.worst, events: P.events,
    rt: [bw, bh], systems: Object.keys(S), sanityFound: !!pf.sanity };
}, { SECONDS, BISECT });
} finally {
  await closeBrowser();
}

console.log(`\nnanhunt — driving, port ${PORT}, ${W}x${H}, HDR buffer ${out.rt.join('x')}`);
console.log(out.sanityFound
  ? 'sampled with the HDR sanity pass disabled, so sources are visible rather than masked'
  : 'WARNING: no postfx.sanity pass found — the HDR guard is missing from the post chain');
console.log(`frames sampled: ${out.n}`);
console.log(`frames with a non-finite HDR pixel: ${out.hits}  (${(100 * out.hits / Math.max(1, out.n)).toFixed(2)}%)   worst channel count: ${out.worst}`);
for (const ev of out.events) {
  console.log(`\n  t=${ev.t}s  bad=${ev.bad}  first at ${ev.at.join(',')}  cam ${ev.cam.join(',')}  reproduced-on-rerender=${ev.reproduced}`);
  for (const [l, v] of ev.trials) console.log(`      ${String(l).padEnd(18)} ${v}`);
}
if (out.hits) { console.log('\nFAIL: non-finite pixels reached the HDR buffer.'); process.exit(1); }
console.log('\nclean: no non-finite pixel in any sampled frame.');
