// ─────────────────────────────────────────────────────────────────────────────
//  Pointer — one definition of "the player clicked" and "where are they
//  pointing", for world systems that take clicks (the boat, and eventually
//  anything else).
//
//  Camp.js carries its own private copies of these (`_pollClick`,
//  `_pointerRay`, `_rayMiss`, `_camperHit`). This module is those exact
//  behaviours extracted, and Camp deliberately keeps its copies for now: its
//  click state is consumed mid-frame by the scope view (`this._click = false`)
//  and threaded through five methods, so rebasing it onto this in the same
//  change as a new system would put two behaviour changes in one diff. The
//  numbers below must match Camp's — if a click stops being a click at 6 px of
//  travel in one system and not the other, the game has two ideas of clicking.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

// A click is a press and release in the same place. The camera look drag uses
// the same button, so the honest test is "did the pointer move", not a timer —
// a slow deliberate click is still a click, a fast flick to turn the camera is
// not. Same numbers as Camp.js.
const CLICK_SLOP = 6;      // px of travel that still counts as a click
const CLICK_TIME = 0.55;   // s held that still counts as a click

/** Press-and-release-in-place tracker. Call `poll(dt)` once per frame. */
export class ClickTracker {
  constructor(input) {
    this.input = input;
    this.clicked = false;
    this._down = false;
    this._t = 0;
    this._travel = 0;
  }

  poll(dt) {
    const m = this.input.mouse;
    this.clicked = false;
    if (m.down && !this._down) {
      this._down = true;
      this._t = 0;
      this._travel = 0;
    } else if (m.down) {
      this._t += dt;
      this._travel += Math.abs(m.dx) + Math.abs(m.dy);
    } else if (this._down) {
      this._down = false;
      if (this._travel <= CLICK_SLOP && this._t <= CLICK_TIME) this.clicked = true;
    }
    return this.clicked;
  }
}

/**
 * The pointer ray: the mouse ray if the pointer is usable, the camera's own
 * forward ray otherwise — which is what a gamepad player gets, and what the
 * capture harness gets. Writes into `ray` ({o, d} of Vector3) and returns it.
 */
export function pointerRay(input, camera, ray) {
  const o = ray.o.copy(camera.position);
  const d = ray.d;
  if (input.mouse && Number.isFinite(input.mouse.x) && !window.__forceCamera) {
    d.set(input.mouse.x, input.mouse.y, 0.5).unproject(camera).sub(o).normalize();
  } else {
    camera.getWorldDirection(d);
  }
  return ray;
}

/**
 * How far a ray misses a sphere's centre, as a fraction of that sphere's
 * radius: 0 is dead on, 1 is grazing the rim, Infinity is a miss or behind
 * the lens. The "which target is the click CENTRED on" test.
 */
export function rayMiss(ray, centre, r) {
  const { o, d } = ray;
  const ox = centre.x - o.x, oy = centre.y - o.y, oz = centre.z - o.z;
  const along = ox * d.x + oy * d.y + oz * d.z;
  if (along < 0) return Infinity;                    // behind the lens
  const px = ox - d.x * along, py = oy - d.y * along, pz = oz - d.z * along;
  const perp = Math.sqrt(px * px + py * py + pz * pz);
  return perp > r ? Infinity : perp / r;
}

const _caster = new THREE.Raycaster();

/**
 * How far along a ray an object's own triangles are, or Infinity. The one
 * real scene raycast — used where the question genuinely is "did the player
 * click THIS object" (the camper), and only its geometry can answer it.
 */
export function objectHit(ray, object, far = 60) {
  if (!object) return Infinity;
  _caster.set(ray.o, ray.d);
  _caster.far = far;
  const hits = _caster.intersectObject(object, true);
  return hits.length ? hits[0].distance : Infinity;
}
