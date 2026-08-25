#!/usr/bin/env node
// dogslope — walk the dog rig across/up/down steep ground; find backward-neck poses.
import * as THREE from 'three';
import { buildCampDog } from '../../src/wildlife/animal_species.js';
import { instantiate } from '../../src/wildlife/animal_rig.js';
import { AnimRig } from '../../src/wildlife/animal_anim.js';
import { DOG_GAIT_CFG } from '../../src/camp/camp_dog.js';

const protos = buildCampDog(0xd06);
const proto = protos[0];

for (const grade of [0, 0.15, 0.3, 0.45, 0.6]) {
  for (const dir of ['up', 'down', 'across']) {
    const world = { getHeight: (x, z) => z * grade, getSlope: () => grade };
    const inst = instantiate(proto, new THREE.MeshBasicMaterial(), 0);
    const rig = new AnimRig(proto, inst, 1, DOG_GAIT_CFG, 'dog');
    const root = new THREE.Group(); root.add(inst.mesh);
    const heading = dir === 'up' ? 0 : dir === 'down' ? Math.PI : Math.PI / 2;
    const pos = new THREE.Vector3(0, 0, 0);
    const drive = { pos, heading, speed: 0.7, graze: 0, alert: 0.1, flag: 0, look: null, lod: 0 };
    rig.reset(pos, heading, world);
    const muz = new THREE.Vector3();
    let worstUp = -2, worstAt = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 600; i++) {
      pos.x += Math.sin(heading) * drive.speed * dt;
      pos.z += Math.cos(heading) * drive.speed * dt;
      pos.y = world.getHeight(pos.x, pos.z);
      rig.update(dt, drive, world);
      root.updateMatrixWorld(true);
      // muzzle direction: head bone's local +z (forward) in world
      muz.set(0, 0, 1).transformDirection(inst.byName['head'].matrixWorld);
      // how far "back" is the muzzle pointing relative to travel?
      const fwd = Math.sin(heading) * muz.x + Math.cos(heading) * muz.z;
      if (i > 120 && muz.y > worstUp) { worstUp = muz.y; worstAt = fwd; }
    }
    console.log(`grade ${grade} ${dir.padEnd(6)} muzzle max upY ${worstUp.toFixed(2)} (fwd comp ${worstAt.toFixed(2)})`);
  }
}
