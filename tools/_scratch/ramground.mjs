#!/usr/bin/env node
/**
 * `glb_rig.measureGround`, run in the BROWSER against any GLB, with the whole
 * velocity distribution printed rather than just its answer.
 *
 * `_glbground.mjs` does this in node, and cannot read a textured asset — the
 * pack's animals carry a palette image, and node's GLTFLoader wants `self` and
 * a DOM to decode it. This one borrows the page's own loader, so it reads
 * exactly what the game reads.
 *
 *   node tools/_scratch/ramground.mjs /models/ram_pack.glb toeL,toeR,front_toeL,front_toeR
 */
import { chromium } from 'playwright';
import { acquire } from './../_lock.mjs';

const URL_ = process.argv[2] || '/models/ram_pack.glb';
const FEET = (process.argv[3] || 'toeL,toeR,front_toeL,front_toeR').split(',');

await acquire('ramground');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
// Neuter Vite's HMR client, as probe.mjs does: a peer saving a file mid-run
// reloads the page and kills the run with "Execution context was destroyed".
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {},
        addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await p.goto(process.env.AUTUMN_URL || 'http://localhost:5178');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });

const out = await p.evaluate(async ([url, feet]) => {
  // Bare specifiers are not resolvable from an inline eval, so go through the
  // dev server's own paths — Vite rewrites the bare imports inside them.
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const N = 256, TOL = 0.02, PLANTED = 0.12;
  const rows = [];
  for (const clip of gltf.animations) {
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip); action.play();
    const bones = feet.map((n) => root.getObjectByName(n)).filter(Boolean);
    const resolved = bones.length;
    const pos = new THREE.Vector3();
    const z = bones.map(() => new Float64Array(N));
    const y = bones.map(() => new Float64Array(N));
    for (let i = 0; i < N; i++) {
      mixer.setTime((i / N) * clip.duration);
      root.updateMatrixWorld(true);
      for (let bI = 0; bI < bones.length; bI++) {
        pos.setFromMatrixPosition(bones[bI].matrixWorld);
        z[bI][i] = pos.z; y[bI][i] = pos.y;
      }
    }
    action.stop(); mixer.uncacheRoot(root);
    const step = clip.duration / N;
    const speeds = [];
    const per = [];
    for (let bI = 0; bI < bones.length; bI++) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < N; i++) { if (y[bI][i] < lo) lo = y[bI][i]; if (y[bI][i] > hi) hi = y[bI][i]; }
      const floor = lo + (hi - lo) * PLANTED;
      const mine = [];
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        if (y[bI][i] > floor || y[bI][j] > floor) continue;
        mine.push((z[bI][j] - z[bI][i]) / step);
      }
      mine.sort((a, c) => a - c);
      per.push({ foot: feet[bI], duty: +(mine.length / N).toFixed(3),
        lift: +(hi - lo).toFixed(4),
        med: mine.length ? +mine[mine.length >> 1].toFixed(3) : null,
        lo: mine.length ? +mine[0].toFixed(3) : null,
        hi: mine.length ? +mine[mine.length - 1].toFixed(3) : null });
      speeds.push(...mine);
    }
    let fellBack = false;
    if (!speeds.length) {
      fellBack = true;
      for (let bI = 0; bI < bones.length; bI++) {
        for (let i = 0; i < N; i++) speeds.push((z[bI][(i + 1) % N] - z[bI][i]) / step);
      }
    }
    speeds.sort((a, c) => a - c);
    const band = (speeds[speeds.length - 1] - speeds[0]) * TOL;
    let bF = 0, bT = 0;
    for (let from = 0, to = 0; from < speeds.length; from++) {
      while (to < speeds.length && speeds[to] - speeds[from] <= band) to++;
      if (to - from > bT - bF) { bF = from; bT = to; }
    }
    let t = 0; for (let i = bF; i < bT; i++) t += speeds[i];
    rows.push({ clip: clip.name, dur: +clip.duration.toFixed(3), resolved, fellBack,
      cluster: +(t / (bT - bF)).toFixed(4), share: +((bT - bF) / speeds.length).toFixed(3),
      per });
  }
  return { modelH: +(box.max.y - box.min.y).toFixed(4), minY: +box.min.y.toFixed(4),
    bones: root.children.length, rows };
}, [URL_, FEET]);

console.log(`model ${out.modelH} units tall, min y ${out.minY}`);
for (const r of out.rows) {
  console.log(`\n${r.clip}  ${r.dur}s  feet resolved ${r.resolved}`
    + `${r.fellBack ? '  [NO STANCE — fell back to all samples]' : ''}`);
  console.log(`  densest cluster ${r.cluster} u/s over ${(r.share * 100).toFixed(0)}% of samples`);
  for (const f of r.per) {
    console.log(`    ${f.foot.padEnd(12)} duty ${f.duty}  lift ${f.lift}  `
      + `stance vel ${f.lo} .. ${f.med} .. ${f.hi}`);
  }
}
await b.close();
