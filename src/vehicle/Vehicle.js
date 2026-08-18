// ─────────────────────────────────────────────────────────────────────────────
//  Vehicle — the camper: model, suspension, drivetrain, physics and juice.
//
//  Owns three things and keeps them in step:
//    · CamperModel     procedural geometry (see that file for the shape logic)
//    · VehiclePhysics  Rapier chassis + raycast suspension + streamed ground
//    · VehicleFX       dust, leaves, spray, exhaust, tyre tracks
//
//  Everything the rest of the game needs is read off this object: `position`,
//  `heading`, `speed`, `forward`, `up`, `wheels`.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { VEHICLE } from '../world/WorldConfig.js';
import { clamp, clamp01, lerp, smoothstep, damp } from '../core/MathUtils.js';
import { buildCamper, buildWheel, buildMaterials, buildEnvMap, DIM } from './CamperModel.js';
import { VehiclePhysics } from './VehiclePhysics.js';
import { ParticleField, TrackRibbons, surfaceDust, KIND } from './VehicleFX.js';

const LEAF_COLORS = [0xe8622a, 0xf09a2c, 0xf3cf45, 0x9e2b28, 0xb8471f];

export class Vehicle extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Vehicle';
    this.loadLabel = 'Packing the camper';

    this.position = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this.quaternion = new THREE.Quaternion();
    this.wheels = [];
    this.waterDepth = 0;
    this.engineLoad = 0;
    this.throttle = 0;
    this.steer = 0;

    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._col = new THREE.Color();
    this._w = {};
    this._exhaustAcc = 0;
    this._headlightMix = 0;
    this._lastSpeed = 0;
    this._accelSmooth = 0;
    this._lateralSmooth = 0;
  }

  async init() {
    const { ctx } = this;
    const { scene, renderer, world, poi } = ctx;

    // ── pick a start: the first road point that is flat, dry and in bounds ──
    let start = null;
    for (let i = 0; i < 24 && !start; i++) {
      const p = poi.best('road', i);
      if (!p) break;
      if (world.getWaterDepth(p.x, p.z) > 0.05) continue;
      if (world.getSlope(p.x, p.z) > 0.42) continue;
      start = p;
    }
    start = start ?? poi.best('meadow') ?? { x: 0, z: 0, yaw: 0 };
    const heading = start.yaw ?? 0;

    // ── materials + model ───────────────────────────────────────────────────
    this.env = buildEnvMap(renderer);
    this.materials = buildMaterials(this.env, 0xc4551f);
    const built = buildCamper(this.materials, 91);
    this.root = built.root;
    this.antenna = built.antenna;
    this.steeringWheel = built.steeringWheel;

    // A pivot between the physics transform and the model, used for the little
    // exaggerations physics alone will not give: idle shake and a touch of
    // extra weight transfer.
    this.pivot = new THREE.Group();
    this.pivot.add(this.root);
    this.rig = new THREE.Group();
    this.rig.name = 'vehicleRig';
    this.rig.add(this.pivot);
    scene.add(this.rig);

    this.wheelNodes = [];
    for (let i = 0; i < 4; i++) {
      const hub = new THREE.Group();          // steering
      const spin = buildWheel(this.materials);
      hub.add(spin);
      this.rig.add(hub);                      // NB: not under `pivot` — wheels
      this.wheelNodes.push({ hub, spin });     // must not inherit body lean
    }

    // ── headlights ──────────────────────────────────────────────────────────
    this.headlights = [];
    for (const s of [-1, 1]) {
      const l = new THREE.SpotLight(0xfff0d2, 0, 68, 0.52, 0.55, 1.4);
      l.castShadow = false;
      l.position.set(s * 0.60, 0.205, DIM.front - 0.02);
      l.target.position.set(s * 0.55, -1.1, DIM.front + 20);
      this.rig.add(l);
      this.rig.add(l.target);
      this.headlights.push(l);
    }

    // ── physics ─────────────────────────────────────────────────────────────
    this.phys = new VehiclePhysics(world);
    await this.phys.init(start.x, start.z, heading);
    this.wheels = this.phys.wheels;

    // ── fx ──────────────────────────────────────────────────────────────────
    const budget = ctx.preset?.grassMul >= 0.8 ? 1100 : 550;
    this.particles = new ParticleField(scene, budget);
    this.tracks = new TrackRibbons(scene, 4, ctx.preset?.grassMul >= 0.8 ? 190 : 110);

    this._sample = (x, z) => world.getHeight(x, z);
    this._syncTransform();

    // Debug surface for tools/drive.mjs.
    window.__vehicle = this;
    window.__vehicleState = () => ({
      x: this.position.x, y: this.position.y, z: this.position.z,
      speed: this.speed, heading: this.heading,
      up: this.up.y, grounded: this.wheels.filter((w) => w.grounded).length,
      water: this.waterDepth, recoveries: this.phys.recoveries,
      nan: this.phys.nanEvents ?? 0,
      ground: world.getHeight(this.position.x, this.position.z),
    });
    window.__vehicleTeleport = (x, z, h = 0) => this.phys.teleport(x, z, h);
    window.__vehicleTune = (o) => this.phys.tune(o);
  }

  update(dt) {
    if (!this.phys?.ready) return;
    const { ctx } = this;
    const input = ctx.input;
    const ax = input.axes;

    // ── camera cycling / input ──────────────────────────────────────────────
    this.throttle = ax.throttle;
    this.steer = ax.steer;

    this.phys.step(dt, {
      throttle: ax.throttle,
      brake: ax.brake,
      steer: ax.steer,
      handbrake: ax.handbrake,
    });

    this._syncTransform();
    this._syncWheels(dt);
    this._body(dt);
    this._effects(dt);
    this._lights(dt);

    this.particles.update(dt, ctx.engine.height);
    this.tracks.update(dt);
    this._patchAnchor();
  }

  // ── transform ─────────────────────────────────────────────────────────────
  _syncTransform() {
    const t = this.phys.body.translation();
    const r = this.phys.body.rotation();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this.rig.position.copy(this.position);
    this.rig.quaternion.copy(this.quaternion);
    this.forward.copy(this.phys._fwd);
    this.right.copy(this.phys._right);
    this.up.copy(this.phys._up);
    this.heading = Math.atan2(this.forward.x, this.forward.z);
    this.speed = this.phys.speed;
    this.velocity.copy(this.phys.velocity);
    this.waterDepth = this.phys.waterDepth;
  }

  _syncWheels(dt) {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const n = this.wheelNodes[i];
      // Physics reports wheel centres in world space; the rig carries the
      // chassis transform, so convert once through the rig's inverse.
      this._tmp.copy(w.pos);
      this.rig.worldToLocal(this._tmp);
      n.hub.position.copy(this._tmp);
      n.hub.rotation.y = w.steer;
      n.spin.rotation.x = -w.spin;
      void dt;
    }
  }

  /** Exaggerated weight transfer + idle shake, applied to the body only. */
  _body(dt) {
    const accel = (this.speed - this._lastSpeed) / Math.max(dt, 1e-3);
    this._lastSpeed = this.speed;
    this._accelSmooth = damp(this._accelSmooth, clamp(accel, -14, 14), 7, dt);
    this._lateralSmooth = damp(this._lateralSmooth, clamp(this.phys.lateral ?? 0, -12, 12), 6, dt);

    const idle = this.throttle > 0.05 ? 1.0 : 0.42;
    const t = performance.now() * 0.001;
    const shake = (this.wheels.some((w) => w.grounded) ? 1 : 0.2) * idle * 0.0016;

    // Physics already pitches through the springs; this adds ~25% on top so it
    // reads at a glance in a chase camera without feeling like a boat.
    this.pivot.rotation.x = damp(this.pivot.rotation.x, -this._accelSmooth * 0.012, 9, dt)
      + Math.sin(t * 41.0) * shake;
    this.pivot.rotation.z = damp(this.pivot.rotation.z, this._lateralSmooth * 0.010, 8, dt)
      + Math.sin(t * 33.0 + 1.7) * shake * 0.7;
    this.pivot.position.y = Math.sin(t * 37.0) * shake * 0.5;

    // Antenna trails the acceleration and whips in a turn.
    const aw = clamp(-this._accelSmooth * 0.03 + Math.sin(t * 3.1) * 0.02, -0.4, 0.4);
    this.antenna.rotation.x = damp(this.antenna.rotation.x, aw, 5, dt);
    this.antenna.rotation.z = damp(this.antenna.rotation.z,
      clamp(this._lateralSmooth * 0.035, -0.4, 0.4) + Math.sin(t * 2.3) * 0.03, 4, dt);

    // Steering wheel follows the road wheels, with a little lag.
    const target = -(this.phys.steerAngle ?? 0) * 3.4;
    this.steeringWheel.rotation.z = damp(this.steeringWheel.rotation.z, target, 10, dt);
  }

  // ── particles, spray, tracks ──────────────────────────────────────────────
  _effects(dt) {
    const { world } = this.ctx;
    const P = this.particles;
    const absSpeed = Math.abs(this.speed);
    const c = this._col;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) continue;
      const cx = w.contact.x, cy = w.contact.y, cz = w.contact.z;
      if (!Number.isFinite(cx)) continue;

      const depth = world.getWaterDepth(cx, cz);
      const weights = world.getSurfaceWeights(cx, cz, this._w);
      const soft = clamp01(weights.grass * 0.7 + weights.dry * 0.8 + weights.dirt * 1.0
        + weights.sand * 1.0 + weights.snow * 0.9 - weights.rock * 0.8);

      // spin-up and slide both throw material; so does simply moving fast
      const work = clamp01(absSpeed / 16) * 0.55 + w.slip * 0.9;

      if (depth > 0.06) {
        // ── water: spray sheets off the tyre, higher with speed ─────────────
        const n = Math.min(4, Math.floor(absSpeed * dt * 9 + Math.random() * 0.8));
        for (let k = 0; k < n; k++) {
          const sp = 1.2 + absSpeed * 0.22;
          c.setRGB(0.93, 0.97, 1.0);
          P.spawn(
            cx + (Math.random() - 0.5) * 0.3,
            cy + 0.1 + Math.random() * 0.2,
            cz + (Math.random() - 0.5) * 0.3,
            -this.forward.x * sp * (0.3 + Math.random() * 0.8) + (Math.random() - 0.5) * 2.2,
            1.6 + Math.random() * 2.6,
            -this.forward.z * sp * (0.3 + Math.random() * 0.8) + (Math.random() - 0.5) * 2.2,
            0.55 + Math.random() * 0.45, 0.10 + Math.random() * 0.10, KIND.SPRAY, c,
          );
        }
        continue;
      }

      if (work * soft < 0.05) continue;

      // ── dust / dirt ────────────────────────────────────────────────────────
      const rate = work * soft * (2.0 + absSpeed * 0.55);
      let n = Math.floor(rate * dt * 26);
      if (Math.random() < rate * dt * 26 - n) n++;
      for (let k = 0; k < Math.min(n, 5); k++) {
        surfaceDust(weights, c);
        const j = 0.85 + Math.random() * 0.3;
        c.multiplyScalar(j);
        P.spawn(
          cx + (Math.random() - 0.5) * 0.34,
          cy + 0.08 + Math.random() * 0.12,
          cz + (Math.random() - 0.5) * 0.34,
          -this.forward.x * (0.8 + absSpeed * 0.16) * (0.4 + Math.random()) + (Math.random() - 0.5) * 1.1,
          0.5 + Math.random() * 1.1,
          -this.forward.z * (0.8 + absSpeed * 0.16) * (0.4 + Math.random()) + (Math.random() - 0.5) * 1.1,
          0.9 + Math.random() * 1.1, 0.28 + Math.random() * 0.4, KIND.DUST, c,
        );
      }

      // ── kicked-up leaves, only where litter actually lies ──────────────────
      if (Math.random() < weights.litter * work * dt * 16) {
        c.setHex(LEAF_COLORS[(Math.random() * LEAF_COLORS.length) | 0], THREE.SRGBColorSpace);
        P.spawn(
          cx + (Math.random() - 0.5) * 0.5, cy + 0.12, cz + (Math.random() - 0.5) * 0.5,
          -this.forward.x * (1.4 + absSpeed * 0.3) + (Math.random() - 0.5) * 2.4,
          1.4 + Math.random() * 2.4,
          -this.forward.z * (1.4 + absSpeed * 0.3) + (Math.random() - 0.5) * 2.4,
          1.6 + Math.random() * 1.4, 0.13 + Math.random() * 0.07, KIND.LEAF, c,
        );
      }

      // ── tracks in soft ground ─────────────────────────────────────────────
      if (soft > 0.28 && absSpeed > 1.0) {
        surfaceDust(weights, c);
        c.multiplyScalar(0.55);          // a rut is the same soil, in shadow
        this.tracks.emit(i, cx, cz, this.right.x, this.right.z, 0.19, c,
          clamp01(soft * 1.1) * clamp01(absSpeed * 0.5), this._sample);
      }
    }

    // ── bow wave when wading ────────────────────────────────────────────────
    if (this.waterDepth > 0.12 && absSpeed > 1.2) {
      const wl = world.getWaterHeight(this.position.x, this.position.z) ?? this.position.y;
      const n = Math.min(5, Math.floor(absSpeed * dt * 14));
      for (let k = 0; k < n; k++) {
        const s = (Math.random() - 0.5) * 2;
        this._tmp.copy(this.position)
          .addScaledVector(this.forward, 2.1 * Math.sign(this.speed || 1))
          .addScaledVector(this.right, s * 0.95);
        c.setRGB(0.95, 0.98, 1.0);
        P.spawn(this._tmp.x, wl + 0.08, this._tmp.z,
          this.forward.x * absSpeed * 0.28 + s * 1.6, 1.0 + Math.random() * 1.8,
          this.forward.z * absSpeed * 0.28 + s * 1.6,
          0.7 + Math.random() * 0.5, 0.16 + Math.random() * 0.16, KIND.SPRAY, c);
      }
    }

    // ── exhaust: a puff on throttle, a wisp at idle ─────────────────────────
    this._exhaustAcc += dt * (0.9 + this.throttle * 7.5 + clamp01(this._accelSmooth * 0.3) * 6);
    while (this._exhaustAcc > 1) {
      this._exhaustAcc -= 1;
      this._tmp.set(0.46, DIM.floor - 0.06, DIM.rear - 0.05).applyQuaternion(this.quaternion).add(this.position);
      c.setRGB(0.52, 0.50, 0.50);
      P.spawn(this._tmp.x, this._tmp.y, this._tmp.z,
        -this.forward.x * 1.6 + (Math.random() - 0.5) * 0.5,
        0.35 + Math.random() * 0.4,
        -this.forward.z * 1.6 + (Math.random() - 0.5) * 0.5,
        0.85 + Math.random() * 0.7, 0.13 + Math.random() * 0.12, KIND.SMOKE, c);
    }
  }

  // ── headlights + lamp emissives follow the sun ───────────────────────────
  _lights(dt) {
    const sunY = this.ctx.lighting?.sunDir?.y ?? 1;
    const want = 1 - smoothstep(-0.02, 0.20, sunY);
    this._headlightMix = damp(this._headlightMix, want, 2.2, dt);
    const k = this._headlightMix;
    for (const l of this.headlights) l.intensity = k * 190;
    const m = this.materials;
    m.lensHead.emissiveIntensity = lerp(0.30, 2.4, k);
    m.lensTail.emissiveIntensity = lerp(0.45, 1.7, k) +
      (this.ctx.input.axes.brake > 0.05 ? 1.6 : 0);
    m.lensAmber.emissiveIntensity = lerp(0.25, 0.9, k);
  }

  /**
   * The capture harness stands the camera *at* `vehicle.position`, which puts
   * it inside the cabin. Offset the anchor back along the view direction so
   * `--view vehicle` actually frames the camper. Logged in
   * docs/INTEGRATION_REQUESTS.md; harmless if the harness ever changes.
   */
  _patchAnchor() {
    if (this._anchorPatched || !window.__cameraAnchors) return;
    this._anchorPatched = true;
    window.__cameraAnchors.vehicle = () => {
      const a = this.heading + 2.30;         // rear three-quarter
      return {
        x: this.position.x + Math.sin(a) * 9,
        z: this.position.z + Math.cos(a) * 9,
        y: this.position.y,
        yaw: a + Math.PI,
        lookY: 1.4,
      };
    };
  }

  dispose() {
    this.rig?.parent?.remove(this.rig);
    this.particles?.dispose();
    this.tracks?.dispose();
    this.phys?.dispose();
    this.env?.dispose();
    for (const m of Object.values(this.materials ?? {})) m.dispose?.();
  }
}
