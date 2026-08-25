// ─────────────────────────────────────────────────────────────────────────────
//  raccoon — the nocturnal one, identified by markings not by shape.
//
//  Everything one animal is: the blueprint (the profile arrays that are the
//  actual art), the coat variants, the gait ladder and the brain numbers.
//  `quadruped.js` turns the blueprint into geometry; nothing in here knows
//  how that is done, and nothing in there knows about this animal.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp01 } from '../../core/MathUtils.js';
import { MIX, mixLerp } from '../animal_rig.js';

// Raccoon. The night animal, and the only one in the cast whose identity is
// carried by MARKINGS rather than by proportions — which changes what this
// blueprint has to get right.
//
// Every other species here is a silhouette argument: the bear's hump, the fox's
// brush, the deer's flag. A raccoon read as a flat shape is a badger. The two
// things that make it a raccoon are the black bandit mask on a pale face and
// the banded tail, and both are colour, so this is the one blueprint where the
// mix channel is doing as much work as the profile arrays. That in turn is why
// the palette below is authored LIGHT and why the silhouette treatment is
// switched off for this species (see the `sil*` fields in SPECIES.raccoon):
// collapsing four regions into one flat dark tone deletes the entire animal,
// and it does it at exactly the ranges a nocturnal animal is seen at.
//
// The frame under the markings is mined from the bear more than the squirrel:
// a long low hunched back highest over the mid-spine, the head carried BELOW
// the shoulder and pushed forward, short legs, plantigrade hind feet flat on
// the ground. It ambles; it does not trot (see LADDER).
//
// The pale break in the mask, as a weight around the ring. `sa` is the +Y
// component of the ring angle: positive is the crown, negative is the throat.
// The forehead stripe is the narrower of the two — on a real animal it is a
// line, and widening it eats the mask it is supposed to be dividing.
const MASK_BREAK = (a, ca, sa) => Math.max(
  // Tuned against a three-quarter view from slightly above, which is where the
  // player sees an animal from: at that angle most of the visible side of the
  // face is above the equator of the ring, so a forehead break that starts at
  // 0.42 looks reasonable in a plan view and erases the mask in the frame that
  // matters. 0.58 keeps it.
  clamp01((sa - 0.58) / 0.26),      // up the forehead
  clamp01((-sa - 0.42) / 0.30),     // and the pale chin and throat
);

const BLUEPRINT = () => ({
  key: 'raccoon',
  pelvis: [0, 0.196, -0.145],
  spine: [[0, 0.206, -0.070], [0, 0.200, 0.014]],
  chest: [0, 0.190, 0.096],
  // Low and forward, and the amount of each is a fine balance that took three
  // passes. The head has to sit clearly UNDER the topline — that drop is the
  // bear's trick and it is most of the hunched read; a raccoon carrying its
  // head up like the fox is a small dog. But the first cut put the poll at
  // 0.181, a full 0.11 below the arch, and the head then hung off the bottom
  // of the chest with the neck buried inside the barrel: not a hunch, a
  // shrew. At 0.194 the top of the skull lands level with the FRONT of the
  // barrel and a clear 0.05 below the arch over the back, which is the shape
  // a raccoon actually makes.
  //
  // Two bones, always — see the note on the bear, and this neck is short
  // enough to be tempted otherwise.
  neck: [[0, 0.202, 0.126], [0, 0.202, 0.158]],
  head: [0, 0.190, 0.196],
  // A raccoon's backside is a rounded mass it sits down on, not a taper.
  rumpTip: false,
  // Deliberately fat. Measured in the gallery, the first cut's barrel came out
  // at the same girth as the RABBIT's (both 0.10 m across the ribs once their
  // variant scales are applied) and was only longer — so at a glance the two
  // animals were the same size, which is not what "clearly bigger than a
  // rabbit" means. Widened here rather than solved with variant scale alone,
  // because scale lengthens the animal too and it must stay shorter than the
  // fox.
  //
  // ── and authored at twice the station density of the rest of the cast ─────
  // `DETAIL[0].smooth` inserts two Catmull-Rom rings between each authored
  // pair and is SHARED by every mammal, so the only per-species lever on how
  // round this animal is is how many stations it authors. A raccoon is all
  // curve — there is not a straight run anywhere between the rump and the
  // shoulder — and at the six stations the fox and squirrel use, that curve
  // came back as four visible facets down the flank. Fourteen here, with the
  // pairs closest together where the section is changing fastest.
  barrel: [
    { z: -0.195, y: 0.182, rx: 0.056, ry: 0.062 },
    { z: -0.176, y: 0.189, rx: 0.068, ry: 0.074 },
    { z: -0.150, y: 0.198, rx: 0.086, ry: 0.093, key: 1 },
    { z: -0.124, y: 0.202, rx: 0.089, ry: 0.096 },
    { z: -0.098, y: 0.204, rx: 0.091, ry: 0.098 },
    // The arch. The topline peaks between the haunch and the mid-back and
    // falls away forward to a LOWER shoulder — the opposite of the bear's
    // hump, and what makes the animal read as rounded and hunched rather than
    // as heavy-fronted.
    { z: -0.070, y: 0.206, rx: 0.092, ry: 0.100, key: 1 },
    { z: -0.042, y: 0.206, rx: 0.092, ry: 0.100 },
    { z: -0.016, y: 0.204, rx: 0.091, ry: 0.099 },
    { z: 0.010, y: 0.202, rx: 0.089, ry: 0.097, key: 1 },
    { z: 0.038, y: 0.198, rx: 0.086, ry: 0.094 },
    { z: 0.062, y: 0.195, rx: 0.083, ry: 0.091 },
    { z: 0.080, y: 0.192, rx: 0.080, ry: 0.088, key: 1 },
    { z: 0.110, y: 0.188, rx: 0.072, ry: 0.079 },
    { z: 0.145, y: 0.184, rx: 0.062, ry: 0.068, key: 1 },
  ],
  // Four stations, not two: `smoothStations` returns its input untouched below
  // three, so a two-station belly is a hard-edged wedge however high the
  // smoothing factor is set. The pale underside is one of the three things a
  // headlight finds on this animal and it should not have a corner in it.
  belly: [
    { z: -0.118, y: 0.144, rx: 0.040, ry: 0.017 },
    { z: -0.062, y: 0.138, rx: 0.049, ry: 0.021 },
    { z: -0.006, y: 0.134, rx: 0.052, ry: 0.022 },
    { z: 0.052, y: 0.138, rx: 0.046, ry: 0.020 },
  ],
  // Root as deep as the barrel station it meets (0.062 / 0.068 at z 0.145) —
  // the step-at-the-withers trap the fox and squirrel notes both describe, and
  // this neck folds down every time the animal noses along a water margin,
  // which is most of what it ever does.
  // ...and then waists hard, because the skull has to be a separate mass from
  // the shoulder. The first cut ended the neck at 0.040 against a 0.042 skull,
  // and the whole head/neck/chest run came out as one smooth horizontal tube
  // with a nose on the end — an anteater. The bear's neck note is the fix:
  // waisted at the throat, and the cranium wider than the throat it sits on.
  //
  // Eight stations rather than four. The neck's RING count is `DETAIL.neckRings`
  // and shared, so this buys no geometry — what it buys is that the fourteen
  // rings that exist land on a curve instead of on three straight chords, which
  // is where the visible crease at the throat was coming from.
  neckProfile: [
    { rx: 0.064, ry: 0.070 },
    { rx: 0.059, ry: 0.065 },
    { rx: 0.054, ry: 0.059 },
    { rx: 0.049, ry: 0.053 },
    { rx: 0.044, ry: 0.047 },
    { rx: 0.040, ry: 0.042 },
    { rx: 0.036, ry: 0.038 },
    { rx: 0.033, ry: 0.034 },
  ],
  // ── THE MASK ──────────────────────────────────────────────────────────────
  // `mix` is resolved per ring, so a marking on the head can only ever be a
  // band ACROSS it — and that is exactly what a raccoon's mask is. Read from
  // the nape forward: grey coat, a pale brow, the black band through the eyes,
  // then a white muzzle running out to the nose. The pale stations either side
  // are not decoration; a black band needs something to be a band against, and
  // near-white is the only thing in the palette with the contrast to do it at
  // the ranges a small animal is seen at.
  //
  // The pale/dark station pairs are deliberately close together in dz. This
  // profile is resampled by `smoothStations` at the near LOD, which lerps the
  // mix between authored keys, so the width of a gap IS the softness of that
  // colour edge. 12 mm reads as a marking; the 30 mm the first cut used read
  // as a gradient, which is a dirty face rather than a mask.
  // SHORT. The first cut ran 0.132 m of head off the front of a 0.34 m body and
  // the animal read as an anteater: at that length the mask lands on the snout
  // instead of on the face, and a mask on a snout is a muzzle band, which is a
  // badger. 0.086 m puts the mask back over the eyes where it belongs, and the
  // cranium is now the biggest part of the head rather than a bump behind a
  // proboscis.
  //
  // And BIG, deliberately — bigger against this body than any other head in the
  // cast is against its own. That is the cute lever and it is the honest one: a
  // raccoon really does have a large head for its size, and a large head on a
  // small round body over short legs is most of why one reads as an animal you
  // want to look at rather than as vermin.
  //
  // ── and this is where the station budget goes ─────────────────────────────
  // Fourteen stations over 0.098 m of head, against the fox's five over 0.14.
  // Two reasons, and the second is the real one:
  //
  //  · the skull is the most curved thing on the animal and the one part the
  //    player gets close to.
  //  · a colour boundary is only as sharp as the gap between the two stations
  //    that straddle it, because `smoothStations` LERPS the mix across it. The
  //    mask's leading edge is a 5 mm gap and its trailing edge a 6 mm one, so
  //    each reads as an edge; at the 26 mm spacing the first cut used, the same
  //    boundary was a soft ramp and the mask read as a dirty face rather than
  //    as a marking.
  headProfile: [
    { dy: 0.004, dz: -0.050, rx: 0.051, ry: 0.053 },
    { dy: 0.007, dz: -0.042, rx: 0.056, ry: 0.057 },
    // The pale brow begins. 8 mm from the station before it.
    { dy: 0.0085, dz: -0.034, rx: 0.060, ry: 0.060, mix: mixLerp(MIX.coat, MIX.pale, 0.70) },
    // A broad round cranium — a raccoon's head is wide across the eyes and
    // that width is what stops the pointed snout reading as a rat's. Crowning
    // just proud of the barrel's front station is load-bearing too: sunk level
    // with it the head/neck/shoulder ran as one unbroken line and the animal
    // had no neck at all.
    { dy: 0.009, dz: -0.027, rx: 0.063, ry: 0.062, mix: mixLerp(MIX.coat, MIX.pale, 0.70) },
    { dy: 0.008, dz: -0.020, rx: 0.063, ry: 0.062, mix: mixLerp(MIX.coat, MIX.pale, 0.70) },
    { dy: 0.007, dz: -0.014, rx: 0.062, ry: 0.061, mix: mixLerp(MIX.coat, MIX.pale, 0.70) },
    // ── THE MASK ────────────────────────────────────────────────────────────
    // Four dark rings, leading edge 5 mm off the pale brow. On their own they
    // are a band right round the head, which from the side is a blindfold and
    // from the front is a stripe — and a raccoon's mask is neither: it is two
    // patches over the eyes, split by a pale line up the forehead and stopping
    // clear of a pale chin.
    //
    // `mix` cannot say that, because it is resolved per ring and a ring is the
    // whole way round. `spot` can: it is evaluated per VERTEX with the ring
    // angle, so `MASK_BREAK` below paints the fifth colour onto the top and the
    // bottom of these four rings and leaves the sides black. Same machinery as
    // the camp dog's nose patch, and `uSpot` is set to a near-white in the
    // raccoon's palette because nothing else in the wild cast uses that channel.
    { dy: 0.005, dz: -0.009, rx: 0.061, ry: 0.059, mix: MIX.dark, spot: MASK_BREAK },
    { dy: 0.002, dz: -0.002, rx: 0.058, ry: 0.056, mix: MIX.dark, spot: MASK_BREAK },
    { dy: -0.001, dz: 0.005, rx: 0.054, ry: 0.052, mix: MIX.dark, spot: MASK_BREAK },
    { dy: -0.003, dz: 0.012, rx: 0.049, ry: 0.047, mix: MIX.dark, spot: MASK_BREAK },
    // ...and out of it into the white muzzle, 6 mm.
    { dy: -0.006, dz: 0.018, rx: 0.043, ry: 0.041, mix: mixLerp(MIX.coat, MIX.pale, 0.88) },
    { dy: -0.009, dz: 0.026, rx: 0.036, ry: 0.034, mix: mixLerp(MIX.coat, MIX.pale, 0.88) },
    { dy: -0.012, dz: 0.036, rx: 0.030, ry: 0.029, mix: mixLerp(MIX.coat, MIX.pale, 0.88) },
    { dy: -0.016, dz: 0.048, rx: 0.023, ry: 0.022, mix: mixLerp(MIX.coat, MIX.pale, 0.88) },
  ],
  // The snout ends in a nose pad rather than a point. `muzzleTip` false plus a
  // small dark bulb, the dog's trick — on a white muzzle the black button is
  // the last of the three face marks and it costs three rings.
  muzzleTip: false,
  nose: { at: [-0.021, 0.056], r: 0.013, flat: 0.92 },
  // Small, round and set wide on a low broad skull, pale-rimmed. Every other
  // small mammal here has ears that are its signature and so are generous; a
  // raccoon's are the opposite — SHORT is the cue, because tall ones would turn
  // the same head into a cat's. `mixTip` pale carries the white rim.
  ear: {
    at: [0.044, 0.038, -0.034], dir: [0.36, 0.91, -0.18],
    len: 0.068, w: 0.042, h: 0.025,
    mixBase: mixLerp(MIX.coat, MIX.dark, 0.45), mixTip: mixLerp(MIX.coat, MIX.pale, 0.85),
  },
  // ── THE RINGED TAIL ───────────────────────────────────────────────────────
  // Carried low and trailing with a slight droop — not arched like the
  // squirrel's and not streaming like the fox's. Thick along its whole length
  // and barely tapering, because it is a cylinder of fur.
  //
  // `tailBands` steps the mix across resampled rings instead of ramping it
  // (see the tail block in buildQuadruped): six bands over the visible length,
  // grey at the root where it leaves the rump and dark at the tip, which is
  // where a real one's are. `tailMix`/`tailTipMix`/`tailMixBias` are all
  // inapplicable here and deliberately absent — a linear ramp cannot express
  // a repeating marking at any bias.
  tail: [[0, 0.186, -0.230], [0, 0.168, -0.310], [0, 0.148, -0.386], [0, 0.132, -0.452]],
  tailR: [0.042, 0.032], tailFlat: 1,
  tailBands: [
    MIX.coat,
    MIX.dark,
    mixLerp(MIX.coat, MIX.pale, 0.72),
    MIX.dark,
    mixLerp(MIX.coat, MIX.pale, 0.72),
    MIX.dark,
    mixLerp(MIX.coat, MIX.pale, 0.72),
    MIX.dark,
  ],
  // 44 rings over eight bands — five and a half rings a band, so a band edge
  // falls inside a fifth of a band's length. At the 24 the first cut used the
  // edges were three rings wide and the rings read as a soft wave; this is what
  // makes them read as rings. The tail's own radial count is `DETAIL.radialTrim`
  // and shared, so ring count along the chain is the only lever there is here.
  tailRings: 44,
  // Short legs on a heavy body, dark from the elbow down — a raccoon's lower
  // legs and its feet are near-black, and against a pale belly that is a real
  // marking rather than shading, so `sockTop` runs high like the fox's.
  //
  // The joints zigzag hard for the bear's reason: this is a short chain under a
  // long body and the standing span has to stay well inside the reach or the IK
  // locks mid-amble. Standing hip->hock is 0.135 of a possible 0.184 (73%) at
  // the back and 0.136 of 0.165 (82%) at the front.
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.058, 0.190, -0.140], knee: [0, -0.072, 0.055], hock: [0, -0.062, -0.070], foot: [0, -0.056, 0.036],
    rTop: 0.052, rMid: 0.030, rLow: 0.021, rFoot: 0.017, flat: 0.84,
    // Plantigrade: a raccoon walks on the whole sole and the print is the
    // length of the foot. Same long flat block as the bear's and the rabbit's.
    hoofH: 0.015, hoofR: 0.019, hoofLong: 2.5, hoofFwd: 0.024, sockTop: 0.62,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.050, 0.188, 0.090], knee: [0, -0.078, -0.042], hock: [0, -0.058, 0.050], foot: [0, -0.052, 0.004],
    rTop: 0.040, rMid: 0.024, rLow: 0.018, rFoot: 0.016, flat: 0.86,
    // The front paws are the hands. Wider and blunter than the hind print and
    // set a little forward, so the animal reads as standing on them rather
    // than on toes.
    hoofH: 0.014, hoofR: 0.020, hoofLong: 1.7, hoofFwd: 0.014, sockTop: 0.62,
  },
});

export const RACCOON = {
  key: 'raccoon',
  plural: 'Raccoons',
  // ── the only nocturnal species, and every colour decision follows from it ─
  //
  // A raccoon exists between roughly 20:00 and 05:00 (Wildlife._scan gates on
  // SKY_STATE.nightFactor). At those hours the whole lighting budget is the
  // moon key, the sky fill and — the one thing that ever actually picks an
  // animal out — the camper's headlights. So the palette is authored a good
  // deal LIGHTER than a real raccoon, which is a mid-grey animal:
  //
  //  · the coat sits around 0x817d74. Author it at a real raccoon's value and
  //    the bear's palette note comes true twice over: the stylised lighting
  //    floors a shaded surface at a fraction of the key, and at night the key
  //    itself is already down by an order of magnitude, so there is nothing
  //    left to multiply. A dark coat at midnight is not a dark animal, it is
  //    an animal-shaped hole in the grass.
  //  · `dark` is held OFF the near-black floor for the same reason, even
  //    though it is carrying the mask and the tail rings — the markings only
  //    have to be darker than the face, and against a 0xdcd4c0 pale they are
  //    that by a mile at 0x211b15 without going to a void.
  //  · `pale` is near-white and doing more work here than on any other
  //    species: it is the muzzle, the brow, the ear rims and every second
  //    band of the tail. It is what a headlight finds.
  //
  // `silDark: 1.0` and `silFlat: 0.0` switch off the distance-silhouette
  // treatment for this species alone. That treatment exists to make a daylit
  // animal hold a value the sunlit meadow does not, by flattening its regions
  // into one tone and pulling it down after fog — and both halves of it are
  // wrong here. Flattening deletes the mask and the rings, which ARE the
  // animal, and darkening on top of moonlight turns it into the hole above.
  // (The residual term it cannot switch off is the shading flatten, which
  // rides `hideSil` directly. It is left alone because the raccoon's whole
  // streaming band — 92 m out, 124 m gone — sits at the very near end of the
  // 70 → 190 m ramp, where that term is a few percent.)
  variants: [
    { name: 'grey', scale: 1.22, weight: 0.56,
      col: { coat: 0x817d74, pale: 0xe3dcca, dark: 0x211b15, horn: 0x8a7a60,
        spot: 0xe3dcca, shadeLo: 0.80, silDark: 1.0, silFlat: 0.0 } },
    // A warm brown morph for the river margins, and a pale silver one — both
    // the same animal in a different wash, the pattern the rest of the cast
    // uses.
    { name: 'brown', scale: 1.16, weight: 0.27,
      col: { coat: 0x8c7a5f, pale: 0xe7dcc4, dark: 0x241d15, horn: 0x8a7a60,
        spot: 0xe7dcc4, shadeLo: 0.80, silDark: 1.0, silFlat: 0.0 } },
    { name: 'silver', scale: 1.26, weight: 0.17,
      col: { coat: 0x928f86, pale: 0xece6d6, dark: 0x1e1a15, horn: 0x8a7a60,
        spot: 0xece6d6, shadeLo: 0.80, silDark: 1.0, silFlat: 0.0 } },
  ],
  blueprint: BLUEPRINT,
  gait: {
    // Slow. A raccoon's top speed is nothing and its cruising speed is less;
    // the bands are set low so the amble covers almost everything the animal
    // ever does and the bound is reserved for actually being frightened.
    walk: 0.75, trot: 1.7, run: 5.0,
    // Short steps at a high cadence, the bear's correction for the same
    // reason: this is a short leg under a long body, and a stride authored
    // for a canid asks the chain for reach it does not have.
    strideBase: 0.34, strideGain: 2.4, dutyWalk: 0.70, dutyTrot: 0.56, dutyRun: 0.30,
    // Low lift and a low bob — a plantigrade animal shuffles, it does not
    // pick its feet up. `pitchAmp` is the roll that makes the amble read.
    bobAmp: 0.016, pitchAmp: 0.042, liftScale: 0.80,
    // The head is already low, and nose-down in the shallows is the pose the
    // whole species is for. Shallow for the squirrel's reason — this neck is
    // short and steep, and folding it further humps the topline at the root.
    grazeAng: 0.95, grazeRake: 1.15,
  },
  brain: {
    // Bolder than the rabbit and far bolder than the squirrel: a raccoon
    // notices you, stops, and looks at you for a beat before it decides to
    // leave. That stare is the sighting, and it is the reason the freeze is
    // nearly the deer's despite the animal being a fifth of the size.
    standoff: 0,
    alertDist: 34, fleeDist: 15, calmDist: 52,
    // No `noticeDist`: at 0.4 m and at night the wary-watch beat outside
    // 34 m would be animation nobody can resolve.
    // Inside the 92 m spawn ring with room, and short for the squirrel's
    // reason — but not as short, because a raccoon at night is a thing the
    // player will actually turn the camper around for.
    hintDist: 62,
    freezeTime: [0.8, 2.2], fleeTime: [2.0, 4.2],
    grazeTime: [5, 15], idleTime: [1.5, 5], walkTime: [3, 9],
    // A family party rather than a herd or a solitary animal.
    herd: [1, 3], herdRadius: 5, wanderRadius: 16,
    // Nose down almost all the time — foraging IS the raccoon pose.
    grazeChance: 0.70,
  },
};
