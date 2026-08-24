// ─────────────────────────────────────────────────────────────────────────────
//  Input vocabulary — what this game calls its own controls, in one place.
//
//  Every prompt in the game used to name a key or a mouse button: "E pack up
//  this camp", "click launch a kayak here", "Esc step back". On a phone there
//  is no E, no click and no Esc, and a prompt that names one is worse than no
//  prompt at all — it tells the player that the thing they are looking at is
//  for somebody else. The rule this module exists to keep is simply:
//
//      nothing the player reads on a touch device may name a key.
//
//  `touchCapable()` is the one test the whole game keys off (ui/TouchControls
//  builds its layer on it, hud.css keys `body.pa-touch` on it, and the verbs
//  below follow it), and it is answered ONCE and cached: a device that grows a
//  mouse mid-session must not have half its prompts change language while the
//  on-screen pedals are still on screen.
//
//  Two verbs, because the game has two kinds of interaction and they deserve
//  different gestures:
//
//    pickVerb()   acting on a THING already in the world — a boat to board,
//                 the camper to drive, an eyepiece to look through. The target
//                 is unambiguous, so it is a tap; making the player hold half a
//                 second to board a canoe they are pointing straight at reads
//                 as the game being broken.
//    placeVerb()  committing to a PLACE — pitching a camp here, putting a boat
//                 in the water here, stepping ashore. There is no hover on a
//                 touch screen, so the press IS the hover: hold and the ring
//                 and its validity appear under your thumb, release and it
//                 happens, slide off a red spot first and it does not. See
//                 core/Input.js `press`.
// ─────────────────────────────────────────────────────────────────────────────

let _touch = null;

/** Does this device have a touch screen? Answered once, then cached. */
export function touchCapable() {
  if (_touch === null) {
    _touch = (navigator.maxTouchPoints ?? 0) > 0
      || !!window.matchMedia?.('(pointer: coarse)').matches;
  }
  return _touch;
}

/** Test seam: force the answer. Only the harness and unit tests call this. */
export function setTouchCapable(v) { _touch = v === null ? null : !!v; }

/** Acting on a thing in the world: "<b>tap</b>" / "<b>click</b>". */
export function pickVerb() { return touchCapable() ? '<b>tap</b>' : '<b>click</b>'; }

/** Committing to a place: "<b>hold</b>" / "<b>Click</b> or <b>E</b>". */
export function placeVerb() {
  return touchCapable() ? '<b>hold</b>' : '<b>Click</b> or <b>E</b>';
}

/**
 * The place verb where the sentence already has a subject and only wants the
 * gesture — "<b>E</b>&nbsp; pack up this camp" and its touch twin.
 */
export function actVerb() { return touchCapable() ? '<b>hold</b>' : '<b>E</b>'; }
