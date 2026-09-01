// The encounter's state machine, simulated in node against a stub valley.
//
// A browser run costs a world bake and a contended GPU; the machine under test
// needs neither. `Bigfoot` asks the world four questions and the camera one, so
// both are twenty lines of stub — and what comes back is a deterministic trace
// instead of whatever the frame rate happened to be.
import * as THREE from 'three';
import { Bigfoot } from '/Users/sean/htdocs/procedural-fall/src/wildlife/bigfoot.js';

// A flat wet forest, everywhere. The habitat gates are tested separately below.
const world = {
  getHeight: () => 0,
  getMoisture: () => 0.9,
  getSlope: () => 0.1,
  getWaterDepth: () => 0,
};
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2000);
const ctx = { world, scene, camera: cam };

const aim = (at) => {
  cam.position.set(0, 1.7, 0);
  if (at) cam.lookAt(at.x, at.y + 1.1, at.z); else cam.lookAt(0, 1.7, 1000);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
};

const bf = new Bigfoot(ctx, 12345);
bf.armed = true;
aim(null);

const NAMES = ['WAIT', 'SEEN', 'LEAVE', 'LOOK'];
const dt = 1 / 60;
let t = 0, spawnedAt = null, look = false;
const marks = [];
let last = null;

for (let i = 0; i < 60 * 200; i++) {
  // The player looks at him one second after he appears, and keeps looking.
  if (bf.present && spawnedAt == null) { spawnedAt = t; }
  if (spawnedAt != null && t - spawnedAt > 1.0) look = true;
  aim(look && bf.present ? bf.pos : null);
  bf.update(dt, cam);
  const st = bf.present ? NAMES[bf.state] : 'GONE';
  if (st !== last) {
    marks.push({ t: +t.toFixed(2), st,
      d: bf.present ? +Math.hypot(bf.pos.x, bf.pos.z).toFixed(1) : null,
      look: +bf._look.toFixed(2), mv: +bf._moving.toFixed(2) });
    last = st;
    if (st === 'GONE' && spawnedAt != null) break;
  }
  t += dt;
}

console.log('state trace  (t, state, distance from camera, lookBack, moving)');
for (const m of marks) {
  console.log(`  ${String(m.t).padStart(7)}s  ${m.st.padEnd(6)} ` +
    `${String(m.d).padStart(6)} m  look ${String(m.look).padStart(5)}  mv ${String(m.mv).padStart(5)}`);
}
console.log('stats', JSON.stringify(bf.stats));

// ── the habitat gates ────────────────────────────────────────────────────────
const gate = (name, patch) => {
  const w = { ...world, ...patch };
  const b = new Bigfoot({ world: w, scene: new THREE.Scene(), camera: cam }, 7);
  b.armed = true;
  aim(null);
  for (let i = 0; i < 60 * 40 && !b.present; i++) b.update(dt, cam);
  console.log(`  ${name.padEnd(26)} ${b.present ? 'SPAWNS' : 'no spawn'}`);
};
console.log('\nhabitat gates over 40 s of trying');
gate('deep wet forest', {});
gate('meadow (moisture 0.35)', { getMoisture: () => 0.35 });
gate('forest but a cliff', { getSlope: () => 0.9 });
gate('forest but a lake', { getWaterDepth: () => 2 });
gate('forest above 260 m', { getHeight: () => 300 });

// ── never in shot ────────────────────────────────────────────────────────────
// Fifty spawns, and the frustum guard checked against every one of them.
let inShot = 0, n = 0;
const frustum = new THREE.Frustum(), pm = new THREE.Matrix4();
for (let s = 0; s < 50; s++) {
  const b = new Bigfoot(ctx, 1000 + s);
  b.armed = true;
  aim(null);
  for (let i = 0; i < 60 * 30 && !b.present; i++) b.update(dt, cam);
  if (!b.present) continue;
  n++;
  pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  frustum.setFromProjectionMatrix(pm);
  const sph = new THREE.Sphere(new THREE.Vector3(b.pos.x, b.pos.y + 1.11, b.pos.z), 1.11);
  if (frustum.intersectsSphere(sph)) inShot++;
}
console.log(`\n${n} spawns, ${inShot} of them inside the frustum at the moment they appeared`);
