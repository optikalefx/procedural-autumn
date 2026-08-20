#!/usr/bin/env node
/**
 * Does the frustum now take BARK and ROCK out of the way?
 *
 * The hard part of this measurement is not the measurement, it is arriving at
 * the frame. The window in which a trunk stands between the lens and the camper
 * while driving is about half a second wide, and a poll from node misses it
 * every time — the first version of this file caught the GATE firing (which is
 * deliberately conservative and fires early) on a frame where the fade itself
 * had not yet bitten, and reported 0.0001 of the frame changed.
 *
 * So the pose is BUILT rather than hunted. Drive into the wood, stop, pick the
 * nearest trunk (or crag) to the camper, and put the camera on the far side of
 * it looking back — which is exactly the frame the player photographed. Then
 * every comparison happens inside that one page load with the engine stopped,
 * for the reason occlab.mjs gives.
 *
 *   node tools/_scratch/occsolid.mjs --pose trunk
 *   node tools/_scratch/occsolid.mjs --pose rock
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/occsolid');
const POSE = arg('pose', 'trunk');
const WARM = parseFloat(arg('warm', '15000'));
const W = parseInt(arg('w', '1200'), 10);
const H = parseInt(arg('h', '720'), 10);

mkdirSync(DIR, { recursive: true });
await acquire('occsolid');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, q) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, q);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
p.on('console', (m) => { if (/Shader Error|ERROR: 0:|VALIDATE_STATUS/i.test(m.text())) console.log('GL', m.text().slice(0, 400)); });
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(700);

// ── drive into the wood ────────────────────────────────────────────────────
await p.evaluate((warm) => {
  window.__lighting.hour = 16.7; window.__lighting.cycleSpeed = 0;
  const inp = window.__ctx.input; window.__drive = true; const t0 = performance.now();
  const tick = () => { if (!window.__drive) return; const t = (performance.now() - t0) / 1000;
    inp.axes.throttle = 1; inp.axes.steer = Math.sin(t * 0.23) * 0.32; requestAnimationFrame(tick); };
  tick();
  return new Promise((r) => setTimeout(r, warm));
}, WARM);
await p.evaluate(() => { window.__drive = false; window.__ctx.input.axes.throttle = 0; });
await p.waitForTimeout(1200);

// ── build the pose ─────────────────────────────────────────────────────────
const pose = await p.evaluate((kind) => {
  const T3 = window.__THREE, e = window.__engine, cam = e.camera;
  const veh = window.__systems.vehicle.position;
  let obj = null;

  if (kind === 'rock') {
    const rk = window.__systems.rocks;
    for (const c of rk.cells.values()) {
      for (const inst of c.instances) {
        const d = Math.hypot(inst.x - veh.x, inst.z - veh.z);
        const size = Math.max(inst.sx, inst.sy, inst.sz) * (rk.byArch[inst.arch]?.[inst.variant]?.userData.occR ?? 1);
        if (d < 5 || d > 26 || size < 2.5) continue;
        if (!obj || d < obj.d) obj = { x: inst.x, y: inst.y, z: inst.z, d, size, what: `${inst.arch}/${inst.variant}` };
      }
    }
  } else {
    const T = window.__systems.trees.trees;
    for (let t = 0; t < T.n; t++) {
      const d = Math.hypot(T.px[t] - veh.x, T.pz[t] - veh.z);
      if (d < 4 || d > 26) continue;
      const size = T.pscale[t];
      if (!obj || d < obj.d) obj = { x: T.px[t], y: T.py[t], z: T.pz[t], d, size, what: `tree scale ${size.toFixed(2)}` };
    }
  }
  if (!obj) return null;

  // Camera on the far side of it, looking back at the camper: the subject
  // behind the obstacle, which is the whole shape this feature is about.
  const dx = obj.x - veh.x, dz = obj.z - veh.z;
  const len = Math.hypot(dx, dz) || 1;
  const back = kind === 'rock' ? obj.size * 1.5 + 2.5 : 5.5;
  const cx = obj.x + (dx / len) * back, cz = obj.z + (dz / len) * back;
  // Put the LENS where the obstacle is actually on the sight line. Standing the
  // camera at ground level + 2.6 and looking down at the camper walked the ray
  // straight over the top of a two-metre boulder, and the first rock run
  // measured a boulder that was never in the shot. Solve for the eye height
  // that makes the camera-to-camper ray pass through the obstacle instead.
  const aimY = veh.y + 1.2;
  const targetY = obj.y + (kind === 'rock' ? obj.size * 0.35 : 2.0);
  const f = back / (back + obj.d);
  const eyeY = Math.max((targetY - f * aimY) / (1 - f), window.__world.getHeight(cx, cz) + 1.4);
  cam.position.set(cx, eyeY, cz);
  cam.lookAt(veh.x, aimY, veh.z);
  window.__forceCamera = true;
  return { what: obj.what, obstacleAt: +obj.d.toFixed(1),
           camDist: +cam.position.distanceTo(veh).toFixed(2) };
}, POSE);
console.log('pose', JSON.stringify(pose));

// ── freeze, and hand-drive the whole frame ─────────────────────────────────
await p.evaluate(() => {
  const e = window.__engine;
  e.stop();
  const veh = window.__systems.vehicle;
  window.__pin = { bark: false, rock: false };
  window.__step = () => new Promise((res) => requestAnimationFrame(() => {
    const tr = window.__systems.trees, rk = window.__systems.rocks;
    window.__occlusion.setTarget(e.camera, veh.position);
    // The gates normally run in lateUpdate; the clock is stopped, so run them.
    tr?.lateUpdate?.(); rk?.lateUpdate?.();
    // Isolation: hand one surface back its plain program after the gate has
    // spoken, so each can be priced on its own.
    // Clear the gate's own bookkeeping along with the material, or the next
    // gate sees "already on" and never hands the occluding program back.
    if (window.__pin.bark) for (const s of tr._barkSlots) { s.meshes[0].material = tr.bark.mat; s.occOn = false; }
    if (window.__pin.rock) for (const m of rk.meshes) { m.material = rk.material; m.userData.occOn = false; }
    e._render ? e._render(0, e.elapsed) : e.renderer.render(e.scene, e.camera);
    requestAnimationFrame(() => res());
  }));
  window.__diff = async (b64a, b64b) => {
    const dec = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
    const [A, B] = await Promise.all([dec(b64a), dec(b64b)]);
    const c = new OffscreenCanvas(A.width, A.height), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(A, 0, 0); const a = g.getImageData(0, 0, A.width, A.height).data;
    g.clearRect(0, 0, A.width, A.height); g.drawImage(B, 0, 0);
    const bb = g.getImageData(0, 0, A.width, A.height).data;
    let n = 0; const tot = a.length / 4;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - bb[i]) + Math.abs(a[i + 1] - bb[i + 1]) + Math.abs(a[i + 2] - bb[i + 2]) > 18) n++;
    }
    return +(n / tot).toFixed(4);
  };
});

// Let the temporal passes converge before every capture. The first version of
// this file took its control from the first two frames after a camera move and
// reported 0.0756 of the frame differing between two identical renders — that
// was n8ao and the postfx accumulating, not noise.
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await p.evaluate(() => window.__step()); };
const shot = async (name) => {
  await settle();
  await p.evaluate(() => window.__step());
  const s = (await p.screenshot()).toString('base64');
  if (name) writeFileSync(`${DIR}/${POSE}-${name}.png`, Buffer.from(s, 'base64'));
  return s;
};
const setP = (o) => p.evaluate((o) => Object.assign(window.__occlusion.params, o), o);
const pin = (o) => p.evaluate((o) => Object.assign(window.__pin, o), o);
const diff = (a, c) => p.evaluate(([x, y]) => window.__diff(x, y), [a, c]);

await setP({ enabled: false });
const off = await shot('off');
const control = await diff(off, await shot());
console.log(`control (two identical frames): ${control}`);

await setP({ enabled: true });
await pin({ bark: true, rock: true });
const leavesOnly = await shot('leaves-only');
await pin({ bark: false, rock: false });
const all = await shot('all');

console.log(`leaves+cover only   engaged ${await diff(off, leavesOnly)}`);
console.log(`+ bark and rock     engaged ${await diff(off, all)}`);
console.log(`bark/rock's own share            ${await diff(leavesOnly, all)}   (control ${control})`);
// ── what it costs, in the frame that needs it ──────────────────────────────
// The clock is stopped and the pose is fixed, so the only difference between
// the two arms is which program the bark and rock meshes are on. Interleaved
// in short blocks, median reported, because the machine is shared.
const timed = await p.evaluate(async (blocks) => {
  const e = window.__engine, r = e.renderer;
  const run = async (pin) => {
    Object.assign(window.__pin, { bark: pin, rock: pin });
    for (let i = 0; i < 12; i++) await window.__step();           // settle
    const t = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      await window.__step();
      r.getContext().finish();
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    return t[t.length >> 1];
  };
  const base = [], tweak = [];
  for (let i = 0; i < blocks; i++) { base.push(await run(true)); tweak.push(await run(false)); }
  const med = (a) => { a.sort((x, y) => x - y); return +a[a.length >> 1].toFixed(2); };
  return { plainPrograms: med(base), occludingPrograms: med(tweak) };
}, 5);
console.log(`frozen-frame cost  plain ${timed.plainPrograms} ms  ->  occluding ${timed.occludingPrograms} ms  (delta ${(timed.occludingPrograms - timed.plainPrograms).toFixed(2)} ms)`);

console.log('programs ' + JSON.stringify(await p.evaluate(() => {
  const tr = window.__systems.trees, rk = window.__systems.rocks;
  const on = tr._barkSlots.filter((s) => s.occOn);
  const m = on[0]?.meshes[0];
  return {
    barkMeshUsesOccMaterial: m ? m.material === tr.barkOcc.mat : null,
    barkOccDefined: /BARK_OCCLUDE/.test(tr.barkOcc.mat.fragmentShader),
    barkOccHasCut: /occludeCut/.test(tr.barkOcc.mat.fragmentShader),
    barkPlainHasCut: /occludeCut/.test(tr.bark.mat.fragmentShader),
    barkOccAmount: tr.barkOcc.mat.uniforms.uOccAmount?.value,
    rockOccHasCut: /occludeCut/.test(rk.materialOcc.userData.shader?.fragmentShader ?? ''),
  };
})));
console.log('gate ' + JSON.stringify(await p.evaluate(() => {
  const tr = window.__systems.trees, rk = window.__systems.rocks;
  const on = tr._barkSlots.filter((s) => s.occOn);
  return {
    barkSlotsOn: on.length, barkInstancesOn: on.reduce((a, s) => a + s.count, 0),
    barkInstancesDrawn: tr._barkSlots.reduce((a, s) => a + s.count, 0),
    rockMeshesOn: rk.meshes.filter((m) => m.userData.occOn).length,
    rockMeshesDrawn: rk.meshes.filter((m) => m.count > 0).length,
  };
})));
await b.close();
