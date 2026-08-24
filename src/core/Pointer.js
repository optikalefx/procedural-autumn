// ─────────────────────────────────────────────────────────────────────────────
//  Pointer — one definition of "the player clicked" and "where are they
//  pointing", for world systems that take clicks (the boat, and eventually
//  anything else).
//
//  Camp.js carries its own private copies of these (`_pointerRay`, `_rayMiss`,
//  `_camperHit`). This module is those exact behaviours extracted, and Camp
//  deliberately keeps its copies for now: its click state is consumed mid-frame
//  by the scope view (`this._click = false`) and threaded through five methods,
//  so rebasing it onto this in the same change as a new system would put two
//  behaviour changes in one diff.
//
//  What both systems now share is the gesture itself. Press tracking used to
//  live here AND in Camp, each sampling `input.mouse.down` once a frame — which
//  is exactly what made the game unplayable on a phone, because the synthetic
//  mouse events a browser fires after a tap all land inside one task and no
//  frame ever sees the button down. core/Input.js owns the press now, and this
//  module is the vocabulary on top of it: `pick` for a thing, `place` for a
//  spot. See the header of core/verbs.js for why those are different gestures.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { touchCapable } from './verbs.js';

/**
 * Press-and-release-in-place tracker.
 *
 * Kept as a class with a `poll(dt)` so its call sites did not have to change,
 * but there is nothing left to track: `Input` resolves the press and this reads
 * the answer. `clicked` is a PICK — acting on a thing the player is already
 * pointing at — so it takes a press that ended in place however long it was
 * held. A slow deliberate click has always counted, and on touch a hold that
 * lands on a boat may as well board it.
 */
export class ClickTracker {
  constructor(input) {
    this.input = input;
    this.clicked = false;
  }

  poll() {
    this.clicked = picked(this.input);
    return this.clicked;
  }
}

/** A press that resolved in place: the player picked whatever they were on. */
export function picked(input) {
  const p = input.press;
  return p.tap || p.commit;
}

/**
 * The player committed to a SPOT — pitch the camp here, put the boat in here.
 *
 * On touch this is the release of a hold and nothing else: a stray tap while
 * swinging the camera must not drop a camp in the lake, and the hold is what
 * bought the player the preview they are agreeing to. With a mouse there is a
 * hover doing that job already, so a plain click still commits.
 */
export function placed(input) {
  return touchCapable() ? input.press.commit : picked(input);
}

/**
 * Is the placement preview live — the ring, its validity, the prompt?
 *
 * With a mouse, always: the pointer hovers whether or not a button is down.
 * On touch, only while a hold is in progress, because there the press IS the
 * hover and a permanent ring under a thumb that is not there is a lie.
 */
export function placing(input) {
  return touchCapable() ? input.press.holding : true;
}

/**
 * Is the player pointing at the world at all?
 *
 * A mouse is always pointing somewhere. A finger is only pointing while it is
 * down — and `mouse.x/y` keeps the last press's position after it lifts, so
 * without this every prompt on a phone would freeze wherever the player last
 * touched and sit there claiming a boat is under their thumb. Systems clear
 * their prompt and their reticle when this is false, which gives touch a quiet
 * screen that answers when asked: press to see what is there, hold to commit.
 */
export function pointing(input) {
  const p = input.press;
  // `tap` and `commit` land on the frame AFTER the finger lifts, so `down` is
  // already false by the time a system is told what the press decided. Without
  // them here, every gesture on a touch screen would be cleared away one frame
  // before the code that acts on it ever ran — which is precisely what it did:
  // the hold showed its ring and its prompt for half a second and then pitched
  // nothing at all.
  return touchCapable() ? (p.down || p.tap || p.commit) : true;
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
