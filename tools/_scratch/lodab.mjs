#!/usr/bin/env node
/**
 * Near-field LOD A/B — two reach settings, ONE page load, interleaved blocks.
 *
 * Five authors are capturing on this machine at once. Two consecutive
 * `dprtest.mjs` runs an hour apart differed by 2x for reasons that had nothing
 * to do with the tree (INTEGRATION_REQUESTS X1), so an absolute number cannot
 * price a reach change. This is the perf author's instrument instead: alternate
 * the two configurations in short blocks inside a single page load, so machine
 * contention lands on both arms equally, and report the PAIRED difference.
 *
 *   node tools/_scratch/lodab.mjs --a '{"coverVis":1}' --b '{"coverVis":1.8}'
 *
 * Config keys (all optional, anything omitted is left alone):
 *   coverVis   multiplier on every cover instance's visibility radius
 *   near       [a,b] near grass ring fadeOut
 *   nearIn     [a,b] near grass ring fadeIn
 *   mid        [a,b] mid grass ring fadeIn
 *   grass      false to hide the grass group entirely
 *   cover      false to hide the ground-cover group entirely
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const W = parseInt(arg('w', '1170'), 10);
const H = parseInt(arg('h', '870'), 10);
const DPR = parseFloat(arg('dpr', '2'));
const BLOCK = parseFloat(arg('block', '4'));      // seconds per block
const CYCLES = parseInt(arg('cycles', '6'), 10);  // A/B pairs
const A = JSON.parse(arg('a', '{}'));
const B = JSON.parse(arg('b', '{}'));
// Static pose by default. A driving A/B is unusable: the world under the car
// changes monotonically, so whichever arm runs second in each cycle samples
// different ground, and the adaptive resolution scaler closes a feedback loop
// between the arms on top of that. A null A/B (A === B) while driving measured
// Δp50 15.9 ms. Standing still at the `drive` anchor — eye level on the road,
// the exact framing the player is complaining about — with the scaler frozen,
// the same null test is the noise floor of the machine and nothing else.
const POSE = arg('pose', 'drive');
const DRIVE = argv.includes('--drive');

await acquire('lodab');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
// Seven authors share this dev server; every save one of them makes triggers a
// Vite HMR reload that destroys the execution context mid-measurement. Same
// stub dprtest.mjs uses.
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
               set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new RealWS(u, p);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await page.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

// ── pose ────────────────────────────────────────────────────────────────────
if (!DRIVE) {
  await page.evaluate(async (pose) => {
    const e = window.__engine, wd = window.__world;
    const V = { drive: { anchor: 'road', height: 4.2, dist: 12, pitch: -0.10, fov: 55, standOff: 16 },
                meadow: { anchor: 'meadow', height: 1.6, dist: 6, pitch: -0.05, fov: 58, standOff: 0 } }[pose];
    const a = window.__cameraAnchors[V.anchor]();
    const yaw = a.yaw ?? 0;
    const gx = a.x - Math.sin(yaw) * V.standOff, gz = a.z - Math.cos(yaw) * V.standOff;
    const gy = wd.getHeight(gx, gz) + V.height;
    e.camera.fov = V.fov; e.camera.updateProjectionMatrix();
    e.camera.position.set(gx, gy, gz);
    e.camera.lookAt(gx + Math.sin(yaw) * V.dist, gy + Math.tan(V.pitch) * V.dist, gz + Math.cos(yaw) * V.dist);
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
    await window.__settle(90);
  }, POSE);
}

const out = await page.evaluate(async ({ A, B, BLOCK, CYCLES, DRIVE }) => {
  const e = window.__engine;
  const S = window.__systems;
  const grass = S.grass, cover = S.groundCover;

  const apply = (c) => {
    if (c.coverVis !== undefined && cover) { cover.visMul = c.coverVis; cover._dirty = true; }
    if (grass) {
      const set = (ring, key, v) => {
        if (!v) return;
        ring.material.userData.uniforms[key].value.set(v[0], v[1]);
      };
      set(grass.rings[0], 'uFadeOut', c.near);
      set(grass.rings[0], 'uFadeIn', c.nearIn);
      set(grass.rings[1], 'uFadeIn', c.mid);
      if (c.grass !== undefined) grass.group.visible = c.grass;
    }
    if (c.cover !== undefined && cover) cover.group.visible = c.cover;
  };

  // Freeze adaptive resolution. Otherwise the scaler reacts to arm B's cost
  // and hands arm A a cheaper frame — the two arms stop being independent
  // samples and the difference measures the controller, not the change.
  e.adaptive = false;

  // Real driving input, same path dprtest uses.
  const input = DRIVE ? window.__ctx?.input : null;
  let t0 = performance.now();
  if (input) {
    window.__drive = true;
    const tick = () => {
      if (!window.__drive) return;
      const t = (performance.now() - t0) / 1000;
      input.axes.throttle = 1;
      input.axes.steer = Math.sin(t * 0.42) * 0.7;
      requestAnimationFrame(tick);
    };
    tick();
  }

  const samples = [];
  let arm = null, last = performance.now(), blockStart = performance.now();
  e.onLateUpdate(() => {
    const now = performance.now();
    const dt = now - last; last = now;
    // Drop the first 900 ms of every block: a repack and a shader recompile
    // can land in it, and that is a switching cost, not a steady-state cost.
    if (arm && now - blockStart > 900) samples.push([arm, dt]);
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const info = { A: [], B: [] };
  const counts = { A: null, B: null };

  // One warm block per arm before anything is recorded, so neither arm pays
  // for the other's first repack.
  for (const c of [A, B]) { apply(c); arm = null; await sleep(BLOCK * 1000); }

  for (let k = 0; k < CYCLES; k++) {
    // ABBA, not ABAB. Any monotonic drift over the run (thermal, another
    // author's capture starting) cancels to first order within a cycle.
    const order = [['A', A], ['B', B], ['B', B], ['A', A]];
    for (const [name, c] of order) {
      apply(c);
      arm = null; blockStart = performance.now();
      await sleep(200);
      arm = name;
      await sleep(BLOCK * 1000);
      const r = e.renderer ?? window.__engine.renderer;
      info[name].push([r.info.render.calls, r.info.render.triangles]);
      if (cover) counts[name] = { instances: cover.stats.instances, tris: cover.stats.tris };
      arm = null;
    }
  }
  window.__drive = false;

  const stat = (name) => {
    const f = samples.filter((s) => s[0] === name).map((s) => s[1]).sort((a, b) => a - b);
    const pct = (p) => f[Math.min(f.length - 1, Math.floor(p * f.length))];
    return { n: f.length, p50: +pct(0.5).toFixed(2), p90: +pct(0.9).toFixed(2), p95: +pct(0.95).toFixed(2) };
  };
  const avg = (a, i) => +(a.reduce((s, v) => s + v[i], 0) / a.length).toFixed(0);

  // Per-slot fill against cap, so a clamped bucket cannot be mistaken for a
  // cheap one.
  const slots = cover ? cover.slots.map((s) => ({
    key: s.arch.key, v: s.variant, n: s.mesh.count, cap: s.mesh.instanceMatrix.count,
  })).filter((s) => s.n > 0) : [];

  return {
    A: { ...stat('A'), calls: avg(info.A, 0), tris: avg(info.A, 1), cover: counts.A },
    B: { ...stat('B'), calls: avg(info.B, 0), tris: avg(info.B, 1), cover: counts.B },
    slots,
    resolution: window.__resolution ? window.__resolution() : null,
  };
}, { A, B, BLOCK, CYCLES, DRIVE });

await browser.close();

const d = (k) => +(out.B[k] - out.A[k]).toFixed(2);
const compact = (o) => o ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'cover')) : o;
console.log('A', JSON.stringify(compact(out.A)), out.A.cover ? JSON.stringify(out.A.cover) : '');
console.log('B', JSON.stringify(compact(out.B)), out.B.cover ? JSON.stringify(out.B.cover) : '');
console.log('slots', out.slots.map((s) => `${s.key}${s.v}:${s.n}/${s.cap}`).join(' '));
console.log('res', JSON.stringify(out.resolution));
console.log(`\nA ${JSON.stringify(A)}\nB ${JSON.stringify(B)}`);
console.log(`Δp50 ${d('p50')} ms   Δp90 ${d('p90')} ms   Δp95 ${d('p95')} ms   ` +
            `Δtris ${(out.B.tris - out.A.tris) / 1000 | 0} k   Δcalls ${out.B.calls - out.A.calls}`);
