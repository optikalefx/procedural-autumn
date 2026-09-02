// ─────────────────────────────────────────────────────────────────────────────
//  frogs — the frogs on the lily pads.
//
//  The body is one file over in `frog_model.js`. This is the layer `Wildlife.js`
//  is for every other animal — where one exists, what it does, when it goes —
//  collapsed into one object the way `bigfoot.js` does it, because a frog lives
//  on ONE kind of ground (a lily pad) and the machinery that places six hundred
//  mammal home sites by habitat field has nothing to say about that. The pads
//  are the habitat, and `LilyPads` already knows where every one of them is.
//
//  ── what a frog does ────────────────────────────────────────────────────────
//
//    SIT      on a pad, riding it (the pad bobs and the boat can push it; the
//             frog asks `surfaceAt` every frame and sits where the leaf is).
//             Breathes. Now and then inflates the vocal sac and croaks — the
//             sound is an EVENT pushed to `events`, which `wildlife_audio.js`
//             drains, so there is never a croak with no frog under it.
//    HOP      to another pad within reach: crouch, launch, a ballistic arc,
//             land facing the way it jumped. Real frogs jump a few body lengths
//             and land short as often as long; the arc is chosen from the
//             distance so a long hop is a flatter, faster one.
//    DIVE     the same jump, into open water: it goes in at the end of the arc,
//             the water gets a ring (`pushWake`) and a splash event, and the
//             frog is gone. Startled — a hull, the camper, or the camera close
//             enough to touch — it dives at once; left alone it dives now and
//             then anyway, because a colony where every frog stays put forever
//             reads as decoration.
//
//  Frogs that have dived do not climb back out; new ones arrive on pads out of
//  view as the colony streams. That is the same trick `Wildlife` plays with
//  every animal: existence is cheap, and appearing unobserved is what keeps a
//  spawner from reading as a spawner.
//
//  ── the ranges ──────────────────────────────────────────────────────────────
//
//  A 20 cm frog is a few pixels past forty metres, so the whole thing lives
//  inside `SPAWN_R`. Nothing may appear inside the player's view — the same
//  rule as the mammals — so a pad is a spawn site only when it is out of the
//  frustum or beyond `FAR_OK`, where a frog is a dot on a leaf anyway.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, lerp, mulberry32, wrapAngle } from '../core/MathUtils.js';
import { FROG, frogProtos, pickFrogVariant, FrogRig, JUMP } from './frog_model.js';
import { createHideMaterial } from './mammals/hide.js';

const LIVE = 6;                 // simultaneous frogs
const SPAWN_R = 44;             // metres from the camera a pad may host a frog
const DESPAWN_R = 58;
const FAR_OK = 26;              // beyond this a spawn in view is a dot; allowed
const SCAN_EVERY = 0.6;         // seconds between spawn scans
const SPAWN_CHANCE = 0.45;      // per scan, per free slot, when a site exists
const MIN_PAD_R = 0.19;         // metres — a leaf a frog can sit on
const HOP_MIN = 0.30, HOP_MAX = 1.35;
const G = 9.81;
// Startle radii, metres from the frog.
const STARTLE_HULL = 2.4, STARTLE_CAMPER = 5.0, STARTLE_CAMERA = 1.7;

const ST = { SIT: 0, CROUCH: 1, LAUNCH: 2, FLIGHT: 3, LAND: 4, SINK: 5 };
const NAMES = ['sit', 'crouch', 'launch', 'flight', 'land', 'sink'];

export class Frogs {
  constructor(ctx, seed = 0) {
    this.ctx = ctx;
    this.rnd = mulberry32((seed ^ 0xf209) >>> 0);
    this.group = new THREE.Group();
    this.group.name = 'Frogs';
    this.frogs = [];
    /**
     * Sound events for the audio layer: { kind, x, y, z, size }. Drained by
     * the reader; capped by `_event` so a page with audio off (or a harness
     * that never runs the audio layer) cannot grow it without bound.
     */
    this.events = [];
    this.mats = null;
    this._scanT = 0;
    this._fr = new THREE.Frustum();
    this._pm = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._c = { x: 0, z: 0 };
    this.stats = { live: 0, hops: 0, dives: 0, croaks: 0 };
  }

  build() {
    this.mats = FROG.variants.map((v) => {
      const m = createHideMaterial(v.col);
      m.roughness = 0.55;           // wet skin, unlike the cast's matte hide
      // Small and close: the distance-silhouette treatment is for deer at a
      // hundred metres and would flatten a frog you are leaning over.
      m.userData.shader?.uniforms?.uSilNear && (m.userData.shader.uniforms.uSilNear.value = 400);
      return m;
    });
    frogProtos();
    this.ctx.scene.add(this.group);
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  update(dt, cam, elapsed) {
    const L = this.ctx.systems?.lilyPads;
    if (!L || !this.mats) return;
    this._scanT -= dt;
    if (this._scanT <= 0) { this._scanT = SCAN_EVERY; this._scan(cam, L); }
    for (let i = this.frogs.length - 1; i >= 0; i--) {
      const f = this.frogs[i];
      this._step(f, dt, cam, L, elapsed);
      const d = Math.hypot(f.x - cam.position.x, f.z - cam.position.z);
      if (f.state === ST.SINK && f.t > 0.6 || d > DESPAWN_R) this._remove(i);
    }
    this.stats.live = this.frogs.length;
  }

  _scan(cam, L) {
    if (this.frogs.length >= LIVE) return;
    const cx = cam.position.x, cz = cam.position.z;
    const pads = L.padsNear(cx, cz, SPAWN_R, this._near ??= []);
    if (!pads.length) return;
    this._pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._fr.setFromProjectionMatrix(this._pm);
    // A handful of throws rather than a scan of every pad: a colony has hundreds.
    for (let k = 0; k < 8 && this.frogs.length < LIVE; k++) {
      const pad = pads[(this.rnd() * pads.length) | 0];
      if (pad.r < MIN_PAD_R || pad.frog) continue;
      const c = L.padCentre(pad, this._c);
      const d = Math.hypot(c.x - cx, c.z - cz);
      if (d < 3) continue;
      if (d < FAR_OK && this._fr.containsPoint(this._v.set(c.x, pad.y, c.z))) continue;
      // A frog wants company: a lone leaf in open water is not a colony.
      if (L.padsNear(c.x, c.z, 2.5, this._near2 ??= []).length < 3) continue;
      if (this.rnd() > SPAWN_CHANCE) continue;
      this._spawn(pad, L);
    }
  }

  _spawn(pad, L) {
    const vi = pickFrogVariant(this.rnd());
    const v = FROG.variants[vi];
    const rig = new FrogRig(frogProtos()[vi], this.mats[vi], v.scale);
    const c = L.padCentre(pad, this._c);
    const f = {
      rig, vi, size: v.scale,
      pad, state: ST.SIT, t: 0,
      x: c.x, z: c.z, y: pad.y,
      heading: this.rnd() * Math.PI * 2,
      sitT: 3 + this.rnd() * 9,
      croakT: 4 + this.rnd() * 14,
      sac: 0, sacT: -1,
      from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 }, toPad: null,
      apex: 0, flightT: 0, dive: false,
      heading0: 0, crouchT: JUMP.crouch,
    };
    pad.frog = f;
    rig.mesh.rotation.y = f.heading;
    this.group.add(rig.mesh);
    this.frogs.push(f);
    this._place(f, L, 0);
  }

  _event(kind, f) {
    this.events.push({ kind, x: f.x, y: f.y, z: f.z, size: f.size });
    if (this.events.length > 32) this.events.splice(0, this.events.length - 32);
  }

  _remove(i) {
    const f = this.frogs[i];
    if (f.pad && f.pad.frog === f) f.pad.frog = null;
    if (f.toPad && f.toPad.frog === f) f.toPad.frog = null;
    f.rig.dispose();
    this.frogs.splice(i, 1);
  }

  /** Sit the frog on its pad's leaf, wherever the leaf is this frame. */
  _place(f, L, elapsed) {
    const pad = f.pad;
    if (!pad) return;
    const c = L.padCentre(pad, this._c);
    f.x = c.x; f.z = c.z;
    f.y = L.surfaceAt(c.x, c.z, elapsed) ?? L.padTop(pad, elapsed);
    f.rig.mesh.position.set(f.x, f.y, f.z);
  }

  _step(f, dt, cam, L, elapsed) {
    const rig = f.rig;
    f.t += dt;
    switch (f.state) {
      case ST.SIT: {
        this._place(f, L, elapsed);
        rig.setPose('sit', 0);
        // The croak: the sac swells over a third of a second, holds, and drops.
        f.croakT -= dt;
        if (f.croakT <= 0 && f.sacT < 0) {
          f.sacT = 0;
          f.croakT = 7 + this.rnd() * 18;
          this._event('croak', f);
          this.stats.croaks++;
        }
        if (f.sacT >= 0) {
          f.sacT += dt;
          const u = f.sacT / 0.75;
          rig.sac = u < 0.4 ? u / 0.4 : u < 0.7 ? 1 : Math.max(0, 1 - (u - 0.7) / 0.3);
          if (u >= 1) { f.sacT = -1; rig.sac = 0; }
        }
        // Startled?
        if (this._startled(f, cam)) { this._beginDive(f, L, true); break; }
        f.sitT -= dt;
        if (f.sitT <= 0) this._decide(f, L, elapsed);
        break;
      }
      case ST.CROUCH: {
        // The frog turns to face its target DURING the crouch — a shuffle,
        // not a snap on the first launch frame — and the crouch is longer the
        // further it has to turn (see _aim).
        this._place(f, L, elapsed);
        const u = clamp01(f.t / f.crouchT);
        const k = u * u * (3 - 2 * u);
        rig.mesh.rotation.y = f.heading0 + wrapAngle(f.heading - f.heading0) * k;
        rig.setPose('crouch', u);
        if (f.t >= f.crouchT) { f.state = ST.LAUNCH; f.t = 0; rig.mesh.rotation.y = f.heading; }
        break;
      }
      case ST.LAUNCH: {
        // The body leaves the pad during the push: the arc's first JUMP.arc
        // plays under the legs going straight, so the body rises about a leg
        // length with them and flight begins at the speed it will keep.
        const u = f.t / JUMP.launch;
        rig.setPose('launch', u);
        this._arc(f, JUMP.arc * u);
        if (f.t >= JUMP.launch) {
          f.state = ST.FLIGHT; f.t = 0;
          if (f.pad && f.pad.frog === f) f.pad.frog = null;
          f.pad = null;
        }
        break;
      }
      case ST.FLIGHT: {
        // The remaining (1 - arc) of the parabola over the remaining time,
        // so gravity is gravity — mapping 85% of the arc onto 100% of the
        // flight time was a float at 0.72 g with a speed step at the join.
        const u = JUMP.arc + (1 - JUMP.arc) * (f.t / ((1 - JUMP.arc) * f.flightT));
        rig.setPose('flight', clamp01((u - JUMP.arc) / (1 - JUMP.arc)), f.dive);
        this._arc(f, u);
        if (u >= 1) {
          if (f.dive) {
            this._splash(f);
            f.state = ST.SINK; f.t = 0;
          } else {
            f.state = ST.LAND; f.t = 0;
            f.pad = f.toPad; f.toPad = null;
            this._event('land', f);
          }
        }
        break;
      }
      case ST.LAND: {
        this._place(f, L, elapsed);
        rig.setPose('land', f.t / JUMP.land);
        if (f.t >= JUMP.land) {
          f.state = ST.SIT; f.t = 0;
          f.sitT = 3 + this.rnd() * 10;
        }
        break;
      }
      case ST.SINK: {
        // Under, holding the entry pose — legs straight, nose down — and
        // down out of sight.
        rig.setPose('flight', 1, true);
        f.y -= dt * 0.9;
        f.x += Math.sin(f.heading) * dt * 0.5;
        f.z += Math.cos(f.heading) * dt * 0.5;
        rig.mesh.position.set(f.x, f.y, f.z);
        break;
      }
    }
    rig.update(dt);
  }

  // ── decisions ─────────────────────────────────────────────────────────────

  _decide(f, L, elapsed) {
    const r = this.rnd();
    if (r < 0.62) {
      if (this._beginHop(f, L, elapsed)) return;
    } else if (r < 0.74) {
      this._beginDive(f, L, false);
      return;
    }
    // Stay put a while longer (or no pad was in reach).
    f.sitT = 2 + this.rnd() * 6;
  }

  _beginHop(f, L, elapsed = 0) {
    const cands = L.padsNear(f.x, f.z, HOP_MAX, this._near3 ??= []);
    let best = null, bestScore = -1;
    for (const p of cands) {
      if (p === f.pad || p.frog || p.r < 0.16) continue;
      const c = L.padCentre(p, this._c);
      const d = Math.hypot(c.x - f.x, c.z - f.z);
      if (d < HOP_MIN || d > HOP_MAX) continue;
      // Prefer bigger leaves and middling distances; a little noise so a
      // frog does not shuttle between the same two.
      const score = p.r * 2 + (1 - Math.abs(d - 0.7) / 0.7) * 0.5 + this.rnd() * 0.6;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) return false;
    const c = L.padCentre(best, this._c);
    // The leaf's height NOW (with its bob), the same number _place will
    // read at touchdown, or the landing steps by up to the bob amplitude.
    this._aim(f, c.x, L.padTop(best, elapsed), c.z);
    best.frog = f;
    f.toPad = best;
    f.dive = false;
    f.state = ST.CROUCH; f.t = 0;
    this.stats.hops++;
    return true;
  }

  _beginDive(f, L, startled) {
    const W = this.ctx.world;
    // A point of open water 0.5-1.1 m away with no leaf under it, preferring
    // AWAY from whatever startled it if anything did.
    let tx = 0, tz = 0, ok = false;
    for (let k = 0; k < 8; k++) {
      let a = this.rnd() * Math.PI * 2;
      if (startled && this._threatDir) a = this._threatDir + Math.PI + (this.rnd() - 0.5) * 1.2;
      const d = 0.5 + this.rnd() * 0.6;
      const x = f.x + Math.sin(a) * d, z = f.z + Math.cos(a) * d;
      if ((W.getWaterDepth?.(x, z) ?? 0) < 0.25) continue;
      if (L.padAt(x, z)) continue;
      tx = x; tz = z; ok = true; break;
    }
    if (!ok) { f.sitT = 1 + this.rnd() * 3; return; }
    const wy = W.getWaterHeight(tx, tz) ?? f.y;
    this._aim(f, tx, wy, tz);
    f.dive = true; f.toPad = null;
    // Startled, the gather is a flinch: the turn and the crouch in 80 ms.
    if (startled) f.crouchT = 0.08;
    f.state = ST.CROUCH; f.t = 0;
    this.stats.dives++;
  }

  /** Set up the arc from where the frog sits to (x, y, z). */
  _aim(f, x, y, z) {
    f.from.x = f.x; f.from.y = f.y; f.from.z = f.z;
    f.to.x = x; f.to.y = y; f.to.z = z;
    const d = Math.hypot(x - f.x, z - f.z);
    f.heading0 = f.rig.mesh.rotation.y;
    f.heading = Math.atan2(x - f.x, z - f.z);
    // The crouch is where the frog comes round to face the target; a big
    // turn gets a longer gather.
    f.crouchT = JUMP.crouch + 0.10 * Math.abs(wrapAngle(f.heading - f.heading0)) / Math.PI;
    // A hop begun mid-croak would otherwise carry the sac inflated all the way.
    f.sacT = -1; f.rig.sac = 0;
    // Apex over the higher end: a short hop is a high one, a long one flatter.
    f.apex = clamp(0.30 * d, 0.10, 0.32) * (0.8 + 0.4 * f.size);
    // Time of flight for a parabola of that apex over the start-to-end line.
    f.flightT = 2 * Math.sqrt(2 * f.apex / G) + Math.abs(y - f.y) * 0.4;
  }

  /** Put the body at fraction `u` along the arc. */
  _arc(f, u) {
    u = clamp01(u);
    f.x = lerp(f.from.x, f.to.x, u);
    f.z = lerp(f.from.z, f.to.z, u);
    f.y = lerp(f.from.y, f.to.y, u) + 4 * f.apex * u * (1 - u);
    f.rig.mesh.position.set(f.x, f.y, f.z);
    f.rig.mesh.rotation.y = f.heading;
  }

  _splash(f) {
    this.ctx.systems?.water?.pushWake?.(f.x, f.z, 0.35 + 0.35 * f.size, 0.9 + 0.5 * f.size);
    this._event('splash', f);
  }

  _startled(f, cam) {
    const S = this.ctx.systems;
    this._threatDir = null;
    // Hulls, under way or drifting close.
    const boats = S?.boat?.boats;
    if (boats) {
      for (const b of boats) {
        if (b.sinkT !== null && b.sinkT !== undefined) continue;
        const p = b.phys; if (!p) continue;
        const d = Math.hypot(p.x - f.x, p.z - f.z);
        const dim = b.group?.userData?.dim ?? S.boat.models?.[b.kind]?.dim;
        if (d < STARTLE_HULL + (dim?.length ?? 4) * 0.5) { this._threatDir = Math.atan2(p.x - f.x, p.z - f.z); return true; }
      }
    }
    const vp = S?.vehicle?.position;
    if (vp) {
      const d = Math.hypot(vp.x - f.x, vp.z - f.z);
      if (d < STARTLE_CAMPER) { this._threatDir = Math.atan2(vp.x - f.x, vp.z - f.z); return true; }
    }
    const d = Math.hypot(cam.position.x - f.x, cam.position.z - f.z);
    if (d < STARTLE_CAMERA) { this._threatDir = Math.atan2(cam.position.x - f.x, cam.position.z - f.z); return true; }
    return false;
  }

  // ── for the harness and the audio layer ───────────────────────────────────

  /** Force a frog onto the nearest suitable pad to (x, z); returns it or null. */
  debugSpawn(x, z) {
    const L = this.ctx.systems?.lilyPads;
    if (!L) return null;
    const pads = L.padsNear(x, z, 6, []).filter((p) => p.r >= MIN_PAD_R && !p.frog)
      .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    if (!pads.length) return null;
    this._spawn(pads[0], L);
    return this.frogs[this.frogs.length - 1];
  }

  debugState() {
    return this.frogs.map((f) => ({
      state: NAMES[f.state], t: +f.t.toFixed(2), x: +f.x.toFixed(2), y: +f.y.toFixed(3), z: +f.z.toFixed(2),
      heading: +f.heading.toFixed(2), size: f.size, sac: +f.rig.sac.toFixed(2), dive: f.dive,
    }));
  }

  dispose() {
    for (let i = this.frogs.length - 1; i >= 0; i--) this._remove(i);
    this.ctx.scene.remove(this.group);
    for (const m of this.mats ?? []) m.dispose();
  }
}
