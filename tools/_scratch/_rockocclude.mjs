// Geometry check for hunt_detect.clearRocks against a fake rock system.
import * as THREE from 'three';
import { _internals as I } from '../../src/game/hunt_detect.js';

const mk = (x, z, top, reach, size = 2) => ({ x, z, y: 0, top, reach, size });
const rocks = {
  list: [],
  drawnRocksAround(x, z, r, minSize, out) {
    for (const i of this.list) {
      const dx = i.x - x, dz = i.z - z;
      if (dx * dx + dz * dz < r * r && i.size >= minSize) out.push(i);
    }
    return out;
  },
  reachOf: (i) => i.reach,
  topOf: (i) => i.top,
};

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const cases = [];
const t = (name, want, eye, sub, r, list) => {
  rocks.list = list;
  const got = I.clearRocks(rocks, eye, sub, r);
  cases.push([name, want === got, `want clear=${want} got=${got}`]);
};

// The report: moose 30 m off, half-height 1.35 (mid-height 1.35), a 3 m slab
// halfway between at 3 m tall.
t('moose behind a 3 m slab', false, V(0, 2, 0), V(0, 1.35, 30), 1.35,
  [mk(0, 15, 3.0, 3.0)]);
// Same slab, but only 1 m tall — you see over it.
t('moose behind a 1 m cobble', true, V(0, 2, 0), V(0, 1.35, 30), 1.35,
  [mk(0, 15, 1.0, 3.0)]);
// Slab off to one side of the corridor.
t('slab 10 m off the line', true, V(0, 2, 0), V(0, 1.35, 30), 1.35,
  [mk(10, 15, 3.0, 3.0)]);
// Goat standing ON its boulder: rock disc contains the subject.
t('goat on its own boulder', true, V(0, 2, 0), V(0, 3.7, 24), 0.68,
  [mk(0, 24, 3.0, 3.0)]);
// The photographer standing on the crag, looking down off it at an animal 30 m
// out on the flat. The crag's summit is above the line of sight and its disc
// contains the lens — you are on the thing, it is not in front of you.
t('photographer on the crag', true, V(0, 12, 0), V(0, 1.35, 30), 1.35,
  [mk(4, -2, 13.0, 11.7)]);
// Rock behind the subject.
t('rock behind the subject', true, V(0, 2, 0), V(0, 1.35, 30), 1.35,
  [mk(0, 40, 6.0, 3.0)]);
// Rock behind the camera.
t('rock behind the camera', true, V(0, 2, 0), V(0, 1.35, 30), 1.35,
  [mk(0, -12, 6.0, 3.0)]);
// Shingle: under ROCK_MIN, never asked about even though it is "tall".
t('shingle under the size cut', true, V(0, 2, 0), V(0, 1.35, 30), 1.35,
  [mk(0, 15, 9.0, 3.0, 0.2)]);
// Subject closer than 6 m: the bail.
t('subject inside 6 m', true, V(0, 2, 0), V(0, 1.35, 4), 1.35,
  [mk(0, 2, 9.0, 3.0)]);
// No rock system at all.
cases.push(['no rock system', I.clearRocks(null, V(0,2,0), V(0,1.35,30), 1.35) === true, '']);
// Looking DOWN from a bank at a heron 40 m off. The ray is 6.99 m up where it
// crosses a slab 6 m from the lens, so a 9 m slab hides the bird and a 7.4 m
// one does not — the second is inside OCC_TOL of the line and is the shape of
// every "you can see past it" near miss.
t('downhill lens, 9 m slab', false, V(0, 8, 0), V(0, 0.8, 40), 0.8,
  [mk(0, 6, 9.0, 2.0)]);
t('downhill lens, slab just under the ray', true, V(0, 8, 0), V(0, 0.8, 40), 0.8,
  [mk(0, 6, 7.4, 2.0)]);

let bad = 0;
for (const [n, ok, why] of cases) {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n}${ok ? '' : '   ' + why}`);
}
console.log(bad ? `\n${bad} FAILED` : '\nall pass');
