// ─────────────────────────────────────────────────────────────────────────────
//  Weather — the air between the camera and the landscape.
//
//  Everything else in this game is a surface. This system is the only one that
//  puts anything *in front* of those surfaces, and that turns out to be what
//  separates "a very good diorama" from "a place you are standing in":
//
//    · leaves        one InstancedMesh, real ballistics, shed from the actual
//                    deciduous trees around you       (weather_leaves.js)
//    · motes         pollen and seed fluff catching the low sun, GPU-resident
//                    and free on the CPU              (weather_motes.js)
//    · shafts        canopy god rays as billboarded geometry, because the post
//                    chain belongs to another author  (weather_shafts.js)
//    · wind          one coherent field, published so grass and trees can
//                    eventually ride the same gusts   (wind.js)
//
//  Everything is pooled and instanced; `update()` allocates nothing. Total
//  cost is three draw calls plus the wind maths.
//
//  The time-of-day gates are as important as the effects. A drift of leaves is
//  charming at golden hour and looks like dirt on the lens at midnight, so
//  each element is driven from `SKY_STATE` rather than left running flat out.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { SEED } from '../world/WorldConfig.js';
import { clamp01, smoothstep } from '../core/MathUtils.js';
import { SKY_STATE } from '../render/Lighting.js';
import { WindField } from './wind.js';
import { GroundCache } from './weather_ground.js';
import { NearTrees } from './weather_trees.js';
import { LeafDrift } from './weather_leaves.js';
import { Motes } from './weather_motes.js';
import { LightShafts } from './weather_shafts.js';

// Pool sizes per tier. Leaves are the expensive one (CPU integration + a
// matrix upload); motes are nearly free, so they scale down far less.
const TIERS = {
  ultra:  { leaves: 900, motes: 1500, shafts: 30 },
  high:   { leaves: 700, motes: 1200, shafts: 24 },
  medium: { leaves: 400, motes: 800,  shafts: 14 },
  low:    { leaves: 180, motes: 400,  shafts: 0 },
};

export class Weather extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Weather';
    this.loadLabel = 'Letting the wind in';

    this.wind = new WindField(SEED ^ 0x77d);
    // Trees already reads this defensively as a sway multiplier; publishing it
    // is what puts the canopy and the leaves leaving it on the same gust.
    this.windScale = 1;

    this._scratch = new THREE.Vector3();
  }

  async init() {
    const { quality, preset, world, camera } = this.ctx;
    const tier = TIERS[quality] ?? TIERS.high;

    this.ground = new GroundCache(world);
    this.ground.prime(camera.position.x, camera.position.z);

    this.near = new NearTrees(this.ctx, 70);

    this.leaves = new LeafDrift(this.ctx, this.wind, this.ground, this.near, tier.leaves);
    this.leaves.init();

    this.motes = new Motes(this.ctx, this.wind, tier.motes);
    this.motes.init();

    // Shafts are the one genuinely volumetric-feeling element here, so they
    // are the one that respects the preset flag. Everything else is cheap
    // enough to keep at every tier.
    const shaftN = preset?.volumetric ? tier.shafts : Math.round(tier.shafts * 0.4);
    if (shaftN > 0) {
      this.shafts = new LightShafts(this.ctx, this.near, shaftN);
      this.shafts.init();
    }
  }

  /**
   * Wind velocity, m/s, at a world position. Public API for other systems.
   *
   *   const v = ctx.systems.weather.windAt(pos, elapsed, myVec3);
   *
   * Omitting `out` returns a shared scratch vector that is only valid until
   * the next call — convenient inside a tight loop, wrong to store.
   */
  windAt(pos, t, out) {
    return this.wind.windAt(pos, t, out);
  }

  /** Scalar gust envelope at a point, ~0.45 … ~1.55. */
  gustAt(x, z) { return this.wind.gustAt(x, z); }

  /** Unit horizontal wind direction (do not mutate). */
  get windDir() { return this.wind.dir; }

  update(dt, elapsed) {
    const s = SKY_STATE;
    const cam = this.ctx.camera.position;

    this.wind.update(dt, elapsed);
    this.windScale = this.wind.gust;
    this.ground.update(cam.x, cam.z);
    this.near.update(dt, cam);

    // ── time-of-day gates ────────────────────────────────────────────────────
    // Leaves stay through dusk (a silhouetted leaf against a bright sky is one
    // of the best frames this game has) but thin out overnight, where they
    // would only ever read as noise.
    const day = s.dayFactor;
    const leafAmt = 0.22 + 0.78 * day;

    // Motes need a low, direct sun to be lit at all — at noon the air just
    // looks clean. Peak at first light and at golden hour.
    const elev = s.sunElev;                       // sin(elevation)
    const lowSun = smoothstep(0.005, 0.075, elev) * (1 - smoothstep(0.30, 0.62, elev));
    const moteAmt = clamp01(0.10 * day + 0.75 * lowSun);

    // Shafts want the same low sun, but harder: a shaft at noon is vertical
    // and invisible, and a shaft after sunset has no light in it.
    const shaftAmt = clamp01(smoothstep(0.012, 0.10, elev) * (1 - smoothstep(0.26, 0.55, elev)));

    this.leaves.update(dt, elapsed, leafAmt);
    this.motes.update(dt, elapsed, moteAmt * 0.85);
    if (this.shafts) this.shafts.update(dt, elapsed, shaftAmt * 0.7);
  }

  dispose() {
    this.leaves?.dispose();
    this.motes?.dispose();
    this.shafts?.dispose();
  }
}
