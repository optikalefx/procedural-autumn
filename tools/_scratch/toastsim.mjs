// ─────────────────────────────────────────────────────────────────────────────
//  toastsim — headless driver for src/camp/marshmallow_toast.js
//
//  The toast rates have two acceptance criteria written into the contract, and
//  neither of them can be checked in the game without sitting in front of a
//  fireside view with a stopwatch for a minute at a time, six times a round:
//
//    · a patient player who turns steadily reaches "golden all over"
//      (doneness .55-.80, evenness > .78) in roughly 35-55 s
//    · a player who never turns has a black side in about 20 s
//
//  So: build a ToastMap, synthesise the stick transform the view would produce,
//  step it at a fixed 60 Hz for sixty simulated seconds under several policies,
//  and print the getters. No three.js rendering is involved and none is needed —
//  the whole simulation is CPU state and a world matrix.
//
//  The pose matches the view's contract: the marshmallow sits over the flame,
//  the stick comes in from the lower right so the mallow's own axis is roughly
//  horizontal, and "height" is measured above the flame's hottest point.
//
//    node tools/_scratch/toastsim.mjs
//    node tools/_scratch/toastsim.mjs --hz 30 --seconds 90
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { ToastMap } from '../../src/camp/marshmallow_toast.js';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const HZ = arg('hz', 60);
const SECONDS = arg('seconds', 60);
const DT = 1 / HZ;

// The fire, as Camp publishes it. `top` is the height of the flame's hottest
// point above the pit centre; the flame geometry is 0.80 m tall and its hot core
// lives in the lower half of that.
const FIRE = { pos: new THREE.Vector3(0, 0, 0), top: 0.30, power: 1 };

/**
 * The marshmallow's world transform.
 *
 * @param height  metres above the flame's hottest point (the view's range is
 *                0.10 to 0.55)
 * @param spin    radians about the stick's own axis
 *
 * The stick runs along its local +Z and is held roughly level, so the mallow's
 * own axis is horizontal — laid along world +X here — and the spin is a roll
 * about that axis. The mallow is set 40 mm off the fire's axis, which is where
 * somebody sitting at the edge of the ring actually holds it.
 */
function pose(obj, height, spin) {
  obj.position.set(0.04, FIRE.pos.y + FIRE.top + height, 0.02);
  // local +Z onto world +X, then roll.
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), spin));
  obj.quaternion.copy(q);
  obj.updateMatrixWorld(true);
}

const POLICIES = [
  {
    name: 'never turn        (0.25 m, no spin)',
    height: () => 0.25,
    spin: () => 0,
  },
  {
    name: 'turn steadily     (0.25 m, 2.0 rad/s)',
    height: () => 0.25,
    spin: (t) => t * 2.0,
  },
  {
    name: 'held in the flame (0.06 m, no spin)',
    height: () => 0.06,
    spin: () => 0,
  },
  {
    name: 'timid: high+turn  (0.55 m, 2.0 rad/s)',
    height: () => 0.55,
    spin: (t) => t * 2.0,
  },
];

const pad = (s, n) => String(s).padEnd(n);
const f2 = (v) => v.toFixed(3);

for (const p of POLICIES) {
  const map = new ToastMap();
  const obj = new THREE.Object3D();
  console.log('\n' + '─'.repeat(96));
  console.log(p.name);
  console.log('─'.repeat(96));
  console.log('   t  doneness evenness    peak   ruined     melt     heat  burn  grade');

  let t = 0;
  let nextPrint = 0;
  // Where each milestone was crossed, so the acceptance criteria are numbers
  // rather than a shape in a table.
  const marks = {};
  while (t <= SECONDS + 1e-9) {
    if (t >= nextPrint - 1e-9) {
      const g = map.grade();
      console.log(
        pad(t.toFixed(0).padStart(4), 4) + '  ' +
        pad(f2(map.doneness), 7) + '  ' +
        pad(f2(map.evenness), 7) + '  ' +
        pad(f2(map.peak), 6) + '  ' +
        pad(f2(map.ruined), 7) + '  ' +
        pad(f2(map.melt), 7) + '  ' +
        pad(f2(map.heat), 7) + '  ' +
        pad(map.burning ? 'YES' : ' . ', 4) + '  ' + g.key + ' (' + g.label + ')');
      nextPrint += 5;
    }
    if (!marks.gold && map.doneness >= 0.55) marks.gold = t;
    if (!marks.past && map.doneness > 0.80) marks.past = t;
    if (!marks.black && map.peak >= 0.995) marks.black = t;
    if (!marks.charred && map.ruined >= 0.16) marks.charred = t;
    if (!marks.alight && map.burning) marks.alight = t;
    if (!marks.perfect && map.grade().key === 'perfect') marks.perfect = t;

    pose(obj, p.height(t), p.spin(t));
    map.update(DT, obj, FIRE);
    t += DT;
  }
  const m = (k) => (marks[k] === undefined ? '  --  ' : marks[k].toFixed(1) + 's');
  console.log(
    '  milestones: doneness>=.55 ' + m('gold') +
    '   doneness>.80 ' + m('past') +
    '   a texel fully black ' + m('black') +
    '\n              16% charred ' + m('charred') +
    '   alight ' + m('alight') +
    '   first graded perfect ' + m('perfect'));
  map.dispose();
}

// ── the debug hooks the harness needs ───────────────────────────────────────
console.log('\n' + '─'.repeat(96));
console.log('debug hooks (tools/roastshot.mjs drives the capture sheet through these)');
console.log('─'.repeat(96));
{
  const map = new ToastMap();
  for (const k of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    map.setDoneness(k);
    const g = map.grade();
    console.log('  setDoneness(' + k.toFixed(1) + ')  doneness ' + f2(map.doneness) +
      '  evenness ' + f2(map.evenness) + '  ruined ' + f2(map.ruined) + '  -> ' + g.key);
  }
  map.reset();
  // The 'uneven' frame: one side toasted hard, the other left alone. Two
  // overlapping patches so the painted side covers a bit more than a hemisphere,
  // which is what a marshmallow that was turned once and then forgotten looks
  // like.
  map.paint(0.25, 0.5, 0.34, 0.95);
  map.paint(0.25, 0.5, 0.52, 0.45);
  console.log('  paint(uneven)      doneness ' + f2(map.doneness) +
    '  evenness ' + f2(map.evenness) + '  peak ' + f2(map.peak) +
    '  -> ' + map.grade().key + ' (' + map.grade().label + ')');
  map.reset();
  map.ignite();
  console.log('  ignite()           doneness ' + f2(map.doneness) +
    '  ruined ' + f2(map.ruined) + '  burning ' + map.burning +
    '  -> ' + map.grade().key);
  map.douse();
  console.log('  douse()            burning ' + map.burning + '  heat ' + f2(map.heat));
  map.reset();
  console.log('  reset()            doneness ' + f2(map.doneness) +
    '  evenness ' + f2(map.evenness) + '  -> ' + map.grade().key);
  map.dispose();
}

// ── the seam ────────────────────────────────────────────────────────────────
// u = 0 and u = 1 are the same ring of the marshmallow. If paint() did not take
// the shortest way round the circle, a patch centred on the seam would come out
// as two patches with a raw stripe between them — which is invisible in a table
// of means and glaring in a frame.
{
  const map = new ToastMap();
  map.paint(0.0, 0.5, 0.20, 1.0);
  const row = Math.floor(map.bands / 2);
  const strip = [];
  for (let i = 0; i < map.rings; i++) strip.push(map.toast[row * map.rings + i].toFixed(2));
  console.log('\n  paint() across the u seam, middle row:\n    ' + strip.join(' '));
  map.dispose();
}
