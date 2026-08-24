import * as THREE from 'three';
import { buildCampDog, SPECIES } from '../../src/wildlife/animal_species.js';
import { instantiate } from '../../src/wildlife/animal_rig.js';
import { AnimRig } from '../../src/wildlife/animal_anim.js';
const world = { getHeight: () => 0 };
const protos = buildCampDog(12345);
const proto = protos[0];
const sp = { gait: { walk: 0.95, trot: 2.6, run: 6.5, strideBase: 0.62, strideGain: 2.4, dutyWalk: 0.62, dutyTrot: 0.50, dutyRun: 0.32, bobAmp: 0.020, pitchAmp: 0.038, liftScale: 1.05, grazeAng: 1.32, grazeRake: 1.40 } };
for (const [name, spd, gz, al] of [['stand',0,0,0],['walk',0.95,0,0],['trot',2.6,0,0.3],['sniff',0,1,0]]) {
  const inst = instantiate(proto, new THREE.MeshBasicMaterial(), 0);
  const rig = new AnimRig(proto, inst, 1, sp.gait, 'dog');
  const root = new THREE.Group(); root.add(inst.mesh);
  const pos = new THREE.Vector3();
  const drive = { pos, heading: 0, speed: spd, graze: gz, alert: al, flag: 0, look: null, lod: 0 };
  rig.reset(pos, 0, world);
  const q = new THREE.Quaternion(), qp = new THREE.Quaternion();
  let maxW = 0; const dt = 1/60;
  for (let i = 0; i < 600; i++) {
    pos.z += drive.speed * dt;
    rig.update(dt, drive, world);
    root.updateMatrixWorld(true);
    inst.byName['head'].getWorldQuaternion(q);
    if (i > 120) { const w = 2 * Math.acos(Math.min(1, Math.abs(q.dot(qp)))) / dt; if (w > maxW) maxW = w; }
    qp.copy(q);
  }
  const hd = new THREE.Vector3().setFromMatrixPosition(inst.byName['head'].matrixWorld);
  console.log('dog', name.padEnd(6), 'max head ang vel', maxW.toFixed(2), ' head', hd.y.toFixed(3), hd.z.toFixed(3));
}
