#!/usr/bin/env node
/**
 * Find a freeze and NAME THE FUNCTION THAT CAUSED IT.
 *
 *   node tools/stall.mjs                      # 120 s drive, sun changes, report
 *   node tools/stall.mjs --seconds 240 --stall 1000
 *   node tools/stall.mjs --no-sun --seconds 90
 *
 * ── why this exists next to perf.mjs ─────────────────────────────────────────
 *
 * `perf.mjs` answers "is the frame rate good", and it answers it well. It
 * cannot answer "what ran during that 4-second freeze", and neither can any of
 * the off-the-shelf three.js performance tools, which is worth stating once so
 * nobody goes shopping for one again:
 *
 *   stats.js / r3f-perf / three-perf  are FPS and counter DISPLAYS. They tell
 *                                     you a frame was slow. perf.mjs already
 *                                     does that, with better statistics.
 *   Spector.js                        captures a frame draw call by draw call.
 *                                     It is a GPU instrument. A main-thread
 *                                     JavaScript stall is invisible to it,
 *                                     because during the stall there are no
 *                                     draw calls at all -- that IS the defect.
 *   DevTools Performance panel        is the right instrument, and it is
 *                                     interactive. It cannot be run in CI, and
 *                                     a freeze that happens "every so often"
 *                                     is exactly the kind you fail to catch
 *                                     while hand-driving with a panel open.
 *
 * So this drives the game unattended, records every frame, and runs Chrome's
 * own sampling CPU profiler over the whole run through CDP -- the same profiler
 * the DevTools panel uses, with no new dependency, because Playwright is
 * already here. When a frame exceeds the stall threshold, the samples inside
 * that frame's window are aggregated and the hottest stacks are printed. That
 * turns "there was a 4 s freeze" into "4 s of it was in this function".
 *
 * ── reading the report ───────────────────────────────────────────────────────
 *
 * `self ms` is time in the function itself, not its callees. A stall caused by
 * one enormous synchronous routine shows up as one fat `self` row. A stall
 * caused by garbage collection shows as `(garbage collector)`. A stall caused
 * by shader compilation shows in the renderer's program functions, or -- if the
 * driver blocks -- as `(program)` with little JavaScript underneath it, which
 * is the signature to expect for a link that stalls in ANGLE.
 *
 * A stall with NO samples under it is itself a finding: the main thread was
 * blocked somewhere the JavaScript profiler cannot see, which in this engine
 * means a synchronous GL call (a shader link, a texture upload, a readback) or
 * the compositor waiting on the GPU.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const SECONDS = parseFloat(arg('seconds', '120'));
const STALL_MS = parseFloat(arg('stall', '250'));
const RES = arg('res', '1536');
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const QUALITY = arg('quality', null);
const DPR = parseFloat(arg('dpr', '1'));
const JSON_OUT = arg('json', null);
const SUN = !has('no-sun');
// The automatic quality ladder is disabled under automation on purpose, so
// that a tier change cannot invalidate a capture. That also makes every
// harness in this tree blind to what the ladder itself costs -- and a tier
// step rebuilds materials, which relinks shaders, which on this scene is
// seconds. `--autoquality` re-arms it the way Engine's own comment says a
// harness should, so the freeze a PLAYER gets is measurable here.
const AUTOQ = has('autoquality');
// Measure the PLAYER's code path, not the harness's. `checkShaderErrors` is on
// under automation so health.mjs can catch a silently-failed program, and it
// turns every shader link into a synchronous `getProgramInfoLog` block — which
// shows up here as a startup stall the player never experiences. `--player`
// forces the shipped path via the query parameter Engine reads.
const PLAYER = has('player');
// Measure the frame the PLAYER SEES, not the frame the CPU finishes.
//
// WebGL commands are queued. The main thread can hand the driver a frame and
// return in 17 ms while the GPU is still 100 ms behind, so every CPU-side frame
// timer in this tree -- perf.mjs, PerfOverlay, and this tool without the flag --
// can report 60 fps while the screen is visibly running at 10. That is not a
// hypothetical: the player reports exactly that gap.
//
// GPU timer queries are not the answer here. `EXT_disjoint_timer_query_webgl2`
// returns incoherent values under ANGLE-Metal in this project -- a previous pass
// measured scene-WITH-water as faster than scene-without. The reliable move is
// to force completion: a 1x1 `readPixels` after the render blocks until the GPU
// has actually finished the frame, so the interval between successive sync
// points is true end-to-end frame cost. `gl.finish()` does NOT work here (it is
// a no-op under ANGLE-Metal) and `clientWaitSync` deadlocks when busy-polled.
//
// This makes the measurement pessimistic by removing CPU/GPU overlap, so read
// it as an upper bound and always beside the unsynced number.
const GPUSYNC = has('gpusync');
// Pitch and strike camps during the drive.
//
// A 360 s profiled drive found ZERO stalls over 900 ms, while the player hit a
// six-second freeze about two minutes into ordinary play. The difference is
// what the drive does: it steers and throttles, and the player was opening
// menus and placing camps. Camp pitching is a known program-linking event --
// `Camp.js`'s own prewarm comment records that even after a boot warm-up "the
// first camp still linked 30" programs, because `renderer.compile()` does not
// run the shadow pass. A link on this scene is measured in seconds.
const CAMP = has('camp');

await acquire('stall');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });

// Same HMR neutering as perf.mjs: a peer saving a file mid-run reloads the page
// and destroys the execution context half way through the drive.
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return {
        readyState: 3, url, close() {}, send() {},
        addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {},
      };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
page.on('console', (m) => {
  const t = m.text();
  // The engine announces a tier change on the console. That line is a prime
  // suspect for a multi-second freeze, so keep it whatever its level.
  if (m.type() === 'error' || /quality|bake|compil/i.test(t)) errors.push(`[${m.type()}] ${t.slice(0, 200)}`);
});
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});

const params = new URLSearchParams({ res: RES });
if (QUALITY) params.set('quality', QUALITY);
if (PLAYER) params.set('shadercheck', '0');
const base = process.env.AUTUMN_URL || 'http://localhost:5178';
await page.goto(`${base}/?${params}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

// ── recorder + drive ────────────────────────────────────────────────────────
await page.evaluate(({ sun, autoq, gpusync, camp }) => {
  const e = window.__engine;
  if (autoq) e.autoQuality = true;
  if (gpusync) {
    // Our rAF is registered from inside a frame, so it runs after the engine's
    // own setAnimationLoop callback for that frame -- i.e. after the render has
    // been submitted. readPixels then blocks until the GPU drains it.
    const gl = e.renderer.getContext();
    const px = new Uint8Array(4);
    window.__gpuSync = { times: [], last: performance.now() };
    const tick = () => {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const now = performance.now();
      window.__gpuSync.times.push(now - window.__gpuSync.last);
      window.__gpuSync.last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  const r = e.renderer;
  window.__st = { frames: [], events: [], started: performance.now() };

  let last = performance.now();
  e.onLateUpdate(() => {
    const now = performance.now();
    window.__st.frames.push({
      t: now - window.__st.started,
      ms: now - last,
      calls: r.info.render.calls,
      tris: r.info.render.triangles,
      geo: r.info.memory.geometries,
      tex: r.info.memory.textures,
      prog: r.info.programs?.length ?? 0,
      q: e.quality,
      rs: e.resolutionScale,
    });
    last = now;
  });

  // Note anything that changes the tier, so a stall can be lined up with it.
  const origSetQuality = e.setQuality?.bind(e);
  if (origSetQuality) {
    e.setQuality = (q) => {
      window.__st.events.push({ t: performance.now() - window.__st.started, kind: 'setQuality', detail: String(q) });
      return origSetQuality(q);
    };
  }

  const input = window.__ctx?.input;
  if (input) {
    window.__stDrive = true;
    const tick = () => {
      if (!window.__stDrive) return;
      const t = (performance.now() - window.__st.started) / 1000;
      input.axes.throttle = 1;
      input.axes.brake = 0;
      input.axes.steer = Math.sin(t * 0.42) * 0.75;
      input.axes.handbrake = 0;
      requestAnimationFrame(tick);
    };
    tick();
  }

  if (camp && window.__camp?.pitchAt) {
    window.__stCamp = setInterval(() => {
      const v = window.__vehicleState || window.__vehicle;
      const p = v?.position || window.__engine.camera.position;
      const t = performance.now() - window.__st.started;
      try {
        window.__st.events.push({ t, kind: 'pitchAt', detail: `${Math.round(p.x)},${Math.round(p.z)}` });
        window.__camp.pitchAt(p.x, p.z, { instant: true });
      } catch (err) {
        window.__st.events.push({ t, kind: 'pitchErr', detail: String(err).slice(0, 60) });
      }
    }, 12000);
  }

  // The user saw a freeze while changing the sun in the menu, so exercise that
  // too rather than only driving. This is the same field the HUD's control
  // writes to.
  if (sun && window.__lighting) {
    window.__stSun = setInterval(() => {
      const t = (performance.now() - window.__st.started) / 1000;
      const hour = 4 + ((t * 1.7) % 18);
      window.__st.events.push({ t: performance.now() - window.__st.started, kind: 'hour', detail: hour.toFixed(1) });
      window.__lighting.hour = hour;
    }, 4000);
  }
}, { sun: SUN, autoq: AUTOQ, gpusync: GPUSYNC, camp: CAMP });

// ── Chrome's own sampling profiler, over the whole drive ────────────────────
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
// 200 us. Fine enough to attribute a 250 ms stall to a single function, coarse
// enough that the profiler is not itself the thing that stalls the run.
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
// Correlate the profiler's clock with the page's. Profile timestamps are in
// microseconds on the same monotonic base as performance.timeOrigin, but the
// safe move is to anchor both ends ourselves.
const anchorPage = await page.evaluate(() => performance.now() - window.__st.started);

await page.waitForTimeout(SECONDS * 1000);

const { profile } = await cdp.send('Profiler.stop');
await page.evaluate(() => {
  window.__stDrive = false;
  if (window.__stSun) clearInterval(window.__stSun);
  if (window.__stCamp) clearInterval(window.__stCamp);
});
const data = await page.evaluate(() => window.__st);
const gpu = GPUSYNC ? await page.evaluate(() => window.__gpuSync.times) : null;

// ── attribute ───────────────────────────────────────────────────────────────
const nodes = new Map();
for (const n of profile.nodes) nodes.set(n.id, n);

// Absolute sample times, in the page's "ms since drive start" clock.
const sampleT = [];
{
  let ts = profile.startTime; // microseconds
  for (let i = 0; i < profile.timeDeltas.length; i++) {
    ts += profile.timeDeltas[i];
    sampleT.push(ts);
  }
}
const profStartUs = profile.startTime;
const toPageMs = (us) => anchorPage + (us - profStartUs) / 1000;

const label = (n) => {
  const f = n.callFrame;
  const name = f.functionName || '(anonymous)';
  const url = (f.url || '').split('/').slice(-1)[0];
  return url ? `${name} @ ${url}:${f.lineNumber + 1}` : name;
};

function attribute(t0, t1) {
  const self = new Map();
  let n = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const t = toPageMs(sampleT[i]);
    if (t < t0 || t > t1) continue;
    n++;
    const node = nodes.get(profile.samples[i]);
    if (!node) continue;
    const k = label(node);
    const dt = i > 0 ? profile.timeDeltas[i] / 1000 : 0.2;
    self.set(k, (self.get(k) || 0) + dt);
  }
  return { rows: [...self.entries()].sort((a, b) => b[1] - a[1]), samples: n };
}

const frames = data.frames;
const stalls = frames.filter((f) => f.ms >= STALL_MS).sort((a, b) => b.ms - a.ms);
const msList = frames.map((f) => f.ms).sort((a, b) => a - b);
const pct = (p) => msList.length ? msList[Math.min(msList.length - 1, Math.floor(msList.length * p))] : 0;

const out = [];
const say = (s = '') => { out.push(s); console.log(s); };

say(`frames ${frames.length} over ${SECONDS}s   p50 ${pct(0.5).toFixed(1)} ms   p95 ${pct(0.95).toFixed(1)} ms   p99 ${pct(0.99).toFixed(1)} ms`);
say(`stalls >= ${STALL_MS} ms: ${stalls.length}`);
const worst = frames.reduce((a, b) => (b.ms > a.ms ? b : a), frames[0] || { ms: 0, t: 0 });
say(`worst frame ${worst.ms?.toFixed(0)} ms at ${(worst.t / 1000).toFixed(1)}s`);
say(`profiler: ${profile.samples.length} samples, ${profile.nodes.length} nodes`);
say();

const first = frames[0] || {};
const lastF = frames[frames.length - 1] || {};
say(`resource growth   geo ${first.geo} -> ${lastF.geo}   tex ${first.tex} -> ${lastF.tex}   prog ${first.prog} -> ${lastF.prog}`);
say(`quality           ${first.q} @ ${first.rs} -> ${lastF.q} @ ${lastF.rs}`);
say(`autoQuality       ${AUTOQ ? 'ARMED (--autoquality)' : 'OFF — this run cannot see a tier-change freeze'}`);
say(`shader check      ${PLAYER ? 'OFF (--player, the shipped path)' : 'ON — adds a synchronous link block players do not get'}`);
if (gpu && gpu.length > 20) {
  const g = gpu.slice(10).sort((a, b) => a - b);
  const gp = (q) => g[Math.min(g.length - 1, Math.floor(g.length * q))];
  say(`GPU-SYNCED frame  p50 ${gp(0.5).toFixed(1)} ms (${(1000 / gp(0.5)).toFixed(0)} fps)   p95 ${gp(0.95).toFixed(1)} ms   worst ${g[g.length - 1].toFixed(0)} ms`);
  say(`                  ^ true end-to-end cost. Compare with the CPU-side p50 above:`);
  say(`                    a large gap means the scene is GPU-bound and every CPU-side`);
  say(`                    frame counter in this tree is over-reporting the frame rate.`);
}
if (data.events.length) {
  say(`events            ${data.events.filter((e) => e.kind !== 'hour').map((e) => `${e.kind}(${e.detail})@${(e.t / 1000).toFixed(1)}s`).join('  ') || '(no tier changes)'}`);
}
say();

for (const s of stalls.slice(0, 8)) {
  const t1 = s.t;
  const t0 = s.t - s.ms;
  say(`── stall ${s.ms.toFixed(0)} ms at ${(t0 / 1000).toFixed(1)}s  (calls ${s.calls}, tris ${(s.tris / 1e6).toFixed(2)}M, prog ${s.prog}) ──`);
  const near = data.events.filter((e) => e.t > t0 - 500 && e.t < t1 + 100);
  if (near.length) say(`   events in window: ${near.map((e) => `${e.kind}=${e.detail}`).join(', ')}`);
  const { rows, samples } = attribute(t0, t1);
  if (!samples) {
    say('   NO JS SAMPLES IN THIS WINDOW.');
    say('   The main thread was blocked outside JavaScript — a synchronous GL call');
    say('   (shader link, texture upload, readback) or a wait on the GPU/compositor.');
  } else {
    for (const [k, ms] of rows.slice(0, 8)) {
      if (ms < 1) break;
      say(`   ${ms.toFixed(0).padStart(6)} ms  ${k}`);
    }
  }
  say();
}

if (!stalls.length) say('No stall reached the threshold. Try --seconds higher, or lower --stall.');
if (errors.length) { say('console:'); for (const e of errors.slice(0, 12)) say(`   ${e}`); }

if (JSON_OUT) {
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify({ frames, events: data.events, stalls: stalls.slice(0, 20), errors }, null, 1));
  say(`wrote ${JSON_OUT}`);
}

await browser.close();
