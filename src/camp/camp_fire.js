// ─────────────────────────────────────────────────────────────────────────────
//  camp_fire — the fire pit: stone ring, burning logs, flame, embers, smoke,
//  and the light the whole camp is lit by after sundown.
//
//  PLACEHOLDER. Scaffolding only; see docs/CAMP_BRIEF.md.
//
//  API contract (Camp.js depends on exactly this):
//    new Firepit(scene, rnd, opts) -> { group, light, update(dt,t,camera),
//                                       setReveal(k), setPosition(v3), dispose() }
//    buildWoodpile(rnd, opts) -> THREE.Group
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { Parts, at, rod, tube, tintOf, campMaterials, span, M } from './camp_materials.js';
import { clamp01, lerp, mulberry32 } from '../core/MathUtils.js';

const TAU = Math.PI * 2;

export class Firepit {
  constructor(scene, rnd = Math.random, opts = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'camp_fire';
    this.reveal = 1;
    this._t = 0;

    const P = new Parts('fire');
    const R = opts.radius ?? 0.62;

    // Stone ring.
    const n = 9 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + (rnd() - 0.5) * 0.22;
      const rr = R * (0.94 + rnd() * 0.12);
      const s = 0.13 + rnd() * 0.09;
      const geo = new THREE.DodecahedronGeometry(s, 0);
      const k = 0.86 + rnd() * 0.24;
      P.add(geo, 'stone',
        at(Math.cos(a) * rr, s * 0.52, Math.sin(a) * rr,
           rnd() * TAU, rnd() * TAU, rnd() * TAU, 1.15, 0.72, 1.0),
        [k, k * 0.98, k * 0.95]);
    }
    // Burnt logs, leaned into a rough tipi.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + rnd() * 0.5;
      const foot = new THREE.Vector3(Math.cos(a) * R * 0.62, 0.04, Math.sin(a) * R * 0.62);
      const head = new THREE.Vector3(Math.cos(a) * 0.08, 0.34, Math.sin(a) * 0.08);
      const len = foot.distanceTo(head);
      P.add(rod(0.036 + rnd() * 0.014, len), 'char', span(foot, head, M()), [1, 1, 1]);
    }
    P.flush(this.group, { cast: true, receive: true });

    // The flame: crossed additive cards. Cheap, and at this size the shape of
    // the silhouette matters far more than the simulation behind it.
    this.flameMat = new THREE.MeshBasicMaterial({
      color: 0xffb347, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    this.flame = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.62, 1, 4), this.flameMat);
      m.position.y = 0.31;
      m.rotation.y = (i / 3) * Math.PI;
      this.flame.add(m);
    }
    this.group.add(this.flame);

    // The light. One point light: at night this is the only warm source in the
    // frame and everything the camp does visually after sundown comes off it.
    this.light = new THREE.PointLight(0xff9a3c, 6.0, 22, 2);
    this.light.position.set(0, 0.42, 0);
    this.light.castShadow = false;
    this.group.add(this.light);

    scene.add(this.group);
  }

  setPosition(v) { this.group.position.copy(v); }

  setReveal(k) {
    this.reveal = clamp01(k);
    this.group.visible = this.reveal > 0.01;
    this.group.scale.setScalar(lerp(0.6, 1, this.reveal));
  }

  update(dt, t, camera) {
    this._t = t;
    // Flicker: two incommensurable rates so it never reads as a sine.
    const f = 0.78 + 0.14 * Math.sin(t * 11.3) + 0.08 * Math.sin(t * 6.1 + 1.7);
    this.light.intensity = 6.0 * f * this.reveal;
    this.flameMat.opacity = 0.9 * f;
    const s = 0.92 + 0.12 * Math.sin(t * 9.4 + 0.6);
    this.flame.scale.set(1, s, 1);
    if (camera) this.flame.rotation.y = Math.atan2(
      camera.position.x - this.group.position.x,
      camera.position.z - this.group.position.z);
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => { o.geometry?.dispose?.(); });
    this.flameMat.dispose();
  }
}

/** A stack of split logs. */
export function buildWoodpile(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_woodpile';
  const P = new Parts('woodpile');
  const n = opts.logs ?? 6;
  let y = 0.055;
  for (let row = 0; row < 3 && n > 0; row++) {
    const count = Math.max(1, Math.round(n / 3) - row);
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) * 0.5) * 0.115 + (rnd() - 0.5) * 0.02;
      const len = 0.42 + rnd() * 0.10;
      P.add(rod(0.052, len), 'wood',
        at(x, y, (rnd() - 0.5) * 0.03, 0, 0, Math.PI * 0.5), [0.94 + rnd() * 0.14, 1, 0.95]);
    }
    y += 0.10;
  }
  P.flush(g);
  g.userData.footprint = 0.44;
  return g;
}
