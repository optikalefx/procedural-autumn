// ─────────────────────────────────────────────────────────────────────────────
//  goat — the white shape on the skyline.
//
//  Everything one animal is: the blueprint (the profile arrays that are the
//  actual art), the coat variants, the gait ladder and the brain numbers.
//  `quadruped.js` turns the blueprint into geometry; nothing in here knows
//  how that is done, and nothing in there knows about this animal.
//
//  The goat is the first of the two alpine species, and the pair are the only
//  animals in the game that live *above* the world the rest of the cast shares:
//  the crags, the talus fans and the scree at the top of the massif. Two things
//  follow from that and both are in the numbers below — a goat is barely
//  frightened of a camper (nothing on a cliff is), and it climbs, which is the
//  `rock` block at the bottom of `brain`.
// ─────────────────────────────────────────────────────────────────────────────
import { MIX, mixLerp } from '../animal_rig.js';

// Mountain goat. Not a deer with white paint on it: the back line *rises* to a
// hump over the shoulders and the head is carried below it, the barrel is short
// and blocky, and the legs are short columns rather than the deer's stilts. Read
// as a flat shape at 90 m it is a pale brick with a bump on the front of it and
// a black hook on the front of that, which is exactly what the animal is.
const BLUEPRINT = () => ({
  key: 'goat',
  pelvis: [0, 0.82, -0.38],
  spine: [[0, 0.845, -0.14], [0, 0.855, 0.10]],
  chest: [0, 0.885, 0.30],
  // Short and carried level-to-low: a goat's poll sits *under* the top of its
  // own shoulder hump, which is the single proportion that stops this reading
  // as a small pale deer. Two bones, always — the animator solves the neck as a
  // two-link chain and silently welds the skull to the shoulders below that.
  neck: [[0, 0.975, 0.44], [0, 1.045, 0.58]],
  head: [0, 1.045, 0.68],
  // A goat's backside is a rounded woolly mass, not a taper.
  rumpTip: false,
  barrel: [
    { z: -0.60, y: 0.780, rx: 0.115, ry: 0.130 },
    { z: -0.52, y: 0.820, rx: 0.165, ry: 0.185, key: 1 },
    { z: -0.38, y: 0.845, rx: 0.196, ry: 0.212, key: 1 },   // haunch
    { z: -0.14, y: 0.845, rx: 0.190, ry: 0.222 },
    { z: 0.10, y: 0.855, rx: 0.196, ry: 0.238, key: 1 },
    // The withers hump. It is the highest point on the animal and it is the
    // whole silhouette — flagged `key` so the mid LOD keeps it, for the same
    // reason the bear's is.
    { z: 0.28, y: 0.885, rx: 0.204, ry: 0.262, key: 1 },
    { z: 0.42, y: 0.855, rx: 0.150, ry: 0.196, key: 1 },
  ],
  belly: [
    { z: -0.28, y: 0.700, rx: 0.115, ry: 0.050 },
    { z: 0.00, y: 0.685, rx: 0.130, ry: 0.058 },
    { z: 0.26, y: 0.705, rx: 0.120, ry: 0.052 },
  ],
  // As deep at the root as the withers station it grows out of. A narrower
  // first station looks fine standing and then becomes a discrete hump the
  // moment graze folds the neck down and exposes the seam.
  neckProfile: [
    { rx: 0.170, ry: 0.230 },
    { rx: 0.140, ry: 0.180 },
    { rx: 0.108, ry: 0.128 },
    { rx: 0.086, ry: 0.098 },
  ],
  // Narrow, straight-profiled skull. No beard: it is 12 cm of hair on an animal
  // whose closest honest approach is tens of metres, and the horns above it are
  // already doing the identification work at every range that exists.
  headProfile: [
    { dy: -0.006, dz: -0.086, rx: 0.078, ry: 0.084 },
    { dy: 0.002, dz: -0.012, rx: 0.092, ry: 0.098 },
    { dy: -0.010, dz: 0.066, rx: 0.066, ry: 0.068 },
    { dy: -0.026, dz: 0.136, rx: 0.050, ry: 0.048 },
    { dy: -0.038, dz: 0.178, rx: 0.040, ry: 0.036, mix: MIX.dark },
  ],
  ear: { at: [0.062, 0.046, -0.024], dir: [0.72, 0.60, -0.26], len: 0.115, w: 0.048, h: 0.032 },
  // Short, held clear of the rump, dark underneath. `tailMixBias` holds the
  // pale coat until the last of it so this is a dark tip rather than half a
  // dark tail — see the fox's brush.
  tail: [[0, 0.800, -0.600], [0, 0.815, -0.660]],
  tailR: [0.038, 0.020], tailFlat: 0.90,
  tailMix: MIX.coat, tailTipMix: mixLerp(MIX.coat, MIX.dark, 0.65), tailMixBias: 2.0,
  // ── why the joints zigzag ──────────────────────────────────────────────────
  // Same arithmetic the bear's header sets out. Standing hip→hock has to sit
  // under ~85% of what `|knee| + |hock|` can reach or the IK clamps straight
  // for most of the stride and the legs visibly lock. These sit at 83% and 84%,
  // front and back, on legs deliberately short: a goat is a body on stumps.
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.135, 0.86, -0.36], knee: [0, -0.28, 0.14], hock: [0, -0.22, -0.19], foot: [0, -0.36, 0.04],
    rTop: 0.135, rMid: 0.062, rLow: 0.038, rFoot: 0.028, flat: 0.86,
    hoofH: 0.052, hoofR: 0.038, hoofLong: 1.25, hoofFwd: 0.006, sockTop: 0.86,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.125, 0.95, 0.28], knee: [0, -0.30, -0.16], hock: [0, -0.24, 0.19], foot: [0, -0.41, 0.0],
    rTop: 0.128, rMid: 0.060, rLow: 0.037, rFoot: 0.027, flat: 0.86,
    hoofH: 0.052, hoofR: 0.036, hoofLong: 1.25, hoofFwd: 0.006, sockTop: 0.86,
  },
});

// Both sexes carry horns, so unlike the stag's rack this is not variant data —
// every goat gets it. `tineEvery: 99` is the whole trick: the antler builder
// forks a tine every `tineEvery` segments and there are only seven, so a number
// past the end buys a bare curving beam. That beam already sweeps back and down
// as it grows (see `buildAntler`), which is precisely a goat's horn.
const GOAT_HORN = {
  base: [0.042, 0.062, -0.030],
  out: 0.22, up: 0.92, back: -0.34,
  len: 0.24, r0: 0.026, r1: 0.009, tineEvery: 99,
};

export const GOAT = {
  key: 'goat',
  plural: 'Mountain goats',
  // ── a pale animal, and the one hide in the cast that keeps its value ──────
  // Every other coat here is dark because it has to survive being a silhouette
  // against a #f0ad46 meadow. A goat is never against a meadow: it is against
  // wet grey rock, blue shadow and sky, and the reason a real one is visible at
  // two kilometres is that it is *lighter* than all three. So the identity is
  // carried the other way up — a near-white coat with black horns, hooves and
  // muzzle — and the distance treatment is turned down to match.
  //
  // `silFlat` collapses the four hide regions toward `dark` with range and
  // `silDark` pulls the whole animal down in value; at the cast defaults
  // (0.55 / 0.72) a goat at 120 m is a grey blob, which throws away the only
  // cue this animal has. Turned down rather than off: some flattening still
  // buys the shape, and a hide that ignored the ramp entirely would be the one
  // animal in the game that gets *brighter* relative to its neighbours as it
  // recedes.
  variants: [
    { name: 'nanny', scale: 0.94, antler: GOAT_HORN, weight: 0.44,
      col: { coat: 0xcfc8b6, pale: 0xe6e0d0, dark: 0x413c36, horn: 0x2c2926,
        silFlat: 0.26, silDark: 0.90 } },
    { name: 'billy', scale: 1.08, antler: GOAT_HORN, weight: 0.30,
      col: { coat: 0xd6cfbd, pale: 0xeee8d8, dark: 0x3a352f, horn: 0x272421,
        silFlat: 0.26, silDark: 0.90 } },
    { name: 'kid', scale: 0.68, antler: GOAT_HORN, weight: 0.16,
      col: { coat: 0xd9d3c3, pale: 0xefeade, dark: 0x484239, horn: 0x36322d,
        silFlat: 0.26, silDark: 0.90 } },
    // Summer coat, half shed and stained by the rock it lies on.
    { name: 'smoke', scale: 0.99, antler: GOAT_HORN, weight: 0.10,
      col: { coat: 0xb2aa98, pale: 0xd8d1c0, dark: 0x3c372f, horn: 0x2a2724,
        silFlat: 0.30, silDark: 0.88 } },
  ],
  blueprint: BLUEPRINT,
  gait: {
    walk: 1.05, trot: 2.8, run: 7.5,
    strideBase: 0.85, strideGain: 2.2, dutyWalk: 0.65, dutyTrot: 0.52, dutyRun: 0.34,
    bobAmp: 0.032, pitchAmp: 0.045, liftScale: 0.95,
    grazeAng: 1.25, grazeRake: 1.40,
  },
  brain: {
    // ── barely frightened, and honestly so ──────────────────────────────────
    // A mountain goat lives where nothing can follow it, and it behaves like
    // it: it looks up, it watches, and it does not leave. So `noticeDist` is
    // short (there is no long-range wariness to model), `fleeDist` is the
    // shortest in the cast after the bear's, and `calmDist` is close behind it
    // — the whole encounter is meant to resolve into the animal standing there
    // looking at you, which is also the most legible thing it can do.
    //
    // No `standoff`: that lever walks a stand point out of canopy shadow, and
    // there is no canopy at 200 m of altitude to walk out of.
    alertDist: 30, fleeDist: 9, calmDist: 50, noticeDist: 55,
    // One step outside `noticeDist`, and well inside the 165 m spawn ring —
    // see the deer's note for why that ring is the real ceiling on this.
    hintDist: 78,
    freezeTime: [0.8, 1.8], fleeTime: [2.0, 4.0],
    grazeTime: [8, 22], idleTime: [3, 8], walkTime: [5, 14],
    herd: [1, 3], herdRadius: 7, wanderRadius: 22,
    grazeChance: 0.45,
    // ── the rock ────────────────────────────────────────────────────────────
    // The block that makes this species what it is. See `animal_brain.js`
    // (CLIMB / PERCH) for the machinery and `Wildlife._findPerches` for where
    // the boulder list comes from.
    rock: {
      // Where a goat may stand at all. `slopeMax` widens the two hard gates
      // every other species is held to — placement, wander targets and the
      // probe fan all read it — and `slopeSoft` is where the fan starts
      // charging for steepness at all. A goat on 0.45 slope is a goat on a
      // lawn.
      slopeMax: 1.45, slopeSoft: 0.95,
      // Altitude band. Below the first number there is no goat at any
      // steepness; the ramp is what keeps them off the shoulders of the
      // valley and on the massif.
      // A goat wants the rock it is standing on, so the habitat raster is read
      // at the point itself — `nearCells: 0`. See `Wildlife._rockiness`.
      altBand: [140, 215], rockGain: 2.10, slopeBest: [0.45, 0.95], nearCells: 0,
      // ── what counts as a boulder worth standing on ────────────────────
      // Measured, not guessed. Within 48 m of a goat site the rock scatter
      // leaves about twelve instances over 0.6 m, and almost all of them fail
      // one of the three tests below — the crag bands are 15-25 m slabs, the
      // scree is ankle-deep rubble, and a great many rocks on a hillside have
      // their summit BELOW the ground level at their own centre because
      // placement buries them against the lowest corner of their footprint.
      // What survives is 0.8 boulders per site: a bit under half of all bands
      // get one, and that is the intent rather than a shortfall. A band with a
      // rock is a band with a rock; one without is grazing the scree like
      // anything else, and a mountain where every group is standing on a
      // plinth would be a diorama.
      //
      //   rise   summit above the ground under it. Under 0.60 m it is a kerb
      //          and standing on it reads as nothing at all.
      //   maxR   half-width in plan. A 20 m crag bench would become a 20 m
      //          mesa under `Brain._groundY`'s dome, which is a lie the eye
      //          catches instantly.
      //   steep  minimum rise per metre of half-width. This is the one that
      //          rejects the flat slabs: a rock has to actually stick up
      //          before climbing it is a thing the player can see happening.
      search: 48, minSize: 0.60, rise: [0.60, 3.00], maxR: 7.0, steep: 0.25,
      // How far an animal will walk to one. Generous, because the walk to the
      // rock is itself worth watching and because the alternative is a goat
      // that stands next to a boulder it has decided is too far away.
      reach: 45,
      // How far the band's stand point may be dragged to sit beside its
      // boulder — see `Wildlife._standAtRock`. Well inside the 40 m gap
      // between this species' spawn and despawn radii, which is the real
      // ceiling on it: the streaming tests are measured at the SITE, and a
      // stand point too far from one would let a group wake inside the view.
      snap: 25,
      // How often an animal with nothing else to do goes up, how long it
      // stays, and how often a wander is a lap of a boulder instead of a walk
      // across the hill. The lap is the other half of the brief: they climb
      // onto the rocks, and they climb *around* them.
      climbChance: 0.55, perchTime: [12, 34], orbit: 0.55,
    },
  },
};
