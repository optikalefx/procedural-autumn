#!/usr/bin/env node
import * as THREE from 'three';
import { buildCampDog } from '../../src/wildlife/animal_species.js';
import { instantiate } from '../../src/wildlife/animal_rig.js';
import { AnimRig } from '../../src/wildlife/animal_anim.js';
import { DOG_GAIT_CFG } from '../../src/camp/camp_dog.js';

const proto = buildCampDog(0xd06)[0];
for (const grade of [0, 0.15, 0.3]) {
  const world = { getHeight: (x, z) => z * grade, getSlope: () => grade };
  const inst = instantiate(proto, new THREE.MeshBasicMaterial(), 0);
  const rig = new AnimRig(proto, inst, 1, DOG_GAIT_CFG, 'dog');
  const root = new THREE.Group(); root.add(inst.mesh);
  const heading = Math.PI; // downhill
  const pos = new THREE.Vector3();
  const drive = { pos, heading, speed: 0.7, graze: 0, alert: 0.1, flag: 0, look: null, lod: 0 };
  rig.reset(pos, heading, world);
  const dt = 1 / 60;
  for (let i = 0; i < 480; i++) {
    pos.x += Math.sin(heading) * drive.speed * dt;
    pos.z += Math.cos(heading) * drive.speed * dt;
    pos.y = world.getHeight(pos.x, pos.z);
    rig.update(dt, drive, world);
  }
  root.updateMatrixWorld(true);
  // chest-frame target elevation, recomputed the way _poseHead does
  const b = rig.headTarget.clone();
  rig.mesh.localToWorld(b);
  const m = rig.chest.matrixWorld.clone().invert();
  b.applyMatrix4(m);
  const fz = Math.hypot(b.x, b.z) * Math.sign(b.z || 1);
  const dy = b.y - rig.neck.a.position.y, dz = fz - rig.neck.a.position.z;
  const muz = new THREE.Vector3(0, 0, 1).transformDirection(inst.byName['head'].matrixWorld);
  // the probe _poseHead uses, recomputed
  const pr = rig.neckRest.clone().sub(rig.neckBase);
  pr.transformDirection(rig.mesh.matrixWorld);
  pr.transformDirection(m);
  const ppz = Math.hypot(pr.x, pr.z) * Math.sign(pr.z || 1);
  const probeElev = Math.atan2(pr.y, ppz);
  console.log(`grade ${grade}: bodyPitch ${rig.bodyPitch.toFixed(3)}`,
    `rawElev ${Math.atan2(dy, dz).toFixed(3)} probeDelta ${(probeElev + rig.restAng).toFixed(3)}`,
    `neckA ${rig.neck.a.rotation.x.toFixed(3)} neckB ${rig.neck.b.rotation.x.toFixed(3)}`,
    `headRx ${rig.head.rotation.x.toFixed(3)} muzY ${muz.y.toFixed(2)}`);
}
