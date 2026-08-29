import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';

const buf = readFileSync(process.argv[2]);
const loader = new GLTFLoader();
loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', (g) => {
  const root = g.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const h = box.max.y - box.min.y;
  console.log('bbox', JSON.stringify({min:box.min.toArray().map(v=>+v.toFixed(3)), max:box.max.toArray().map(v=>+v.toFixed(3))}), 'height', h.toFixed(3));
  console.log('clips', g.animations.map(a => `${a.name}=${a.duration.toFixed(3)}s`).join(' '));

  const walk = g.animations.find(a => a.name === 'Walk');
  const mixer = new THREE.AnimationMixer(root);
  const act = mixer.clipAction(walk); act.play();

  const feet = ['fore_footL','fore_footR','hind_footL','hind_footR'];
  const track = {}; feet.forEach(f => track[f] = {minz: Infinity, maxz: -Infinity, miny: Infinity});
  const p = new THREE.Vector3();
  const N = 96;
  for (let i = 0; i < N; i++) {
    mixer.setTime((i / N) * walk.duration);
    root.updateMatrixWorld(true);
    for (const f of feet) {
      const b = root.getObjectByName(f);
      if (!b) { console.log('MISSING BONE', f); continue; }
      p.setFromMatrixPosition(b.matrixWorld);
      const t = track[f];
      t.minz = Math.min(t.minz, p.z); t.maxz = Math.max(t.maxz, p.z);
      t.miny = Math.min(t.miny, p.y);
    }
  }
  for (const f of feet) {
    const t = track[f];
    console.log(`${f.padEnd(14)} z-travel=${(t.maxz-t.minz).toFixed(4)} model-units   lowest y=${t.miny.toFixed(3)}`);
  }
  const stride = Math.max(...feet.map(f => track[f].maxz - track[f].minz));
  console.log(`\nstride (model units) = ${stride.toFixed(4)}`);
  for (const target of [0.55, 0.62, 0.70]) {
    const s = target / h;
    console.log(`  target height ${target}m -> scale ${s.toFixed(4)}, stride ${(stride*s).toFixed(4)} m, implied ground speed ${(stride*s/walk.duration).toFixed(4)} m/s at 1x`);
  }
}, (e) => { console.error('PARSE FAIL', e); process.exit(1); });
