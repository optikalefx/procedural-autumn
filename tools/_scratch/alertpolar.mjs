// What the Cartesian alert lift actually asks of each species' neck.
import * as THREE from 'three';
import { SPECIES, buildSpecies } from '../../src/wildlife/animal_species.js';
import { instantiate } from '../../src/wildlife/animal_rig.js';
import { AnimRig } from '../../src/wildlife/animal_anim.js';
for (const key of ['deer','fox','bear','raccoon','rabbit','squirrel','dog']) {
  let proto; try { proto = buildSpecies(key, 12345)[0]; } catch (e) { console.log(key, 'skip'); continue; }
  const sp = SPECIES[key], v = sp.variants[0];
  const inst = instantiate(proto, new THREE.MeshBasicMaterial(), 0);
  const rig = new AnimRig(proto, inst, v.scale, sp.gait, key);
  const nk = rig.neckK;
  const b = rig.neckBase, r = rig.neckRest;
  const ax = 0, ay = r.y + 0.16 * nk, az = r.z - 0.06 * nk;
  const dy = ay - b.y, dz = az - b.z;
  const ang = Math.atan2(-dy, dz), len = Math.hypot(dy, dz);
  console.log(
    key.padEnd(9),
    'span', rig.neckSpan.toFixed(3),
    'nk', nk.toFixed(2),
    '| rest ang', rig.restAng.toFixed(3), 'len', rig.restLen.toFixed(3), `(${(rig.restLen/rig.neckSpan*100).toFixed(0)}% reach)`,
    '| alert ang', ang.toFixed(3), 'len', len.toFixed(3), `(${(len/rig.neckSpan*100).toFixed(0)}%)`,
    '| d(ang)', (rig.restAng - ang).toFixed(3), 'reach x', (len / rig.restLen).toFixed(3),
  );
}
