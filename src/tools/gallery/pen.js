// ─────────────────────────────────────────────────────────────────────────────
//  Habitat pen — a behaviour sandbox card for the gallery.
//
//  The poses on the animal cards prove the gait; they prove nothing about the
//  BRAIN — steering, obstacle avoidance, the blocked-step guard, herd station
//  keeping, the freeze → watch → leave beat. Those live in animal_brain.js and
//  only ever run against a baked world, so judging a change meant driving out
//  to find one. This card is the missing harness: a fenced meadow with
//  rocks and a pond, running the REAL Brain and the REAL rig against a
//  synthetic world object.
//
//  ── hand-authored cast only ────────────────────────────────────────────────
//
//  This pen stocks only species carrying a `glb` block (`animal_species.isGlb`)
//  — today the fox alone, in time the whole cast, because the Blender track is
//  the one being converted onto. That is deliberate rather than incidental. A
//  procedural animal's gait is SOLVED against the ground every frame and is
//  correct on any terrain by construction; a hand-authored one is a handful of
//  fixed clips whose blend bands, playback rates and derived travel speeds are
//  all judgement calls that only show themselves in motion, over time, against
//  obstacles. That is precisely what this pen is: somewhere controlled and
//  game-like to watch those calls before the animal goes into the valley.
//
//  So there is no `AnimRig` path here. A species joins the moment its file
//  grows a `glb` block, with no edit to this one. If the pen comes up empty,
//  nothing is on the hand-authored track yet — that is the message, not a bug.
//
//  The trick that makes it honest: the brain's entire world interface is four
//  functions — isInBounds / getWaterDepth / getSlope / getHeight. So:
//
//    · the fence is `isInBounds` — the same hard wall as the world edge,
//    · the pond is real water depth — the waterline rules apply unmodified,
//    · each rock's footprint reports water depth 1 (impassable, the same
//      hard wall a river is) inside a steep slope apron, so the probe fan
//      steers off rocks early and the blocked-step guard catches the rest.
//
//  Nothing in the behaviour stack is stubbed or forked. If an animal paces a
//  fence line, walks a pond bank, gets cornered and turns to face you — that
//  is exactly what it would do in the game, because it is the game's code.
//
//  The threat toggle orbits a marker through the pen at walking pace, standing
//  in for the camper: watch → alert → flee plays out against the obstacles.
//  Threat *distances* are compressed to pen scale (a deer's real alertDist is
//  wider than the whole pen); times, speeds and steering are untouched.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32, clamp01 } from '../../core/MathUtils.js';

// Small on purpose. The first cut was 26 m and the animals never met the
// fence: a wander leg is a few metres and the herds lived in the middle, so
// the boundary code — the thing a pen exists to exercise — never ran. At 14 m
// an ordinary wander reaches the rail, a flee hits it in under two seconds,
// and the pond + rocks eat enough of the floor that paths have to thread
// between obstacle and edge.
const PEN_R = 14;          // fence radius, metres
const POND = { x: -4.5, z: 3.5, r: 4.2 };
// The whole pen rides one metre above the stage floor, as a diorama slab with
// a soil skirt. Not for looks alone: the stage's ground-grid plane at y = 0 is
// opaque, so any real basin — and the pond IS a basin — would be sliced off
// black wherever the terrain dips below it. Heights are all relative, so the
// sim neither knows nor cares.
const LIFT = 1.0;
const WATER_Y = LIFT - 0.14;   // pond surface, below the flat rim (h = LIFT)
const MAX_ANIMALS = 8;

// ── the synthetic world ──────────────────────────────────────────────────────

function makePenWorld(rocks, solid = true, engaged = null) {
  // `engaged` is a getter for the perch record an animal currently owns: that
  // one rock stops being a wall for it (it is busy walking up the thing)
  // while every other rock stays solid. First cut gave alpine animals a
  // world with NO rock walls, and they strolled through boulders they were
  // not even climbing.
  const open = (k) => {
    const e = engaged?.();
    return e && e.x === k.x && e.z === k.z;
  };
  // Rolling meadow that flattens toward the rim so the fence sits level.
  const base = (x, z) => {
    const r = Math.hypot(x, z);
    const amp = 0.42 * clamp01((PEN_R - 2.5 - r) / 4.5);
    return amp * (0.55 * Math.sin(x * 0.21) * Math.cos(z * 0.17)
      + 0.45 * Math.sin((x + z) * 0.31));
  };
  // River-bank grade, not a crater. The first basin dropped 0.85 m over the
  // pond radius; an animal legally standing in the 15 cm shallows had the
  // bed falling away under its own body span, so the rig sank it chest-deep
  // and the water plane swallowed the legs — the "yak frozen in the water,
  // missing a leg" report. A dry lip and a 0.55 m core keep the shallow band
  // walkable at wading depth while the middle stays a hard wall.
  const pondDip = (x, z) => {
    const t = clamp01(1 - Math.hypot(x - POND.x, z - POND.z) / POND.r);
    const u = clamp01((t - 0.10) / 0.90);
    return 0.55 * u * u * (3 - 2 * u);
  };
  const height = (x, z) => LIFT + base(x, z) - pondDip(x, z);

  return {
    isInBounds: (x, z) => x * x + z * z < (PEN_R - 0.6) * (PEN_R - 0.6),
    getHeight: height,
    getWaterDepth(x, z) {
      // A rock footprint is "deep water": the same hard wall a river is, so
      // the whole rulebook — probe fan, final _dry guard, bank-tangent walk,
      // pinned/cornered — applies to it with no new code path. The alpine
      // pair get the `solid: false` view of the same world instead, where
      // rocks are ground — they climb them (Brain._groundY), exactly as in
      // the game, where rocks are scatter and only the CLIMB machinery cares.
      if (solid) {
        for (const k of rocks) {
          if (open(k)) continue;
          const dx = x - k.x, dz = z - k.z;
          if (dx * dx + dz * dz < k.r * k.r) return 1;
        }
      }
      if (Math.hypot(x - POND.x, z - POND.z) > POND.r) return 0;
      return Math.max(0, WATER_Y - height(x, z));
    },
    getSlope(x, z) {
      const e = 0.5;
      let s = Math.hypot(
        height(x + e, z) - height(x - e, z),
        height(x, z + e) - height(x, z - e),
      ) / (2 * e);
      // Steep apron around each rock so the probe fan's soft slope cost bends
      // paths off them before the hard footprint is ever hit. Only in the
      // solid view: for the alpine pair a rock is a destination, and an apron
      // in their world had the fan shouldering a climbing goat off the very
      // boulder it was aiming for — the toward-away-toward weave. (The game
      // has no apron at all; boulders are not in its slope field.)
      if (solid) {
        for (const k of rocks) {
          if (open(k)) continue;
          const d = Math.hypot(x - k.x, z - k.z) - k.r;
          if (d < 1.6) s += (1 - Math.max(0, d) / 1.6) * 1.2;
        }
      }
      return s;
    },
  };
}

/** A spot an animal can stand on, or null. Mirrors Wildlife._activate's test. */
function dryStand(W, rnd, rMax, tries = 14) {
  for (let t = 0; t < tries; t++) {
    const a = rnd() * Math.PI * 2;
    const r = 3 + rnd() * (rMax - 3);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (W.isInBounds(x, z) && W.getWaterDepth(x, z) <= 0.15 && W.getSlope(x, z) < 0.9) {
      return { x, z };
    }
  }
  return null;
}

// ── scenery ──────────────────────────────────────────────────────────────────

function buildGround(W) {
  // A ring, not a circle: CircleGeometry is a fan with no interior vertices,
  // so displacing it leaves a flat disc — RingGeometry's phi segments give
  // the radial rings the terrain and the pond basin need.
  const geo = new THREE.RingGeometry(0.02, PEN_R + 1.6, 128, 48);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const dry = new THREE.Color(0xb98a3f);      // meadow gold, a shade under the game's
  const moist = new THREE.Color(0x8a7a35);    // greener band at the pond edge
  const bed = new THREE.Color(0x5d4a2e);      // pond bed
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, W.getHeight(x, z));
    const t = clamp01(1 - Math.hypot(x - POND.x, z - POND.z) / (POND.r * 1.7));
    c.copy(dry).lerp(moist, clamp01(t * 1.6));
    if (W.getHeight(x, z) < WATER_Y + 0.03) c.copy(bed);
    // A little seeded mottle so the disc does not read as billiard felt.
    const m = 0.92 + 0.08 * Math.sin(x * 1.7 + z * 2.3) * Math.sin(x * 0.9 - z * 1.1);
    col[i * 3] = c.r * m; col[i * 3 + 1] = c.g * m; col[i * 3 + 2] = c.b * m;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;

  // The diorama skirt: a soil wall from the stage floor up to the rim.
  const g = new THREE.Group();
  g.add(mesh);
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(PEN_R + 1.6, PEN_R + 1.9, LIFT, 96, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1, side: THREE.DoubleSide }),
  );
  skirt.position.y = LIFT / 2;
  g.add(skirt);
  return g;
}

function buildPond() {
  const geo = new THREE.CircleGeometry(POND.r * 0.99, 48);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x3f6d8e, roughness: 0.25, transparent: true, opacity: 0.88,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(POND.x, WATER_Y, POND.z);
  return mesh;
}

function buildFence() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6e553a, roughness: 0.9 });
  const posts = 18;
  const post = new THREE.CylinderGeometry(0.055, 0.065, 1.05, 6);
  const inst = new THREE.InstancedMesh(post, wood, posts);
  const m = new THREE.Matrix4();
  for (let i = 0; i < posts; i++) {
    const a = (i / posts) * Math.PI * 2;
    m.makeTranslation(Math.sin(a) * PEN_R, LIFT + 0.5, Math.cos(a) * PEN_R);
    inst.setMatrixAt(i, m);
  }
  inst.castShadow = true;
  g.add(inst);
  // The rim is flattened by the terrain function, so flat rail rings sit true.
  for (const y of [0.42, 0.86]) {
    const rail = new THREE.Mesh(new THREE.TorusGeometry(PEN_R, 0.028, 5, 96), wood);
    rail.rotation.x = Math.PI / 2;
    rail.position.y = LIFT + y;
    g.add(rail);
  }
  return g;
}

// ── the entry ────────────────────────────────────────────────────────────────

/**
 * The gallery card. `mod` is animal_species.js; `path` its module path — the
 * same arguments every family adapter gets.
 */
export function penEntry(mod, path, rockKit) {
  // Hand-authored species only — see the header.
  const speciesKeys = Object.keys(mod.SPECIES).filter((k) => mod.isGlb(k));
  // key -> Promise of protos (all coats). The PROMISE is cached, not the
  // value: loading is a network fetch plus a decode, so a card rebuilt three
  // times while its options are fiddled with pays for the GLB once, and two
  // rebuilds racing each other still share one decode.
  const protoCache = new Map();
  const protos = (key) => {
    if (!protoCache.has(key)) protoCache.set(key, mod.loadSpecies(key));
    return protoCache.get(key);
  };

  return {
    id: 'animal:pen',
    label: 'Habitat Pen',
    sub: 'behaviour sandbox',
    group: 'Wildlife',
    family: 'Animals',
    file: path,
    call: 'new Brain(...) + new GlbRig(...) against a synthetic world',
    seeded: true,
    options: [
      // 'mix' rolls a random species per herd; 'all' fields the entire cast,
      // one animal of every species, and ignores the herd slider.
      { name: 'species', kind: 'enum', values: ['mix', 'all', ...speciesKeys] },
      { name: 'herds', kind: 'number', def: 3 },
      // Which slice of the behaviour space to soak in. All of them run the
      // real state machine — the modes only rig the dice:
      //   free   the shipped numbers, untouched
      //   roam   graze suppressed, idles cut short — near-constant walking,
      //          the mode that works the fence, the rocks and the pond bank
      //   graze  feeding weighted to certain — heads down, drift steps
      //   alert  a parked threat at the pen's centre — watch/alert holds
      //   spook  the threat teleports beside one animal after another, so the
      //          freeze -> flee -> calm cycle fires over and over
      //   climb  alpine climb odds forced to 1 — rock traffic all day
      { name: 'behaviour', kind: 'enum', values: ['free', 'roam', 'graze', 'alert', 'spook', 'climb'] },
      { name: 'threat', kind: 'bool' },
    ],
    allOptions: [
      { name: 'species', kind: 'enum' },
      { name: 'herds', kind: 'number' },
      { name: 'behaviour', kind: 'enum' },
      { name: 'threat', kind: 'bool' },
    ],

    async build(seed, opts = {}) {
      const { GlbRig } = await import('../../wildlife/glb_rig.js');
      const { Brain, ST } = await import('../../wildlife/animal_brain.js');

      if (!speciesKeys.length) {
        return { root: new THREE.Group(), update() {}, dispose() {},
          _animals: [], _world: null,
          notes: ['no hand-authored species yet — one joins this pen by growing '
            + 'a `glb` block in mammals/<species>.js'] };
      }

      const rnd = mulberry32((seed ^ 0x9e77) >>> 0);
      const root = new THREE.Group();
      const disposables = [];

      // ── rocks: real forms from the rock kit, placed clear of the pond ──────
      const kit = await rockKit();
      const picks = [];
      for (const [arch, geoms] of Object.entries(kit.library)) {
        geoms.forEach((g, v) => {
          if (!g.boundingBox) g.computeBoundingBox();
          const b = g.boundingBox;
          const rx = Math.max(Math.abs(b.min.x), Math.abs(b.max.x));
          const rz = Math.max(Math.abs(b.min.z), Math.abs(b.max.z));
          const r = Math.max(rx, rz);
          if (r > 0.55 && r < 2.4) picks.push({ arch, v, geo: g, r });
        });
      }
      const rocks = [];
      // A dense field, on purpose: the pen exists to surface steering bugs,
      // and a maze of rocks with body-width corridors between them works the
      // probe fan, the blocked-step guard and the cornered timer far harder
      // than open ground ever will. Placement fails quietly when a rock will
      // not fit, so the count is a ceiling, not a promise.
      const nRocks = 9 + Math.floor(rnd() * 4);
      for (let i = 0; i < nRocks && picks.length; i++) {
        const p = picks[Math.floor(rnd() * picks.length)];
        // A climbable rock's influence is wider than its footprint: the brain
        // walks a dome out to ~1.18 r around it and picks descent targets past
        // that. Placement keeps dome + a body length clear of the fence and
        // the pond, or a descending animal walks off the dome straight into
        // the boundary and the blocked-step guard freezes it there mid-slope —
        // which is exactly the "yak stuck coming off a rock" report.
        const skirt = p.r * 0.85 * 1.18;
        const rMax = PEN_R - 3.1 - skirt - 2.0;
        let placed = null;
        for (let t = 0; t < 30 && !placed && rMax > 3.5; t++) {
          const a = rnd() * Math.PI * 2;
          const r = 3.5 + rnd() * (rMax - 3.5);
          const x = Math.sin(a) * r, z = Math.cos(a) * r;
          if (Math.hypot(x - POND.x, z - POND.z) < POND.r + skirt + 1.2) continue;
          // Corridors a body wide between neighbours — tight enough to have
          // to be steered, wide enough that steering can succeed.
          if (rocks.some((k) => Math.hypot(x - k.x, z - k.z) < k.r + p.r + 1.7)) continue;
          placed = { x, z };
        }
        if (placed) {
          rocks.push({
            ...placed, r: p.r * 0.85, pick: p, yaw: rnd() * Math.PI * 2,
            // Summit height above the ground it sits on — the geometry's own
            // local top, since the mesh is planted at ground level.
            rise: p.geo.boundingBox.max.y,
          });
        }
      }

      const W = makePenWorld(rocks);   // rocks are walls (everyone's default)

      root.add(buildGround(W), buildPond(), buildFence());
      for (const k of rocks) {
        const size = k.pick.r * 2;
        const mesh = kit.single(k.pick.geo, {
          aRockA: [0, 0.35, rnd(), size],
          aRockB: [-9999, 0, W.getHeight(k.x, k.z)],
          aRockC: [0, 0],
        });
        mesh.position.set(k.x, W.getHeight(k.x, k.z), k.z);
        mesh.rotation.y = k.yaw;
        root.add(mesh);
      }

      // ── the cast ───────────────────────────────────────────────────────────
      // One herd key per entry. 'all' fields the whole cast, one group per
      // species; 'mix' rolls a species per herd; a named species repeats it.
      const everyone = opts.species === 'all';
      const wantKey = opts.species && opts.species !== 'mix' && !everyone ? opts.species : null;
      const nHerds = Math.max(1, Math.round(opts.herds ?? 3));
      const herdKeys = everyone
        ? [...speciesKeys]
        : Array.from({ length: nHerds },
          () => wantKey ?? speciesKeys[Math.floor(rnd() * speciesKeys.length)]);
      const mode = opts.behaviour ?? 'free';
      const animals = [];
      const groups = [];
      const rigs = [];

      // ONE shared set of perch records, filtered per species below. Shared
      // objects are what make the claim tokens global: separate copies per
      // group let two goats from different groups own "the same" rock and
      // stand inside each other on its summit.
      const perchRecords = rocks.map((k) => ({
        x: k.x, z: k.z, top: W.getHeight(k.x, k.z) + k.rise, r: k.r, rise: k.rise, taken: null,
      }));

      for (const key of herdKeys) {
        if (animals.length >= MAX_ANIMALS) break;
        // Load before reading `sp.gait`: `loadSpecies` MEASURES the clips and
        // writes the real walk/trot/run speeds onto the species record. A cfg
        // captured before that write steers the animal at speeds its clips
        // cannot carry, and the paws skate — the one thing the whole
        // measure-the-asset mechanism exists to prevent.
        const speciesProtos = await protos(key);
        const sp = mod.SPECIES[key];
        // The real brain numbers, with only the threat DISTANCES compressed to
        // pen scale — a deer's alertDist is wider than the whole pen. Times,
        // speeds and steering are the shipped values.
        const cfg = {
          gait: sp.gait,
          brain: {
            ...sp.brain,
            // wanderRadius reaches PAST the fence on purpose: _pickWander
            // rejects out-of-bounds targets, so the surviving ones land right
            // across the pen — including up against the rail, which is where
            // the boundary code gets exercised.
            wanderRadius: Math.min(sp.brain.wanderRadius, PEN_R + 4),
            noticeDist: Math.min(sp.brain.noticeDist ?? sp.brain.alertDist, 15),
            alertDist: Math.min(sp.brain.alertDist, 9),
            fleeDist: Math.min(sp.brain.fleeDist, 5.5),
            calmDist: Math.min(sp.brain.calmDist, 16),
          },
        };
        // Behaviour modes rig the DICE, never the machinery: every transition
        // below still runs through the real state machine — these only weight
        // which branch it keeps taking.
        if (mode === 'roam') {
          cfg.brain.grazeChance = 0;
          cfg.brain.idleTime = [0.8, 2.0];
        } else if (mode === 'graze') {
          cfg.brain.grazeChance = 1;
          cfg.brain.grazeTime = [14, 30];
        } else if (mode === 'climb' && cfg.brain.rock) {
          cfg.brain.rock = { ...cfg.brain.rock, climbChance: 1 };
          cfg.brain.grazeChance = 0.15;
          cfg.brain.idleTime = [1, 3];
        }
        const home = dryStand(W, rnd, PEN_R - 4) ?? { x: 0, z: 0 };
        const g = { alarm: 0, fleeH: null, line: null, members: [] };
        // The alpine pair climb: hand their group the pen's rocks in the same
        // record shape Wildlife._findPerches builds, gated by the species' own
        // rock taste. A rock nothing qualifies for just never gets climbed.
        if (sp.brain.rock) {
          const rc = sp.brain.rock;
          g.rocks = perchRecords
            .filter((r) => r.rise >= rc.rise[0] && r.rise <= rc.rise[1]
              && r.r <= rc.maxR && r.rise >= r.r * rc.steep
              // The plateau and flank gates, same as Wildlife._findPerches —
              // these started life here (the "goat perched in a dive" and
              // "yak frozen mid-descent" reports) and were promoted into the
              // game; the pen now mirrors the shipped rule.
              && r.r >= (rc.minR ?? 1.0) && r.rise <= r.r * 1.15)
            .sort((a, b) => b.rise - a.rise);
        }
        groups.push(g);
        // 'all' fields one representative per species so the full cast fits
        // under the animal cap; otherwise the species' own herd-size roll.
        const count = everyone ? 1 : Math.min(
          sp.brain.herd[0] + Math.floor(rnd() * (sp.brain.herd[1] - sp.brain.herd[0] + 1)),
          MAX_ANIMALS - animals.length,
        );
        for (let m = 0; m < count; m++) {
          const vi = mod.pickVariant(key, rnd());
          const v = sp.variants[vi];
          const proto = speciesProtos[vi];
          // No hide material: a hand-authored animal wears the materials its
          // .blend authored, one set per coat, already on the prototype. Those
          // are cached WITH the prototype and shared by every build of this
          // card, so they are not disposed below — disposing them would blank
          // the animal on the next re-roll.
          const rig = new GlbRig(proto, proto.scale, cfg.gait, key);
          rigs.push(rig);
          const brain = new Brain(key, cfg, (seed ^ (groups.length * 8191 + m * 131)) >>> 0, g, m);

          // Scatter around home exactly the way _activate does.
          let x = home.x, z = home.z;
          for (let t = 0; t < 8; t++) {
            const a = rnd() * Math.PI * 2;
            const r = m === 0 ? rnd() * 2 : 2 + rnd() * Math.max(2, sp.brain.herdRadius);
            const tx = home.x + Math.sin(a) * r, tz = home.z + Math.cos(a) * r;
            if (W.isInBounds(tx, tz) && W.getWaterDepth(tx, tz) <= 0.15) { x = tx; z = tz; break; }
          }
          const heading = rnd() * Math.PI * 2;
          // `proto.size`, NOT `proto.scale`. The Brain multiplies every gait
          // speed by this, so it has to be how big the animal IS (~1) and not
          // the asset's model-units-to-metres fit (~0.22 for the fox). Handing
          // it the fit is a bug already paid for once in `Wildlife._buildPool`:
          // it left a fleeing fox strolling off at 0.07 m/s playing the walk.
          const size = proto.size ?? v.scale;
          brain.reset(x, W.getHeight(x, z), z, heading, size);
          brain.home.set(home.x, 0, home.z);
          rig.reset(brain.pos, heading, W);

          root.add(rig.mesh);
          const a = {
            key, brain, rig, g, slot: m, scale: size, mesh: rig.mesh,
            // Alpine animals see their OWN world: all rocks solid except the
            // one this brain currently owns (its climb target).
            W: sp.brain.rock ? makePenWorld(rocks, true, () => brain.rock) : null,
            drive: { pos: null, heading: 0, speed: 0, graze: 0, alert: 0, flag: 0, look: null, lod: 0 },
          };
          g.members.push(a);
          animals.push(a);
        }
      }

      // ── the stand-in camper ────────────────────────────────────────────────
      // The alert and spook modes ARE threat choreography, so they bring the
      // marker regardless of the checkbox.
      const useThreat = !!opts.threat || mode === 'alert' || mode === 'spook';
      let marker = null;
      if (useThreat) {
        marker = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color: 0xc4483a, roughness: 0.6 });
        disposables.push(mat);
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.30, 16, 12), mat);
        ball.position.y = 1.5;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6), mat);
        pole.position.y = 0.75;
        marker.add(ball, pole);
        root.add(marker);
      }
      const threat = { x: 0, z: 0, speed: 0 };
      let tA = rnd() * Math.PI * 2, tTime = 0;
      let spookI = -1, spookT = 0;

      let elapsed = 0;
      return {
        root,
        // Harness surface: headless drivers (and the console) read brain
        // state straight off this instead of inferring it from mesh motion.
        _animals: animals,
        _world: W,
        update(dt) {
          elapsed += dt;

          let th = null;
          if (marker) {
            tTime += dt;
            if (mode === 'alert') {
              // Parked dead centre and never moving: the whole pen sits
              // inside the compressed notice band, so the cast holds its
              // watch/alert poses against a stationary observer.
              threat.x = 0; threat.z = 0; threat.speed = 0;
            } else if (mode === 'spook') {
              // Every few seconds the threat appears beside a different
              // animal — inside its flee distance — so the whole
              // freeze -> flee -> calm -> resume cycle fires round-robin,
              // with the flights running through the rock maze.
              spookT -= dt;
              if (spookT <= 0 && animals.length) {
                spookI = (spookI + 1) % animals.length;
                spookT = 12;
                const p = animals[spookI].brain.pos;
                const ang = rnd() * Math.PI * 2;
                threat.x = p.x + Math.sin(ang) * 2.5;
                threat.z = p.z + Math.cos(ang) * 2.5;
              }
              threat.speed = 0;
            } else {
              // A slow lap that breathes in and out, so every herd sees the
              // full approach-and-recede beat. ~1.5 m/s: walking pace.
              const orbit = PEN_R * 0.55 + PEN_R * 0.28 * Math.sin(tTime * 0.11);
              tA += (1.5 / Math.max(6, orbit)) * dt;
              const nx = Math.sin(tA) * orbit, nz = Math.cos(tA) * orbit;
              threat.speed = Math.hypot(nx - threat.x, nz - threat.z) / Math.max(dt, 1e-4);
              threat.x = nx; threat.z = nz;
            }
            marker.position.set(threat.x, W.getHeight(threat.x, threat.z), threat.z);
            th = threat;
          }

          for (const a of animals) {
            const lead = a.slot === 0 ? null : a.g.members[0]?.brain ?? null;
            // Alpine species carry a personal world (their engaged rock is
            // open, all others solid); everyone else shares the solid one.
            const Wa = a.W ?? W;
            a.brain.update(dt, Wa, th, lead);
            // A rabbit that fled "down a hole" respawns across the pen —
            // the sandbox equivalent of the pool recycling it.
            if (a.brain.done) {
              const s = dryStand(W, rnd, PEN_R - 4) ?? { x: 0, z: 0 };
              a.brain.reset(s.x, W.getHeight(s.x, s.z), s.z, rnd() * Math.PI * 2, a.scale);
              a.brain.home.set(s.x, 0, s.z);
              a.rig._warm = false;
            }
            // Engaged with a rock, the gait solver reads the ground through
            // the brain's boulder override — same line Wildlife._step has.
            const G = (a.brain.rock && a.brain.ground) ? a.brain.ground : Wa;
            a.rig.update(dt, a.brain.fill(a.drive, 0), G);
          }

          // Herd alarm decays on the group, exactly as Wildlife.update does.
          for (const g of groups) {
            if (g.alarm > 0
              && !g.members.some((a) => a.brain.state === ST.ALERT || a.brain.state === ST.FLEE)) {
              g.alarm = 0; g.fleeH = null;
            }
          }
        },
        dispose() {
          // Each rig owns a mixer and a cloned skeleton. The prototype's
          // geometry and coat materials are cached and shared across builds —
          // not ours to free.
          for (const r of rigs) r.dispose();
          for (const d of disposables) d.dispose();
        },
        notes: [
          `${animals.length} animals in ${groups.length} group${groups.length === 1 ? '' : 's'}`,
          `cast: ${[...new Set(animals.map((a) => a.key))].join(', ')}`,
          `${rocks.length} rock obstacles · 1 pond · fence at ${PEN_R} m`,
          'real Brain + GlbRig against a synthetic world',
          `${animals.length * 12} draw calls — a hand-authored animal is six `
            + 'primitives, drawn twice once its shadow counts',
          `behaviour: ${mode}`,
          useThreat
            ? (mode === 'alert' ? 'threat parked at centre'
              : mode === 'spook' ? 'threat teleports beside each animal in turn'
                : 'threat: red marker lapping at walking pace')
            : 'threat off — enable it or try behaviour alert/spook',
        ],
      };
    },
  };
}
