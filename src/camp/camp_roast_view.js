// ─────────────────────────────────────────────────────────────────────────────
//  camp_roast_view — sitting at the fire with a marshmallow on a stick.
//
//  Click the whittled stick leaning on the camp table and the camera walks to
//  the fire, sits down, and takes it: a first-person view over the flames with
//  the stick coming in low from the right. Drag left/right (or A/D) to TWIRL it,
//  drag up/down (or W/S) to raise and lower it over the heat, `E` or a click to
//  eat it, Escape to step back. `docs/ROAST_CONTRACT.md` §3 is the spec; this
//  file is the whole of it.
//
//  `camp_scope_view.js` is this file's older sibling and it solved the same four
//  problems. They are restated here because the answers are different every
//  time, and because a reader who arrives at this file first should not have to
//  go and read the telescope to understand the fire.
//
//  ── 1. Where the eye goes ────────────────────────────────────────────────
//
//  At a seat. Not "near the fire" and not at the fire's own centre — the shot
//  has to read as SITTING at a campfire, leaning forward with a stick out, and
//  that is a very specific set of numbers: 1.05 m of eye ABOVE THE GROUND AT
//  THE SEAT, 1.30 m out from the fire's centre, pitched 30 degrees down. Those
//  three together drop the near stones under the bottom edge, lay the far ring
//  across the bottom third as an arc, and leave the grass line and the treeline
//  at the top — three value groups, which is the composition.
//
//  ABOVE THE GROUND AT THE SEAT is load-bearing and it was wrong until round 5:
//  the height was measured from the FIRE'S OWN ORIGIN, which is not the floor
//  the camp stands on and is not level with it. See `_measureSeatY`. Get the
//  height wrong by 40 cm and the identical camera reads as standing over the
//  fire, which is what nobody does with a marshmallow because it cooks your
//  face; get it wrong by 18 the other way and you are photographing a tent's
//  underside from below its floor, which is round 4.
//
//  The BEARING is the other half and it is not a constant: the camera sits on
//  the side of the fire the player was already looking from, chosen as the
//  chair nearest their pointer, so the player ends up sitting where somebody
//  would rather than being teleported round the fire to a canonical seat.
//
//  ── 2. The stick has to be in the hand, not in the world ─────────────────
//
//  It is parented to the CAMERA. That is not a shortcut around a transform —
//  it is the difference between holding something and standing next to it. A
//  world-parented stick posed at the camera every frame inherits one frame of
//  camera lag and shears against the background on every breath; a camera
//  child cannot, by construction, and its tiny sway is then legible as the
//  hand moving rather than as tracking error.
//
//  Three consequences worth knowing before touching this:
//
//   · the camera has to be IN THE SCENE for its children to be drawn at all —
//     `WebGLRenderer` traverses `scene`, not `camera` — so `enter` adds it and
//     `_release` takes it back out. Adding it permanently would leave a stick
//     hanging in front of every raycast in the game;
//   · the whole stick pose is therefore computed in CAMERA-LOCAL space, and
//     against the SETTLED camera pose rather than the live transitional one.
//     Deriving it from the live camera would be a feedback loop: the camera
//     eases in, the stick chases the camera easing in, and the tip describes a
//     hook on arrival that no amount of damping removes;
//   · the marshmallow's world position is a consequence of the pose, so the
//     toast map — which needs a real world matrix to know which texel faces the
//     fire — is stepped in `_drive`, after the pose and after
//     `updateMatrixWorld`, and never in `update`.
//
//  ── 3. The rig has to let go ────────────────────────────────────────────
//
//  `CameraRig.lateUpdate` runs after every system update and writes the camera
//  outright, so a system that poses the camera in its own `update` is simply
//  overwritten. `CameraRig.takeCamera()` is the hook, and it outranks even
//  `window.__forceCamera` (see the ordering note in `lateUpdate`). This view is
//  the second caller; the telescope is the first.
//
//  ── 4. It has to READ as a fire, and stay CALM ──────────────────────────
//
//  The telescope's answer was a hard field stop, because an eyepiece is an
//  optic and optics have edges. A fire has no edge. What it has is a warm
//  bottom-weighted glow on the eye — the light is BELOW you and in front of
//  you — so the overlay is a soft warm lift from the bottom of the frame with
//  only a whisper of falloff at the corners. Explicitly not a black tunnel:
//  a vignette that hard would say "you are looking through a thing", and the
//  player is not looking through anything, they are sitting somewhere.
//
//  And nothing else. No timer, no progress bar, no score, no chime. The
//  marshmallow is the readout — that is the entire design of the mini-game —
//  and the only text is one line naming the controls and the way out, plus one
//  line at the end naming the result. Anything that counts down turns a thing
//  you do while talking to someone into a thing you can lose.
//
//  ── 5. PHOTO MODE: THE STICK STANDS, IT DOES NOT LEAVE ──────────────────
//
//  The player asked: "is there any way to use photo mode and be able to
//  capture a photo while you're roasting?" They want to press F mid-roast and
//  photograph THE MARSHMALLOW OVER THE FIRE — fly the free camera round it and
//  take the shot. See `handOff` / `endHandOff`.
//
//  This file used to do the opposite, and the reasoning was half right. The old
//  `handOff` released everything: the stick was detached and deleted, the
//  leaning prop came back on the table, and the free camera got the fireside
//  seat with nothing in front of it. The stated argument — "a free camera flying
//  off with a stick welded to the lens is not a photograph" — is exactly right
//  about the failure it prevents and wrong about the cure. The fix for WELDED TO
//  THE LENS is to unparent, not to delete: `Object3D.attach` preserves the world
//  transform, so the stick stops being a camera child and stands in the world at
//  the pose the player's hand had it in, and the free camera then orbits a
//  marshmallow that stays put over the fire. That is the shot.
//
//  Measured, before this landed (`tools/_scratch/roastphoto.mjs --before`):
//  pressing F mid-roast did not even reach the old `handOff`. `Camp.update`
//  computes `holding = brakeHold && !photographing`, so photo mode makes the
//  camp think the player has stopped playing, and the not-holding branch calls
//  `roast.leave()` — every frame. The view eased itself out under the free
//  camera and `_release`d: `active:false, phase:'off', took:false`, stick gone
//  from the graph, and F again dropped the player into a chase camera 19.7 m
//  away. Four things wrong, none of them announced.
//
//  So the hand-off keeps the VIEW alive and gives up only the CAMERA:
//
//   · `detach()` — the same method `roastshot.mjs` uses for its macros — takes
//     the stick out of the hand and into the scene with its world transform
//     intact. `_detached` then stops `_poseStick` writing over it, which is
//     what makes it stand still while the camera flies;
//   · the rig's takeover is handed back and `window.__forceCamera` goes down,
//     because `CameraRig.lateUpdate` returns at BOTH of those before it ever
//     reaches free mode. Leave either up and photo mode is a still frame with a
//     control rail on it;
//   · `leave()` becomes a no-op for the duration, which is the answer to Camp's
//     `holding` gate above. Composing a photograph is not standing up;
//   · THE COOK IS PAUSED AND THE ANIMATION IS NOT. `_photoUpdate` runs
//     `_writeUniforms` and `_dressFlames` — the glow, the ember flicker, the
//     candle flame, the steam wisp — and does NOT run `_stepToast` or `_sim`.
//     Nothing accumulates: not toast, not slip, not the flywheel, not `time`. A
//     marshmallow that chars while you pick an angle is a punishment for using
//     the feature. (In the live path the whole view is simply not stepped —
//     Camp's `holding` gate again — so the fireside freezes alongside the
//     campfire under `ctx.worldPaused`, which is the look you want anyway. See
//     `_photoUpdate` for the honest version of who calls what.)
//   · the fire's leaned falloff goes back to the game's, for the same reason
//     the lens does. See `handOff`.
//
//  Coming back is `attach()` plus a `_repose`: the stick returns to the hand at
//  the authored pose, the camera cuts back to the same seat, the doneness is the
//  doneness it was. Verified across the transition rather than at the ends —
//  `roastphoto.mjs` asserts `doneness` unchanged to 1e-5, the seat returned to
//  within a millimetre, and `stickParent` reading camera -> scene -> camera.
//
//  What is deliberately NOT undone at hand-off: the stick's `raycast = () => {}`
//  and `frustumCulled = false`. Both look like held-object insurance and both
//  are still right on a world object. `raycast`: `_clearance()` casts thirteen
//  rays from the lens to the marshmallow and counts what writes depth in the way
//  — a pickable stick would occlude itself and `state().clear` would go false on
//  its own geometry. `frustumCulled`: the cost is two draw calls of a stick that
//  is off screen, and turning it back on would re-arm the exact bug the note in
//  `_build` describes the moment the stick is back in the hand.
//
//  ── the twirl, which is the actual feature ──────────────────────────────
//
//  Everything above is staging. The verb is the twirl, and it has to feel good
//  in the hand before any of the art is worth judging, so it is modelled as a
//  small piece of angular physics rather than as an angle you set:
//
//   · a drag is coupled DIRECTLY to the angle (the stick turns exactly as far
//     as your hand moved — anything indirect reads as lag), while a damped
//     estimate of the hand's angular velocity runs alongside it;
//   · letting go hands that estimate to the flywheel, so a flick coasts. With
//     the friction below a hard flick keeps visibly turning for about 1.2 s and
//     lays down roughly four radians of angle on its own;
//   · A/D are a torque, not a rate: they spin UP over about a third of a second
//     to a comfortable cruise and then coast on the same friction when you let
//     go. Same flywheel, same feel, one verb with two inputs;
//   · the stick is very slightly bent, so the marshmallow's tip describes a
//     small circle as it turns, and the circle LAGS with speed like a whipped
//     rod. Together with the off-axis mounting the geometry author gives the
//     marshmallow, that is what makes rotation legible at all: a body of
//     revolution spinning about its own axis is a still image.
//
//  All of it is frame-rate independent — `damp` and explicit `* dt`, never a
//  bare per-frame multiply, which would change the feel with the framerate and
//  make every number in this file a lie on a 144 Hz monitor.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/MathUtils.js';
import { touchCapable } from '../core/verbs.js';
import { picked, pointerRay, rayMiss } from '../core/Pointer.js';
import { buildHeldStick } from './camp_marshmallow.js';
import { ToastMap, marshmallowMaterial, RESULTS } from './marshmallow_toast.js';

// ── the arrival and the departure ───────────────────────────────────────────
//
// Longer than the telescope's 0.55 in both directions, deliberately. Leaning
// into an eyepiece is a small move of the head; this is standing up, walking
// round a fire and sitting down, and a step that size taken in half a second
// reads as a teleport with motion blur. 0.75 s is about the shortest a walk can
// be without becoming a cut.
//
// Out is faster than in for the reason it always is: arriving somewhere should
// feel deliberate, leaving it should feel immediate. Both numbers are also the
// cover for the prop swap — see `_drive`.
const IN_TIME = 0.75;
const OUT_TIME = 0.40;

// ── the seat, the lens, and where the marshmallow is held ───────────────────
//
// One object, because these six numbers are not six decisions — they are one
// composition, and moving any of them without the others is what produced both
// of the frames below. `window.__roast.pose()` writes it, which is how the
// candidates for round 4 were shot rather than argued about.
//
// ── what round 3 got wrong ───────────────────────────────────────────────
//
// Round 3 sat the eye 0.86 m up and 0.86 m out on a 34. The stone ring is
// 0.58 m to the middle of its cobbles (FIRE_RING) and a cobble is ~0.14 m
// across and stands to 0.30, so that camera was INSIDE the ring and below the
// crown of the stones. Every defect in those frames follows from that one
// fact: the near stones read as house-sized boulders because the lens was
// 0.28 m from them, the flame's own silhouette was off the top of the frame so
// the fire read as a vertical light shaft, and there was no ground, no
// treeline and no object of known size anywhere in the picture.
//
// ── the constraint round 3 invented, and where it was wrong ──────────────
//
// Round 2's note said the frame wants three mutually exclusive things —
// (1) a marshmallow big enough to read, (2) the fire behind it, (3) somewhere
// for the frame to BE — and concluded that (3) had to lose. Two of those wants
// are real. The third leg of the argument was not: it assumed the marshmallow
// sits at the FIRE's distance from the lens, which made "big subject" and
// "outside the ring" the same knob pulled in opposite directions, and the only
// exit from that was to walk the camera into the fire.
//
// It is not the same knob, and there are two ways to make the subject big:
//
//   frac = MALLOW_D / (2 tan(fov/2) · d)          MALLOW_D = 0.0468 m, measured
//
// Round 3 shrank `d` to 0.68 m and paid for it with the seat. Narrowing the
// LENS buys the identical frac and costs nothing but angle of view, and angle
// of view is the one thing there was a surplus of: at 0.86 m from a fire, a 34
// sees nothing but fire. So the seat went back out to where a person is and
// the lens took the whole difference.
//
// ── the numbers, and where they came from ────────────────────────────────
//
// Six candidate seats were SHOT, in one browser session, through
// `tools/_scratch/roastpose.mjs` and `window.__roast.pose()` — which is the
// whole reason that pair exists. The winner is the contract's own pose with
// nothing changed but the lens and where the hand holds the stick:
//
//   1.12 m  EYE. `docs/ROAST_CONTRACT.md` §3, unchanged: 0.70 m of seated eye
//           over a 0.42 m camp-chair seat.
//   1.55 m  OUT. The contract's, unchanged. Sanity-checked against the game's
//           own furniture rather than taken on trust: `camp_site.js` puts
//           chairs at 0.30-0.38 of a 5.8 m clearing and the camp in
//           `shots/roast/r3/ROAST.json` has its two at 2.08 m and 2.28 m from
//           the fire, so 1.55 is sitting forward on one of them with your
//           boots at the stones. It is 0.97 m clear of the ring (FIRE_RING
//           0.58), which puts the near cobbles 40 deg below the lens and a
//           clear 8 deg under the bottom edge instead of filling the frame.
//   22 deg  PITCH. The contract's, unchanged.
//   0.24 m  NEAR — how far in front of the fire's axis, toward the player, the
//           marshmallow is held. Reach 1.31 m, drop 0.62 m, so d = 1.45 m.
//   20 deg  LENS, and this is the ONLY number that moved. 0.0468 / (2 tan 10 ·
//           1.45) = 9.1% of frame height: 82 px at 900p, against round 1's
//           2.8% on the same seat with the game's 52. Round 3 bought the same
//           9% by walking the camera to 0.68 m and it cost the entire picture;
//           this buys it out of angle of view, which at a fire is the one
//           thing there was a surplus of.
//   0.126 m RIGHT — lateral, in the camera's own right. 65% across, which is
//           where the marshmallow stops being a white object on the flame's
//           white core and becomes a toasted one against the flame's amber
//           right flank. The first cut of this round had it at 0.084 / 59% and
//           the frames show a subject you cannot find; the same pose at 0.126
//           is the frame this round ships. A pale subject needs a background
//           darker than it is, and on a fire that is a decision about a
//           lateral offset of four centimetres.
//
// ── what the sweep proved you cannot have ────────────────────────────────
//
// Over 1.05-1.30 eye x 1.25-1.95 out x 0.24-0.50 near x 20-36 fov x 6-34 pitch,
// there is NO pose that keeps the marshmallow at 8% or more, the flame's whole
// column in frame, and the top edge of frame within 14 deg of horizontal. Zero
// of ~9 million. The flame is 0.80 m of geometry (camp_fire.js) and from 1.55 m
// it subtends 23 deg on its own, which is more than the whole of a 20 deg lens.
// So the fire grows out of the BOTTOM edge of this frame — its cropped base
// among the stones, its body up the middle, its tip fading below the grass
// line. That is a choice, it is the only one on offer, and it is the right way
// round: a flame cropped at its base still reads as fire, a flame with its tip
// cropped reads as a glow, which is round 3.
//
// ═══ ROUND 5: WHAT THE PLAYER SAW ═══════════════════════════════════════════
//
// Round 4 shipped the pose above and the player who played it said: "I could
// never see the roasting, there was something blocking my view every time,
// looked like a rock of the fire maybe."
//
// ── the hypothesis, and what the measurement said ────────────────────────
//
// The obvious reading is that a cobble is between the lens and the sugar, and
// the arithmetic supports it: `near: 0.24` puts the marshmallow at d = 1.45 m
// while the near ring stones are at 0.97 m, so they are geometrically in front.
// It is wrong, and it is wrong by measurement rather than by argument.
// `tools/_scratch/roastocc.mjs` casts thirteen rays from the lens to the
// marshmallow's silhouette against the real scene and counts what writes depth
// in the way. At the round-4 pose: ZERO, and zero at all 648 candidates of the
// round-5 sweep as well. Nothing is ever in front of it. The near stones are
// 40 degrees below the lens and a clear 8 degrees under the bottom edge,
// exactly as the round-4 note claimed.
//
// That assertion now lives in `state().clear` and is checked on every frame a
// tool takes. It is worth having even though it came back clean: it is the one
// question nobody could answer before, and a frame can now fail on it.
//
// ── what was actually wrong: THREE THINGS, and one of them was a bug ─────
//
// **1. The eye was measured from the wrong datum, and by 18 cm.**
// `_settledPose` wrote `eye.y = fire.y + POSE.eye`, so a number that reads as
// "a seated eye height" was measured from the FIRE'S ORIGIN. The camp floor is
// not the fire's origin and it is not level: at the harness's own camp the
// ground at the seat is 0.18 m ABOVE the fire, so the contract's 1.12 m
// delivered 0.94 m of eye, and on the opposite bearing it would have delivered
// 1.33. The same POSE gave a seat that swung through 0.6 m depending on which
// chair the player clicked. `shots/roast/r4/dusk-held-clean.png` shows it
// plainly: the tent is at the TOP of the frame with its guy lines hanging DOWN,
// because the lens is below the tent's floor. See `_measureSeatY`. Every number
// below is struck against the fixed datum, so they are NOT comparable to the
// ones above them.
//
// **2. Nothing was in front of the marshmallow — sometimes it was sitting ON
// one.** The second measurement is `backdrop`: cast the same thirteen rays PAST
// the subject and classify what they land on. It is seat-dependent, and that is
// the finding rather than a caveat: at three of the eight bearings measured
// below, 13 of 13 land on `fire_stone` — the far half of the ring, which from
// 1.55 m out sits at very nearly the marshmallow's own height in the frame — and
// at the others 13 of 13 land on dirt. A pale 82-pixel disc on a firelit cobble
// of the same value and the same hue is not occluded and is not findable
// either, and "there was a rock" is a completely fair description of it.
// `ladder-2` and `dusk-held-clean` both show the marshmallow's right edge dying
// into a cobble's silhouette.
//
// This one is NOT fully fixed and the note below says where it stands.
//
// **3. The frame had nothing else in it.** A grid of rays through the round-4
// frame classified 70.8% of the bottom half as bare dirt and 26.0% as ring
// stone, with the top edge 12 degrees BELOW horizontal — so no treeline, no
// grass line, no sky, no mid-ground. Rocks and dirt were not merely present,
// they were the entire picture. Worse, at the seats where the camera ended up
// low the stone climbed into the MIDDLE THIRD of the frame and as far as the
// top third: 65% and 17% of those bands at the worst bearing.
//
// ── the sweep, and the one variable round 4 never moved ─────────────────
//
// 648 candidates over eye 1.05-1.25 x out 1.10-1.50 x pitch 22-34 x fov 22-30
// x screen-x 52-64% x height 0.24/0.36, each one measured for occlusion, for
// what is behind the subject, for stone within three radii of it, and for where
// the stones and the flame land in the frame. 25 passed everything.
//
// Round 4's sweep moved the SEAT and nothing else — every candidate it looked
// at put the marshmallow at the same 59% across. That is precisely the variable
// the player's complaint is about: what decides whether there is a rock behind
// the marshmallow is not where you sit, it is WHERE THE SUBJECT IS IN THE
// FRAME. So `right` is solved for a target screen x here rather than guessed,
// and the winner moves it from 65% to 64% across but moves the whole frame up
// underneath it.
//
// ── the numbers ─────────────────────────────────────────────────────────
//
//   1.05 m  EYE, above THE GROUND AT THE SEAT (this is the datum fix; the
//           contract's 1.12 was never delivered as 1.12). Lower than the
//           contract's upright seated eye on purpose: this is a person LEANING
//           FORWARD over a fire with a stick out, which is one posture with the
//           1.30 below and not two independent numbers.
//   1.30 m  OUT, in from 1.55. Boots at the stones — 0.72 m clear of the ring
//           (FIRE_RING 0.58) — and leaning in. It is what puts the near cobbles
//           steeply enough below the lens that a 30-degree pitch drops them
//           under the bottom edge rather than magnifying them.
//   0.456 m AIM, and this replaces PITCH outright. See the block below.
//
//   ~30 deg PITCH, up from 22 — DERIVED now, not authored. This is the one that
//           does the work. It buys
//           three value groups the round-4 frame did not have: the near stones
//           leave through the bottom, the fire's own ring becomes an arc across
//           the bottom third, and the grass line and the dark treeline arrive
//           at the top. Measured: stone is 0% of the top third, 0% of the
//           middle third and 36% of the bottom third, against a round-4 frame
//           with a quarter of its whole lower half in stone and nothing at all
//           above it.
//   24 deg  LENS, out from 20. The round-4 note bought subject size out of
//           angle of view and it was right to, but 20 was past the point of
//           diminishing return: it magnified the ring stones by exactly the
//           same factor, and they are at the same distance. 24 gives back a
//           fifth of the angle of view and the subject stays the same size
//           because the seat came in to pay for it: the harness measures the
//           marshmallow at 83.6 px of 900 on `dusk-held-clean`, 9.3% of frame
//           height, against round 4's 83.1 px / 9.2% on a 20.
//   0.24 m  NEAR — unchanged, and unchanged deliberately. It is the heat
//           model's number, not the composition's; see the note below.
//   0.142 m RIGHT — 64% across, from 65%. Barely moved, and it did not need to:
//           what decides whether the marshmallow is against dirt or against a
//           cobble is where the frame is POINTED, not where the hand is held.
//           See the note by SHAFT_RIGHT for the part of this that is still
//           open.
//
// ── what it costs, stated rather than buried ────────────────────────────
//
// rho — the horizontal distance off the fire's axis, which is what both terms
// of the heat model care about — goes from hypot(0.24, 0.126) = 0.271 to
// hypot(0.24, 0.142) = 0.279. That is 2.8%, and it moves the radiative term by
// 4% and the convective bell by 3%. The cooking curve is the one the
// mini-game's timings were measured against, to within the noise.
//
// The sweep's own best frames were at height 0.36 rather than the resting
// 0.24 — raising the marshmallow is the other way to clear it of the ring —
// and they were rejected for exactly this reason: 0.36 costs 38% of the cook
// rate, which is a retune of the whole mini-game to buy a composition the
// pitch buys for nothing.
//
// ── AND THE REASON THE PLAYER SAID "EVERY TIME" ─────────────────────────
//
// One more thing came out of the round-5 A/B and it is the most important of
// them, because it is the only one that explains the word EVERY TIME rather
// than a single bad frame. The camera LOOKS somewhere, and until now where it
// looked was an absolute angle. An absolute pitch from a seat whose height is
// set by the ground is a composition that swings with the ground:
//
//   `tools/_scratch/roastocc.mjs --ab` sits at eight bearings round ONE camp
//   and measures where the marshmallow lands. The camp floor runs from 0.28 m
//   BELOW the fire's origin on one side to 0.29 m above it on the other — a
//   0.57 m range across one clearing — and under the round-4 pose the
//   marshmallow lands at, in order:
//
//     15%  17%  30%  40%  75%  82%  106%  116%   of frame height
//
//   At two of the eight seats it is entirely BELOW THE BOTTOM EDGE. At two more
//   it is jammed into the top sixth. Same pose, same camp, same marshmallow,
//   and which of the eight you get is decided by which way you happened to be
//   looking when you clicked the stick.
//
// A player who sat on the high side could not see the roasting, would have no
// reason to think it was a fluke, and no way to discover that a different chair
// was a different game. "Every time" is exactly what that feels like.
//
// Fixing the datum (`_measureSeatY`) makes the EYE honest and does not fix this
// at all: the eye is now correct relative to the ground and the marshmallow's
// height is measured from the FIRE, so the drop between them still moves with
// the slope.
//
// So the camera no longer holds an angle, it holds a POINT. `POSE.aim` is a
// height above the fire's own origin, the pitch is whatever it takes to look at
// it from wherever the seat turned out to be, and the composition is therefore
// a property of the fire rather than of the dirt. It is also what a person
// does: you do not hold your neck at 30 degrees, you look at the fire.
//
// 0.456 m is the aim, and it is where 30 degrees of pitch pointed from the seat
// the round was composed at. The pitch that falls out of it ranges from 15 to
// 32 degrees across those eight seats, which is the point: a steeper look from
// the uphill side and a flatter one from the downhill side is what a person
// does, and it is what holds the picture still. Measured across the same eight:
//
//     round 4    15  17  30  40  75  82  106  116     of frame height
//     round 5    56  56  58  59  65  65   67   68
//
// A 101-point swing with two seats off the frame entirely, against a 12-point
// swing with the subject in the middle third at every one of them. Stone in the
// top third of the frame goes from up to 17% to ZERO at all eight, and in the
// middle third from up to 65% to at most 16%.
//
// ── FOR THE LEAD: THIS DEVIATES FROM THE CONTRACT, DELIBERATELY ─────────
//
// `docs/ROAST_CONTRACT.md` §3 lists under "Behaviour, non-negotiable": "Seated
// eye height at the fire's edge — 1.12 m above the ground, 1.55 m out from the
// fire's centre, pitched down about 22 degrees". Round 5 ships 1.05 / 1.30 /
// an aim point, and the reason is not that the contract's numbers were wrong.
//
// It is that they were never delivered. "1.12 m above the ground" is exactly
// right and the code measured it from the FIRE'S ORIGIN for four rounds, which
// on the harness's own camp is anything from 0.28 m below the ground to 0.29 m
// above it. The contract asked for a seated eye and got one anywhere between
// 0.83 m and 1.40 m depending on the bearing. Nothing in the frames could have
// shown that, because a frame shot from one seat looks like a composition
// rather than like a sample.
//
// So: the datum fix is this file honouring §3 for the first time, and the
// 1.05 / 1.30 / aim is a re-composition on top of it, sat forward rather than
// upright. If the lead would rather have the contract's 1.12 and 1.55 literally
// now that the datum is honest, it is three numbers and a capture run — but the
// round-5 frames were shot at 1.05 / 1.30 and those are what there is evidence
// for. The "about 22 degrees" clause is the one that cannot come back as
// written whatever else changes: an absolute pitch is what put the marshmallow
// off the bottom of the frame at two seats in eight.
const POSE = {
  eye: 1.05,
  out: 1.30,
  aim: 0.456,
  fov: 24,
  near: 0.24,
  right: 0.142,
};

// The marshmallow's diameter in the world, as the capture harness measures it
// off the mesh's own bounding sphere (`ROAST.json` → `probe.mallowPx.worldR`).
// Bigger than camp_marshmallow's authored `MALLOW_R` of 0.021 because the mesh
// is a lathe with an off-axis mounting, and it is the measured number every
// framing sum above is struck against — using the authored one puts every
// frac in this file 11% optimistic.
const MALLOW_D = 0.0468;

// The hottest point of the flame, above the fire's own origin.
//
// `camp_fire.js` builds its outer shell 0.80 m tall, but a flame is not hottest
// at its tip — it is hottest just above the fuel, where the volatiles are
// burning off, which is also where its core shell is widest. 0.26 m is that
// point, and it is the datum the height control is measured from, so the
// marshmallow's range of 0.10-0.55 m above it puts it from inside the flame
// tips (0.36 m above the ground: fast, and it will catch) to a comfortable
// 0.81 m above (slow, and safe). Published to the toast map as `fire.top`.
const FLAME_TOP = 0.26;

// ── the height control ──────────────────────────────────────────────────────
//
// The contract's band is 0.10-0.55 m above the flame's hot point. At round 1's
// range that was a 12% sweep of the frame and correctly invisible; at round 2's
// the SAME 0.45 m of travel became a 105% sweep and the one control that is
// supposed to be shown "in the picture and nowhere else" would have been shown
// by the subject leaving the frame at both ends.
//
// 0.12-0.42 was the round-2 answer to that and the lead accepted it, asking for
// a re-derivation if the range moved. It has, twice, and the deviation is now
// closed at the bottom and 0.05 short at the top.
//
// Round 5 moved the frame under this band rather than the band itself: the seat
// came in to 1.30 m and the pitch to 30 degrees, so 0.45 m of arm sweeps a
// LARGER angle than it did from 1.55, and the lens went out to 24 to give some
// of that back. Measured against the shipped pose, with the marshmallow at 9.3%
// of frame height:
//
//   h = 0.10   the contract's floor exactly. Centre at 87.3%, bottom edge at
//              91.4% — whole, in frame, and down among the split logs: the
//              backdrop measures 5 of 13 rays on `fire_wood` and 5 on
//              `fire_stone`, which is what "in the fire" should look like as
//              well as what it should cost.
//   h = 0.24   66.9%. The pose everything above is composed at, the one the
//              harness pins for every judged frame, and the one every heat
//              number in this file and in `marshmallow_toast.js` is struck at.
//   h = 0.50   22.2%, top edge at 17.4%. Held up out of the heat, against the
//              dirt and the grass line rather than against the fire, which is
//              what "high is slow and safe" ought to LOOK like.
//
// Every rung measured with `tools/_scratch/roastocc.mjs --band`, and every rung
// reports `clear` — nothing between the lens and the sugar anywhere in the
// band, which is not something any previous round could say.
//
// A 65-point sweep of the frame across the band, both ends whole and both ends
// clear. The bottom is the contract's number to the centimetre; the top is 0.05 short of its 0.55, and
// that is the only deviation left, for the reason round 4 gave: 0.55 puts the
// subject's top edge into the frame edge, and a control whose extreme is a
// clipped subject is one pose tweak away from being a control whose extreme is
// an absent one.
//
// H_REST is the harness's 0.24 exactly. Round 2 wrote the right argument for
// this ("the shipped default should be the frame that gets judged") and then
// set 0.26; the frame the critic loop looks at is 0.24, so this is 0.24.
//
// ROUND 7 SPLIT THIS IN TWO and the split is the point. H_REST is a
// COMPOSITION datum and nothing else now: the shaft's pivot is measured from it
// (`SHAFT_PIVOT` in `_poseStick`) and every judged frame in `roastshot.mjs`
// pins the height to it, so it is the height this file's whole picture is
// struck at and it does not move. H_START is where a PLAYER's fresh stick
// starts, and it is lower, because a player who has not been told a band exists
// has to be shown one. See section 3 of the ROUND 7 block.
const H_MIN = 0.10;
const H_MAX = 0.50;
const H_REST = 0.24;         // the composition's height: what the harness pins
const H_START = 0.17;        // where a fresh stick starts: in the heat, visibly
const H_PER_PX = 0.00088;    // vertical drag, metres per pixel — ~340 px of full range
const H_PER_SEC = 0.27;      // W/S, metres per second: the full range in ~1.1 s
const H_DAMP = 7.0;          // smoothing on the commanded height; the arm has mass

// ── the twirl ───────────────────────────────────────────────────────────────
//
// TWIRL_PER_PX: a 500 px drag is one full turn. Chosen by the hand rather than
// by the maths — the gesture people make when told to turn a marshmallow is a
// couple of hundred pixels wide and they expect most of a half-turn from it.
//
// TWIRL_FRICTION is the whole coast. It is an exponential rate, so a release at
// v0 lays down exactly v0 / FRICTION more radians and decays to a twentieth of
// its speed in 3 / FRICTION seconds. At 2.2 that is 1.36 s of visible turning
// and ~4.3 rad from a 9.5 rad/s flick: "a flick keeps turning for about a
// second", measured rather than guessed.
//
// TWIRL_ACCEL / TWIRL_CRUISE are the keyboard's half of the same flywheel:
// 26 rad/s² reaches the 9.5 rad/s cruise in 0.37 s, which is a perceptible
// spin-UP rather than an instant rate, and releasing the key drops straight
// into the same coast a mouse flick gets. That shared coast is the reason the
// two inputs read as one verb.
//
// TWIRL_MAX only exists to stop a violent flick strobing the marshmallow's
// blister pattern into a moiré. 26 rad/s is a bit over four turns a second.
const TWIRL_PER_PX = 0.0125;
const TWIRL_FRICTION = 2.2;
const TWIRL_ACCEL = 26;
const TWIRL_CRUISE = 9.5;
const TWIRL_MAX = 26;
const HAND_TRACK = 20;       // damping on the hand-velocity estimate handed to the flywheel

// The stick's bend: how far off its own axis the marshmallow orbits as it
// turns, and how far that orbit lags the rotation per rad/s of spin.
//
// 14 mm at 1.7 m subtends about half a degree — roughly ten pixels at 1080p.
// Small enough to never read as a wobble, large enough that the eye locks onto
// it and knows the stick is turning even when the toast pattern is symmetric.
// The lag is what makes it read as a whittled stick rather than a bent rod: the
// tip trails the hand, and trails it further the faster you go.
const BEND = 0.014;
const BEND_LAG = 0.035;

// A reversal fast enough to count as a shake, and how long two of them may be
// apart and still be the same gesture. Only a forced reversal can trip this:
// the friction is exponential and decays toward zero without ever crossing it,
// so coasting to a stop can never look like a shake.
const SHAKE_SPEED = 7.0;
const SHAKE_WINDOW = 0.70;
const BLOW_COOL = 1.30;      // seconds after a blow-out during which it cannot relight

// ── the marshmallow in frame ────────────────────────────────────────────────
//
// `POSE.right` and `POSE.near` are the offsets from the fire's own axis, in the
// camera's own right and forward, applied to where the marshmallow is held.
// Both are read every frame off POSE so `window.__roast.pose()` can sweep them;
// the two notes that belong with them are here rather than up there because
// they are about HEAT, not about the frame.
//
// NEAR has been 0.24 since round 4 and has not moved since, through two
// complete re-compositions. That is not inertia, it is the point:
// `marshmallow_toast.js` runs a radiative term on 1/r^2 about the flame's hot
// point and a convective plume as a bell of half-width 0.42 m about the fire's
// axis, and the quantity both care about is rho, the horizontal distance off
// that axis — hypot(NEAR, RIGHT). NEAR is the heat model's number and the
// composition is not allowed to spend it.
//
// rho is 0.279 here against round 4's 0.271 and round 3's 0.284: a 2.8% move,
// worth 4% of the radiative term and 3% of the convective one. The composition
// moved a long way in round 5 and the mini-game's timings did not move at all,
// which is the whole reason this paragraph exists.
//
// Which is also the warning: do not push NEAR out to buy frame. Every
// centimetre is real distance from the heat, the toast rate goes as the inverse
// square of it, and the round-5 sweep rejected its own highest-scoring
// candidates for the same reason in the other axis — they cleared the stone
// ring by raising the marshmallow to 0.36 above the flame's hot point, which
// costs 38% of the cook rate to buy a composition the PITCH buys for nothing.
//
// RIGHT is 0.142 and it is a picture number, not a metres number: it is where
// a 1.06 m reach puts the marshmallow at 64% across. It is far enough right to
// clear the flame's blown-out core, which is what a pale subject has to do to
// be seen at all, and near enough left that the marshmallow still OVERLAPS the
// flame column rather than being a marshmallow against a stone with the flame
// next door, which is round 1's defect D.
//
// ── WHAT ROUND 5 LEFT OPEN, AND WHERE ROUND 6 PUT IT ────────────────────
//
// Round 5's note ended here, with the defect named: RIGHT is a CONSTANT and
// the stone ring is not, the far cobbles land where the camp's own `rnd` put
// them, and at three of eight bearings 13 of 13 backdrop rays landed on
// `fire_stone`. It asked for RIGHT to be SOLVED per seat.
//
// It is, and the machinery is the ROUND 6 block below. Two things it found
// belong up here beside the number they correct:
//
//  · RIGHT IS NO LONGER WHAT DECIDES THIS. `POSE.right` and `POSE.near` are
//    the SEED now; `_hold` is what `_poseStick` reads, and it is solved along
//    the arc of constant rho — the one degree of freedom the heat model cannot
//    see. 0.142 is where that arc starts, not where the hand ends up.
//  · THE ROUND-5 MEASUREMENT WAS THE WRONG MEASUREMENT, and it made the defect
//    look bigger than it is. "13 of 13 on `fire_stone`" is a statement about a
//    NAME. Measured in VALUE at the same eight bearings at dusk, those far
//    cobbles sit at 0.05-0.13 of linear luma against a marshmallow at 0.27:
//    a full stop of separation and more, and the frames agree. Seven of the
//    eight bearings needed nothing. The one that did — where the subject
//    overlapped the flame's own plume — went from 0.67 stops of separation to
//    2.28 by moving the hold 3.4 degrees round the arc, which is 22 mm. The
//    full table, and the second one taken after the toast ramp moved 1.7 stops
//    under this file mid-round, are in the ROUND 6 block.
//
// The DAYLIGHT frame round 5 also left open did NOT fall out of this, and the
// measurement now says exactly why rather than guessing. See the DAYLIGHT note
// at the end of the ROUND 6 block.
//
// The brief's one hard rule is unaffected and still has room: measured with
// `tools/_scratch/duskvalue.mjs`, the dusk frame has 0.20 of linear-luma
// headroom between the subject's maximum and the frame's p99.9, against round
// 4's 0.15.

// ═══ ROUND 6: THE BACKDROP, SOLVED PER SEAT ═════════════════════════════════
//
// Round 5 left the note above open and named the defect exactly: at three of
// eight bearings the marshmallow is against a cobble, `right` is a constant and
// the stone ring is not. This is that round.
//
// ── the invariant, which is what makes the fix free ─────────────────────────
//
// The note above says NEAR is the heat model's number and the composition is
// not allowed to spend it. That is right about the QUANTITY and wrong about the
// AXIS, and the difference is the whole of this round. Read
// `marshmallow_toast.js`'s `step`: the radiative term is 1/r^2 about a point on
// the fire's own axis, and the convective bell is `PR2 / (PR2 + rho2)` where
// `rho2 = rx*rx + rz*rz` about that same axis. Neither term knows which
// DIRECTION off the axis the marshmallow is. Both know only rho.
//
// So the pair (NEAR, RIGHT) has two degrees of freedom and the heat model can
// see exactly one of them. The other — the angle round the fire's axis,
//
//    phi = atan2(RIGHT, NEAR),   rho = hypot(NEAR, RIGHT)
//
// — is FREE. Sliding the hold along the constant-rho arc moves the marshmallow
// up to 8 cm laterally across the backdrop and changes the cook rate by nothing
// at all: not by 3%, not by a percent, by nothing, because every input the heat
// model reads is held to the digit. That is a much bigger lateral budget than
// `right` alone had (round 5's rho tolerance of a few percent is worth ±1.5 cm,
// which is a third of a marshmallow) and it costs nothing to spend.
//
// POSE.right and POSE.near are therefore the SEED — where the hand holds it
// when nothing has been measured — and phi0 = 30.6 deg, rho = 0.279 are what
// they mean. `_solveHold` picks the phi for this seat and `_hold` carries it.
//
// ── how a backdrop is scored, and why it is not a list of names ─────────────
//
// The round-5 instrument classified the backdrop by what the ray HIT:
// `fire_stone` bad, `camp_ground` good. That is a blacklist, it is the thing
// `_clearance` deliberately refused to do, and it is wrong in both directions —
// a cobble in the ring's own shadow is a fine backdrop and the flame's white
// core is a terrible one, and neither of those facts is in the name.
//
// What actually makes a pale 80-pixel disc unfindable is that the thing behind
// it is the same VALUE. So the measurement is a value measurement, and it is
// taken the only honest way: by DRAWING THE FRAME. `_probeRender` renders the
// scene from the settled seat into a 320-wide off-screen target twice — once
// with the held stick hidden, which is the backdrop, and once with it shown,
// which is the subject — and `_scoreAt` reads the two back. No tone map is
// applied to a render target, and the engine runs `NoToneMapping` on the canvas
// anyway, so what comes back is LINEAR LUMA: the same quantity
// `tools/_scratch/duskvalue.mjs` judges the dusk rule in, and the same quantity
// the brief's one hard rule is written in.
//
// Per candidate, 65 samples on a polar grid over the subject's own projected
// disc and a ring 1.2 radii out — the disc is what it is seen against, the ring
// is what its outline dies into — each scored as
//
//    sep = | log2( (Ls + e) / (Lbg + e) ) |     stops of value separation
//
// in stops rather than in differences because value perception is a ratio and
// a difference of 0.02 means one thing in the dirt and nothing at all in the
// flame. Ls is the subject's own MEDIAN, measured in the same frame rather than
// assumed, which matters twice over: it tracks the toast ramp a peer is moving
// under this file, and it tracks the hour, so the daylight frame is scored on
// the daylight subject.
//
// ── and it is TWO-SIDED, which the first cut of this round got wrong ───────
//
// The brief for this round said the marshmallow needs "a backdrop darker than
// it is", and the first cut took that literally: any sample not at least
// HOLD_MARGIN stops BELOW the subject counted as lost. The frames say
// otherwise. `dusk-held-clean` has the subject's left flank over the flame's
// plume — deliberately, it is round 1's defect D not to — and the plume there
// is half a stop brighter than a toasted marshmallow. The one-sided rule
// scored a third of that outline lost; the frame reads perfectly well, because
// a light object on a lighter ground is still an edge. So is a CHARRED
// marshmallow, which is four stops darker than the dirt and the most legible
// thing in the sheet, and which the one-sided rule scored as lost at every
// sample.
//
// What actually hides a subject is its backdrop matching its VALUE, in either
// direction, so the test is on the separation and not on its sign. The one
// asymmetry that is real is kept and it is an ABSOLUTE test rather than a
// relative one: a backdrop past HOLD_BLOWN is clipped white — the engine runs
// `NoToneMapping`, so linear 1.0 IS the top of the display — and a pale subject
// in front of a blown highlight is eaten by the bloom whatever the ratio says.
//
// Two numbers come out: `lost`, the fraction of those 65 samples within
// HOLD_MARGIN stops of the subject's own value or sitting on blown white, and
// `margin`, the tenth percentile of the separation — the worst tenth of the
// outline rather than the average of it, because an average is exactly how
// "the right edge dies into a cobble" scores well.
//
// ── and the rule for choosing, which is to move as little as possible ───────
//
// Every candidate that passes the composition gates (whole in frame, 8% of
// frame height or more, inside the lateral band the shaft was authored for) is
// scored. Among those that CLEAR — `lost` at or under HOLD_LOST and `margin` at
// or over HOLD_MARGIN — the winner is the one NEAREST THE SEED, not the one
// with the best score. Round 5 composed this frame at phi0 and the five seats
// in eight that were already against dirt should not move a millimetre to buy a
// number; only the three that were against a cobble should move, and only as
// far as they have to. If nothing clears, the best `margin` wins and
// `state().distinct` goes false and says so, which is the point of publishing
// it.
//
// ── the cost, and where it is paid ─────────────────────────────────────────
//
// Three off-screen renders of the whole scene at 320x180 — the subject at each
// end of the cook and the backdrop once, five when the solve wants to move and
// has to verify it — once, on entry, behind the 0.75 s walk to the seat. (Two
// and three before round 7 added the dark rung; see HOLD_JUDGED_DARK.) The 25
// candidates themselves are free: the stick is posed and
// the marshmallow's real world position read for each, which is 25 matrix
// updates and no draw calls, and every one of them is scored out of the ONE
// backdrop frame. Shadow-map auto-update is off across the probe and
// `renderer.info` is put back exactly as it was found, so a perf capture
// cannot see this happen.
//
// `state()` pays the same two renders when a tool asks for the measurement,
// memoised on the pose — `state()` is only ever called by a tool, and it
// already spends thirteen whole-scene raycasts on `clear`.
const HOLD_PHI_MIN = 10 * Math.PI / 180;
const HOLD_PHI_MAX = 56 * Math.PI / 180;
const HOLD_PHI_STEP = 2 * Math.PI / 180;
// Stops of linear luma the subject's outline has to be SEPARATED from its
// backdrop by, either way — see the two-sided note above. 0.85 is a ratio of
// 1.80: a value step anybody can see, and about half of what the clean
// bearings already deliver against bare dirt.
const HOLD_MARGIN = 0.85;
// A backdrop at or past this is clipped white and the separation test does not
// rescue it: the engine runs `NoToneMapping` (`Engine.js`), so linear 1.0 IS
// the top of the display, and the bloom around anything past it eats a pale
// subject's edge whatever the ratio says. In this frame that is the flame's
// core and nothing else.
const HOLD_BLOWN = 1.0;
// How much of the outline is allowed to fall short of that anyway. Not zero:
// the marshmallow overlaps the flame column by design (defect D, round 1) and
// one sample in twenty landing on something bright is a subject sitting in
// front of a fire rather than a subject nobody can find.
const HOLD_LOST = 0.06;
// ── AND THE DONENESS THE SOLVE IS STRUCK AT ────────────────────────────────
//
// The solve runs on ENTRY, where the marshmallow is RAW and at its brightest,
// and the hold it picks has to hold for the whole cook — it cannot slide
// sideways while the player is watching, and a composition that moved with the
// height control's sibling would be a second control nobody asked for. But the
// subject gets darker as it toasts, so a margin measured raw is the optimistic
// end of the range. Measured, hold pinned, one seat, hour 20.4:
//
//   doneness   0      0.35    0.55    0.80    1.00
//   subject    0.374  0.330   0.265   0.147   0.018    linear luma
//   margin     1.259  1.077   0.766  -0.081  -2.993    stops
//
// The first cut of this round carried that as a CONSTANT — raw to 0.55 cost
// 0.48, 0.48 and 0.49 stops at three seats, so the solve demanded the bar plus
// half a stop while the subject was raw. It was stale inside the hour: the
// toast ramp is a peer's file and it moved under this one mid-round, the drop
// went with it, and the constant silently stopped protecting anything.
//
// So the solve does not model the cook, it PHOTOGRAPHS it: when the map is
// still fresh — which is exactly the entry case, and the only case the game
// ever solves in — it is painted to HOLD_JUDGED for the two probe frames and
// `reset()` afterwards. `RoastView.enter` already resets the map, so reset IS
// the state being restored, to the bit; no snapshot, and no reach into the
// toast author's private arrays. A solve struck on an already-cooked map (a
// tool re-solving mid-cook) uses the doneness it finds.
//
// 0.55 is the doneness every judged frame in `roastshot.mjs` is shot at.
//
// ── ROUND 7: AND AT THE DARK END TOO, BECAUSE ONE RUNG IS NOT THE COOK ─────
//
// The paragraph above is right that the solve cannot model the cook and has to
// photograph it. What round 6 then did was photograph ONE FRAME of it, and a
// peer's finding against that round is the consequence: the hold is struck
// against a golden marshmallow at 0.374-0.265 of linear luma and then has to
// serve one that walks down to 0.018. `ladder-4` is what that costs — subject
// 0.068 against a backdrop of 0.070, `distinct: false`, a frame in which the
// marshmallow is exactly the value of the thing behind it.
//
// The obvious fix is to re-solve as it cooks and it is the wrong one: the hold
// would slide sideways while the player watched, which is a second control
// nobody asked for and a composition that moves under the shot. What is right
// is to keep solving ONCE and to solve against BOTH ENDS OF THE WALK — score
// every candidate twice, against a golden subject and against a nearly-charred
// one, and take the worse of the two.
//
// It costs one more probe render (the subject drawn a second time at
// HOLD_JUDGED_DARK) and it selects against exactly one thing: a backdrop whose
// value lies INSIDE the walk, which is the only kind that can be invisible at
// some doneness and fine at others. The far cobbles at 0.05-0.13 clear both
// ends — 1.56 stops against golden, 2.2 stops against charred — and a fire-lit
// stone at 0.09 clears neither.
//
// 0.88 rather than 1.0: at 1.0 the marshmallow is a cinder that separates from
// everything, so it is not the hard case. The hard case is the shoulder, where
// the subject has come down THROUGH the dirt's own value on its way to black.
const HOLD_JUDGED = 0.55;
const HOLD_JUDGED_DARK = 0.88;
// The lateral band the subject may be solved into, percent of frame width. The
// shaft is authored as a direction that crosses from the subject to the
// bottom-right corner (see SHAFT_RIGHT) and a subject outside this has the
// stick entering the frame beside it rather than under it. Round 5's seed
// lands at 64-66%.
const HOLD_X_MIN = 54;
const HOLD_X_MAX = 74;
// The subject's own value, as a percentile of its disc. The median rather than
// the peak: half the marshmallow faces away from the fire and scoring the
// backdrop against the lit half alone would pass a frame whose shadow side is
// the half that disappears.
const HOLD_SUBJECT_PCT = 0.5;
// The worst tenth of the outline, not the mean of it. See the note above.
const HOLD_MARGIN_PCT = 0.10;
// The off-screen probe. 320x180, so the subject's disc is 16 px across at 9%
// of frame height — 65 samples over rather more than a hundred distinct pixels
// — and small enough
// that two of them are cheaper than the thirteen scene raycasts `_clearance`
// already spends on the same question from the other side.
const PROBE_W = 320;
// Guard against log(0) in a linear-luma frame where the dirt at dusk sits at
// 0.01. Small enough not to flatten the dark end, large enough that a black
// pixel does not score as infinite contrast.
const LUMA_EPS = 0.002;

// ── WHAT IT MEASURED: EIGHT BEARINGS, ONE CAMP, DUSK ───────────────────────
//
// `tools/_scratch/roastback.mjs --hour 20.4`, hold pinned to the round-5
// constant for BEFORE and solved for AFTER, judged at doneness 0.55. Stops of
// value separation at the worst tenth of the outline.
//
// TWO TABLES, and the reason is at the bottom of this block: the toast ramp
// moved under this file while the round was being measured, and it moved the
// subject's own linear luma at doneness 0.55 from 0.27 to 0.085 — 1.7 stops.
// Both tables are real measurements of the same eight seats.
//
//   subject at 0.27 (the ramp this round started against)
//     seat        0     1     2     3     4     5     6     7
//     round 5   0.93  1.34  1.06  0.67  1.16  1.08  1.70  1.18   stops
//     round 6   0.93  1.34  1.06  2.28  1.16  1.08  1.70  1.18
//     lost r5      0     0     0  0.35     0     0  0.05     0
//     lost r6      0     0     0     0     0     0  0.05     0
//     distinct     7 of 8  ->  8 of 8
//
//   subject at 0.085 (the ramp as this round ends)
//     seat        0     1     2     3     4     5     6     7
//     round 5   0.23  0.15  0.42  0.67  0.17  0.09  0.19  0.02   stops
//     round 6   1.39  0.15  0.42  0.85  0.17  0.09  0.88  0.02
//     distinct     0 of 8  ->  2 of 8
//
// The FIRST table is the one that answers round 5's question, and the answer
// is that round 5's pose was already right at seven of its eight seats. What
// its `fire_stone` tally could not tell it is that the far cobbles are DARK —
// 0.05 to 0.13 of linear luma — because the face of them the camera sees is the
// one the fire lights from inside, and at 1.9 m through an inverse square that
// is not much light. The three seats it flagged as ruined were three seats with
// a perfectly good dark backdrop that happened to be made of rock. The eighth
// is the one the metric was worth building for: seat 3 is the steepest seat on
// the slope (pitch 32 deg), its subject lands lowest in the frame, and a third
// of its outline sat on the flame's own plume. Twenty-two millimetres round the
// arc — 3.4 degrees, rho unchanged to four places, subject size 8.44% of frame
// height against 8.43% — takes it from 0.67 stops to 2.28 and from a third of
// the outline lost to none of it.
//
// The SECOND table is what the same machinery does with a marshmallow that has
// become almost exactly the value of the dirt: it finds a hold for three of the
// eight and honestly reports the other five as `distinct: false`. That is the
// solve working — nothing here is baked, it re-runs against whatever the
// material looks like the moment the player sits down — and it is also the
// clearest possible statement that this frame's readability is not the
// composition's alone to fix.
//
// ── THE DAYLIGHT FRAME, WHICH THIS DOES NOT FIX ────────────────────────────
//
// Round 5 asked whether solving the backdrop would also fix `held-clean`, the
// noon frame where a raw marshmallow is a faint ring. It does not, and the
// measurement now says exactly why instead of asserting it.
//
// At hour 12, over the same eight seats: the subject measures 0.40-0.43 of
// linear luma and its backdrop measures 0.15-0.48. The sunlit dirt is the same
// value as a raw marshmallow, to within a tenth of a stop, at six of the eight
// seats — and it is the same value everywhere on the arc, because the arc is
// 16 cm long and the sun lights all of it the same way. Six seats have no
// candidate that clears the bar anywhere; the solve therefore moves nothing at
// those six and reports `distinct: false`, which is the truth about the frame.
//
// Two of the eight DO have shade within reach — seat 3 finds a shadowed cobble
// at 0.15 and goes from -0.58 stops to +1.06, seat 6 finds the tent's own
// shadow — so this is not "the hold can never help at noon", it is "the hold
// can only help where the camp happens to cast a shadow across the arc".
//
// Where the rest of it belongs, in the order it should be tried:
//
//  1. THE TOAST MATERIAL'S RAW END. The subject and the sunlit ground are the
//     same VALUE; what a real marshmallow has that dirt does not is that it is
//     nearly white and nearly neutral, and sunlit dirt is neither. A raw
//     marshmallow that read a third of a stop brighter and a good deal less
//     saturated than the ground would separate at noon without costing the
//     dusk frame anything (the dusk rule is a ceiling — 0.20 of headroom under
//     the frame's p99.9 — and there is room under it). That is
//     `marshmallow_toast.js`'s ramp, not this file's composition, and its
//     author is the one to judge it.
//  2. A DAYLIGHT SEAT. `_chooseSeat` picks the chair nearest the pointer and
//     the header defends that at length. But the machinery to score a seat now
//     exists, and preferring — among the chairs the player might plausibly
//     have meant — the one whose backdrop measures best would be the same idea
//     one level up. It would need its own round and its own frames.
//  3. `POSE.out`. The seat distance is the OTHER heat-free knob: rho is
//     measured from the fire's axis, so moving the seat in or out changes what
//     is behind the subject through parallax without touching the cook at all.
//     It was left alone here because it moves the whole composition round 5
//     tuned, not just the subject.
//
// ── ONE CAVEAT ON EVERY ABSOLUTE NUMBER ABOVE ──────────────────────────────
//
// The toast ramp moved under this file four times while this round was being
// measured — the marshmallow's own linear luma at doneness 0.55 and hour 20.4
// went 0.27, 0.19, 0.17, 0.085 between capture runs, which is 1.7 stops and
// takes a toasted marshmallow from brighter than everything behind it to the
// same value as the dirt. Nothing in this file is baked against that (the
// solve measures the subject every time it runs), but every ABSOLUTE number
// above is a number about a material that was being worked on, and the frames
// in `shots/roast/r6-view` are shot against the last of those four. Re-run
// `roastback.mjs --hour 20.4` once the ramp settles before quoting any of it.

// ═══ ROUND 7: THE PLAYER COULD NOT TELL IT WAS WORKING ══════════════════════
//
// Round 6 shipped and the player who played it said two things:
//
//   "I had no idea I wasn't low enough."
//   "Eat should work no matter what. It only worked after it was a little
//    toasted."
//
// Neither is a simulation bug. The heat model was cooking correctly the whole
// time; the eat gate was doing exactly what the contract asked. Both are the
// same failure at the level of COMMUNICATION: the player did a thing, the game
// changed state, and nothing the player could see or hear changed with it.
//
// ── the design that made it possible, which is still right ──────────────────
//
// "The marshmallow is the readout" is the whole brief of this mini-game and no
// part of this round walks it back. There is still no bar, no timer, no number
// and no chime. But a readout is only a readout on the timescale the reader is
// acting on, and the marshmallow's is MINUTES: browning is an integral, it
// starts from nothing, and the first thirty seconds of it are invisible at
// 82 pixels. The height control acts in ONE SECOND and had nothing at all on
// that timescale. So the mechanic had a slow readout and a fast verb, and the
// player quite reasonably concluded the verb did nothing.
//
// What this round adds is therefore not a second readout for the same quantity.
// It is a readout for the OTHER quantity — not "how cooked is it" (the
// marshmallow, minutes) but "is it in the heat RIGHT NOW" (seconds), which is
// the one the player was actually asking about and the one nothing answered.
//
// ── 1. `heat` WAS NOT LIVE HEAT, AND THAT IS THIS FILE'S BUG ────────────────
//
// The one signal that was supposed to answer it was already wired: `Camp`
// polls this view's `heat` getter every frame and hands it to the fireside
// sizzle (`camp_audio.js`), whose gain and whose band-pass both ride it. The
// getter reads `uGlow`, and `_writeUniforms` was computing
//
//     uGlow = peak * 0.55 + smoothstep(H_MAX, H_MIN, height) * 0.25
//
// `peak` is the map's maximum TOAST — accumulated, monotonic, and nothing at
// all to do with how hot the surface is now. So:
//
//   · at the moment the player is asking the question — raw marshmallow, first
//     ten seconds — `peak` is 0 and the whole signal is the height term, which
//     spans 0.18 at the resting height to 0.25 at the very bottom of the band.
//     A 40% move on a sound mixed at 0.026 against a fire bed at 0.055. That is
//     not a quiet cue, it is nothing;
//   · a minute later `peak` is 0.9 and the sizzle is pinned near full whatever
//     the player does with the stick, so by the time it IS loud it has stopped
//     being about the height at all. `Camp._roastAudio`'s own comment names
//     this exact failure as the reason it does not use `peak` — and `uGlow`
//     was `peak` in a coat.
//
// `marshmallow_toast.js` says the same thing from the other side, twice, in
// notes addressed to this file: "camp_roast_view.js drives `uGlow` from
// `toast.peak`, which is the maximum TOAST, not the live heat — see the
// report. That getter is what still climbs across a ladder." It was right and
// this is the fix.
//
// ── what `heat` is now, and why it is geometry rather than the map ──────────
//
// `_heatNow()`: the fire's reach at the marshmallow, normalised across the
// height band, from the real geometry of where the hand is holding it —
//
//     E(h) = 1 / (rho^2 + h^2)          rho = hypot(hold.near, hold.right)
//     heat = (E(h) - E(H_MAX)) / (E(H_MIN) - E(H_MAX))
//
// an inverse square about the flame's hot point, mapped so the bottom of the
// band is 1 and the top of it is 0. At the shipped rho of 0.279 that is
//
//     h      0.10   0.15   0.17   0.20   0.24   0.30   0.40   0.50
//     heat   1.00   0.83   0.75   0.65   0.52   0.36   0.16   0.00
//
// computed at the shipped rho of 0.279, and spot-checked against the running
// game in `shots/roast/r7-feel/FEEL.json`: 0.758 at h = 0.170, 0.656 at 0.199,
// 0.440 at 0.266, 0.138 at 0.400, 0.000 at 0.500.
//
// Three properties, and each of them is why it is this and not the obvious
// alternative:
//
//  · IT SPANS THE BAND BY CONSTRUCTION. The obvious alternative is
//    `ToastMap.heat` — the map's own `_liveMax`, which is a genuine live-heat
//    channel and is the right quantity in principle. It is `clamp01(h /
//    HEAT_FULL)` on the hottest texel, and a peer is retuning the gains in that
//    expression by a factor of four this week. A signal that saturates at 1
//    across the whole band the moment somebody quadruples RAD_GAIN is a signal
//    that stops being a readout without anybody noticing. This one cannot: it
//    is a ratio of two distances the composition owns.
//  · IT IS ZERO AT THE TOP OF THE BAND. Not a floor, zero. "A player holding it
//    too high should feel the absence" is a design requirement and the absence
//    has to be a real silence, not a quiet hiss. The marshmallow held at 0.50
//    is still receiving heat and still browning very slowly; what it is not
//    doing is anything the player should be able to hear.
//  · IT DOES NOT MOVE WITH DONENESS. Which is what the toast author asked for
//    in the note beside their own `setDoneness`, and what makes `state().glow`
//    flat across a doneness ladder instead of climbing 0.162 -> 0.55. The ember
//    in the cracks is a live-heat effect; a burnt marshmallow lifted out of the
//    fire should go dark, and it does now.
//
// `alight` is 1 outright, and the blow-out cooldown is fed in the same way
// `_stepToast` feeds it — as a dip in the fire's own power — so the sizzle
// falls away when you blow on it, which is the acknowledgement that input
// never had.
//
// ── 2. THE STEAM, WHICH IS THE HALF OF IT YOU CAN SEE ───────────────────────
//
// The sizzle is now honest but it is one sound at 0.026 under a fire the brief
// itself calls "very loud", and a player with the sound off has learned
// nothing. The visible half has to be diegetic, has to work on a RAW
// marshmallow (which is the entire window the complaint is about), and must not
// be a gauge.
//
// It is steam. The first thing that happens to a marshmallow over a fire, long
// before it colours, is that the water in the surface boils out of it — that is
// what the sizzle IS — and a wisp coming off it is the thing a person actually
// looks for. `steamWisp()`, four nested lathes, pale and additive, 0.23 of
// total weight on the axis against the candle flame's 1.37, parented to the
// marshmallow exactly like the flame so that no camera pose any tool can strike
// separates them (see `_dressFlames` for the two rounds that argument cost).
// It rises with `heat` on a `smoothstep(0.22, 0.92, ·)` — nothing at all at the
// top of the band, a definite plume at the bottom — and it goes out when the
// marshmallow catches, because at that point there is a flame there instead.
//
// ── AND IT WAS MEASURED, BECAUSE A PLUME NEXT TO A FIRE IS NOT SELF-EVIDENT ─
//
// `tools/_scratch/roastfeel.mjs` steps the stick down the band on a granted
// clock and reads a 60x90 px box directly above the marshmallow off the drawing
// buffer TWICE per frame — once as drawn, once with the steam taken out of the
// scene graph and the same frame redrawn. The difference is the steam and
// nothing else, which matters because at the bottom of the band the flame
// column is behind that box and a single reading cannot tell them apart.
// Dusk, hour 20.4, linear luma, mean over the box (with steam / without):
//
//   h       0.50    0.40    0.33    0.27    0.20    0.13    0.11    0.10
//   heat    0.00    0.14    0.27    0.44    0.66    0.89    0.98    1.00
//   with   .0921   .0148   .0336   .0597   .1045   .1147   .1254   .1257
//   bare   .0921   .0148   .0336   .0565   .0873   .0585   .0650   .0800
//
// Identical to five decimal places for the whole top half of the band — the
// absence is a real absence — and by the bottom the box is worth 0.126 against
// a bare 0.080 with a peak texel at 0.342 against 0.241. The plume roughly
// doubles the light in that window, and it does it inside a second: `uGlow` is
// damped at 6, so 0.17 s to 63% of a step and half a second to 95%.
//
// Four things it deliberately is not:
//
//  · not a light. Same argument as the candle flame's: a runtime `PointLight`
//    relinks every lit material in the valley.
//  · not in the backdrop measurement. It is a child of the marshmallow, and
//    `_probeRender(true, ·)` hides the held stick, so the backdrop frame the
//    solve scores against has no steam in it at any candidate. The SUBJECT
//    frame does, which is correct — it is part of the subject now.
//  · not over the dusk ceiling. Its brightest texel measures 0.342 of linear
//    luma at the very bottom of the band against a frame p99.9 of 0.86, so it
//    is not the brightest thing in the picture and cannot be what breaks the
//    one hard rule in the brief.
//  · not a balloon. The first cut had the radius profile and the brightness
//    profile peaking together and it photographed as a grey teardrop welded to
//    the sugar. See `steamWisp` for the pairing that fixed it.
//
// ── 3. WHERE THE PLAYER STARTS ─────────────────────────────────────────────
//
// H_REST was 0.24 and a fresh stick started there, which is the middle of the
// band and — before this round — the middle of nothing: no steam, half a
// sizzle, and a minute of waiting before the marshmallow said anything. A
// player who does not know a band exists has no reason to go looking for it.
//
// So `H_START` is 0.17 and it is a separate constant from `H_REST` on purpose.
// H_REST is a COMPOSITION datum — the shaft's pivot is struck against it
// (`SHAFT_PIVOT`, in `_poseStick`) and every judged frame in `roastshot.mjs`
// pins the height to 0.24 explicitly — so moving it would move the shot. What
// moves is only where a PLAYER's marshmallow starts: at 0.17 they open on
// heat 0.75, a plume and an audible hiss, and the first time they touch W the
// plume thins and the hiss drops. That is the control taught in one second,
// where a tip line cannot.
//
// ── 4. AND THE TIP LINE SAYS WHAT THE VERB DOES ────────────────────────────
//
// "W/S height" names an axis. It does not say that the axis is the throttle of
// the entire mechanic, which is the one fact the player needed. It now reads
// "S down into the heat, W up out of it" — the same calm register, and honest
// about which direction is the one that does something.
//
// ── 5. EAT NEVER REFUSES ───────────────────────────────────────────────────
//
// `EAT_MIN` is gone. It was 0.15 and the contract asks for it in §3 ("`E`, or a
// click, when doneness > 0.15"); the lead has ruled the other way on the
// player's own words and this file follows the ruling, which is the same
// deviation-and-say-so this header does for the pose. A raw marshmallow eaten
// straight off the stick plays the full unhurried beat, counts as one roasted,
// grades `pale` from the map's own `grade()`, and gets its own line.
//
// The principle behind it is the one worth keeping: NO INPUT IN THIS VIEW MAY
// SILENTLY DO NOTHING. The audit, so the next author does not have to redo it:
//
//   E / click       eats, always, at any doneness.        no gate
//   drag, A/D       turns it, always.                     no gate
//   W/S, drag-y     moves it, until the band's end — and the end of the band
//                   is now the end of the heat signal in both directions,
//                   which is what makes a clamp read as an end rather than as
//                   a control that stopped working.
//   Space           blows it out. When nothing is alight this is a no-op in
//                   the world as well as in the code — there is no flame on
//                   screen to go out — so it is the one input whose refusal is
//                   already visible, and it gets no line.
//   Escape / Q      leaves, always.
//
// ── 6. AND THE BACKDROP IS SOLVED FOR THE WHOLE COOK ───────────────────────
//
// A peer's finding against round 6, fixed here: the solve was struck at
// HOLD_JUDGED = 0.55 and the hold it picks has to serve the whole cook, but the
// subject's own value walks 8:1 as it browns (0.374 -> 0.018 in the table
// above). A backdrop that separates cleanly from a golden marshmallow can sit
// exactly on top of a charred one, and `ladder-4` is that: subject 0.068,
// behind 0.070, `distinct: false`.
//
// The fix is not to re-solve as it cooks — the hold must not slide sideways
// while the player is watching — it is to score every candidate against BOTH
// ENDS of the walk and take the worse of the two. One extra probe render: the
// subject is drawn a second time at HOLD_JUDGED_DARK, and `lost` and `margin`
// become the worst rung rather than the middle one. What it selects against is
// precisely the backdrop whose value lies INSIDE the walk, which is the only
// kind that can be hidden at some doneness.
//
// ── WHAT IT COST, MEASURED, BECAUSE A STRICTER RULE CAN ONLY LOSE ──────────
//
// Taking the worse of two scores is strictly stricter than taking one, so it
// can only shrink the set of candidates that clear, and the honest question is
// whether it shrinks it to nothing at seats round 6 could fix.
// `tools/_scratch/roastrungs.mjs` asks the solve rather than guessing: it runs
// one real solve per seat and dumps every candidate with its per-rung scores,
// so both rules are counted against the SAME measurement. Eight bearings at two
// hours:
//
//   clears, light rung alone (round 6)   0 1 0 7 0 0 0 0  |  0 1 9 7 11 10 2
//   clears, both rungs (round 7)         0 1 0 7 0 0 0 0  |  0 1 3 7 11  2 2
//   hold chosen — SAME at all sixteen
//
// It narrows the clearing set at two seats and changes the chosen hold at NONE
// of the sixteen, because the rule is "nearest the seed among those that
// clear" and the candidates it removes are never the nearest. So it costs one
// render and nothing else, and it removes holds that would have failed at the
// dark end without anybody being able to see why.
//
// ── AND ONE THING THE MEASUREMENT SAID THAT NOBODY EXPECTED ────────────────
//
// Against the toast ramp as it stands TODAY the dark rung is the EASY one. Seed
// margins over those sixteen seats: 0.02-1.00 stops at HOLD_JUDGED and
// 1.10-2.91 stops at HOLD_JUDGED_DARK. The `ladder-4` collapse this section is
// written against — subject 0.068, behind 0.070 — is not reproducible, because
// the ramp moved about 1.1 stops BRIGHTER at the raw end between that
// measurement and this one (`ladder-0` measured 0.164 in round 6 and 0.343
// now). The hard rung is now the golden one, and at noon it is very hard: a raw
// marshmallow measures 0.356 against sunlit dirt at 0.336, which is 0.08 stops
// apart and is the daylight defect the ROUND 6 block ends by handing to the
// toast material's author. This round leaves it there and hands them a fresh
// number for it.
//
// Both rungs are published — `marginLight`, `marginDark` in `state().backdrop`,
// and `per` / `lostPer` on every candidate `holdCandidates()` returns — so a
// frame that fails can say which end of the cook failed it. They are non-null
// only on a real solve; `state()`'s own live measurement re-scores at whatever
// doneness is actually on the marshmallow, which is the number a judged frame
// should be held to.

// ── how the stick lies across the frame ─────────────────────────────────────
//
// Round 1 struck the aim from a NOMINAL grip — a fixed camera-local point off
// the bottom-right — and slid the real grip back along that line by the stick's
// own length. The idea was right (the composition should not care how long a
// peer builds the stick) and the consequence was fatal at this range: with the
// marshmallow 0.56 m from the lens and the stick 1.15 m from grip to tip, the
// grip lands 0.4 m BEHIND the lens whatever you do, and a nominal grip in front
// of the lens then drags the shaft round to skim the frame's corner — which is
// exactly what the critic saw ("enters at the extreme bottom-right corner and
// simply stops").
//
// So the aim is authored directly, as a camera-local DIRECTION from the grip to
// the marshmallow, and the grip is wherever that direction and the stick's
// length put it. The two angles are the shot:
//
//   RIGHT 32 deg  how far round to the right the shaft runs as it comes back
//                 toward the player. More is a shaft that crosses the frame
//                 laterally and exits the right edge; less is one that comes
//                 almost straight at the lens and is barely visible at all.
//   DOWN  14 deg  how far below the marshmallow the near end of the shaft
//                 hangs, measured in CAMERA space — and camera space is pitched
//                 30 deg down, so 14 deg of camera-down is a fist that ends up
//                 well ABOVE the marshmallow in the world. Which is where a
//                 fist is: you hold the stick out and down at the fire.
//
// Both moved in round 4, and by a lot, because the subject went from 0.68 m
// from the lens to 1.45 m. At round 2's angles the shaft left the frame through
// the bottom edge less than a fifth of the way from tip to fist — a 15 px stub
// in the corner. Round 5 brought the subject back in to 1.28 m and pitched the
// lens 8 degrees further down, and 32/14 survived both without a change: it
// crosses from the marshmallow at (64%, 68%) to the bottom-right corner, a
// third of the way down the stick, where the shaft is thicker. That the angles
// did not need retuning is the point of authoring them as a DIRECTION rather
// than deriving them from a nominal grip — see the paragraph above.
//
// The near end of the stick is in front of the lens and off to the right of the
// frame, and that is not a defect to fix. What reads as "held" is a shaft
// entering the frame edge and tapering away to the subject, not a visible butt
// end.
const SHAFT_RIGHT = 32 * Math.PI / 180;
const SHAFT_DOWN = 14 * Math.PI / 180;

// How much of the height control the shaft's angle absorbs, rather than the
// whole stick sliding up and down parallel to itself.
//
// A real arm pivots at the fist: raise the marshmallow 0.17 m on a 1.15 m stick
// and the shaft tilts by atan(0.17/1.15) = 8.4 degrees while the fist barely
// moves. At 1.0 the near end would be pinned exactly and the wrist would have
// to do all of it; 0.6 is a fist that gives a little, which is what an arm
// does, and it keeps the shaft's screen angle inside a few degrees across the
// whole band so the composition does not swing with the height control.
const SHAFT_PIVOT = 0.6;

// ── THERE IS NO DONENESS FLOOR ON THE EAT ──────────────────────────────────
//
// There was: `EAT_MIN = 0.15`, and `docs/ROAST_CONTRACT.md` §3 still asks for
// it. The player who played round 6 pressed E on a raw marshmallow, nothing
// happened, and nothing said why — "Eat should work no matter what. It only
// worked after it was a little toasted." The lead ruled the gate out entirely
// rather than ruling a refusal message in, and that is the better answer: a
// refusal you have to explain is a rule the game did not need.
//
// So E eats at any doneness including 0.00, plays the whole beat, counts as one
// roasted, and grades through the map's own `grade()` — which already answers
// the bottom of the range with `pale`. The one thing this file adds is the LINE
// for the very bottom, because "barely warmed" is not true of a marshmallow
// that has been nowhere near the fire. See `eat()`.
const RAW_DONE = 0.04;       // below this it has not been warmed, it has been carried
const RAW_LABEL = 'straight out of the bag';

// The two beats. Both are unhurried on purpose: they are the payoff, and a
// payoff that is over before you have read it is not one.
const EAT_TIME = 1.55;
const DROP_TIME = 1.20;

/**
 * The overlay: firelight on the eye, one line of tip, one line of result.
 *
 * Its own DOM element at z-index 38, exactly like the telescope's `Eyepiece`,
 * and for exactly the same three reasons: it is UI, so it must not appear in a
 * `tools/shot.mjs` capture; it must not be graded by the tonemapper; and its
 * gradients must stay smooth at any resolution scale.
 *
 * ── why it is warm and soft rather than dark and hard ──────────────────────
 *
 * A vignette is the cheapest possible "you are inside something" signal and it
 * is nearly always the wrong one. Here the player is not inside anything: they
 * are sitting in the open at night with a fire in front of them, and what that
 * actually does to your eye is LIFT the bottom of your field of view — the
 * light source is below the lens axis and close — while the far corners fall
 * away because your iris has closed down on the fire.
 *
 * So this is two passes and neither of them is black:
 *
 *   · a screen-blended warm lift rising from below the bottom edge, brightest
 *     just off-frame where the fire is. It is doing the job the telescope's
 *     bloom pass does — saying that there is a light source in the room — and
 *     at 0.16 alpha it is a suggestion rather than a filter.
 *   · a corner falloff in a warm near-black (10,6,4 rather than 0,0,0), soft
 *     over a very long ramp and reaching only 0.34 at the very corners. Pure
 *     black at any strength reads as a mask; a warm dark at a third reads as
 *     the dark of a valley at night, which is the thing outside the frame.
 */
class Hearthside {
  constructor() {
    const el = document.createElement('div');
    el.className = 'pa-roast-vig';
    el.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:38',
      'opacity:0', 'transition:opacity .22s ease',
      // The corner falloff. Elliptical and centred a little ABOVE the middle,
      // because the frame's own subject sits a little below it and the darkest
      // part of a vignette must never be where the eye is going.
      'background:radial-gradient(ellipse 96% 92% at 50% 44%,' +
        'rgba(10,6,4,0) 0 46%,' +
        'rgba(10,6,4,0.13) 74%,' +
        'rgba(10,6,4,0.34) 100%)',
    ].join(';');
    document.body.appendChild(el);

    const glow = document.createElement('div');
    glow.className = 'pa-roast-glow';
    glow.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:37',
      'opacity:0', 'transition:opacity .22s ease', 'mix-blend-mode:screen',
      // Centred at 118% down: the source is off the bottom of the frame, which
      // is where the fire actually is relative to the lens.
      'background:radial-gradient(120% 86% at 50% 118%,' +
        'rgba(255,152,64,0.17) 0%,' +
        'rgba(255,120,44,0.075) 34%,' +
        'rgba(255,96,32,0.018) 58%,' +
        'rgba(0,0,0,0) 76%)',
    ].join(';');
    document.body.appendChild(glow);

    // ── the tip line ────────────────────────────────────────────────────────
    //
    // It cannot use `CampPrompt`. This view raises `window.__forceCamera` so the
    // HUD leaves the frame, and `CampPrompt` hides itself under that global with
    // everything else — correct for the HUD, fatal for the one line whose whole
    // job is to say how to get out. Same argument, same solution as the
    // telescope's tip.
    const tip = document.createElement('div');
    tip.className = 'pa-roast-tip';
    tip.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:7.5%', 'transform:translateX(-50%)',
      'pointer-events:none', 'opacity:0', 'transition:opacity .2s ease',
      'font:500 13px/1.35 system-ui,-apple-system,sans-serif', 'letter-spacing:.02em',
      'padding:7px 13px', 'border-radius:8px', 'white-space:nowrap', 'z-index:39',
      'color:#f2e6d6', 'background:rgba(24,14,8,.46)',
      'backdrop-filter:blur(7px)', '-webkit-backdrop-filter:blur(7px)',
      'border:1px solid rgba(255,196,140,.16)',
    ].join(';');
    // Two devices, two honest sentences, and on touch the tip is ITSELF the way
    // out. A modal view entered by tapping a prop, on a device with no Escape
    // key, is a room with no door unless something on screen is the door.
    //
    // ── ROUND 7: THE HEIGHT CLAUSE NAMES THE VERB, NOT THE AXIS ────────────
    //
    // It read "W/S height", which is true and useless. Height is not one of
    // four equal controls, it is the THROTTLE of the whole mechanic — the
    // browning rate at the bottom of the band is multiples of the rate at the
    // top — and the player who played round 6 never found that out. Naming
    // the axis leaves them to discover what the axis is for; naming the heat
    // says it in four extra words and in the same calm register as the rest.
    //
    // Deliberately NOT "lower is faster" or anything else that reads as a
    // number going up: the sentence is about where the marshmallow IS, which is
    // what the player is looking at.
    const touch = touchCapable();
    tip.innerHTML = touch
      ? 'drag to turn it&nbsp; ·&nbsp; drag down into the heat' +
        '&nbsp; ·&nbsp; tap it to eat&nbsp; ·&nbsp; <b>tap here</b> to step back'
      : 'drag or <b>A</b>/<b>D</b> to turn it&nbsp; ·&nbsp; <b>S</b> down into the heat,' +
        ' <b>W</b> up out of it&nbsp; ·&nbsp; <b>E</b> eat&nbsp; ·&nbsp; <b>Esc</b> step back';
    if (touch) {
      tip.style.pointerEvents = 'auto';
      tip.style.cursor = 'pointer';
      tip.addEventListener('click', (e) => { e.stopPropagation(); this.onExit?.(); });
    }
    document.body.appendChild(tip);

    // ── the result line ─────────────────────────────────────────────────────
    //
    // The only score this game shows, and it shows it once, at the end, in
    // words. It sits ABOVE the frame's centre rather than at the bottom with
    // the tip, because at the moment it appears the marshmallow is coming
    // toward the lens and the bottom of the frame is full of stick.
    const res = document.createElement('div');
    res.className = 'pa-roast-result';
    res.style.cssText = [
      'position:fixed', 'left:50%', 'top:26%', 'transform:translate(-50%,-50%)',
      'pointer-events:none', 'opacity:0', 'transition:opacity .3s ease',
      'font:500 20px/1.3 system-ui,-apple-system,sans-serif', 'letter-spacing:.015em',
      'white-space:nowrap', 'z-index:39', 'color:#f6e3c8',
      'text-shadow:0 2px 14px rgba(20,8,2,.85), 0 0 3px rgba(20,8,2,.6)',
    ].join(';');
    document.body.appendChild(res);

    this.el = el; this.glow = glow; this.tip = tip; this.res = res;
    this.onExit = null;
    this._o = -1;
    this._r = -1;
    this._muted = false;
  }

  /**
   * Take the whole overlay out of the frame, or put it back.
   *
   * `visibility` rather than `opacity`, and rather than a flag `set()` reads,
   * for one reason: the capture harness audits every frame for UI by walking
   * `[class^="pa-roast"]` and testing computed `visibility`, `display` and
   * `opacity`. Muting through the same property it inspects means the tool's
   * own assertion is what proves the mute worked — a `setOverlay(false)` that
   * silently did nothing would otherwise turn six "clean" frames into six
   * captioned ones and say so nowhere.
   */
  mute(on) {
    if (this._muted === !!on) return;
    this._muted = !!on;
    const v = on ? 'hidden' : '';
    this.el.style.visibility = v;
    this.glow.style.visibility = v;
    this.tip.style.visibility = v;
    this.res.style.visibility = v;
  }

  /** Overlay opacity, 0..1. Cheap-guarded: this is called every frame. */
  set(o) {
    const v = clamp01(o);
    if (Math.abs(v - this._o) < 0.004) return;
    this._o = v;
    // NOT gated on `__forceCamera` — this view raises that global itself, so
    // gating on it would hide the overlay the instant it opened.
    this.el.style.opacity = String(v);
    this.glow.style.opacity = String(v);
    // The tip arrives behind the glow, once there is something to look at.
    this.tip.style.opacity = String(clamp01((v - 0.55) / 0.45));
  }

  /** The one line of result text. Pass null to clear it. */
  result(text) {
    const v = text ? 1 : 0;
    if (text && this.res.textContent !== text) this.res.textContent = text;
    if (v === this._r) return;
    this._r = v;
    this.res.style.opacity = String(v);
  }

  dispose() { this.el.remove(); this.glow.remove(); this.tip.remove(); this.res.remove(); }
}

/**
 * A small candle flame, for the marshmallow that has caught and for the flare
 * when one falls in the fire.
 *
 * Deliberately NOT a light. Adding a `PointLight` at runtime changes
 * `NUM_POINT_LIGHTS` and relinks every lit material in the valley — measured
 * elsewhere in this camp as most of a second of freeze on the frame it happens
 * (see the light block in `camp_fire.js`) — and there is nothing about a burning
 * marshmallow that needs to light the tent. What it needs is to be visibly on
 * fire and to glow from inside, and the second half of that is `uGlow` on the
 * marshmallow's own material, which the toast author already provides.
 *
 * ── round 3's version, and what was wrong with it ─────────────────────────
 *
 * It was one OPEN cone, `ConeGeometry(0.030, 0.085, 9, 4, true)`, additive and
 * double-sided, placed at the marshmallow's centre plus a radius of camera-local
 * up. `shots/roast/r3/mallow-burning.png` shows the four consequences:
 *
 *  · it FLOATS. The lift was applied along the CAMERA's up, not the world's,
 *    and the camera is pitched down, so the offset ran up and forward. Worse,
 *    the harness's macro framings reparent the held stick to the scene and pose
 *    the camera themselves — the flame stayed a camera child and rode away with
 *    it. `detach()`/`attach()` now take the flames too;
 *  · you can see INTO it. An open cone shows its base ring, and at nine radial
 *    segments that ring is a visible octagon hanging in mid-air. The profile is
 *    now a closed lathe that pinches to zero radius at BOTH ends, so there is
 *    no rim to see and the base is a point that can be buried in the sugar;
 *  · it is HARD-EDGED, because a single additive shell has the same number of
 *    surface crossings down its axis as at its silhouette and therefore no
 *    radial gradient at all. Three nested shells do: six crossings on the axis,
 *    four just outside the core, two at the outer skin. Same trick and the same
 *    reason as the fire's own shell stack in `camp_fire.js`;
 *  · it is TWICE THE SIZE it should be. 85 mm of flame on a 47 mm marshmallow.
 *    A candle flame on one is about 55 mm and 20 mm across, and its base is
 *    smaller than the thing it is burning on.
 *
 * Still deliberately NOT a light: adding a `PointLight` at runtime changes
 * `NUM_POINT_LIGHTS` and relinks every lit material in the valley.
 *
 * ── round 5: a fourth shell, and why the edge was still hard ─────────────
 *
 * Three shells give three steps, and a step is exactly what a critic reading
 * `shots/roast/r4/mallow-burning.png` called hard-edged. The outermost skin was
 * the problem: at its silhouette the accumulated weight jumps from nothing to
 * 2 x 0.09 = 0.18 in one pixel, which is a visible contour on an additive
 * sprite of that brightness. The fix is not fewer steps but a smaller FIRST
 * one — a wide, very faint halo outside the old outer skin, so the ramp starts
 * at 0.07 instead of 0.18 and the eye reads a gradient rather than a rim.
 *
 * The four weights sum, doubled for the double-sided crossings, to 1.37 on the
 * axis — bright enough to clip warm through the tonemapper without going the
 * flat 2.0 white round 3's single shell put down — 0.65 outside the core,
 * 0.25 at the old outer skin and 0.07 at the halo.
 */
const CANDLE_SHELLS = [
  { r: 0.0300, h: 0.070, seg: 11, w: 0.035, tint: [1.00, 0.34, 0.06] },
  { r: 0.0210, h: 0.060, seg: 13, w: 0.09, tint: [1.00, 0.42, 0.10] },
  { r: 0.0135, h: 0.050, seg: 10, w: 0.20, tint: [1.00, 0.62, 0.22] },
  { r: 0.0072, h: 0.038, seg: 8, w: 0.36, tint: [1.00, 0.88, 0.62] },
];

function candleFlame() {
  const geos = [];
  for (const s of CANDLE_SHELLS) {
    // A closed teardrop lathe: zero radius at the fuel, widest a third of the
    // way up, back to a point at the tip. `LatheGeometry` needs the profile in
    // XY with X the radius, and a zero-radius first and last point is what
    // closes both ends without a cap face.
    const N = 9;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const r = s.r * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.62)), 1.25);
      pts.push(new THREE.Vector2(Math.max(r, 1e-5), s.h * u));
    }
    const g = new THREE.LatheGeometry(pts, s.seg);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const u = clamp01(p.getY(i) / s.h);
      // Hot at the fuel, gone by the tip, biased low so the flame has a compact
      // heart rather than being a uniformly glowing cone.
      const k = s.w * Math.pow(1 - u, 1.55);
      col[i * 3] = s.tint[0] * k;
      col[i * 3 + 1] = lerp(s.tint[1] * 0.45, s.tint[1], 1 - u) * k;
      col[i * 3 + 2] = lerp(0.02, s.tint[2], Math.pow(1 - u, 2.2)) * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
  }

  const m = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
  });
  // One group, three meshes, one material: the shells have to be separate draws
  // to nest, and a shared material means one program and one opacity to fade
  // the burst with.
  const grp = new THREE.Group();
  for (const g of geos) {
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    mesh.raycast = () => {};
    grp.add(mesh);
  }
  grp.visible = false;
  grp.userData.flameMat = m;
  // A camera child that is never a click target. See `_attach`.
  grp.raycast = () => {};
  return grp;
}

/**
 * THE STEAM. The visible half of "this thing is in the heat right now".
 *
 * ── why steam and not something else ────────────────────────────────────────
 *
 * The player who played round 6 said "I had no idea I wasn't low enough", and
 * the whole of section 1 of the ROUND 7 block is about why nothing told them.
 * Whatever answers it has to work on a RAW marshmallow — that is the entire
 * window the complaint is about, and browning is invisible in it — and it has
 * to be something a fire actually gives you rather than a gauge painted on the
 * frame.
 *
 * Steam is the honest one. The first thing that happens to a marshmallow held
 * over a fire, well before it colours, is that the water in its surface boils
 * out; that is what the sizzle IS, and the wisp is the same event seen instead
 * of heard. It appears in under a second, it goes away in under a second, and
 * nobody has to be told what it means.
 *
 * ── the shape, and what it borrows from the candle flame ────────────────────
 *
 * The same closed teardrop lathe, for the same three reasons the candle flame's
 * note gives at length: a lathe that pinches to zero radius at both ends has no
 * rim to see, nested shells give a radial gradient that a single additive shell
 * cannot, and a faint wide outer shell keeps the silhouette from stepping.
 *
 * Everything else is different, because steam is not fire:
 *
 *  · TALL AND THIN. 95 mm of plume on a 47 mm marshmallow, 24 mm across at its
 *    widest — a flame is short and fat, a wisp is the other way round.
 *  · IT WIDENS AS IT RISES AND DIMS AS IT WIDENS, and that pairing is the whole
 *    read. The radius profile puts the widest point two thirds of the way up
 *    (the flame's is a third of the way up) while the vertical weight peaks
 *    just above the sugar and is nearly gone by the top, so the plume LEAVES
 *    the marshmallow bright and narrow and dissolves into nothing wide. The
 *    first cut had the two the same way round — widest and brightest together
 *    — and it photographed as a grey balloon on a stick, which is the note the
 *    strip in `shots/roast/r7-feel` was shot to catch.
 *  · FOUR SHELLS AND FIFTEEN SEGMENTS. The candle flame's round-5 note is the
 *    argument and it applies harder here: two shells is two steps and the outer
 *    one is a visible contour, and nine radial segments on something this wide
 *    is a legible nonagon. The outermost shell is a very faint halo so the
 *    silhouette ramp starts at 0.024 rather than at 0.088.
 *  · WARM AT THE BASE, BARELY COOL AT THE TOP. A real plume is lit from below
 *    by the fire and is just water in cold air by the time it is a hand's width
 *    up. The gradient is small — a cold blue-grey wisp in front of a campfire
 *    reads as smoke, and this is not smoke.
 *  · A SIXTH OF THE WEIGHT. 0.23 summed and doubled on the axis, against the
 *    candle flame's 1.37. Measured on the shipped dusk frame (see the ROUND 7
 *    block) it lands at 0.28 of linear luma at its brightest against a subject
 *    maximum of about 0.53 and a frame p99.9 of 0.86, so it is a suggestion
 *    rather than the brightest thing in the picture — which the brief's one
 *    hard rule would forbid.
 */
const STEAM_SHELLS = [
  { r: 0.0240, h: 0.095, seg: 15, w: 0.012, tint: [0.90, 0.90, 0.94] },
  { r: 0.0170, h: 0.090, seg: 15, w: 0.022, tint: [0.94, 0.92, 0.92] },
  { r: 0.0115, h: 0.084, seg: 13, w: 0.032, tint: [0.98, 0.94, 0.90] },
  { r: 0.0070, h: 0.076, seg: 11, w: 0.048, tint: [1.00, 0.96, 0.90] },
];

function steamWisp() {
  const grp = new THREE.Group();
  const m = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
    opacity: 0,
  });
  for (const s of STEAM_SHELLS) {
    const N = 13;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      // `pow(u, 1.35)` inside the sine, against the flame's 0.62: the widest
      // point moves from a third of the way up to nearly two thirds, which is
      // the difference between a teardrop and a plume. Zero radius at both ends
      // still, so the lathe closes with no rim to see.
      const r = s.r * Math.pow(Math.sin(Math.PI * Math.pow(u, 1.35)), 0.70);
      pts.push(new THREE.Vector2(Math.max(r, 1e-5), s.h * u));
    }
    const g = new THREE.LatheGeometry(pts, s.seg);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const u = clamp01(p.getY(i) / s.h);
      // Brightest just above the sugar and nearly gone by the tip. Against the
      // radius profile above — which is doing the opposite — this is what makes
      // it dissolve rather than end.
      const k = s.w * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.55)), 1.5);
      // Warm at the base where the fire lights it, neutral by the top. The
      // gradient is small on purpose; see the note above.
      col[i * 3] = lerp(s.tint[0] * 1.10, s.tint[0] * 0.90, u) * k;
      col[i * 3 + 1] = lerp(s.tint[1] * 0.94, s.tint[1] * 0.94, u) * k;
      col[i * 3 + 2] = lerp(s.tint[2] * 0.74, s.tint[2] * 1.00, u) * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;      // under the candle flame, which is 9
    mesh.raycast = () => {};
    grp.add(mesh);
  }
  grp.visible = false;
  grp.userData.steamMat = m;
  grp.raycast = () => {};
  return grp;
}

/**
 * The view and the mini-game.
 *
 * Owns exactly three things: the held stick (built once, lazily, on first
 * enter), the toast map and the marshmallow's material, and the DOM overlay.
 * Everything else it borrows and gives back — the camera from `CameraRig`, the
 * prop from the camp, `window.__forceCamera` from the HUD.
 *
 * `active` is the only thing the rest of the camp has to read; `subject` is the
 * only thing it has to read to answer "was that MY stick".
 */
export class RoastView {
  constructor(ctx) {
    this.ctx = ctx;
    this.overlay = new Hearthside();
    this.overlay.onExit = () => this.leave();
    this.overlayOn = true;       // `window.__roast.setOverlay` lowers this

    this.prop = null;            // the stick prop on the ground, while holding it
    this.camp = null;            // the camp it belongs to
    this.t = 0;                  // 0 = out, 1 = seated
    this.closing = false;

    // ── the flywheel ──────────────────────────────────────────────────────
    this.spin = 0;               // radians about the stick's own axis
    this.spinVel = 0;            // rad/s
    this.height = H_START;       // commanded height over the flame's hot point
    this.heightCmd = H_START;    // what the input has asked for, before smoothing
    this._handVel = 0;           // damped estimate of the hand's angular rate
    this._prevVel = 0;
    this._flips = 0;             // reversals inside the shake window
    this._flipT = 0;
    // Is a hand ON the stick this frame — mouse OR finger.
    //
    // One flag for both, because the flywheel must not be integrating
    // underneath a hand that is turning the stick directly: the drag would be
    // adding angle while the coast added more, and the object would slide out
    // from under the cursor. While this is up the flywheel MIRRORS the hand
    // instead (so `spinVel` still reads as the true rate, which is what the
    // shake detector needs), and the frame it drops is the flick.
    this._grab = false;

    // ── the mini-game ─────────────────────────────────────────────────────
    this.alight = false;         // the marshmallow itself is burning
    this.cool = 0;               // seconds of blow-out immunity left
    this.slip = 0;               // 0..1 — how far it has melted off the stick
    this.eating = -1;            // seconds into the eat beat, or -1
    this.dropping = -1;          // seconds into the drop beat, or -1
    this.flare = 0;              // 0..1 — the fire's flare when one falls in

    // ── what Stats.js polls ───────────────────────────────────────────────
    //
    // Written here and NOWHERE else. The Stats author polls these off this
    // object from their own loop; this file never calls into Stats, which is
    // the rule the whole stats system is built on. `made` and `perfect` and
    // `time` are the names §4 of the contract asks for; `roasted` is the name
    // the view's own brief asks for. They are the same numbers — see the
    // getters below — because two names for one counter is cheaper than a
    // contract argument in the middle of a build.
    this.result = null;          // the last grade object, or null
    this.roasted = 0;            // monotonic: marshmallows eaten
    this.perfect = 0;            // of those, 'perfect'
    this.burnt = 0;              // graded 'burnt' when eaten, or eaten alight
    this.dropped = 0;            // lost in the fire
    this.time = 0;               // seconds spent at the fire, all sessions

    // ── borrowed camera state ─────────────────────────────────────────────
    this._from = { p: new THREE.Vector3(), q: new THREE.Quaternion(), fov: 52 };
    this._eye = new THREE.Vector3();     // the settled seat
    this._camQ = new THREE.Quaternion(); // the settled orientation
    this._camQi = new THREE.Quaternion();
    this._bearing = 0;                   // fire -> seat, radians
    this._pitch = 0;                     // DERIVED from POSE.aim; see `_settledPose`
    // The height of the GROUND AT THE SEAT, which is the datum `POSE.eye` is
    // measured from. Null until `_chooseSeat` has run. See `_measureSeatY`.
    this._seatY = null;
    // WHERE THE HAND HOLDS IT, solved per seat. `POSE.right`/`POSE.near` are
    // the seed; `_solveHold` slides it along the arc of constant rho until the
    // backdrop is darker than the subject. See the ROUND 6 block above
    // `HOLD_PHI_MIN`. `_holdDirty` is the once-per-seat trigger; `_holdPin` is
    // a tool having said outright where it wants the hold and meaning it.
    this._hold = this._seedHold();
    this._holdDirty = true;
    this._holdPin = false;
    this._holdRec = null;
    this._holdCands = null;
    this._measSig = null;
    this._measRec = null;
    this._probing = false;
    this._took = false;
    this._hadForce = false;
    this._addedCam = false;
    // A harness has taken the held stick out of the hand and into the world.
    // While this is up nothing here poses it. See `detach`.
    this._detached = false;
    // PHOTO MODE holds the frame: the stick is standing in the world, the rig
    // has the camera back, and this view is alive but driving nothing. Distinct
    // from `_detached`, which a harness raises on its own for the macro
    // framings — every hand-off detaches, not every detach is a hand-off. See
    // section 5 of the header, and `handOff`.
    this._handedOff = false;
    // The frame `endHandOff` ran on, so the Escape that closed photo mode is
    // not also read as the Escape that stands you up. See `_readInput`.
    this._photoOutFrame = -99;
    this._fov = POSE.fov;
    // Non-null pins the step-in at that fraction and stops `_drive` advancing
    // it. Only `window.__roast.setT` ever sets it; see the debug surface.
    this._holdT = null;
    // The fire's own falloff, as it was before this view leaned into it. See
    // `_dampHearth`.
    this._fireWas = null;
    // One callback, made once, so `_watchTakeover` can hand the rig the same
    // function object every time without allocating inside a frame.
    this._driveCb = (dt) => this._drive(dt);
    this._frame = 0;      // this view's own frame counter, for the watchdog
    this._droveAt = 0;    // the frame `_drive` last ran on

    // ── the held stick ────────────────────────────────────────────────────
    this.held = null;            // THREE.Group, built lazily, parented to camera
    this.mallow = null;          // its marshmallow mesh
    this.toast = null;           // ToastMap
    this.mat = null;             // marshmallowMaterial
    this.uniforms = null;        // the material's roastUniforms, for convenience
    this.stickLen = 1.0;
    this.mallowR = 0.021;
    this.flame = null;           // the candle flame on a burning marshmallow
    this.burst = null;           // the flare when one goes in the fire
    this.steam = null;           // the wisp off one that is in the heat
    this._mallowHome = new THREE.Vector3();
    this._mallowScale = 1;

    // ── scratch. Nothing in `update`/`_drive` allocates. ──────────────────
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._rgt = new THREE.Vector3();
    this._tgt = new THREE.Vector3();
    this._grip = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._bx = new THREE.Vector3();
    this._by = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._az = new THREE.Vector3(0, 0, 1);   // the twirl axis, never written to
    this._chain = [];                        // reused by `_localDown`
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._qz = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._ray = { o: new THREE.Vector3(), d: new THREE.Vector3() };
    this._fire = { pos: new THREE.Vector3(), top: FLAME_TOP, power: 1 };
    this._clock = 0;             // this view's own seconds, for the drifts
    this._dragging = false;
    this._lastPx = 0;
    this._lastPy = 0;

    this._publishDebug();
  }

  get active() { return !!this.prop; }

  /**
   * The stick currently in hand, or null.
   *
   * `Camp.js` needs this to answer one question: when a camp is struck, was the
   * stick in the player's hand one of ITS props? With several camps in the
   * world that is not the same question as "is anyone roasting", and getting it
   * wrong either leaves the player holding geometry that has been packed away
   * or throws them out of a fire in a camp nobody touched. Named `subject`
   * because that is the name the integration already reads off `ScopeView`.
   */
  get subject() { return this.prop; }

  /** §4 of the contract calls the eaten count `made`. It is `roasted`. */
  get made() { return this.roasted; }

  // ───────────────────────────────────────────────────────────────────────────
  //  Entering and leaving
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Step to the fire and pick the stick up.
   *
   * The pose the camera is at RIGHT NOW is remembered, and the step back returns
   * to it exactly. That is what makes leaving feel like leaving rather than like
   * a cut: the camper has not moved (the player is parked, or this prompt would
   * not have been offered), so the shot they came from is still the right shot
   * to go back to.
   *
   * @param prop THREE.Object3D — the stick prop, carrying `userData.roast`.
   * @param camp the camp it belongs to: `{ x, y, z, fire, props }`.
   */
  enter(prop, camp) {
    if (this.prop === prop && this.prop) return;
    const cam = this.ctx.camera;
    if (!prop) return;

    this.prop = prop;
    this.camp = camp ?? this._campOf(prop);
    this.closing = false;
    this.t = 0;
    this._from.p.copy(cam.position);
    this._from.q.copy(cam.quaternion);
    this._from.fov = cam.fov;
    this._fov = POSE.fov;
    this._holdT = null;

    // The seat, decided BEFORE the camera moves — `_seatBearing` reads the
    // pointer ray, and the pointer ray is only meaningful from the pose the
    // player was actually looking from when they clicked.
    this._chooseSeat();

    // A fresh marshmallow every time. The prop's own `opts.toast` describes how
    // used the stick LOOKS on the ground; what you pick up is always raw,
    // because the alternative is a game that hands you somebody else's burnt
    // marshmallow and offers no way to get a new one.
    this._build();
    this.toast?.reset?.();
    this.spin = 0; this.spinVel = 0; this._handVel = 0; this._prevVel = 0;
    this._flips = 0; this._flipT = 0;
    // The press that CLICKED the stick is very often still down on the frame
    // this runs. Clearing both here means it cannot be mistaken for the start
    // of a drag, which would otherwise hand the flywheel a flick nobody made.
    this._grab = false; this._dragging = false;
    // H_START, not H_REST. A fresh stick starts IN the heat — steaming, hissing
    // — so the first thing the player does with W or S is turn something they
    // can already see off. See section 3 of the ROUND 7 block. A harness that
    // wants the composition's height asks for it (`setHeight(0.24)`), and every
    // judged frame in `roastshot.mjs` does.
    this.height = this.heightCmd = H_START;
    this.alight = false; this.cool = 0; this.slip = 0;
    this.eating = -1; this.dropping = -1; this.flare = 0;
    this._mallowScale = 1;
    this.overlay.result(null);
    if (this.mallow) {
      this.mallow.visible = true;
      this.mallow.scale.setScalar(1);
      this.mallow.position.copy(this._mallowHome);
    }
    if (this.flame) this.flame.visible = false;
    if (this.burst) this.burst.visible = false;
    if (this.steam) this.steam.visible = false;

    this._attach();

    // A fresh seat is a fresh backdrop. The solve itself is deferred to the
    // first `_drive` — it needs the marshmallow built and attached, which is
    // the line above, and it needs the fire's own light to have been written
    // at least once, which happens in `Firepit.update` before this view's
    // `lateUpdate`. See `_solveHold`.
    this._hold = this._seedHold();
    this._holdDirty = true;
    this._holdPin = false;
    this._holdRec = null;
    this._holdCands = null;
    this._measSig = null;
    this._measRec = null;

    // Get the HUD out of the frame.
    //
    // A speedometer, a compass and a keybind bar around a first-person shot of
    // somebody's hands is the loudest possible statement that this is a camera
    // trick. `__forceCamera` is the global every one of those elements already
    // reads — it is what the capture harness raises for the same reason — so
    // this raises it and puts it back on the way out. `CameraRig` checks its
    // takeover BEFORE this global; see the ordering note there.
    this._hadForce = window.__forceCamera;
    window.__forceCamera = true;

    const rig = this.ctx.systems?.cameraRig;
    if (rig?.takeCamera) { rig.takeCamera(this._driveCb); this._took = true; }
    this._droveAt = this._frame;

    // Take the driving controls off the camper.
    //
    // `core/Input.js` maps `KeyW`/`ArrowUp` onto `axes.throttle` and
    // `KeyS`/`ArrowDown` onto the brake, and W/S are this view's height control
    // — the contract's, not a choice made here. So for as long as this view is
    // open the player raising a marshmallow is also flooring the accelerator of
    // a parked camper, and S releases nothing and applies the brake but W
    // releases the park brake outright (`_holdEligible` / `driving` in
    // Vehicle.update).
    //
    // `Vehicle.controlsHeldBy` is the mechanism built for exactly this and its
    // own comment says so: "while held, the pedals and steering are fed to the
    // physics as zeros and the brake hold cannot release — the camper stays
    // parked exactly as it was. Deliberately NOT input.suppressed (the holder
    // needs those same axes)". Boat.js is the other holder. `input.suppressed`
    // would indeed be wrong here: it clears `pressed`, and this view reads
    // Escape, Space and E through `justPressed`.
    //
    // "The holder must clear it unconditionally on exit and in its dispose" —
    // `_release` does, and `dispose` calls `_release`.
    const veh = this.ctx.systems?.vehicle;
    if (veh) veh.controlsHeldBy = 'roast';
  }

  /**
   * Begin the step back. The camera is released when the ease-out finishes.
   *
   * A NO-OP WHILE PHOTO MODE HOLDS THE FRAME, and that guard is not defensive
   * tidiness — it is the load-bearing half of the hand-off. `Camp.update`
   * computes `holding = veh.brakeHold && !photographing` and its not-holding
   * branch calls `roast.leave()` on every frame, deliberately: "the player is
   * only ever doing one of two things — aiming, or not". Composing a photograph
   * of a marshmallow is neither, and without this the view eased itself out
   * from under the free camera 0.4 s after F and released everything. That is
   * the whole of the measured round-13 defect; see section 5 of the header.
   *
   * `force` is the way past it and it exists for one caller that does not use
   * it yet. `Camp._strike` calls `leave()` and then disposes the geometry this
   * view is holding — "never leave the player inside a prop that has been
   * packed away" — and THAT call must not be swallowed. It is not reachable by
   * a player mid-photograph (packing up goes through `_interact`, which Camp
   * does not run while photographing), but `pitchNear` at the camp cap and any
   * harness can reach it. So: `leave(true)` from `Camp._strike`, please. Until
   * then `endHandOff` catches the orphan on the way out rather than putting a
   * disposed stick back in the player's hand — see the check there.
   *
   * @param force ignore the photo-mode hold — the prop itself is going.
   */
  leave(force = false) {
    if (!this.prop || this.closing) return;
    if (this._handedOff) {
      if (!force) return;
      this.endHandOff();
      // `endHandOff` releases outright when it finds the prop already orphaned,
      // and setting `closing` on a released view is how `state().phase` starts
      // lying about an inactive one — the bug `_release`'s own reset was
      // written for.
      if (!this.prop) return;
    }
    this.closing = true;
  }

  /**
   * Hand the composed frame to photo mode, and STAND THE STICK IN THE WORLD.
   *
   * The player's ask is to photograph the marshmallow over the fire, so the
   * marshmallow has to still be there. The old shape of this method released
   * everything — `_detach()` and `prop.visible = true` — and its argument, "a
   * free camera flying up a hillside with a marshmallow welded to the lens is
   * not a photograph", is right about the failure and wrong about the cure. The
   * cure for WELDED TO THE LENS is `detach()`: `Object3D.attach` preserves the
   * world transform, so the stick stops being a camera child without moving a
   * millimetre, and `_detached` then stops `_poseStick` writing over it. The
   * free camera flies; the subject stays.
   *
   * The prop on the table stays hidden, exactly as `ScopeView.handOff` keeps
   * the telescope hidden and for a stronger reason: conceptually the stick is
   * in the player's hand, and a copy of it reappearing on the table while
   * another floats over the fire is the bug this replaces.
   *
   * Three things are given back, and each of them is a gate photo mode's free
   * camera cannot get past on its own:
   *
   *  · the rig's takeover — `CameraRig.lateUpdate` calls it and RETURNS, ahead
   *    of everything including `__forceCamera` (see the ordering note there);
   *  · `window.__forceCamera` — the next check after the takeover, and this
   *    view raises it twice a frame (`_drive`, `_watchTakeover`) to maintain it
   *    as a fact. Left up, free mode never runs and photo mode is a still;
   *  · the camera itself, where it stands. No ease, no restore: `enterFree`
   *    reads the LIVE camera, so the frame the player pressed F on is the frame
   *    they compose from.
   *
   * `_from.fov`, `rig.camPos` — both kept from the old method, both still
   * right. The rig has been returning early at its takeover for as long as this
   * view has been open, so its `camPos` is the pose from before the walk to the
   * fire, and `enterFree` measures the free camera's arm and its depth-of-field
   * plane against that field. The lens goes back to the game's for the reason
   * it always did: this view composes on a 24 (see POSE), and photo mode's
   * framing, its DoF arm and every PNG it writes assume one focal length. Both
   * have to happen BEFORE `enterFree` reads them, which is why `hud_photo.js`
   * calls this on the line above it.
   *
   * @returns the stick prop that is in hand, or null.
   */
  handOff() {
    if (!this.prop) return null;
    if (this._handedOff) return this.prop;
    const cam = this.ctx.camera;
    const rig = this.ctx.systems?.cameraRig;

    // A hand-off during the walk-in finishes the prop swap early. `_drive`
    // hides the held stick until t > 0.52 so the pick-up happens off camera,
    // and a player who pressed F at t = 0.3 would otherwise be handed an empty
    // hand and a stick back on the table — nothing to photograph, which is the
    // exact defect this whole method exists to end. One frame of pop inside a
    // transition the player interrupted is the cheaper of the two.
    if (this.held) this.held.visible = true;
    this.prop.visible = false;

    rig?.camPos?.copy(cam.position);
    if (Math.abs(cam.fov - this._from.fov) > 0.005) {
      cam.fov = this._from.fov;
      cam.updateProjectionMatrix();
    }

    // The fire's falloff goes back to the game's, and it is the same argument
    // as the lens above. `_dampHearth` leans the hearth 38% down and toward an
    // inverse square "while the lens is inside it" — a private grade for a
    // modal first-person view. A free camera can fly sixty metres up a
    // hillside, so it is not inside anything, and a camp photographed under a
    // fire that has been dimmed for a camera that has left is a photograph of a
    // lie. Every other PNG photo mode writes is under the game's own light and
    // this one should be too; the exposure dial on the rail is right there if
    // the player disagrees. `endHandOff`'s `_repose` leans it straight back.
    //
    // It also has to be done HERE rather than left to stop happening. The lean
    // is re-applied every frame against values `Firepit.update` rewrites every
    // frame, so merely ceasing to call it would spring the fire back anyway —
    // one frame later, silently, and with `_fireWas` still holding the numbers
    // it thought it had written.
    this._restoreHearth();

    // Out of the hand and into the world, world transform intact.
    this.detach();
    this._handedOff = true;

    if (this._took && rig?.takeCamera) rig.takeCamera(null);
    this._took = false;
    window.__forceCamera = this._hadForce;
    // `Vehicle.controlsHeldBy` is deliberately NOT released. The camper must
    // stay parked exactly as it was for the whole visit — photo mode's
    // `input.suppressed` stops the axes being read, this stops them being
    // ACTED on, and the two are not the same guarantee. `_release` still owns
    // clearing it.
    return this.prop;
  }

  /**
   * Back to roasting. Photo mode calls this on its way out.
   *
   * Mirrors `ScopeView.endHandOff` in shape — one flag, one restore, idempotent
   * — and does more than it, because more was given away. The telescope handed
   * over a hidden prop; this handed over the camera as well, so this takes the
   * camera back.
   *
   * A CUT, not an ease, and for the reason `CameraRig.exitFree` gives: the
   * player may have flown sixty metres up a hillside, and easing back from
   * there is a long ride through terrain nothing composed. `_repose` puts the
   * camera on the seat and the stick in the hand on the frame this is called,
   * rather than on the next one — photo mode's exit path is already a cut and a
   * single frame of chase camera in the middle of it would be the only thing in
   * the sequence anybody noticed.
   *
   * @returns true if a hand-off was actually ended.
   */
  endHandOff() {
    if (!this._handedOff) return false;
    this._handedOff = false;
    this._photoOutFrame = this._frame;
    // The view was released while the shutter was open. Nothing to come back
    // to; `_release` has already cleaned up.
    if (!this.prop) return false;

    // The CAMP was struck while the shutter was open, and `leave()` was
    // swallowed by the hold above. `Camp._strike` takes each prop out of
    // `camp.root` and disposes its geometry, so a prop with no parent is a
    // corpse: putting it back in the player's hand would hand them a stick
    // whose buffers are gone. Let go instead — the same thing `leave()` would
    // have done, one photograph later. See the `force` note on `leave`.
    if (!this.prop.parent) { this._release(); return false; }

    // Back in the hand at the authored pose — `attach()` re-poses rather than
    // preserving the world transform, which is what makes the return exact
    // instead of merely close.
    this.attach();

    window.__forceCamera = true;
    const rig = this.ctx.systems?.cameraRig;
    if (rig?.takeCamera) { rig.takeCamera(this._driveCb); this._took = true; }
    this._droveAt = this._frame;
    const veh = this.ctx.systems?.vehicle;
    if (veh) veh.controlsHeldBy = 'roast';
    this._repose();
    return true;
  }

  /**
   * Let go of everything, immediately and without an ease.
   *
   * Symmetric with `enter` down to the order: the stick leaves the camera, the
   * camera leaves the scene, the global goes back to whatever it was, the prop
   * on the ground comes back.
   */
  _release() {
    const rig = this.ctx.systems?.cameraRig;
    if (this._took && rig?.takeCamera) rig.takeCamera(null);
    this._took = false;
    window.__forceCamera = this._hadForce;
    // Unconditionally, and only if it is still ours: a holder that clears
    // somebody else's claim is worse than one that leaks its own.
    const veh = this.ctx.systems?.vehicle;
    if (veh && veh.controlsHeldBy === 'roast') veh.controlsHeldBy = null;
    this._restoreHearth();
    // Whatever photo mode was holding, it is not holding it any more. Cleared
    // BEFORE `_detach` so nothing downstream can see a released view that still
    // claims to have a stick standing in the world — the same class of leak the
    // `dropping`/`eating` reset a few lines down was written for. `_detach`
    // removes the stick from whichever parent it has, camera or scene.
    this._handedOff = false;
    this._detach();
    if (this.prop) this.prop.visible = true;
    this.prop = null;
    this.camp = null;
    this.closing = false;
    this.t = 0;
    this._holdT = null;
    // The two beats are cleared HERE as well as at `enter`, and that is not
    // belt-and-braces, it is a bug fix. A view torn down in the middle of the
    // drop beat — which is exactly what happens when a marshmallow left alight
    // melts off the stick — left `dropping >= 0` behind it, so `state().phase`
    // went on reporting `drop` on an inactive view for the rest of the session.
    // A tool reading that state cannot tell a released view from a mid-beat one.
    this.eating = -1;
    this.dropping = -1;
    this.flare = 0;
    this.alight = false;
    this.slip = 0;
    this.overlay.set(0);
    this.overlay.result(null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Building, attaching, detaching
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Build the held stick, the toast map and the marshmallow's material — ONCE,
   * on the first enter, and never again.
   *
   * Lazily rather than in the constructor because `Camp` constructs this view at
   * boot for every session whether or not anybody ever picks a stick up, and the
   * marshmallow is a 32 x 24 lathe with a `DataTexture` and an `onBeforeCompile`
   * material behind it. Once rather than per-enter for the reason the whole camp
   * is built that way: a material created at runtime is a shader program linked
   * at runtime, and a program linked on the frame the player clicks is a freeze
   * on the frame the player clicks (see the note on `fireMaterials` in
   * `camp_fire.js`). Re-entering reuses everything and only resets the numbers.
   */
  _build() {
    if (this.held) return;
    const rnd = this.camp?.rnd ?? Math.random;
    this.held = buildHeldStick(rnd, { rings: 32, bands: 24 });
    this.held.name = 'camp_roast_held';
    const d = this.held.userData?.held ?? {};
    this.mallow = d.mallow ?? null;
    this.stickLen = Number.isFinite(d.len) ? d.len : 1.05;
    this.mallowR = Number.isFinite(d.radius) ? d.radius : 0.021;

    this.toast = new ToastMap({ rings: 24, bands: 12 });

    if (this.mallow) {
      // Swap the placeholder out. The geometry author builds the marshmallow
      // with a plain `MeshStandardMaterial` precisely so this can happen, and
      // the placeholder is disposed here because nothing else will ever hold a
      // reference to it again.
      const old = this.mallow.material;
      this.mat = marshmallowMaterial(this.toast.texture, {});
      this.mallow.material = this.mat;
      if (old && old !== this.mat) old.dispose?.();
      this.uniforms = this.mat.userData?.roastUniforms ?? null;
      this._mallowHome.copy(this.mallow.position);
    }

    // Everything in the hand is exempt from frustum culling and from picking.
    // Culling: a bounding sphere 30 cm from the lens is exactly the case
    // three's conservative test gets wrong, and losing the stick for a frame
    // when you look down is not worth two draw calls of saving. Picking: the
    // camera joins the scene graph while this view is open (see `_attach`), so
    // anything under it would otherwise become a raycast target for every
    // system in the game.
    this.held.traverse((o) => { o.frustumCulled = false; o.raycast = () => {}; });

    this.flame = candleFlame();
    this.burst = candleFlame();
    this.steam = steamWisp();
  }

  /**
   * Put the stick in the hand.
   *
   * The camera joins the scene here and leaves it again in `_detach`, because
   * `WebGLRenderer` traverses the SCENE and a camera that is not in it does not
   * have its children drawn — the single most common way a first-person prop
   * ends up invisible with no error anywhere. Adding it permanently would be
   * worse than the bug: every scene raycast in the game would start finding a
   * marshmallow 40 cm from the lens.
   */
  _attach() {
    const cam = this.ctx.camera;
    if (!this.held) return;
    this._detached = false;
    if (!cam.parent && this.ctx.scene) { this.ctx.scene.add(cam); this._addedCam = true; }
    if (this.held.parent !== cam) cam.add(this.held);
    // The flame goes on the MARSHMALLOW and the flare in the SCENE, because
    // that is what each of them is attached to in the world. See `_dressFlames`
    // for the two rounds of `mallow-burning` that argument is written against.
    if (this.flame && this.mallow && this.flame.parent !== this.mallow) this.mallow.add(this.flame);
    // The steam goes on the marshmallow too, and for the same reason the flame
    // does — it is coming OUT of it — with one extra consequence this file
    // depends on: `_probeRender(true, ·)` hides the held stick, so a child of
    // the marshmallow is out of the BACKDROP frame by construction and cannot
    // contaminate the value measurement the hold is solved against.
    if (this.steam && this.mallow && this.steam.parent !== this.mallow) this.mallow.add(this.steam);
    if (this.burst && this.ctx.scene && this.burst.parent !== this.ctx.scene) {
      this.ctx.scene.add(this.burst);
    }
    this.held.visible = false;   // until the transition has covered the pick-up
  }

  _detach() {
    const cam = this.ctx.camera;
    if (this.held?.parent) this.held.parent.remove(this.held);
    if (this.flame?.parent) this.flame.parent.remove(this.flame);
    if (this.steam?.parent) this.steam.parent.remove(this.steam);
    if (this.burst?.parent) this.burst.parent.remove(this.burst);
    if (this._addedCam && cam.parent === this.ctx.scene) this.ctx.scene.remove(cam);
    this._addedCam = false;
    this._detached = false;
  }

  /**
   * Hand the stick to the world, keeping it exactly where it is on screen.
   *
   * The harness's macro framings shoot the marshmallow filling half the frame,
   * which means moving the camera — and the stick is a CAMERA CHILD, so moving
   * the camera moves the subject and the macro photographs the same forty
   * pixels forever. `roastshot.mjs` has been working round it since round 1
   * with `scene.attach(camera.getObjectByName('camp_roast_held'))`, reaching
   * for a `name` because that was the only public handle. Its own header calls
   * that "careful rather than legitimate" and asks for this pair.
   *
   * `Object3D.attach` rather than `add`, in both directions: it preserves the
   * world transform, so nothing on screen moves on the frame it is called.
   *
   * The FLAMES come too, and that is the whole bug in round 3's
   * `mallow-burning`. The workaround only ever knew about the stick, so on the
   * macro frames the candle flame stayed parented to a camera that then flew
   * somewhere else — which is why it is photographed floating several
   * centimetres off a marshmallow it is supposed to be growing out of.
   *
   * While detached `_poseStick` and `_dressFlames` do nothing, so the caller
   * owns the transform until `attach()`. Everything else keeps working: the
   * toast map reads world matrices, which are still real.
   */
  detach() {
    const dst = this.ctx.scene;
    if (!dst || !this.held || this._detached) return false;
    dst.attach(this.held);
    // The flames are NOT moved. Round 3 moved them here and round 4 shipped
    // that, and it was answering the symptom: the flame is a child of the
    // marshmallow now (see `_dressFlames`), so it comes along with the stick by
    // construction, whether the hoist went through this method or through the
    // harness's own `scene.attach(getObjectByName(...))`. The flare is a scene
    // child at a world point and has nothing to be dragged by.
    this._detached = true;
    return true;
  }

  /** Put it back in the hand, and let this file pose it again. */
  attach() {
    const cam = this.ctx.camera;
    if (!this.held || !this._detached) return false;
    cam.attach(this.held);
    this._detached = false;
    // `attach` preserved a world transform that is about to be wrong; the next
    // pose is what makes it right, and a tool with a stopped engine has no next
    // frame, so take it now.
    this._poseStick();
    this._dressFlames();
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Where the seat is
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Choose the side of the fire to sit on.
   *
   * The contract: "from the fire toward the chair nearest the pointer, so the
   * player ends up sitting where somebody would". Three fallbacks under that,
   * in descending order of how much the player told us:
   *
   *  1. The chair the pointer is most nearly ON. Measured with the same
   *     `rayMiss` fraction-of-radius test Camp uses to choose between click
   *     targets, so "nearest the pointer" means the same thing here as it does
   *     everywhere else in this system.
   *  2. Failing that (no chair under the pointer), the chair nearest to the
   *     camera — the one on the near side of the fire, which is the one the
   *     player can see.
   *  3. Failing that (a camp with no chairs at all, which the layout allows),
   *     straight back toward the camera. Sitting on the side you were already
   *     looking from is never wrong; it is only ever less specific.
   *
   * The stick's own prop is deliberately NOT used as the seat hint. It leans on
   * the table, and the table is not where you sit.
   */
  _chooseSeat() {
    const cam = this.ctx.camera;
    const camp = this.camp;
    const fire = this._firePos(this._v);

    let best = null, bestMiss = 1, nearest = null, nearestD = Infinity;
    const ray = pointerRay(this.ctx.input, cam, this._ray);
    for (const p of camp?.props ?? []) {
      if (p.item?.kind !== 'chair') continue;
      const c = this._v2.set(p.item.x, (p.item.y ?? camp.y) + 0.42, p.item.z);
      // 0.62 m: a little wider than a camp chair, so aiming at the gap between
      // its arm and its seat still counts as aiming at it.
      const miss = rayMiss(ray, c, 0.62);
      if (miss < bestMiss) { bestMiss = miss; best = { x: p.item.x, z: p.item.z }; }
      const d = (p.item.x - cam.position.x) ** 2 + (p.item.z - cam.position.z) ** 2;
      if (d < nearestD) { nearestD = d; nearest = { x: p.item.x, z: p.item.z }; }
    }

    const seat = best ?? nearest;
    if (seat) this._bearing = Math.atan2(seat.x - fire.x, seat.z - fire.z);
    else this._bearing = Math.atan2(cam.position.x - fire.x, cam.position.z - fire.z);
    this._measureSeatY();
  }

  /**
   * The height of the ground AT THE SEAT — the datum `POSE.eye` is measured
   * from, and until round 5 the single largest error in this file.
   *
   * ── the bug ────────────────────────────────────────────────────────────
   *
   * `_settledPose` wrote `eye.y = fire.y + POSE.eye`, i.e. it measured a
   * SEATED EYE HEIGHT from the FIRE'S OWN ORIGIN. Those are two different
   * datums and the gap between them is not small. Measured at the harness's
   * own camp (`tools/_scratch/roastocc.mjs`, hour 20.4): the fire's origin is
   * at y 26.585 and the drawn camp floor 1.55 m out along the chosen bearing
   * is at 26.765. The eye was therefore 0.94 m above the ground the player is
   * sitting on, not the 1.12 m this file's whole composition is written
   * against — and the ground rose 0.02 m under the fire and fell 0.39 m on the
   * opposite bearing, so the error is not even a constant: the same POSE gives
   * a seat that swings through 0.6 m of eye height depending on which chair
   * the player happened to click.
   *
   * The header warns about exactly this and did not notice it was the one
   * making the mistake: "Get the height wrong by 40 cm and the identical camera
   * reads as standing over the fire". It was wrong by 18 cm the other way, and
   * `shots/roast/r4/dusk-held-clean.png` is what that looks like — the tent at
   * the TOP of the frame with its guy lines hanging DOWN into it, because the
   * lens is below the tent's own floor.
   *
   * `CampGround.surfaceAt` is the right query and its own note says why: it is
   * the drawn camp floor, lattice and dirt skin and berm included, rather than
   * the analytic terrain field, which departs from it by centimetres. It is
   * what the dog is placed with. Measured once per seat rather than per frame —
   * the seat does not move, and the 4.5 mm of idle sway is not worth a lattice
   * lookup a frame.
   */
  _measureSeatY() {
    const fire = this._firePos(this._v);
    const b = this._bearing;
    const sx = fire.x + Math.sin(b) * POSE.out;
    const sz = fire.z + Math.cos(b) * POSE.out;
    const g = this.camp?.ground;
    const y = g?.surfaceAt ? g.surfaceAt(sx, sz) : NaN;
    // Falling back to the fire's own origin is the pre-round-5 behaviour, and
    // it is the right fallback: a unit harness with a bare camp record has no
    // ground to ask, and a seat at the fire's own datum is wrong by centimetres
    // rather than absent.
    this._seatY = Number.isFinite(y) ? y : fire.y;
    return this._seatY;
  }

  /** The fire's own centre in world space, written into `out`. */
  _firePos(out) {
    const camp = this.camp;
    const g = camp?.fire?.group?.position;
    if (g && Number.isFinite(g.x)) return out.copy(g);
    if (camp) return out.set(camp.x, camp.y ?? 0, camp.z);
    return out.set(0, 0, 0);
  }

  /**
   * How hard the fire is burning, 0..1.
   *
   * `Camp.fireState(camp)` is the contract's answer and the integrator wrote it
   * for exactly this: it carries the build-in and the fade, and deliberately
   * does NOT carry the flicker, because toast is an integral over seconds and
   * ±13% of noise at 0.3-5 Hz would put jitter into the numbers the mini-game
   * grades on without changing a pixel. Round 1 dug the number out of
   * `camp.fire` itself and got the flicker with it.
   *
   * The fallbacks below it stay, unreached in a whole build, for the case this
   * file is exercised without a Camp system under it — a unit harness, or a
   * scratch tool that constructs a view against a bare camp record. They land on
   * 1 rather than 0 when nothing answers: a marshmallow that never cooks is a
   * broken feature, one that cooks at full strength beside a fire still fading
   * up is a wrong number nobody can see.
   *
   * NOTE for the lead: `fireState` also publishes `top = 0.45` (the middle of
   * the visible flame column) where this view has always used 0.26 (just above
   * the fuel) as both the heat datum and the datum its height band is measured
   * from. Taking 0.45 would move every marshmallow 0.19 m and re-tune the whole
   * cooking curve, which is not a round-2 change to make quietly. The view keeps
   * 0.26 and the discrepancy is in the report.
   */
  _firePower() {
    const camp = this.ctx.systems?.camp;
    if (camp?.fireState) {
      const s = camp.fireState(this.camp, this._fireOut ?? (this._fireOut = {}));
      if (Number.isFinite(s?.power)) return clamp01(s.power);
    }
    const f = this.camp?.fire;
    if (Number.isFinite(f?.power)) return clamp01(f.power);
    if (Number.isFinite(f?.reveal)) return clamp01(f.reveal);
    if (Number.isFinite(this.camp?.raise)) return clamp01(this.camp.raise);
    return 1;
  }

  /**
   * Live heat at the marshmallow, 0..1 — how hard the fire is reaching it RIGHT
   * NOW, not how cooked it is.
   *
   * `Camp._roastAudio` reaches for `heat ?? uniforms.uGlow.value ?? toast.peak`
   * and warns to the console when none of the three answers. Its own comment
   * names this getter as the one it wants and says why the last of the three is
   * a bad signal: `peak` is accumulated toast, so a sizzle riding it would keep
   * hissing after the marshmallow was lifted clear of the flame. This is the
   * same quantity `uGlow` carries, published under its own name and read off the
   * damped uniform so the sizzle inherits the smoothing rather than the
   * texel-level noise underneath it.
   */
  get heat() {
    if (!this.prop) return 0;
    const u = this.uniforms ?? this.mat?.userData?.roastUniforms;
    return clamp01(u?.uGlow?.value ?? 0);
  }

  /**
   * HOW HARD THE FIRE IS REACHING THE MARSHMALLOW, 0..1, RIGHT NOW.
   *
   * The undamped source of `uGlow`, of the sizzle, and of the steam — the one
   * number this round is about. The full argument is section 1 of the ROUND 7
   * block; the three things worth having beside the arithmetic:
   *
   *  · IT IS AN INVERSE SQUARE about the flame's hot point, in the two
   *    quantities the heat model itself reads — rho, the horizontal distance
   *    off the fire's axis, and the height above the hot point. Which is the
   *    same shape `marshmallow_toast.js`'s radiative term has, not by copying
   *    its constants (they are being retuned this week and this must not move
   *    when they do) but because it is the same physics.
   *  · IT IS NORMALISED ACROSS THE BAND, so the bottom of the height control is
   *    exactly 1 and the top exactly 0. That is a deliberate re-scaling of a
   *    real quantity rather than the quantity itself: the marshmallow at H_MAX
   *    is still receiving heat, it is just not receiving any the player should
   *    be able to hear. A signal whose ends are the control's ends is what
   *    makes a clamp read as an end.
   *  · IT READS THE HOLD, not POSE, so a seat whose backdrop solve slid the
   *    hand round the constant-rho arc gets the same heat — which is exactly
   *    the invariant the round-6 solve is built on, holding here too.
   *
   * `height` rather than the marshmallow's measured world position on purpose:
   * `_poseStick` puts the subject at `fire.y + FLAME_TOP + height` by
   * construction, so this is the same number without a matrix, it is right with
   * the engine stopped, and it keeps meaning the CONTROL while a harness has
   * the stick detached and is flying it round the world.
   */
  _heatNow() {
    if (!this.prop) return 0;
    if (this.alight) return 1;
    const hold = this._hold ?? POSE;
    const rho2 = (hold.near ?? POSE.near) ** 2 + (hold.right ?? POSE.right) ** 2;
    const E = (h) => 1 / (rho2 + h * h);
    const lo = E(H_MAX), hi = E(H_MIN);
    const k = hi - lo > 1e-9 ? (E(clamp(this.height, H_MIN, H_MAX)) - lo) / (hi - lo) : 0;
    // The fire's own state, on the same two terms `_stepToast` hands the map:
    // how hard it is burning, and the dip after a blow-out. The second is what
    // makes Space an input with an audible consequence rather than a flag.
    // ...and the arrival, on exactly the curve `_stepToast` delivers heat over,
    // so the hiss and the steam arrive with the view rather than being audible
    // over the walk to the seat.
    const power = this._firePower()
      * smoothstep(0.55, 1.0, this.t)
      * (this.cool > 0 ? lerp(0.25, 1, 1 - this.cool / BLOW_COOL) : 1);
    return clamp01(k) * clamp01(power);
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Input
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Read the player. Called from `Camp.update`, which is where the input is
   * read for everything else in this system.
   *
   * Drag rather than pointer lock, for the same reason `CameraRig._readLook`
   * gives: the rest of this game turns things by dragging, and a modal view that
   * suddenly captures the cursor reads as a different game.
   */
  update(dt) {
    if (!this.prop) return;
    const step = Math.min(dt, 1 / 20);
    this._frame++;

    // ── photo mode holds the frame ──────────────────────────────────────────
    //
    // Watched as a FACT, the same way `_watchTakeover` watches the takeover
    // rather than trusting the intention. `hud_photo.js` calls `handOff` and
    // `endHandOff` directly and that is the path this takes in practice; this
    // is what makes a photo mode that opens or closes without telling us
    // recoverable rather than a soft lock with a stick lying in the grass.
    //
    // Note for anyone tracing this: while photo mode is open `Camp.update` does
    // NOT reach here at all — `holding` is false, so `_interact` never runs —
    // which is exactly why the hand-off cannot be driven from this method and
    // `hud_photo.js` has to make the call. What IS reachable is the frame after
    // it closes, which is the recovery below.
    const photographing = !!this.ctx.systems?.hud?.photo?.active;
    if (photographing && !this._handedOff) this.handOff();
    else if (!photographing && this._handedOff) this.endHandOff();
    if (this._handedOff) { this._photoUpdate(step); return; }

    this.time += step;
    this._watchTakeover();

    this._readInput(step);
    // `_readInput` can end the view outright — photo mode takes the frame, the
    // player drives off, the camp is struck. Nothing below has a stick to act
    // on after that.
    if (!this.prop) return;
    this._sim(step);

    // If nothing took the camera — a rig that is missing, or a harness driving
    // this view with no rig at all — drive it from here. `_drive` is idempotent
    // per frame only in the sense that it must be called exactly once, so this
    // is guarded on the takeover rather than run unconditionally.
    if (!this._took) this._drive(step);
  }

  /**
   * Notice, and undo, the camera being taken back out from under this view.
   *
   * ── the bug ────────────────────────────────────────────────────────────
   *
   * `dusk-held` and `dusk-held-clean` came back as chase-camera frames of the
   * whole camp with the speedometer, the compass and the minimap in them, while
   * the view still reported itself active. The critic's summary is the right
   * one: a view that silently stops owning the camera while still reporting
   * `active` is the worst class of bug this file can have, because every other
   * check downstream is satisfied and only the picture is wrong.
   *
   * ── why once at `enter` is not enough ──────────────────────────────────
   *
   * `CameraRig._takeover` is a single slot and `takeCamera(fn)` overwrites it
   * with no notion of who held it. Boat.js takes it, the telescope takes it,
   * and anything that gives it back gives it back to the RIG rather than to
   * whoever held it before. `window.__forceCamera` is worse: a plain global
   * that this view, photo mode and every capture tool in `tools/` all write.
   * Both were raised once, at `enter`, which states an intention on one frame
   * and then trusts four other systems not to contradict it for the next
   * thousand.
   *
   * So this watches the FACT rather than trusting the intention, and it watches
   * the only fact that matters — did `_drive` actually run. Not "is our callback
   * still in the slot", which would mean reaching into the rig's private field
   * and would still miss a rig that holds the callback and does not call it.
   * Two frames of grace, because `update` runs before `lateUpdate` and the frame
   * the view opens legitimately has no drive behind it yet.
   */
  _watchTakeover() {
    // ...unless this view has GIVEN the camera away on purpose. A watchdog
    // that cannot tell a theft from a hand-off would take the camera back off
    // photo mode two frames after F and re-raise the global that hides the
    // control rail — the fact it watches would still be true and the feature
    // would still be dead. `update` returns before this while `_handedOff` is
    // up; the guard is here as well because this is the method whose entire
    // job is to distrust the caller.
    if (this._handedOff) return;
    if (typeof window !== 'undefined' && window.__forceCamera !== true) {
      window.__forceCamera = true;
    }
    const rig = this.ctx.systems?.cameraRig;
    if (!rig?.takeCamera) return;
    if (this._frame - this._droveAt <= 2) return;
    rig.takeCamera(this._driveCb);
    this._took = true;
    this._droveAt = this._frame;   // one grace period per recovery, not per frame
  }

  _readInput(dt) {
    const { input } = this.ctx;
    const touch = touchCapable();

    // ONE frame of grace after a photo mode closed, and only for the way out.
    //
    // Escape is photo mode's own exit as well as this view's — `hud_photo.js`
    // binds it on the control rail and delegates to `HUD.togglePhoto`. That
    // handler calls `preventDefault` but not `stopPropagation`, and
    // `core/Input.js` listens on `window`, so the very same keypress is still
    // sitting in `pressed` on the frame this view gets the camera back. Without
    // this, Escape out of a photograph also stands the player up from the fire
    // — which is precisely the "you looked up and then went back to it" the
    // hand-off exists to deliver, broken by one key event arriving twice.
    const justBack = this._frame - this._photoOutFrame <= 1;
    if (!justBack && (input.justPressed('Escape') || input.justPressed('KeyQ'))) {
      this.leave();
      return;
    }

    // Driving, or the camp being packed up, ends the view. The integration is
    // supposed to call `leave()` for both — this is the belt to that braces,
    // because the failure mode is the player driving away with a first-person
    // camera stuck at a fire they are no longer at.
    //
    // MEASURED SPEED ONLY, and deliberately not `axes.throttle`. Camp's own
    // gates test the pedal as well as the speed, and copying that here is a
    // trap: `core/Input.js` maps W and S onto throttle and brake, and W and S
    // are this view's height control — so a pedal test would throw the player
    // out of the fire on the first frame they raised the marshmallow.
    //
    // Round 1 flagged the other half of that mapping as something this file
    // could not fix from inside itself — the camper still reading W while this
    // view is open, and W releasing the park brake. It can: `enter` now claims
    // `Vehicle.controlsHeldBy`, which zeroes the pedals at the physics and pins
    // the hold. See the note there.
    //
    // WHAT IS STILL BROKEN, and is not this file's to fix: `Camp.update`'s own
    // roast gate reads `(input.axes.throttle ?? 0) > 0.05` and calls
    // `roast.leave()` on it. `axes.throttle` is 1 whenever W or Up is held, so
    // as it stands the first frame the player raises the marshmallow throws
    // them out of the fire. `controlsHeldBy` cannot help — it stops the camper
    // ACTING on the axis, it does not stop the axis reading 1. That test needs
    // to come out and leave the speed test beside it; it is in the round-2
    // report.
    const veh = this.ctx.systems?.vehicle;
    if (Math.abs(veh?.speed ?? 0) > 1.2 || this.camp?.striking) { this.leave(); return; }
    // Photo mode's hand-off is handled at the top of `update`, before this is
    // ever called — it is a state transition rather than an input, and it has
    // to happen whether or not the player is touching anything. Nothing here.

    // Nothing is listening during the two closing beats. Letting the player
    // twirl a marshmallow that is already in their mouth, or steer one that is
    // falling into the fire, is the kind of detail that makes a beat read as a
    // cutscene the game forgot to lock.
    if (this.eating >= 0 || this.dropping >= 0) { this._grab = false; return; }

    const wasGrab = this._grab;
    this._grab = false;

    // ── the twirl, from the mouse ───────────────────────────────────────────
    //
    // The angle follows the hand EXACTLY — no smoothing between the pixels and
    // the rotation — and a damped estimate of the hand's angular rate runs
    // alongside it purely so that letting go can hand the flywheel something.
    // Smoothing the angle itself is the obvious alternative and it is wrong:
    // it costs a frame or two of lag on a gesture whose entire appeal is that
    // the object is attached to your hand.
    //
    // Sign: the stick's +Z points away from the lens, so a POSITIVE rotation
    // about it reads clockwise from where the player is sitting — which is
    // what dragging right should do. Getting this backwards is not a subtle
    // bug, it is a control that fights you.
    // `t > 0.4` is the settling guard: the click that ENTERED this view must
    // not also twirl it, and the drag that follows must not start until the
    // player can see what they are dragging.
    if (input.mouse.down && this.t > 0.4) {
      const d = input.mouse.dx * TWIRL_PER_PX;
      this.spin += d;
      this._handVel = damp(this._handVel, dt > 1e-5 ? d / dt : 0, HAND_TRACK, dt);
      this.heightCmd = clamp(this.heightCmd - input.mouse.dy * H_PER_PX, H_MIN, H_MAX);
      this._grab = true;
    }

    // The finger drag, read straight off `press` rather than through
    // `mouse.dx/dy`. Those are the look drag and on touch they are deliberately
    // left empty — `CameraRig` orbits with them, so a finger in them turns every
    // gesture into a camera swing (see the note in `core/Input.js`). Nothing
    // else in the game wants a raw finger delta, so this keeps its own: one
    // subtraction against last frame's position.
    const pr = input.press;
    if (pr.down && this.t > 0.4) {
      if (this._dragging) {
        const d = (pr.px - this._lastPx) * TWIRL_PER_PX;
        this.spin += d;
        this._handVel = damp(this._handVel, dt > 1e-5 ? d / dt : 0, HAND_TRACK, dt);
        this.heightCmd = clamp(this.heightCmd - (pr.py - this._lastPy) * H_PER_PX, H_MIN, H_MAX);
        this._grab = true;
      }
      this._dragging = true;
      this._lastPx = pr.px; this._lastPy = pr.py;
    } else {
      this._dragging = false;
    }

    // ── the flick ───────────────────────────────────────────────────────────
    // The one frame the hand comes off. Whatever rate it was turning at becomes
    // the flywheel's, and from here the coast in `_sim` owns it.
    if (wasGrab && !this._grab) {
      this.spinVel = clamp(this._handVel, -TWIRL_MAX, TWIRL_MAX);
      this._handVel = 0;
    }

    // ── the twirl, from the keyboard ────────────────────────────────────────
    //
    // A torque, not a rate. The same flywheel the flick feeds, so the two
    // inputs are one verb: hold A and it winds up over a third of a second,
    // release it and it coasts down on exactly the friction a flick coasts on.
    // A key that set the rate directly would start and stop dead, which is a
    // completely different object in the hand.
    let keyed = false;
    const kL = input.key('KeyA') || input.key('ArrowLeft');
    const kR = input.key('KeyD') || input.key('ArrowRight');
    if (kL !== kR) {
      // D turns it the way dragging right does; A the other way. Same sign
      // convention as the drag above, which is the whole point of them being
      // one verb.
      const s = kR ? 1 : -1;
      // Only accelerate toward the cruise; a key pressed while already spinning
      // faster than cruise (after a flick) neither fights it nor adds to it.
      if (Math.abs(this.spinVel) < TWIRL_CRUISE || Math.sign(this.spinVel) !== s) {
        this.spinVel = clamp(this.spinVel + s * TWIRL_ACCEL * dt, -TWIRL_MAX, TWIRL_MAX);
      }
      keyed = true;
    }

    // ── height, from the keyboard ───────────────────────────────────────────
    if (input.key('KeyW') || input.key('ArrowUp')) {
      this.heightCmd = clamp(this.heightCmd + H_PER_SEC * dt, H_MIN, H_MAX);
    }
    if (input.key('KeyS') || input.key('ArrowDown')) {
      this.heightCmd = clamp(this.heightCmd - H_PER_SEC * dt, H_MIN, H_MAX);
    }

    // ── blow it out ─────────────────────────────────────────────────────────
    // A tap of space. Calm and forgiving: it always works, it never fails, and
    // it costs nothing if the marshmallow was not alight.
    if (input.justPressed('Space')) this.blowOut();

    // ── eat it ──────────────────────────────────────────────────────────────
    //
    // `E`, or a click. On touch the tip line is the way OUT (it has to be —
    // there is no Escape key), so a tap anywhere else is the eat, which is also
    // the gesture a player who tapped the stick to get here already has in
    // their hand.
    const clicked = picked(input) && this.t > 0.4 && !this._grab && !keyed;
    if (input.justPressed('KeyE') || (clicked && (!touch || pr.moved < 12))) this.eat();
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  The simulation
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The whole of what this view does while photo mode holds the frame.
   *
   * ── WHAT IS PAUSED, AND WHY ──────────────────────────────────────────────
   *
   * `_stepToast` and `_sim`. That is the list, and between them they are every
   * accumulator this file has: the toast map, `slip`, `cool`, the eat and drop
   * beats, the twirl flywheel, the arm's damped height and `time`. The player
   * is framing a shot, not roasting. A marshmallow that chars while you pick an
   * angle turns the feature into a fine for using it, and the drop beat firing
   * behind a free camera would end the view mid-photograph with no way to see
   * why.
   *
   * ── WHAT IS NOT ──────────────────────────────────────────────────────────
   *
   * `_writeUniforms` and `_dressFlames`. Those two read state and write
   * appearance; neither integrates anything. So the glow breathes, the ember
   * flicker rides `uTime`, a burning marshmallow keeps its candle flame and the
   * steam wisp keeps curling — all on `_clock`, which is advanced here for
   * exactly that reason and is not a simulation clock.
   *
   * `_poseStick` is absent because the stick is not in the hand: `handOff`
   * detached it into the world and `_detached` is what keeps this file's hands
   * off it. The flames and the steam are children of the MARSHMALLOW (see
   * `_dressFlames`), so they came along by construction and their world maths
   * is unchanged by the reparent.
   *
   * `_dampHearth` is absent because `handOff` gave the fire's falloff back
   * outright — see the note there.
   *
   * ── the clock this runs on, and who actually calls it ────────────────────
   *
   * Stated honestly rather than implied, because it is easy to read this method
   * as the thing that enforces the pause and it is not. In the LIVE path it
   * does not run at all: `Camp.update` computes `holding = brakeHold &&
   * !photographing` and only reaches `roast.update` through `_interact`, which
   * only runs while holding. So while photo mode is open the whole view is
   * simply not stepped, and the fireside animation freezes alongside the
   * campfire, the wildlife and the water — main.js drives every world system at
   * dt 0 under `ctx.worldPaused`. That is the right look: a marshmallow
   * steaming away as the single moving object in a stopped world would read as
   * a bug, not as life.
   *
   * What this method is, then, is the DEFINITION of the pause rather than its
   * only enforcement — the shape `update` and `__roast.step(dt)` both take
   * while `_handedOff` is up, so a harness stepping through a hand-off sees the
   * cook stopped and the animation live, and so a photo mode that ever hands
   * the world back gets a fireside that breathes instead of a freeze-frame.
   */
  _photoUpdate(dt) {
    this._clock += dt;
    this._writeUniforms(dt);
    this._dressFlames();
  }

  /**
   * Integrate the flywheel, the arm, and the mini-game's three states.
   *
   * Split from `_readInput` so `window.__roast.step(dt)` can advance the whole
   * thing with no input at all — which is the entire reason the debug surface is
   * worth having. A harness that has to synthesise drags is a harness that
   * breaks the moment somebody retunes `TWIRL_PER_PX`.
   */
  _sim(dt) {
    this._clock += dt;
    if (this.cool > 0) this.cool = Math.max(0, this.cool - dt);
    if (this._flipT > 0) {
      this._flipT -= dt;
      if (this._flipT <= 0) this._flips = 0;
    }

    // ── the flywheel ────────────────────────────────────────────────────────
    // Exponential friction, so the coast is frame-rate independent and — worth
    // knowing, because the shake detector depends on it — can never cross zero.
    // A marshmallow slowing down under friction is therefore never mistaken for
    // one being shaken.
    if (this._grab) {
      // A hand is on it. The angle has already been written by the drag, so
      // this only publishes the rate — which is what the shake detector below
      // and `state()` both read, and which a drag reversal is measured in.
      this.spinVel = clamp(this._handVel, -TWIRL_MAX, TWIRL_MAX);
    } else {
      this.spin += this.spinVel * dt;
      this.spinVel = damp(this.spinVel, 0, TWIRL_FRICTION, dt);
      if (Math.abs(this.spinVel) < 1e-4) this.spinVel = 0;
    }
    // Keep the angle in a sane range. Unbounded it is fine for a while and then
    // it is a float with no precision left in its low bits, which shows up as
    // the marshmallow's blister pattern quantising after ten minutes.
    if (this.spin > 1e4 || this.spin < -1e4) this.spin %= Math.PI * 2;

    // ── the shake: two forced reversals inside 0.7 s ────────────────────────
    if (this._prevVel * this.spinVel < 0
        && Math.abs(this._prevVel) > SHAKE_SPEED && Math.abs(this.spinVel) > 1.0) {
      this._flips++;
      this._flipT = SHAKE_WINDOW;
      if (this._flips >= 2) { this.blowOut(); this._flips = 0; }
    }
    this._prevVel = this.spinVel;

    // ── the arm ─────────────────────────────────────────────────────────────
    // The commanded height is clamped hard; the held height chases it, because
    // an arm has mass and a marshmallow that snapped between heights would make
    // the one control with a physical analogue the only one without weight.
    this.height = damp(this.height, this.heightCmd, H_DAMP, dt);

    // ── the two beats ───────────────────────────────────────────────────────
    if (this.eating >= 0) {
      this.eating += dt;
      if (this.eating >= EAT_TIME) { this.eating = -1; this.leave(); }
      return;
    }
    if (this.dropping >= 0) {
      this.dropping += dt;
      this.flare = Math.max(0, 1 - this.dropping / 0.8);
      if (this.dropping >= DROP_TIME) { this.dropping = -1; this.leave(); }
      return;
    }

    // ── fire ────────────────────────────────────────────────────────────────
    //
    // The toast map owns whether a texel has passed ignition; this owns whether
    // the marshmallow is ALIGHT, which is a different and longer-lived fact. A
    // flame that went out the instant the hottest texel dropped back under the
    // threshold would be a strobe, and there would be nothing to blow out.
    //
    // The runaway is not a special case in the heat model — see `_stepToast`.
    const lit = this.toast?.burning ?? ((this.toast?.peak ?? 0) > 0.94);
    if (lit && !this.alight && this.cool <= 0) this.alight = true;

    // ── the melt, and the joke at the end of it ─────────────────────────────
    //
    // A marshmallow that is cooked far past done stops being a solid. It slides
    // off the stick, and it slides off FASTER the more level the stick is held
    // and the slower it is turning — which is exactly the behaviour that makes
    // the save skilful without ever being explained: the thing you do to save
    // it is the thing the whole mini-game is about.
    //
    // `slip` is a fraction rather than a timer so it can be shown in the
    // material (`uSag`) as the marshmallow visibly stretching before it goes.
    const done = this.toast?.doneness ?? 0;
    const melt = smoothstep(0.72, 0.97, done) + (this.alight ? 0.45 : 0);
    if (melt > 0) {
      // How level the stick is, 0 (steeply raised) .. 1 (level or tip-down).
      // At the low end of the height range the stick points slightly down at
      // the fire, which is the worst place to have a molten marshmallow.
      const level = clamp01(1 - (this.height - H_MIN) / (H_MAX - H_MIN) * 0.75);
      // Turning it holds it on. A comfortable cruise removes about two thirds
      // of the slip rate; standing still removes none.
      const spun = 1 - 0.68 * clamp01(Math.abs(this.spinVel) / TWIRL_CRUISE);
      this.slip = clamp01(this.slip + dt * melt * level * spun * 0.5);
      if (this.slip >= 1) this.drop();
    } else {
      // It cools and firms back up if you rescue it — slowly, because sugar
      // does not un-melt quickly and because a slip that reset instantly would
      // make the whole mechanic toothless.
      this.slip = Math.max(0, this.slip - dt * 0.12);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Actions
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Blow it out. Space, or a shake.
   *
   * The toast map has no extinguish in its contract and does not need one: what
   * "alight" costs the player is the runaway heat this view feeds it while the
   * flag is up (see `_stepToast`), so dropping the flag IS putting it out. The
   * cooldown is what stops it relighting on the same frame from live heat that
   * has not decayed yet — 1.3 s, which is about how long a real one smoulders
   * after you blow on it, and long enough to get it out of the flame if you
   * meant to.
   *
   * The optional call into the map is for a peer who does add an extinguish; it
   * is additive and this works without it.
   */
  blowOut() {
    if (!this.alight) return;
    this.alight = false;
    this.cool = BLOW_COOL;
    this.toast?.extinguish?.();
  }

  /**
   * Eat it. `E`, or a click. ALWAYS — there is no doneness floor.
   *
   * The grade is taken HERE, at the moment of the bite, and the counters move
   * with it — not at the end of the beat. Two reasons: it is the honest moment
   * (what you ate is what it was when you ate it), and it means a view torn
   * down mid-beat by a camp being struck still counts the marshmallow the
   * player has already eaten.
   *
   * ── the raw end, which is reachable now and was not ────────────────────
   *
   * `grade()` already answers it: below 0.18 doneness the key is `pale`, whose
   * label is "barely warmed". That is right for a marshmallow that spent
   * fifteen seconds high over the fire and wrong for one that went straight
   * from the stick to the player's mouth, and with the floor gone the second is
   * one keypress away from every session. So the KEY is the map's — it is what
   * the leaderboard ranks and what `Stats.js` reads — and only the displayed
   * LABEL is overridden under RAW_DONE.
   *
   * A `raw` entry in `RESULTS` would be the tidier home for this, and RESULTS
   * is `marshmallow_toast.js`'s to own; it is in the report as a question for
   * its author rather than as an edit to their file.
   */
  eat() {
    if (this.eating >= 0 || this.dropping >= 0 || !this.prop) return;
    const done = this.toast?.doneness ?? 0;

    const g = this.toast?.grade?.() ?? null;
    const key = g?.key ?? 'pale';
    const label = done < RAW_DONE && !this.alight
      ? RAW_LABEL
      : g?.label ?? RESULTS.find((r) => r.key === key)?.label ?? 'toasted';
    this.result = { key, label, doneness: done, evenness: this.toast?.evenness ?? 0 };
    this.roasted++;
    if (key === 'perfect') this.perfect++;
    if (key === 'burnt' || this.alight) this.burnt++;
    this.alight = false;
    this.eating = 0;
    this.overlay.result(label);
  }

  /**
   * It slides off and goes in the fire.
   *
   * A joke, not a punishment: nothing is lost, nothing is scored against you,
   * and the only cost is that you go and get another stick. The counter exists
   * because the stats page is a logbook of things that happened, and this
   * happening is funnier than it is bad.
   */
  drop() {
    if (this.dropping >= 0 || this.eating >= 0) return;
    this.dropped++;
    this.result = { key: 'dropped', label: 'straight in the fire', doneness: this.toast?.doneness ?? 0, evenness: 0 };
    this.alight = false;
    this.dropping = 0;
    this.flare = 1;
    this.overlay.result('straight in the fire');
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Posing — runs inside CameraRig.lateUpdate
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Pose the camera, pose the stick, step the heat, dress the overlay.
   *
   * Runs after every system has had its say, which is the only place a camera
   * pose survives the frame. The ORDER inside it is load-bearing and is the
   * reason it is one method rather than four:
   *
   *   camera -> stick -> updateMatrixWorld -> toast -> uniforms -> overlay
   *
   * The toast map reads the marshmallow's world matrix to know which texel
   * faces the fire, so it has to run after the matrices are current and the
   * matrices are only current after both poses. Stepping it in `update` instead
   * — which is the obvious place — cooks the marshmallow against LAST frame's
   * orientation, and the visible symptom is a toast pattern that lags the spin
   * by exactly one frame and therefore smears at high spin rates.
   */
  _drive(dt) {
    if (!this.prop) return;
    // The rig's takeover was handed back at `handOff`, so this should not be
    // reachable while photo mode holds the frame — but the takeover is a single
    // slot with no ownership discipline (see `_watchTakeover`) and one stale
    // callback would re-raise `__forceCamera`, re-pose the camera onto the seat
    // and walk `t` while the player was composing sixty metres away.
    if (this._handedOff) return;
    const cam = this.ctx.camera;
    const step = Math.min(dt, 1 / 20);

    // Re-assert the takeover, every frame.
    //
    // This is round 2's answer to the worst bug in the file: `dusk-held` came
    // back a chase-camera frame of the whole camp with the speedometer and the
    // minimap in it, while `state()` still said the view was live. A view that
    // silently stops owning the camera is worse than one that crashes, because
    // nothing downstream can tell.
    //
    // `window.__forceCamera` is a global with no ownership discipline — a
    // capture tool, photo mode and this view all write it — and `takeCamera` is
    // a single slot that any later caller overwrites. Raising both once at
    // `enter` therefore states an intention rather than maintaining a fact. Two
    // assignments a frame maintain the fact, and neither costs anything.
    if (window.__forceCamera !== true) window.__forceCamera = true;
    this._droveAt = this._frame;

    // ── the transition ──────────────────────────────────────────────────────
    //
    // `_holdT` pins it where a harness put it. Without that a tool cannot
    // photograph the arrival at all: it sets t to 0.4, the next frame runs, and
    // `t` is back on its way to 1 before the shutter opens.
    if (this._holdT != null && !this.closing) this.t = clamp01(this._holdT);
    else {
      this.t = this.closing
        ? this.t - step / OUT_TIME
        : Math.min(1, this.t + step / IN_TIME);
    }
    if (this.closing && this.t <= 0) {
      cam.position.copy(this._from.p);
      cam.quaternion.copy(this._from.q);
      if (Math.abs(cam.fov - this._from.fov) > 0.005) {
        cam.fov = this._from.fov;
        cam.updateProjectionMatrix();
      }
      this._release();
      return;
    }

    // Ease both ways and ease the ARRIVAL harder than the departure: a move
    // that decelerates into its target reads as somebody walking over and
    // sitting down, where a linear one reads as a camera on rails. Smoothstep
    // twice — the same `soft` the telescope uses, and the hard decelerate the
    // contract asks for.
    const e = smoothstep(0, 1, clamp01(this.t));
    const soft = e * e * (3 - 2 * e);

    this._settledPose();

    cam.position.lerpVectors(this._from.p, this._eye, soft);
    cam.quaternion.copy(this._from.q).slerp(this._camQ, soft);
    // The lens narrows to POSE.fov on the same curve as the walk, so it is part
    // of the arrival rather than a zoom. See the note on POSE.
    const fov = lerp(this._from.fov, this._fov, soft);
    if (Math.abs(cam.fov - fov) > 0.005) { cam.fov = fov; cam.updateProjectionMatrix(); }

    // ── the prop swap, under cover of the move ──────────────────────────────
    //
    // The stick on the ground goes away and the stick in the hand appears, and
    // the player never sees either happen because the overlay is already most
    // of the way in when they do. Same trick the telescope plays with the tube.
    // The two thresholds are ordered so the ground prop is gone BEFORE the held
    // one appears — the reverse would show two sticks for a frame, which is the
    // one arrangement that gives the whole thing away.
    this.overlay.set(smoothstep(0.22, 0.80, this.t));
    this.prop.visible = this.t < 0.46;
    if (this.held) this.held.visible = this.t > 0.52;

    this._poseStick();

    // Matrices, forced: the camera has just been written directly and the stick
    // under it was written this frame too, so nothing in the graph is current.
    cam.updateMatrixWorld(true);

    this._stepToast(step);
    this._writeUniforms(step);
    this._dressFlames();
    this._dampHearth(soft);

    // ── the backdrop, solved once for this seat ─────────────────────────────
    //
    // Last in the frame, and on the FIRST frame after a seat is chosen — which
    // is the earliest moment everything it reads is true: the marshmallow is
    // built and attached, the fire has written its own light, and the toast
    // map has a doneness. It draws two off-screen frames from the settled seat
    // and picks the hold; the stick is not visible until t > 0.52, so nothing
    // the player can see moves when it lands. See `_solveHold`.
    if (this._holdDirty && !this._holdPin) this._solveHold();
  }

  /**
   * Lean the fire's falloff back toward physical while the lens is inside it.
   *
   * ── the defect this answers ─────────────────────────────────────────────
   *
   * Round 1's money shot measured, over the whole frame: chroma 0.44, 84% of
   * pixels strongly saturated, ZERO near-neutral pixels, and 89% of every
   * chromatic pixel in one hue bucket — red. Against the same world at the same
   * hour from a normal camera (`prop-side`): chroma 0.28, 46% saturated, 2.4%
   * neutral, hue spread across red/orange/yellow/green/cyan/azure. The frame
   * was not merely flat, it was monochrome, and the brief asks for three value
   * groups.
   *
   * The cause is in `camp_fire.js`'s own light block, which documents it
   * exactly: the fire runs at DECAY 1.4 and REACH 8.6 m rather than an inverse
   * square, deliberately, so that "the chairs, the tent and the near grass take
   * [warmth] after dark". The same note records what it costs — "any intensity
   * that lights the tent turns the ring into a flat clipped orange sheet …
   * fireside: no value structure left in the dirt inside two metres" — and
   * accepts the cost, correctly, because until this view existed nothing shipped
   * a camera inside two metres of a fire. This view is a camera 1.30 m from one
   * — 0.72 m clear of its stone ring — with every pixel in frame inside the
   * 8.6 m pool. It is the one framing that
   * bill comes due in, so it is this view's to pay.
   *
   * ── what it does ─────────────────────────────────────────────────────────
   *
   * Three knobs, eased in together over the arrival, and the third of them is
   * the one the first attempt at this got wrong. Raising the decay alone is
   * BACKWARDS in the near field: 1 m is the crossover by definition, so a 1.4
   * to 2.0 change darkens everything past a metre and BRIGHTENS everything
   * inside it — and everything inside it is the stone ring and the dirt of the
   * pit, which is the blown-out mass this is trying to rescue. The measured
   * result was a frame flatter than the one it replaced (contrast 0.151 ->
   * 0.115, saturated pixels 84% -> 88%).
   *
   *   decay     1.4 -> 2.0   an honest inverse square, so the pool has an edge
   *   intensity      x 0.62  the near field comes down with everything else
   *
   * Together: about a sixth off the stones at half a metre, half off the ground
   * at a metre and a half, four fifths off it at six. What comes back is
   * everything the flood was covering — the stones get lit and shaded faces
   * again, and the ground keeps falling away smoothly instead of sitting at one
   * flat clipped value.
   *
   * ── AND THE THIRD KNOB, WHICH WAS A HARD EDGE ACROSS THE FRAME ───────────
   *
   * Round 3 also wrote `distance` 8.6 -> 4.2 m, on the reasoning that "the
   * cutoff comes inside the tent and the woodpile". The reasoning is fine and
   * the instrument is not: a three.js point light with `distance` set does not
   * taper to nothing at that radius, it CLAMPS to zero there —
   * `getDistanceAttenuation` multiplies by `pow2(saturate(1 - pow4(d/cutoff)))`
   * and that term reaches exactly 0. On flat dirt seen from a low eye, a sphere
   * of radius 4.2 m centred on the fire cuts the ground in a circle, and the
   * circle projects as a line.
   *
   * It was measured, and it is in every first-person frame of round 3 at both
   * hours (`docs/ROAST_CRITIC_FINDINGS.md` D3-2): a 2-pixel step about 1000 px
   * wide at y = 555 in `dusk-held-clean`, 556 in `burning`, 561 in `uneven`,
   * 667 in `held-clean`. Above it the frame measured 0.031 mean linear luma
   * over a 500x240 sample — which is not the dark value group this note claimed
   * to be buying, it is nothing at all, and a frame with nothing in the top half
   * has no mid-ground, no depth and no hue but the fire's.
   *
   * So `distance` is left exactly as the fire authored it and the falloff comes
   * from the exponent alone, which is what an exponent is for. `_fireWas` still
   * RECORDS the authored reach, because `state().wasReach` is how a capture
   * tool proves what the fire asked for, but nothing here writes it.
   *
   * ── why it is written from here ──────────────────────────────────────────
   *
   * It is runtime state, not authored data, it is restored on the way out, and
   * `Firepit.update` rewrites both fields every frame — so this has to run in
   * `lateUpdate`, after the fire's own update, which is where `_drive` already
   * is. Flagged to the fire's author in the round-2 report: if they would rather
   * own "the falloff when somebody is sitting in it", these ten lines become a
   * call into their file and nothing else here changes.
   */
  _dampHearth(k) {
    const light = this.camp?.fire?.light;
    if (!light) return;
    // Re-read rather than remember. `Firepit.update` has already written both
    // fields this frame from its own tuning (which moves with the hour and with
    // `window.__fireTune`), so what is on the light right now IS the authored
    // value, and reading it every frame means the ramp tracks a retune and the
    // restore puts back the truth rather than a stale snapshot.
    //
    // ── BUT ONLY WHEN THE FIRE HAS WRITTEN SINCE WE DID ──────────────────
    //
    // That argument holds for a LIVE frame, where `Firepit.update` runs before
    // this and the value on the light is the fire's. It is false for `_repose`,
    // which a tool calls as many times as it likes between world frames with
    // the engine stopped — there the value on the light is THIS METHOD'S OWN
    // OUTPUT, and re-reading it feeds the output back into the input. `decay`
    // survives that (a lerp toward a constant is idempotent at k = 1);
    // `intensity` does not, because it is a multiply, and it compounds 0.62 per
    // call.
    //
    // It is not hypothetical: round 3's own contact sheet has the evidence.
    // `held-clean` reports the fire asking for intensity 4.335 and `ladder-2`,
    // six `_repose` calls later in the same session, reports it asking for
    // 0.201 — which is 4.335 x 0.62^6. Every ladder frame in that round was
    // shot under a fire twenty times too dim and nothing said so.
    //
    // So the authored values are re-read only when the light does not still
    // hold what we last put on it. In a live frame that is every frame; under
    // a stopped engine it is never, which is the point.
    const was = this._fireWas
      ?? (this._fireWas = { decay: 0, distance: 0, intensity: 0, wroteD: NaN, wroteI: NaN });
    if (light.decay !== was.wroteD || light.intensity !== was.wroteI) {
      was.decay = light.decay;
      was.distance = light.distance;    // recorded for `state()`, never written
      was.intensity = light.intensity;
    }
    light.decay = was.wroteD = lerp(was.decay, 2.0, k);
    light.intensity = was.wroteI = was.intensity * lerp(1, 0.62, k);
  }

  /** Put the fire's falloff back exactly as it was found. */
  _restoreHearth() {
    const light = this.camp?.fire?.light;
    if (light && this._fireWas) {
      light.decay = this._fireWas.decay;
      light.intensity = this._fireWas.intensity;
    }
    this._fireWas = null;
  }

  /**
   * Where the seat is, in full: the settled eye, the settled orientation, and
   * the small idle drift on both.
   *
   * ── why a perfectly static camera is wrong ──────────────────────────────
   *
   * A first-person camera that does not move at all does not read as a person
   * sitting still — it reads as a screenshot, and everything moving in the
   * frame reads as a video playing on it. What fixes it is tiny: a couple of
   * centimetres of position and a fraction of a degree of bearing, on periods
   * long enough (5-8 s) that you cannot see the loop. This is breathing, not
   * handheld camera shake; anything you can consciously notice is too much.
   *
   * Three incommensurable rates so it never repeats inside a session, and the
   * vertical is the largest term because breathing is mostly vertical.
   */
  _settledPose() {
    const fire = this._firePos(this._v);
    const b = this._bearing;

    // The camera's own horizontal basis at this bearing. `_fwd` points from the
    // seat at the fire; `_rgt` is the camera's right. Both are used again by
    // the stick pose, so they are stored rather than recomputed.
    const sb = Math.sin(b), cb = Math.cos(b);
    this._fwd.set(-sb, 0, -cb);
    this._rgt.set(cb, 0, -sb);

    // Halved from round 1 in the linear terms, untouched in the angular ones.
    // The screen amplitude of a POSITION drift scales with 1/distance and the
    // subject came from 1.54 m to 0.56 m in round 2 and has settled at 1.28,
    // so round 1's 12 mm of bob would read as more wobble than it was tuned to be — "breathing, not
    // handheld shake" is a statement about pixels, not about metres. The yaw and
    // pitch drifts are angles and are unaffected by the move, so they stand.
    const T = this._clock;
    const bob = Math.sin(T * 0.79) * 0.006 + Math.sin(T * 0.41 + 1.7) * 0.0035;
    const sway = Math.sin(T * 0.53 + 0.9) * 0.0045;
    const yawD = Math.sin(T * 0.37 + 2.2) * 0.0042;
    const pitchD = Math.sin(T * 0.61 + 0.3) * 0.0031;

    this._eye.copy(fire).addScaledVector(this._fwd, -POSE.out);
    // From the GROUND AT THE SEAT, not from the fire's origin. See
    // `_measureSeatY` — this one substitution is most of round 5.
    this._eye.y = (Number.isFinite(this._seatY) ? this._seatY : fire.y) + POSE.eye + bob;
    this._eye.addScaledVector(this._rgt, sway);

    // ── the pitch, DERIVED from the aim point ───────────────────────────
    //
    // Not an authored angle. `POSE.aim` is a height above the fire's own
    // origin and the pitch is whatever looks at it from wherever this seat
    // turned out to be, so a camp on a slope composes the same frame as a camp
    // on the flat. See the block above POSE for the measurement that forced
    // this — the same authored 22 degrees put the marshmallow at 40% of frame
    // height at one chair and 98.5% at the other, in the same camp.
    //
    // Struck against the un-drifted eye height so the breathing bob does not
    // also swing the aim; the bob is 6 mm and the correction would be
    // invisible, but a pitch that is a function of the bob is a pitch that
    // moves twice.
    const drop = (this._eye.y - bob) - (fire.y + POSE.aim);
    const pitch = Math.atan2(drop, Math.max(0.05, POSE.out));

    // Yaw is the bearing itself: with the seat at `fire - fwd * out`, looking
    // along `fwd` at the fire is a `YXZ` yaw of exactly `b`.
    this._e.set(-pitch + pitchD, b + yawD, 0);
    this._pitch = pitch;
    this._camQ.setFromEuler(this._e);
    this._camQi.copy(this._camQ).invert();
  }

  /**
   * Put the stick in the frame.
   *
   * Everything here is CAMERA-LOCAL and struck against the SETTLED pose, never
   * the live one — see note 2 in the header. The chain is four steps and each
   * one exists for a reason:
   *
   *  1. **The target.** Where the marshmallow must be, in world space: over the
   *     near half of the flame, a little to the camera's right of its core, at
   *     the commanded height above the flame's hot point. Carried into camera
   *     space by the settled pose's inverse.
   *  2. **The aim**, authored outright as a camera-local direction from the two
   *     angles above, plus the small pivot the height control puts into it. See
   *     the note on SHAFT_RIGHT — round 1 derived this from a nominal grip and
   *     the derivation collapsed once the marshmallow came near the lens.
   *  3. **The grip**, slid back along that aim by the stick's own length. This
   *     is what makes the file agnostic about how long the geometry author
   *     builds the stick: the marshmallow lands in exactly the same pixel
   *     whether the stick is 0.95 m or 1.25 m, and only how far behind the lens
   *     the fist ends up changes. The shaft's angle across the frame — the part
   *     anybody can see — is now a constant of the composition rather than a
   *     consequence of somebody else's length.
   *  4. **The bend**, which re-aims the tip by a few millimetres around the
   *     spin axis so the rotation is legible.
   */
  _poseStick() {
    // A harness that has detached the stick owns where it is. See `detach`.
    if (!this.held || this._detached) return;
    const fire = this._firePos(this._v);
    const T = this._clock;

    // ── 1. the target ───────────────────────────────────────────────────────
    //
    // Its own sway, at rates that share no factor with the camera's. That is
    // the point of listing them together: if the hand breathed with the head
    // the stick would be nailed to the frame and the whole shot would go dead
    // again, which is the exact failure the camera drift exists to fix.
    // Halved for the same reason the camera's bob was — see `_settledPose`.
    const hx = Math.sin(T * 0.31 + 0.6) * 0.0055 + Math.sin(T * 0.73 + 2.4) * 0.0025;
    const hy = Math.sin(T * 0.19 + 1.9) * 0.007 + Math.sin(T * 0.47) * 0.003;

    // `_hold`, not POSE, and that is the round-6 change: the lateral offset is
    // SOLVED for this seat against what is actually behind the subject there,
    // with POSE.right/POSE.near as the seed it starts from and falls back to.
    // See `_solveHold`.
    const hold = this._hold ?? POSE;
    this._tgt.copy(fire)
      .addScaledVector(this._rgt, hold.right + hx)
      .addScaledVector(this._fwd, -hold.near);
    this._tgt.y = fire.y + FLAME_TOP + this.height + hy;

    // The eat beat draws the whole thing back toward the lens. Lerped in WORLD
    // space toward a point derived from the settled camera, so the arc it
    // travels is a real arc through the scene rather than a slide across the
    // frame.
    if (this.eating >= 0) {
      // Ease out hard: the hand accelerates away from the fire and arrives
      // gently, which is the shape of a real "that's done" motion.
      const k = smoothstep(0, 0.62, this.eating / EAT_TIME);
      const soft = k * k * (3 - 2 * k);
      this._v2.set(0.09, -0.13, -0.40).applyQuaternion(this._camQ).add(this._eye);
      this._tgt.lerp(this._v2, soft);
    }

    // Into camera space.
    this._tgt.sub(this._eye).applyQuaternion(this._camQi);

    // ── 2. the aim, authored ────────────────────────────────────────────────
    //
    // Unit direction from the grip toward the marshmallow: back and to the
    // right becomes forward and to the left, and the near end hangs below.
    // The pivot term is the arm: raising the marshmallow tilts the shaft rather
    // than translating the whole stick, so the fist stays roughly put.
    const dn = SHAFT_DOWN
      + Math.atan2((this.height - H_REST) * SHAFT_PIVOT, Math.max(0.2, this.stickLen));
    const cd = Math.cos(dn);
    this._dir.set(-Math.sin(SHAFT_RIGHT) * cd, Math.sin(dn), -Math.cos(SHAFT_RIGHT) * cd);

    // ── 3. the grip ─────────────────────────────────────────────────────────
    this._grip.copy(this._tgt).addScaledVector(this._dir, -this.stickLen);

    // ── 4. the bend ─────────────────────────────────────────────────────────
    //
    // A perpendicular basis about the aim, and a point on a small circle in it
    // whose phase LAGS the spin in proportion to the spin rate. That lag is the
    // whip, and it is the difference between "a bent stick is turning" and "a
    // rod is turning": the faster you spin it the further behind your hand the
    // tip runs, and the circle it traces opens up.
    this._bx.copy(this._up).cross(this._dir);
    if (this._bx.lengthSq() < 1e-8) this._bx.set(1, 0, 0);
    this._bx.normalize();
    this._by.copy(this._dir).cross(this._bx).normalize();
    const ph = this.spin - clamp(this.spinVel * BEND_LAG, -0.9, 0.9);
    const amp = BEND * (1 + 0.35 * clamp01(Math.abs(this.spinVel) / TWIRL_CRUISE));
    this._v3.copy(this._tgt)
      .addScaledVector(this._bx, Math.cos(ph) * amp)
      .addScaledVector(this._by, Math.sin(ph) * amp);
    this._dir.copy(this._v3).sub(this._grip);
    const l2 = this._dir.length();
    if (l2 > 1e-4) this._dir.divideScalar(l2);

    // ── the transform ───────────────────────────────────────────────────────
    //
    // An explicit right-handed basis with +Z along the stick, rather than
    // `setFromUnitVectors`, because the shortest-arc quaternion carries an
    // arbitrary roll that CHANGES as the aim changes — so raising and lowering
    // the marshmallow would twist it, and the twist would be indistinguishable
    // from the twirl the player is trying to control. Here the roll is exactly
    // and only `spin`.
    this._bx.copy(this._up).cross(this._dir);
    if (this._bx.lengthSq() < 1e-8) this._bx.set(1, 0, 0);
    this._bx.normalize();
    this._by.copy(this._dir).cross(this._bx).normalize();
    this._m.makeBasis(this._bx, this._by, this._dir);
    this._q.setFromRotationMatrix(this._m);
    this._qz.setFromAxisAngle(this._az, this.spin);
    this._q.multiply(this._qz);

    this.held.position.copy(this._grip);
    this.held.quaternion.copy(this._q);

    // ── the marshmallow coming off ──────────────────────────────────────────
    if (this.dropping >= 0 && this.mallow) this._poseDrop();
    else if (this.eating >= 0 && this.mallow) {
      // The bite. It leaves the stick over the last third of the beat, from the
      // far end in, which is the direction a bite actually takes it.
      const k = clamp01((this.eating / EAT_TIME - 0.42) / 0.34);
      this._mallowScale = 1 - k;
      this.mallow.scale.setScalar(Math.max(0.0001, this._mallowScale));
      this.mallow.visible = k < 0.995;
    }
  }

  /**
   * The marshmallow sliding off and falling in.
   *
   * It slides along the stick's own +Z first — off the end, which is how it
   * actually goes — and only then falls, on a gravity dialled well below 9.8.
   * Real gravity over 45 cm is a quarter of a second and reads as a glitch;
   * 3.0 m/s² is about half a second, which is long enough to see it happen and
   * to feel slightly silly about it, which is the point.
   *
   * Driven in the marshmallow's own parent space so it keeps working whatever
   * the stick is doing: world down is carried into that space by `_localDown`,
   * so the fall is vertical in the WORLD even though the thing falling is a
   * child of a stick held at an angle.
   */
  _poseDrop() {
    const t = this.dropping;
    const slide = Math.min(t / 0.22, 1) * 0.055;
    const fallT = Math.max(0, t - 0.16);
    const fall = 0.5 * 3.0 * fallT * fallT;
    this._localDown(this._v2);
    this.mallow.position.copy(this._mallowHome);
    this.mallow.position.z += slide;
    this.mallow.position.addScaledVector(this._v2, fall);
    // Gone once it is inside the fire, which is also where the flare covers it.
    this.mallow.visible = fall < 0.52;
  }

  /**
   * World down, expressed in the marshmallow's own parent space.
   *
   * Built from LOCAL quaternions up the chain rather than from
   * `getWorldQuaternion`, and that is not fussiness. This runs inside
   * `_poseStick`, which runs BEFORE `cam.updateMatrixWorld(true)` — so every
   * `matrixWorld` in the chain is still last frame's, and a fall driven off it
   * would lean by however far the stick turned since. The local quaternions
   * were all written a few lines ago and are current by construction.
   */
  _localDown(out) {
    const chain = this._chain;
    chain.length = 0;
    for (let n = this.mallow.parent; n && n !== this.ctx.camera; n = n.parent) chain.push(n);
    this._q.copy(this._camQ);
    for (let i = chain.length - 1; i >= 0; i--) this._q.multiply(chain[i].quaternion);
    this._q.invert();
    return out.set(0, -1, 0).applyQuaternion(this._q);
  }

  /**
   * Step the heat.
   *
   * The one subtlety is what is handed in as `fire` while the marshmallow is
   * ALIGHT. The obvious model is a bigger multiplier on the camp fire, and it
   * is wrong in a way that shows immediately: the heat would still arrive from
   * below and the marshmallow would char on its underside and stay pale on top,
   * while visibly wrapped in its own flame. So while it is alight the heat
   * source IS the marshmallow — `pos` at its own centre, `top` at zero, `power`
   * full — and every texel therefore faces the source and chars together. That
   * is both physically what is happening and the picture you want: a lit
   * marshmallow goes uniformly black, fast, and its own shape survives in
   * silhouette.
   *
   * The `power` ramp with `t` is the arrival: no heat is delivered until the
   * player is nearly seated, so the walk over does not cook anything and a
   * harness that snaps `t` to 1 gets clean, deterministic numbers from frame
   * one.
   */
  _stepToast(dt) {
    if (!this.toast || !this.mallow) return;
    if (this.eating >= 0 || this.dropping >= 0) return;

    const f = this._fire;
    if (this.alight) {
      this.mallow.getWorldPosition(f.pos);
      f.top = 0;
      f.power = 1;
    } else {
      this._firePos(f.pos);
      f.top = FLAME_TOP;
      // The cooldown after a blow-out is fed as a dip in the fire's own power
      // rather than as a special case in the map: the live-heat channel decays
      // on its own, and the only thing needed is to stop pouring more in for a
      // moment. Which is, near enough, what blowing on it does.
      f.power = this._firePower()
        * smoothstep(0.55, 1.0, this.t)
        * (this.cool > 0 ? lerp(0.25, 1, 1 - this.cool / BLOW_COOL) : 1);
    }
    this.toast.update(dt, this.mallow, f);
  }

  /**
   * Write the material's uniforms.
   *
   * The contract puts these on the material as plain `THREE.Uniform` objects
   * precisely so this can be an assignment rather than a message: five numbers a
   * frame, no allocation, no branch into the toast author's file.
   *
   *   uSwell  the marshmallow inflates as it cooks — the steam inside it has
   *           nowhere to go. Comes on early and saturates by "done".
   *   uSag    it slumps. Two contributions, and both are real: the general
   *           slump of a very cooked marshmallow, and the specific stretch of
   *           one that is on its way off the stick. The second dominates,
   *           because it is the telegraph for the drop and the player has to be
   *           able to see it coming.
   *   uGlow   how lit-from-inside it is. Live heat while it is over the flame;
   *           full while it is alight, because a burning marshmallow is a lamp.
   *   uFireDir the fire's direction in the marshmallow's LOCAL space, which is
   *           what the back-scatter term needs to know where to glow through
   *           from. Local, so it has to be recomputed every frame the stick
   *           turns — which is every frame, which is why it lives here.
   */
  _writeUniforms(dt) {
    const u = this.uniforms ?? this.mat?.userData?.roastUniforms;
    if (!u || !this.mallow) return;
    const done = this.toast?.doneness ?? 0;

    if (u.uTime) u.uTime.value = this._clock;
    if (u.uSwell) u.uSwell.value = smoothstep(0.10, 0.66, done);
    if (u.uSag) {
      u.uSag.value = clamp01(smoothstep(0.62, 1.0, done) * 0.45 + this.slip * 0.85);
    }
    if (u.uGlow) {
      // ── ROUND 7: THIS IS LIVE HEAT NOW, AND IT WAS NOT ──────────────────
      //
      // It was `peak * 0.55 + smoothstep(H_MAX, H_MIN, height) * 0.25`, and
      // `peak` is ACCUMULATED TOAST. Two files carry notes about what that
      // cost: `Camp._roastAudio`, which feeds this straight to the sizzle and
      // whose own comment says `peak` "would keep hissing after the marshmallow
      // was lifted away", and `marshmallow_toast.js`, whose `setDoneness` note
      // says outright that this getter "is what still climbs across a ladder".
      // Both were describing this line. See section 1 of the ROUND 7 block.
      //
      // `_heatNow()` is the whole of it now: an inverse square about the
      // flame's hot point, normalised across the height band, times the fire's
      // own power. Nothing about doneness enters it, which is the point — a
      // burnt marshmallow lifted out of the fire goes dark, and the ember in
      // its cracks answers the hand rather than the history.
      const heat = this._heatNow();
      // Damped rather than assigned: the live-heat channel is noisy at the
      // texel level and an undamped glow flickers at the frame rate, which is
      // the one kind of flicker this camp does not want (see the note on the
      // fire's own rates — everything here moves at the bottom of the range a
      // real fire moves at).
      //
      // dt <= 0 is `_repose` — a tool that has just set an absolute state with
      // the engine stopped. There are no seconds to ease over and the frame
      // about to be photographed has to show the state that was asked for, so
      // the damping is skipped rather than applied with a zero step (which
      // would leave the glow on the PREVIOUS rung of the ladder).
      u.uGlow.value = dt > 1e-6 ? damp(u.uGlow.value ?? 0, heat, 6, dt) : heat;
    }
    if (u.uFireDir?.value?.set) {
      this._firePos(this._v).y += FLAME_TOP;
      this.mallow.getWorldPosition(this._v2);
      this._v.sub(this._v2);
      const l = this._v.length();
      if (l > 1e-5) this._v.divideScalar(l); else this._v.set(0, -1, 0);
      // World -> the marshmallow's own local space. Direction only, so the
      // rotation is all that matters and the inverse quaternion is enough.
      this._v.applyQuaternion(this.mallow.getWorldQuaternion(this._q).invert());
      u.uFireDir.value.set(this._v.x, this._v.y, this._v.z);
    }
  }

  /**
   * The candle flame on a burning marshmallow, and the flare when one falls in.
   *
   * ── who owns them, and why it changed in round 5 ─────────────────────────
   *
   * Both used to be CAMERA children, "so they can be placed in the same
   * camera-local space everything else here works in". That is a convenience
   * and it cost two rounds of `mallow-burning` in a row. The flame belongs to
   * the MARSHMALLOW — that is what "on fire" means — so it is parented to the
   * marshmallow, and the flare belongs to the FIRE, so it is parented to the
   * scene.
   *
   * The bug that argument is written against is worth stating exactly, because
   * it is not the one round 3 fixed. `roastshot.mjs` shoots its macros by
   * hoisting the stick into the world with
   * `scene.attach(camera.getObjectByName('camp_roast_held'))` and then MOVING
   * THE CAMERA — its own header calls that "careful rather than legitimate".
   * Round 3 read the symptom correctly and answered it with `detach()` /
   * `attach()`, which take the flames along; round 4 shipped that method and
   * the harness went on using its old handle, so `_detached` never came up, the
   * flame stayed a camera child, the camera flew to a macro pose 0.30 m from
   * the subject and the flame rode with it. `shots/roast/r4/mallow-burning.png`
   * is the result and the arithmetic is legible in it: the flame photographs at
   * about a quarter of the size it should, which is exactly the ratio of the
   * macro distance to the seat distance it was left behind at.
   *
   * Parented to the marshmallow, none of that is reachable. There is no pose
   * any tool can put the camera in that separates a child from its parent, so
   * the whole class of defect is gone rather than guarded against — and this
   * file stops depending on a peer's harness calling a particular method.
   *
   * Both are still kept UPRIGHT IN THE WORLD, by writing the inverse of their
   * parent's world rotation: a flame that leans with the stick as you twirl it
   * is a flame welded to a marshmallow, and flames do not do that. That is now
   * the marshmallow's rotation rather than the camera's, which is the whole of
   * the change in the maths.
   */
  _dressFlames() {
    if (this.flame && this.mallow) {
      const on = this.alight && this.mallow.visible;
      this.flame.visible = !!on;
      if (on) {
        // Breathing on two incommensurable rates, and taller the more of the
        // marshmallow has caught. `g` is capped: at 1.9 the flame was 160 mm
        // tall on a 47 mm marshmallow.
        const g = 1 + 0.42 * clamp01(this.toast?.ruined ?? 0);
        const w = 0.88 + 0.10 * Math.sin(this._clock * 8.3) + 0.06 * Math.sin(this._clock * 13.1);
        // The marshmallow's own world scale is already in the parent transform,
        // so the shells would shrink with the eat beat's bite. Divided out: a
        // flame is not made of sugar and does not go into anybody's mouth.
        const inv = 1 / Math.max(1e-3, this._mallowScale);
        this.flame.scale.set(w * g * inv, (1.55 - w * 0.5) * g * inv, w * g * inv);
        // The lift is along the WORLD's up and is a bit over half the
        // marshmallow's own radius, so the lathe's zero-radius base point sits
        // INSIDE the sugar and the flame grows out of it rather than hovering
        // over it. Round 3 lifted along the CAMERA's up, which is pitched
        // forward, and that was the other half of why it floated.
        this.mallow.getWorldPosition(this._v);
        this._v.y += this._mallowWorldR() * 0.55;
        this.mallow.updateWorldMatrix(true, false);
        this.flame.position.copy(this.mallow.worldToLocal(this._v));
        this.flame.quaternion.copy(this.mallow.getWorldQuaternion(this._q)).invert();
      }
    }
    // ── the steam ─────────────────────────────────────────────────────────
    //
    // Everything here is a function of `heat`, which is the LIVE quantity — see
    // section 1 of the ROUND 7 block — so the plume answers the height control
    // inside the 0.2 s the glow is damped over rather than inside the minute
    // the browning takes.
    //
    // It is off entirely once the marshmallow catches: there is a candle flame
    // on it at that point, and a wisp of steam climbing out of a flame is two
    // effects fighting over the same ninety millimetres.
    if (this.steam && this.mallow) {
      const u = this.uniforms ?? this.mat?.userData?.roastUniforms;
      const heat = clamp01(u?.uGlow?.value ?? 0);
      // A definite plume at the bottom of the band, nothing at all at the top.
      // The curve starts at 0.22 rather than at 0 so that a marshmallow held
      // high is CLEAN — the absence has to be an absence, not a faint wisp the
      // player has to squint at to rule out.
      const k = smoothstep(0.22, 0.92, heat);
      const on = k > 0.01 && !this.alight && this.mallow.visible;
      this.steam.visible = !!on;
      if (on) {
        const sm = this.steam.userData.steamMat;
        // Two incommensurable rates again, and slower than the flame's: steam
        // curls, it does not flicker. The amplitude rides `k` as well as the
        // opacity, so a wisp at the bottom of the band is taller AND stronger,
        // which is how a plume answers more heat.
        const br = 0.86 + 0.14 * Math.sin(this._clock * 1.7)
                        + 0.08 * Math.sin(this._clock * 2.9 + 1.1);
        if (sm) sm.opacity = k * 0.92;
        const inv = 1 / Math.max(1e-3, this._mallowScale);
        const w = (0.72 + 0.34 * k) * br;
        this.steam.scale.set(w * inv, (0.55 + 0.75 * k) * br * inv, w * inv);
        // Out of the top of the sugar, along WORLD up — the same lift and the
        // same reason as the candle flame's, which round 3 got wrong by lifting
        // along the camera's up on a camera pitched 30 degrees down.
        this.mallow.getWorldPosition(this._v);
        this._v.y += this._mallowWorldR() * 0.62;
        this.mallow.updateWorldMatrix(true, false);
        this.steam.position.copy(this.mallow.worldToLocal(this._v));
        // Upright in the world however the stick is turned, exactly like the
        // flame: steam that leans with the twirl is welded to the sugar, and it
        // would turn the one visible cue into a second rotation readout.
        this.steam.quaternion.copy(this.mallow.getWorldQuaternion(this._q)).invert();
      }
    }
    if (this.burst) {
      const on = this.flare > 0.002;
      this.burst.visible = on;
      if (on) {
        // A scene child at a world point: no conversion, and nothing to ride.
        this._firePos(this.burst.position).y += FLAME_TOP * 0.6;
        this.burst.quaternion.identity();
        // Up fast, out slow: the shape of a handful of sugar hitting embers.
        const k = this.flare;
        const s = (1 - k) * 8 + 3;
        this.burst.scale.set(s, s * (0.6 + k * 1.4), s);
        const bm = this.burst.userData.flameMat;
        if (bm) bm.opacity = k * k;
      }
    }
  }

  /**
   * The marshmallow's radius in the WORLD — the number every framing sum in
   * this file is struck against, and the one `roastshot.mjs` has been digging
   * out of `__roast.view.mallow.geometry.boundingSphere` because `state()` did
   * not publish it. Asked for by the harness author; it is one line.
   *
   * Off the geometry rather than off `camp_marshmallow`'s authored `MALLOW_R`,
   * because the mesh is a lathe with an off-axis mounting and its bounding
   * sphere is 11% wider than the authored radius. Scaled by the mesh's own
   * world scale so the eat beat's shrink is reflected rather than ignored.
   */
  _mallowWorldR() {
    const m = this.mallow;
    if (!m) return this.mallowR;
    const g = m.geometry;
    if (g && !g.boundingSphere) g.computeBoundingSphere();
    const r = g?.boundingSphere?.radius ?? this.mallowR;
    m.updateWorldMatrix(false, false);
    const s = m.matrixWorld;
    // The largest of the three basis lengths: a uniform scale in practice, and
    // the conservative answer if a peer ever makes it non-uniform.
    const sx = Math.hypot(s.elements[0], s.elements[1], s.elements[2]);
    const sy = Math.hypot(s.elements[4], s.elements[5], s.elements[6]);
    const sz = Math.hypot(s.elements[8], s.elements[9], s.elements[10]);
    return r * Math.max(sx, sy, sz);
  }

  /**
   * IS THERE ANYTHING BETWEEN THE LENS AND THE MARSHMALLOW.
   *
   * ── why this exists ──────────────────────────────────────────────────────
   *
   * Round 4 shipped and the player who played it said: "I could never see the
   * roasting, there was something blocking my view every time, looked like a
   * rock of the fire maybe." Every assertion the harness makes is about the
   * SUBJECT — how big it is, where it lands, whether it out-values the flame —
   * and not one of them is about the VOLUME IN FRONT OF IT. A pose can satisfy
   * all of them with a cobble parked between the eye and the sugar, and rounds
   * 1-4 had no way to notice. This is the player's complaint written as a
   * number, so that a frame can fail on it.
   *
   * ── how it is measured ───────────────────────────────────────────────────
   *
   * Thirteen rays: the marshmallow's centre, and twelve round its silhouette at
   * 85% of its world radius, offset in the CAMERA's own right and up so the
   * ring is the disc the player actually sees rather than a world-space circle
   * that foreshortens. Each is cast from the lens and stopped 1.1 radii short
   * of the surface, so the marshmallow cannot occlude itself and neither can
   * the stick it is mounted on.
   *
   * ── what counts as an occluder ───────────────────────────────────────────
   *
   * Anything that WRITES DEPTH. That is the whole rule and it is not a
   * shortcut: the sky dome, the cloud dome, the flame's shell stack, the smoke,
   * the sparks and the ember bed are every one of them `depthWrite: false` by
   * their own authors' deliberate choice, precisely because they are not
   * surfaces you can be behind — and a first-person camera at a fire is inside
   * all six of them at once, so a naive scene raycast reports the marshmallow
   * as 100% occluded by cloud. A name blacklist would have to be maintained
   * against five other files; the depth-write test asks the geometry itself.
   *
   * The invisible are skipped too, up the whole parent chain: the ground prop
   * of the stick is hidden while it is in hand, and a hidden mesh is not
   * something the player can be looking at.
   *
   * ── the cost ─────────────────────────────────────────────────────────────
   *
   * Thirteen scene raycasts. Called from `state()` and from nowhere else — it
   * is an assertion for a harness and for a pose sweep, not a per-frame check,
   * and `state()` is only ever called by a tool.
   */
  _clearance() {
    const cam = this.ctx?.camera;
    const scene = this.ctx?.scene;
    if (!scene || !cam || !this.mallow || !this.prop) {
      return { clear: true, frac: 0, by: null, at: 0 };
    }
    const rc = this._rc ?? (this._rc = new THREE.Raycaster());
    const c = this._clr ?? (this._clr = {
      m: new THREE.Vector3(), p: new THREE.Vector3(), d: new THREE.Vector3(),
      up: new THREE.Vector3(), rt: new THREE.Vector3(),
    });

    this.mallow.getWorldPosition(c.m);
    const R = this._mallowWorldR();
    c.up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    c.rt.set(1, 0, 0).applyQuaternion(cam.quaternion);

    let blocked = 0, by = null, at = Infinity;
    for (let i = 0; i <= 12; i++) {
      c.p.copy(c.m);
      if (i > 0) {
        const a = ((i - 1) / 12) * Math.PI * 2;
        c.p.addScaledVector(c.rt, Math.cos(a) * R * 0.85)
          .addScaledVector(c.up, Math.sin(a) * R * 0.85);
      }
      c.d.copy(c.p).sub(cam.position);
      const L = c.d.length();
      if (L < 1e-4) continue;
      c.d.divideScalar(L);
      rc.set(cam.position, c.d);
      rc.near = 0;
      rc.far = Math.max(0.01, L - R * 1.1);
      const hs = rc.intersectObject(scene, true);
      for (const h of hs) {
        if (!this._occludes(h.object)) continue;
        blocked++;
        if (h.distance < at) { at = h.distance; by = this._nameOf(h.object); }
        break;
      }
    }
    return {
      clear: blocked === 0,
      frac: blocked / 13,
      by,
      at: Number.isFinite(at) ? at : 0,
    };
  }

  /** Does this hit hide what is behind it: visible, and writes depth. */
  _occludes(o) {
    for (let n = o; n; n = n.parent) if (n.visible === false) return false;
    const m = o.material;
    if (!m) return false;
    if (Array.isArray(m)) return m.some((x) => x?.depthWrite !== false);
    return m.depthWrite !== false;
  }

  /** The nearest named ancestor, so a blocker reports as `fire_stone`. */
  _nameOf(o) {
    for (let n = o; n; n = n.parent) if (n.name) return n.name;
    return '(unnamed)';
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  IS THERE ANYTHING BEHIND THE MARSHMALLOW THAT LOOKS LIKE IT
  //
  //  The other half of the player's round-4 report, and the round-6 work. The
  //  argument, the metric and the arc the hold slides along are all in the
  //  ROUND 6 block above `HOLD_PHI_MIN`; this is the machinery.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The hold as a rho and an angle, which is the pair the solve moves in.
   *
   * `rho` is the only thing the heat model can see (see the round-6 block) and
   * is carried through every candidate unchanged; `phi` is the free one.
   */
  _holdSeed() {
    return {
      rho: Math.hypot(POSE.near, POSE.right),
      phi: Math.atan2(POSE.right, POSE.near),
    };
  }

  /** The default hold: the authored seed, for a view that has not solved yet. */
  _seedHold() {
    const s = this._holdSeed();
    return { right: POSE.right, near: POSE.near, phi: s.phi, rho: s.rho, solved: false };
  }

  /**
   * Take the camera to the settled seat, hide what a settled frame hides, and
   * hand back everything that has to be put like it was found.
   *
   * The probe has to draw the frame the player will be looking at, and during
   * `enter()` the camera is still wherever the player was standing when they
   * clicked — `_settledPose` computes the seat into `_eye`/`_camQ` and writes
   * nothing. So this writes it, takes the ground prop out of the shot (a
   * settled frame has it hidden; a probe frame that left it in would be
   * measuring a stick leaning on a table), and stops the shadow maps
   * re-rendering for two frames nobody will see.
   *
   * Returns null — and probes therefore no-op — when there is no renderer, no
   * marshmallow, or a probe already running. A unit harness with a bare camp
   * record falls back to the authored seed, which is round 5's behaviour
   * exactly.
   */
  _probeBegin() {
    const r = this.ctx?.renderer, cam = this.ctx?.camera, scene = this.ctx?.scene;
    if (!r || !cam || !scene || !this.held || !this.mallow) return null;
    if (typeof r.readRenderTargetPixels !== 'function') return null;
    if (this._probing || this._detached) return null;
    this._probing = true;
    const light = this.camp?.fire?.light;
    const save = {
      p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov,
      held: this.held.visible,
      prop: this.prop ? this.prop.visible : null,
      shadow: r.shadowMap.autoUpdate,
      rt: r.getRenderTarget(),
      hold: { ...this._hold },
      light: light ? { d: light.decay, i: light.intensity } : null,
      wrote: this._fireWas ? { d: this._fireWas.wroteD, i: this._fireWas.wroteI } : null,
    };
    this._settledPose();
    cam.position.copy(this._eye);
    cam.quaternion.copy(this._camQ);
    if (Math.abs(cam.fov - this._fov) > 1e-6) { cam.fov = this._fov; cam.updateProjectionMatrix(); }
    if (this.prop) this.prop.visible = false;
    r.shadowMap.autoUpdate = false;
    // THE HEARTH AS THE SHIPPED FRAME HAS IT. The solve usually runs on the
    // first frame of the walk in, where `_dampHearth` has barely started, and
    // measuring the backdrop under the fire's own undamped flood would score
    // the ring stones a third of a stop brighter than the frame the player ends
    // up looking at. Forced to k = 1 here and written back verbatim in
    // `_probeEnd` — verbatim rather than by another `_dampHearth` call, because
    // that method's intensity term is a multiply and re-running it compounds.
    this._dampHearth(1);
    return save;
  }

  /** Put back everything `_probeBegin` moved, in the order it moved it. */
  _probeEnd(save) {
    if (!save) return;
    const r = this.ctx.renderer, cam = this.ctx.camera;
    cam.position.copy(save.p);
    cam.quaternion.copy(save.q);
    if (Math.abs(cam.fov - save.fov) > 1e-6) { cam.fov = save.fov; cam.updateProjectionMatrix(); }
    this.held.visible = save.held;
    if (this.prop && save.prop !== null) this.prop.visible = save.prop;
    r.shadowMap.autoUpdate = save.shadow;
    r.setRenderTarget(save.rt);
    const light = this.camp?.fire?.light;
    if (light && save.light) { light.decay = save.light.d; light.intensity = save.light.i; }
    if (this._fireWas && save.wrote) { this._fireWas.wroteD = save.wrote.d; this._fireWas.wroteI = save.wrote.i; }
    cam.updateMatrixWorld(true);
    this._probing = false;
  }

  /**
   * Draw one probe frame and read it back, LINEAR.
   *
   * A `FloatType` target because the quantity being measured spans the dirt at
   * dusk (0.01) and the flame's core (well past 1.0) and an 8-bit linear buffer
   * has three levels between black and the dirt. If the float read comes back
   * empty — a driver without `EXT_color_buffer_float` — it falls back to bytes
   * once and stays there, which loses the dark end but is still a value
   * measurement rather than a name.
   *
   * `renderer.info` is snapshotted and restored: `Engine` runs with
   * `info.autoReset = false` and adds the frame's own counts up by hand, so an
   * extra render here would otherwise show up in the perf HUD as two hundred
   * draw calls nobody made.
   */
  _probeRender(hideHeld, img) {
    const r = this.ctx.renderer, cam = this.ctx.camera, scene = this.ctx.scene;
    const W = PROBE_W;
    const H = Math.max(2, Math.round(W / (cam.aspect || (16 / 9))));
    const type = this._probeType ?? (this._probeType = THREE.FloatType);
    let rt = this._probeRT;
    if (!rt || rt.width !== W || rt.height !== H || rt.texture.type !== type) {
      rt?.dispose();
      rt = this._probeRT = new THREE.WebGLRenderTarget(W, H, {
        type, depthBuffer: true, stencilBuffer: false,
      });
    }
    const Arr = type === THREE.FloatType ? Float32Array : Uint8Array;
    if (!img.data || img.data.length !== W * H * 4 || img.data.constructor !== Arr) {
      img.data = new Arr(W * H * 4);
    }
    img.W = W; img.H = H; img.byte = Arr === Uint8Array;

    const info = r.info.render;
    const snap = { calls: info.calls, triangles: info.triangles, points: info.points, lines: info.lines };
    this.held.visible = !hideHeld;
    r.setRenderTarget(rt);
    // CLEAR, EXPLICITLY, AND THIS IS NOT BOILERPLATE. `EffectComposer` sets
    // `renderer.autoClear = false` on the renderer it is constructed with and
    // never puts it back, so `renderer.render` into a target this file owns
    // does NOT clear that target's depth. The first render into a fresh target
    // therefore looks right — a new depth renderbuffer starts at 1 — and every
    // one after it inherits the last frame's depth and silently drops every
    // surface that is not NEARER than whatever was there before.
    //
    // It cost this round a day. The symptom is a probe frame with the ground
    // and the terrain simply absent, sky showing through where the dirt should
    // be, at some seats and not others (the seats differ by what the previous
    // probe left in the buffer) — and the value measurement then scores the
    // subject against the SKY, which at dusk is 0.19 and is very close to a
    // fire-lit cobble, so the numbers look plausible and are meaningless.
    r.clear(true, true, true);
    r.render(scene, cam);
    try {
      r.readRenderTargetPixels(rt, 0, 0, W, H, img.data);
    } catch (e) {
      img.data.fill(0);
    }
    r.setRenderTarget(null);
    info.calls = snap.calls; info.triangles = snap.triangles;
    info.points = snap.points; info.lines = snap.lines;

    // The float path, verified once rather than assumed. An all-zero frame from
    // a camera sitting inside a lit scene is a read that did not happen.
    if (!img.byte && !this._probeFloatOk) {
      let sum = 0;
      for (let i = 0; i < img.data.length; i += 64) sum += img.data[i];
      if (sum > 0) this._probeFloatOk = true;
      else {
        this._probeType = THREE.UnsignedByteType;
        this._probeFloatOk = true;      // do not recurse a second time
        return this._probeRender(hideHeld, img);
      }
    }
    return img;
  }

  /** Linear luma of one probe pixel, or NaN outside the frame. */
  _lumaPx(img, x, y) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= img.W || yi >= img.H) return NaN;
    const i = (yi * img.W + xi) * 4;
    const d = img.data;
    const k = img.byte ? 1 / 255 : 1;
    return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) * k;
  }

  /**
   * Where a world point lands in a probe frame, and how big the marshmallow is
   * there. Pixels, with y counted from the BOTTOM, which is where
   * `readRenderTargetPixels` starts.
   */
  _probeAt(img, p) {
    const cam = this.ctx.camera;
    const q = (this._pv ?? (this._pv = new THREE.Vector3())).copy(p).project(cam);
    const d = cam.position.distanceTo(p);
    const R = this._mallowWorldR();
    // Half-extent in NDC-y units, then in pixels. Pixels are square, so the
    // same radius holds across x even though NDC-x spans the wider side.
    const rPx = (R / (Math.tan(cam.fov * Math.PI / 360) * Math.max(0.05, d))) * img.H * 0.5;
    return {
      x: (q.x * 0.5 + 0.5) * img.W,
      y: (q.y * 0.5 + 0.5) * img.H,
      rPx,
      xPct: (q.x * 0.5 + 0.5) * 100,
      yPct: (0.5 - q.y * 0.5) * 100,
      frac: (R * 2) / (2 * Math.tan(cam.fov * Math.PI / 360) * Math.max(0.05, d)) * 100,
      d,
      R,
    };
  }

  /** The polar grid: the disc it is seen against and the ring its outline dies into. */
  _probeSamples(img, at, rings, nAng, out) {
    out.length = 0;
    for (const k of rings) {
      const n = k < 1e-6 ? 1 : nAng;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const L = this._lumaPx(img, at.x + Math.cos(a) * at.rPx * k, at.y + Math.sin(a) * at.rPx * k);
        if (Number.isFinite(L)) out.push(L);
      }
    }
    return out;
  }

  /** A percentile of a small unsorted list. */
  _pct(a, p) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[clamp(Math.round(p * (s.length - 1)), 0, s.length - 1)];
  }

  /**
   * Score one candidate hold against a backdrop frame, at EVERY subject value
   * it will have to survive.
   *
   * `lost` is the fraction of the outline within HOLD_MARGIN stops of its
   * backdrop; `margin` is the tenth percentile of the separation, i.e. the
   * worst tenth of the outline rather than the average of it.
   *
   * ── round 7: `Lset` is a LIST, and the score is the worst of it ──────────
   *
   * It was one subject value, measured at HOLD_JUDGED, and the hold it chose
   * had to serve a subject that walks 8:1 darker as it cooks. Passing both ends
   * of that walk and reporting the worse of the two is the whole of the fix —
   * see the ROUND 7 note above HOLD_JUDGED_DARK. `per` carries the individual
   * rungs so a failing frame can say which end of the cook failed it.
   */
  _scoreAt(img, p, Lset) {
    const at = this._probeAt(img, p);
    const s = this._probeSamples(img, at, [0, 0.45, 0.8, 1.0, 1.2], 16, this._sbuf ?? (this._sbuf = []));
    const list = Array.isArray(Lset) ? Lset : [Lset];
    if (!s.length) {
      return { ...at, n: 0, lost: 1, margin: -9, behind: 0, per: list.map(() => -9), lostPer: list.map(() => 1) };
    }
    let worstLost = 0, worstMargin = Infinity;
    const per = [], lostPer = [];
    for (const Ls of list) {
      let lost = 0;
      const m = [];
      for (const L of s) {
        // The SEPARATION, unsigned, plus the one absolute test. See the
        // two-sided note in the ROUND 6 block.
        const g = Math.abs(Math.log2((Ls + LUMA_EPS) / (L + LUMA_EPS)));
        const blown = L >= HOLD_BLOWN;
        m.push(blown ? 0 : g);
        if (blown || g < HOLD_MARGIN) lost++;
      }
      const margin = this._pct(m, HOLD_MARGIN_PCT);
      per.push(+margin.toFixed(3));
      lostPer.push(+(lost / s.length).toFixed(3));
      if (lost / s.length > worstLost) worstLost = lost / s.length;
      if (margin < worstMargin) worstMargin = margin;
    }
    return {
      ...at,
      n: s.length,
      lost: worstLost,
      margin: worstMargin,
      per,
      lostPer,
      behind: this._pct(s, 0.5),
    };
  }

  /**
   * The subject's own linear luma, by drawing it: pose the stick at `hold`,
   * optionally paint the map to `done` first, render WITH the stick shown, and
   * take the median of a small polar grid over its projected disc.
   *
   * The median rather than the peak, for the reason HOLD_SUBJECT_PCT gives:
   * half the marshmallow faces away from the fire, and scoring against the lit
   * half alone passes a frame whose shadow side is the half that disappears.
   *
   * Painting is the caller's business to undo — `_solveHold` does it in one
   * place, through `reset()`, which is an exact restore on the fresh map that
   * is the only map this is ever called on with a `done`.
   */
  _subjectValue(hold, P, done) {
    if (done != null) this.toast.setDoneness(done);
    this._mallowAtHold(hold.right, hold.near, P);
    const img = this._probeRender(false, this._imgB ?? (this._imgB = {}));
    const at = this._probeAt(img, P);
    const s = this._probeSamples(img, at, [0, 0.3, 0.55], 12, []);
    return s.length ? this._pct(s, HOLD_SUBJECT_PCT) : 0;
  }

  /**
   * Where the marshmallow really ends up for a given hold.
   *
   * Posed rather than computed: `_poseStick` puts the tip through a bend of
   * 14 mm whose phase is the twirl, which at this range is most of a subject
   * radius across the frame, so a candidate scored at its nominal target would
   * be scored eight pixels from where it is drawn.
   */
  _mallowAtHold(right, near, out) {
    this._hold.right = right;
    this._hold.near = near;
    this._poseStick();
    this.ctx.camera.updateMatrixWorld(true);
    return this.mallow.getWorldPosition(out);
  }

  /**
   * The backdrop measurement for the pose AS IT STANDS — the live half of the
   * assertion, and the one `state()` publishes.
   *
   * `clear` is recomputed on every `state()` call and `distinct` has to be the
   * same kind of number, or a harness asserting on it is asserting on whatever
   * the seat happened to measure at entry: every ladder rung would report the
   * raw marshmallow's margin, which is the one doneness the ladder is not
   * about. So this re-measures.
   *
   * Memoised on everything that can move the subject or change its value, so
   * the poll loops a capture tool runs — `waitForFunction(state().t >= 0.999)`
   * at 60 ms — do not each pay for two off-screen renders of a pose that has
   * not moved since the last one.
   */
  _backdropLive() {
    if (!this.prop || !this.held || this._probing || this._detached) return this._holdRec;
    // A seat that has not been solved yet is solved now rather than measured as
    // it stands: a tool can poll `state()` before the first `_drive` of the
    // arrival ever runs, and reporting the authored seed's numbers there would
    // be reporting a pose the player is never going to see.
    if (this._holdDirty && !this._holdPin) this._solveHold();
    const sig = `${this._bearing}|${this._hold.right}|${this._hold.near}|${this.height}` +
      `|${this.spin}|${this._clock}|${this.t}|${this.toast?.doneness ?? 0}|${this.alight}`;
    if (this._measSig === sig && this._measRec) return this._measRec;
    const rec = this._solveHold(true);
    this._measSig = sig;
    this._measRec = rec;
    return rec;
  }

  /**
   * SOLVE THE HOLD FOR THIS SEAT.
   *
   * Once, on entry, cached in `_hold`. The whole argument is in the ROUND 6
   * block above `HOLD_PHI_MIN`; in short: slide the hold along the arc of
   * constant rho, which the heat model cannot see, and stop at the first
   * position whose backdrop the subject out-values — preferring the seed, so a
   * seat that was already clean does not move.
   */
  _solveHold(measureOnly = false) {
    const save = this._probeBegin();
    // The dirty flag is cleared HERE and not on the way in, and only by a real
    // solve. Clearing it first cost this round two capture runs: `state()`
    // measures through `_backdropLive`, a harness polls `state()` before the
    // first `_drive` ever runs, and a `measureOnly` pass that cleared the flag
    // left every frame in the sheet shot at the authored seed with
    // `hold.solved` reporting false and nothing else saying why. A probe that
    // could not run must also leave the flag up, so the next frame retries.
    if (!save) return this._holdRec;
    if (!measureOnly) this._holdDirty = false;

    // Solve against the marshmallow as it will look when there is something to
    // see, not as it looks in the first half-second. Only on a FRESH map, where
    // `reset()` is an exact restore. See HOLD_JUDGED.
    const cook = !measureOnly && (this.toast?.doneness ?? 1) < 0.02
      && typeof this.toast?.setDoneness === 'function'
      && typeof this.toast?.reset === 'function';

    try {
      const cam = this.ctx.camera;
      const seed = this._holdSeed();
      const P = this._pw ?? (this._pw = new THREE.Vector3());

      // 1. The subject, drawn AT THE HOLD IT ARRIVED WITH, at BOTH ENDS of the
      //    cook it will have to survive. Posed before the render, not after it:
      //    during `enter()` the stick has never been posed and rendering first
      //    would photograph it at the origin. See the HOLD_JUDGED note for why
      //    a fresh map is painted and reset rather than modelled, and the
      //    HOLD_JUDGED_DARK note for why one rung is not enough.
      const Ls = this._subjectValue(save.hold, P, cook ? HOLD_JUDGED : null);
      const LsDark = cook ? this._subjectValue(save.hold, P, HOLD_JUDGED_DARK) : null;
      // Back to the rung the frames are judged at, so what the backdrop render
      // below draws and what the record reports are the same marshmallow.
      if (cook) this.toast.setDoneness(HOLD_JUDGED);
      const Lset = LsDark == null ? [Ls] : [Ls, LsDark];
      // What the record reports: the seed's value, or the winner's own once a
      // move has been verified below.
      let subjectL = Ls;
      let subjectD = LsDark;

      // 2. The backdrop, drawn once for every candidate at once.
      const imgA = this._probeRender(true, this._imgA ?? (this._imgA = {}));

      const cands = [];
      const rho = measureOnly ? Math.hypot(save.hold.near, save.hold.right) : seed.rho;
      const list = [];
      if (measureOnly) list.push(Math.atan2(save.hold.right, save.hold.near));
      else {
        for (let phi = HOLD_PHI_MIN; phi <= HOLD_PHI_MAX + 1e-6; phi += HOLD_PHI_STEP) list.push(phi);
        // The SEED ITSELF, exactly, and not merely the nearest grid point to
        // it. Without this a seat that was already clean still moves by half a
        // grid step to a candidate no better than the one round 5 composed, and
        // "move as little as possible" quietly becomes "move a bit, always".
        list.push(seed.phi);
        list.sort((a, b) => a - b);
      }
      for (const phi of list) {
        const right = rho * Math.sin(phi);
        const near = rho * Math.cos(phi);
        this._mallowAtHold(right, near, P);
        const r = this._scoreAt(imgA, P, Lset);
        // The composition gates. A candidate that wins on value by leaving the
        // frame, by shrinking under the readable size, or by sliding out from
        // under the shaft the stick was authored for has not won anything.
        const whole = r.xPct - r.frac * 0.5 / (cam.aspect || 1) > 2
          && r.xPct + r.frac * 0.5 / (cam.aspect || 1) < 98
          && r.yPct - r.frac * 0.5 > 2 && r.yPct + r.frac * 0.5 < 98;
        const framed = whole && r.frac >= 8.0 && r.xPct >= HOLD_X_MIN && r.xPct <= HOLD_X_MAX;
        cands.push({ phi, right: +right.toFixed(4), near: +near.toFixed(4), framed, seed: phi === seed.phi, ...r });
      }

      // 3. Choose: the candidate NEAREST THE SEED among those that clear, and
      //    the seed itself if none does. See the round-6 block for why nearest
      //    rather than best. `measureOnly` is the one-candidate case a tool
      //    that has pinned the hold asks for: score what is there, choose
      //    nothing, move nothing.
      const bar = HOLD_MARGIN;
      const clears = cands.filter((c) => c.framed && c.lost <= HOLD_LOST && c.margin >= bar);
      const at0 = cands.find((c) => c.seed);
      let win = measureOnly ? cands[0] : null;
      if (!measureOnly) {
        // ── NOTHING CLEARS: NOTHING MOVES ──────────────────────────────────
        //
        // There is no "best of a bad lot" branch, and there used to be. At noon
        // the sunlit ground is the same value as the marshmallow everywhere on
        // the arc, every candidate scores between -0.5 and +0.2 stops, and a
        // rule that took the least bad of them gave `held-enter`, `held` and
        // the six ladder rungs — same camp, same hour, minutes apart — holds
        // 18.6 deg apart, chosen on nothing but flame flicker. A composition
        // that is a function of noise is worse than one that is a little wrong,
        // because the little-wrong one is at least the frame the last round was
        // composed and judged at.
        //
        // So the seat either finds a hold that CLEARS the bar or it keeps the
        // one round 5 authored, and `state().distinct` reports which. Every
        // move worth having is a clearing move: the two seats where the noon
        // sun does leave shade within reach of the arc clear at 1.06 and above,
        // and they still move.
        const ranked = clears.slice()
          .sort((a, b) => Math.abs(a.phi - seed.phi) - Math.abs(b.phi - seed.phi));
        // And hold the round-5 assertion: nothing may be in FRONT of it either.
        // A candidate is passed over if something opaque is between it and the
        // lens — which has happened at no bearing measured, and is one raycast
        // bundle against a silent regression if it ever does.
        for (const c of ranked.slice(0, 4)) {
          this._mallowAtHold(c.right, c.near, P);
          if (this._clearance().clear) { win = c; break; }
        }
        win = win ?? ranked[0] ?? at0 ?? null;

        // ── AND THE WINNER HAS TO SURVIVE BEING MEASURED PROPERLY ──────────
        //
        // Every candidate above was scored against ONE subject value, `Ls`,
        // measured with the stick at the seed — which is what makes 25
        // candidates cost one render instead of 25. That approximation is
        // exact for the light (the fire's irradiance on the marshmallow is a
        // function of rho and height, and the arc holds both), and it is WRONG
        // for one thing: the flame's own shells are ADDITIVE and draw over the
        // subject, so a candidate that slides toward the flame column gets a
        // glow laid on top of it that the seed's `Ls` knows nothing about. Its
        // backdrop is glowing too, so the separation it was credited with is
        // not there.
        //
        // It is not theoretical — it is how `dusk-held` came back moved 10
        // degrees toward the flame to a frame measuring 0.09 stops. So a
        // winner that is not the seed is re-rendered, re-valued and re-scored,
        // and reverts to the seed unless it still earns the move.
        if (win && !win.seed && at0) {
          // Re-valued at BOTH rungs, like the candidates were: a hold that
          // gains a flame glow on top of it gains one at every doneness, and
          // verifying only the golden rung would put the dark-end fix straight
          // back where the round-6 note found it.
          const vLs = this._subjectValue(win, P, cook ? HOLD_JUDGED : null);
          const vDark = cook ? this._subjectValue(win, P, HOLD_JUDGED_DARK) : null;
          if (cook) this.toast.setDoneness(HOLD_JUDGED);
          const vSet = vDark == null ? [vLs] : [vLs, vDark];
          this._mallowAtHold(win.right, win.near, P);
          const v = this._scoreAt(imgA, P, vSet);
          if (v.margin >= bar && v.lost <= HOLD_LOST) {
            win = { ...win, ...v, verified: true }; subjectL = vLs; subjectD = vDark;
          } else win = at0;
        }
      }

      if (!win) {
        // Nothing measurable: keep what was there. Never leave the hold
        // somewhere a candidate loop happened to stop.
        this._hold.right = save.hold.right;
        this._hold.near = save.hold.near;
        return this._holdRec;
      }

      this._hold = measureOnly ? { ...save.hold } : {
        right: win.right, near: win.near, phi: win.phi,
        rho: +Math.hypot(win.near, win.right).toFixed(4),
        solved: true,
      };
      this._poseStick();
      this._holdRec = {
        solved: !measureOnly,
        phi: +(win.phi * 180 / Math.PI).toFixed(2),
        phiSeed: +(seed.phi * 180 / Math.PI).toFixed(2),
        moved: +((win.phi - seed.phi) * 180 / Math.PI).toFixed(2),
        right: win.right, near: win.near,
        rho: +Math.hypot(win.near, win.right).toFixed(4),
        rhoSeed: +seed.rho.toFixed(4),
        // The bar, against the subject as it was drawn in the probe — which for
        // a solve is the marshmallow at HOLD_JUDGED and for a `measure()` is
        // whatever the caller has on the stick. `doneness` says which.
        distinct: win.lost <= HOLD_LOST && win.margin >= HOLD_MARGIN,
        bar: +bar.toFixed(3),
        doneness: cook ? HOLD_JUDGED : +(this.toast?.doneness ?? 0).toFixed(3),
        lost: +win.lost.toFixed(3),
        // The WORST of the rungs scored, and the rungs themselves beside it so
        // a frame that fails can say which end of the cook failed it. `margin`
        // is what `distinct` is decided on. See HOLD_JUDGED_DARK.
        margin: +win.margin.toFixed(3),
        marginLight: win.per?.[0] ?? null,
        marginDark: win.per?.length > 1 ? win.per[1] : null,
        subject: +subjectL.toFixed(5),
        subjectDark: subjectD == null ? null : +subjectD.toFixed(5),
        donenessDark: cook ? HOLD_JUDGED_DARK : null,
        behind: +win.behind.toFixed(5),
        xPct: +win.xPct.toFixed(1), yPct: +win.yPct.toFixed(1), frac: +win.frac.toFixed(2),
        cleared: clears.length,
        n: cands.length,
        byte: !!imgA.byte,
      };
      if (!measureOnly) this._holdCands = cands;
      return this._holdRec;
    } finally {
      if (cook) this.toast.reset();
      this._probeEnd(save);
      // The camera is back where the caller had it; the stick's camera-local
      // pose is not a function of that, but its world matrix is.
      this._poseStick();
      this.ctx.camera.updateMatrixWorld(true);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  The debug surface
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `window.__roast` — what `tools/roastshot.mjs` drives.
   *
   * The contract puts the reason plainly and it is worth repeating: a harness
   * that has to synthesise drags breaks the moment somebody touches the input
   * mapping, and the input mapping is the part of this file most likely to be
   * retuned. So every state the critic loop needs a frame of is reachable by a
   * direct call that does not go anywhere near `Input`.
   *
   * `step(dt)` is the other half of that: it advances the simulation and poses
   * everything with NO input read at all, so a harness can put the view in an
   * exact state, take one frame, and know the number it asserted on is the
   * number that was drawn.
   */
  _publishDebug() {
    if (typeof window === 'undefined') return;
    const V = this;
    window.__roast = {
      get view() { return V; },

      /**
       * Sit down at a fire. With no arguments it finds the first camp in the
       * world that has a roasting stick in it, which is what the harness wants;
       * pass a prop and a camp to be specific.
       *
       * ROUND 2: this used to snap `t` to 1 on the way out, on the argument that
       * "the harness wants the composed frame, not the walk to it". That single
       * line cost the round its `held-enter` frame: the harness polls
       * `state().t` in a rAF loop and stops the engine the instant it crosses
       * 0.4, and the first poll already read 1.00. Nobody could judge the
       * arrival. The transition now runs for real; a tool that wants the settled
       * frame waits on `state().t >= 0.999`, which is what the harness already
       * does, and one that wants a specific instant calls `setT`.
       */
      enter(prop, camp) {
        const found = prop ? { obj: prop, camp } : V._anyStick();
        if (!found?.obj) return false;
        // A FORCED reset, asked for by the harness author and owed since round
        // 3. `RoastView.enter` returns early when the stick handed to it is the
        // one already in hand — correct for the game (clicking the stick you
        // are holding must not restart the view) and useless to a tool, which
        // had to call `leave()` first and then knew it was relying on the
        // early-out's exact wording. Here `enter()` means what its own note
        // above says it means: a fresh marshmallow on a fresh stick, whatever
        // was in hand a moment ago.
        if (V.prop) V._release();
        V.enter(found.obj, found.camp);
        V._settledPose();
        return !!V.prop;
      },

      /**
       * Write the composition — eye height, seat distance, pitch, lens, and
       * where the marshmallow is held — and re-pose onto it.
       *
       * This exists because round 3 shipped a camera inside the fire's stone
       * ring on arithmetic that was internally consistent and wrong, and the
       * only instrument that catches that is a frame. With this, a scratch tool
       * shoots six candidate compositions in one browser session; without it,
       * each candidate is an edit, a reload and a capture, and a round costs a
       * day. Partial: `pose({ fov: 24 })` moves the lens and nothing else.
       *
       * Angles in RADIANS for `pitch`, degrees for `fov`, metres for the rest —
       * the same units the module constants are in, because a debug surface
       * that converts is a debug surface that lies about what it set. `pitch`
       * is the one exception and it says so: the camera holds an AIM POINT now
       * rather than an angle, so a `pitch` is converted to the aim that
       * produces it from this seat and the conversion is announced in the code
       * below and in the returned object, which carries both.
       *
       * Returns the pose as it now stands, so a sweep can record what it shot.
       */
      pose(p) {
        if (p) for (const k of Object.keys(POSE)) {
          if (Number.isFinite(p[k])) POSE[k] = p[k];
        }
        V._fov = POSE.fov;
        // ── the hold, and who owns it ────────────────────────────────────
        //
        // A caller who names `right` or `near` MEANS them: the round-5 sweep
        // solves `right` by secant against a target screen x, and a solver
        // that quietly moved it underneath would make that loop diverge and
        // every row it printed a lie. So naming either PINS the hold to
        // exactly what was asked for and stops the solve until somebody says
        // otherwise. A pose that moves anything else — the seat, the lens, the
        // aim — moves the frame under the subject and re-solves.
        if (p && (Number.isFinite(p.right) || Number.isFinite(p.near))) {
          V._hold = V._seedHold();
          V._holdPin = true;
          V._holdDirty = false;
          V._holdRec = null;
        } else if (p) {
          V._holdDirty = true;
        }
        // `out` moves the seat across the ground, and the ground is not level,
        // so the datum `eye` is measured from has to be re-read BEFORE a pitch
        // is converted or a pose is struck. See `_measureSeatY`.
        V._measureSeatY();
        // A caller who asks for a PITCH gets one, converted to the aim point
        // that produces it from this seat. `POSE.pitch` no longer exists — the
        // camera holds a point, not an angle (see the block above POSE) — but a
        // sweep tool asking for 30 degrees means something perfectly clear, and
        // silently ignoring the key it passed is the worst of the three
        // available behaviours. The aim is what is stored, so the request is
        // honoured at THIS seat and stays honoured as a composition at others.
        if (p && Number.isFinite(p.pitch) && !Number.isFinite(p.aim)) {
          const fire = V._firePos(V._v);
          const eyeY = (Number.isFinite(V._seatY) ? V._seatY : fire.y) + POSE.eye;
          POSE.aim = eyeY - fire.y - Math.tan(p.pitch) * POSE.out;
        }
        V._repose();
        // The derived pitch comes back with it, so a sweep can record the angle
        // it actually got rather than the one it asked for.
        return { ...POSE, pitch: V._pitch };
      },

      /**
       * Take the stick out of the hand and into the world, and put it back.
       *
       * The macro framings need this; see `RoastView.detach`. Returns false if
       * there is nothing to detach, so a harness can tell the difference
       * between "done" and "there was no view".
       */
      detach() { return V.detach(); },
      attach() { return V.attach(); },

      /**
       * Open or close PHOTO MODE over the top of this view, and hand the frame
       * across in both directions.
       *
       * A feature with no instrument gets broken silently, and this one is a
       * state transition rather than a state: what has to be provable is that
       * roast -> photo -> roast leaves the same marshmallow at the same
       * doneness on the same seat, which no single frame can show. So the whole
       * edge is reachable from here.
       *
       * `HUD.togglePhoto` rather than `photo.setActive`, because the root
       * class, the chip, the rail focus and the analytics event all hang off
       * the toggle and a harness that reached past it would be testing a photo
       * mode no player can open. It is a real F, minus the keyboard.
       *
       * Falls back to calling this view's own `handOff`/`endHandOff` when there
       * is no HUD at all — a unit harness with no DOM can still drive the edge,
       * and gets told which of the two paths it took.
       *
       * @returns 'hud' | 'direct' | 'no-view' | 'noop'
       */
      photo(on = true) {
        const want = !!on;
        const hud = V.ctx.systems?.hud;
        if (hud?.togglePhoto && hud.photo) {
          if (!!hud.photo.active === want) return 'noop';
          hud.togglePhoto();
          return 'hud';
        }
        if (!V.prop) return 'no-view';
        if (want) V.handOff(); else V.endHandOff();
        return 'direct';
      },

      /**
       * Pin this view's own seconds.
       *
       * `_clock` drives the idle drift on the eye and on the hand and the
       * marshmallow material's `uTime`, so between two capture runs it is worth
       * a few millimetres of subject position — which is 9% of a macro frame.
       * `roastshot.mjs` already pins it (its header says so) by assigning
       * `RoastView._clock` through `__roast.view`, i.e. by reaching into a
       * private field. This is the same thing, supported, and it re-poses so
       * the drift the caller just asked for is the drift in the next frame.
       */
      setClock(s) { V._clock = Number.isFinite(s) ? s : 0; V._repose(); },
      /** Step back out. Immediate, not eased — a harness has no patience. */
      leave() {
        // Take the frame back first. `_drive` is a no-op while photo mode holds
        // it, so a bare `closing = true` would leave the view pinned mid-exit
        // forever with a stick lying in the grass.
        if (V._handedOff) V.endHandOff();
        if (V.prop) { V.closing = true; V.t = 0; V._drive(1 / 60); }
      },
      /**
       * Pin the step-in at `k` and pose everything there, with the engine
       * stopped or running.
       *
       * Two halves and round 1 had neither. The PIN (`_holdT`) is what stops the
       * next `_drive` walking `t` straight back to 1 before the shutter opens;
       * the REPOSE is what puts the camera and the stick where `k` says they are
       * without waiting for a frame that a stopped engine will never run.
       * `enter()` clears the pin, so this is per-capture and not sticky.
       */
      setT(k) { V._ensure(); V._holdT = clamp01(k); V.t = V._holdT; V._repose(); },
      /** Release a `setT` pin and let the step-in run again. */
      playT() { V._holdT = null; },

      /**
       * Cook the whole surface evenly to `k`, 0..1. The doneness ladder.
       *
       * Also puts out anything that is alight and un-melts anything that was
       * sliding. A harness setting an absolute doneness is describing the whole
       * state of the marshmallow, and leaving it on fire underneath that
       * description is how round 1's `burning` frame poisoned every frame after
       * it — see `_ensure`.
       */
      setDoneness(k) {
        V._ensure();
        V.alight = false; V.cool = 0; V.slip = 0;
        V._setDoneness(clamp01(k));
        V._repose();
      },
      /**
       * Paint toast onto one place on the map.
       * @param u 0..1 around the marshmallow's axis (wraps)
       * @param v 0..1 along it (clamps)
       * @param r radius in map units, 0..1
       * @param a target toast, 0..1
       */
      paint(u, v, r, a) { V._ensure(); V._paint(u, v, r, a); V._repose(); },
      /** The contract's name for a spot paint with a default radius. */
      setToast(u, v, a) { V._ensure(); V._paint(u, v, 0.18, a); V._repose(); },

      /** Absolute spin angle, radians. Clears the flywheel so it stays put. */
      setSpin(rad) {
        V._ensure();
        V.spin = rad; V.spinVel = 0; V._handVel = 0;
        V._repose();
      },
      /** Spin RATE, rad/s — for a frame of the twirl actually moving. */
      setSpinVel(v) { V._ensure(); V.spinVel = clamp(v, -TWIRL_MAX, TWIRL_MAX); V._repose(); },
      /** Height over the flame's hot point, metres. Snapped, not eased. */
      setHeight(m) {
        V._ensure();
        V.height = V.heightCmd = clamp(m, H_MIN, H_MAX);
        V._repose();
      },

      /** Light it. */
      ignite() { V._ensure(); V.alight = true; V.cool = 0; V._repose(); },
      /** Put it out. */
      blowOut() { V.blowOut(); V._repose(); },
      /**
       * Eat it. Identical to what `E` does now — round 7 took the doneness
       * floor out, so there is no longer a rule here that a player is held to
       * and a tool is not. `slip` is cleared first for the one reason it always
       * was: a harness photographing the eat beat wants the bite, not a
       * marshmallow that slides off on the frame it is asked for.
       */
      eat() { if (V.prop && V.eating < 0 && V.dropping < 0) { V.slip = 0; V.eat(); } },
      /** Drop it in the fire. */
      drop() { V.drop(); },

      /**
       * Show or hide the whole overlay — vignette, glow, tip and result.
       *
       * Asked for by the harness author and owed since round 1. Without it the
       * tool falls back to hiding every element whose class starts `pa-roast`,
       * which works (they all do) but announces itself as a workaround in
       * `ROAST.json`, and a workaround that has to be maintained across two
       * files is one edit away from six "clean" frames with a caption in them.
       */
      setOverlay(on) { V.overlayOn = !!on; V.overlay.mute(!on); return true; },

      /**
       * Advance one frame with no input. Sim then pose, in the order the live
       * frame runs them, so a harness that steps 60 times sees exactly what a
       * player who sat still for a second would.
       */
      step(dt = 1 / 60) {
        if (!V._ensure()) return false;
        // The live frame's own split. While photo mode holds the frame this
        // view runs `_photoUpdate` and nothing else, so a harness stepping
        // through a hand-off has to see the same pause a player does — a
        // `step()` that cooked here would prove the cook was paused by proving
        // it was not.
        if (V._handedOff) { V._photoUpdate(dt); return true; }
        V.time += dt;
        V._sim(dt);
        V._drive(dt);
        return true;
      },

      /**
       * SOLVE THE HOLD for the seat as it stands, now, and hand back what the
       * measurement said. Clears any pin `pose()` put on it.
       *
       * The view does this itself on entry; this exists so a tool can A/B it
       * against the authored seed at the same seat — pin with
       * `pose({ right: 0.142, near: 0.24 })`, read `state().backdrop`, call
       * this, read it again — which is exactly how the round-6 table was shot.
       */
      solveHold() {
        if (!V._ensure()) return null;
        V._holdPin = false;
        V._holdDirty = true;
        const r = V._solveHold();
        V._repose();
        return r;
      },

      /**
       * Score the backdrop of the hold AS IT STANDS, moving nothing. Two
       * off-screen renders; the number a pinned pose gets to be judged on.
       */
      measure() {
        if (!V._ensure()) return null;
        return V._solveHold(true);
      },

      /** Every candidate the last solve looked at, for a sweep to plot. */
      holdCandidates() { return V._holdCands ? V._holdCands.map((c) => ({ ...c })) : null; },

      /** Everything a harness would assert on. */
      state() { return V.state(); },
    };
  }

  /**
   * Make sure there is a live view under whatever the caller is about to do.
   *
   * ── the failure this exists to end ──────────────────────────────────────
   *
   * Round 1's contact sheet was correct for its first fourteen frames and then
   * became eight identical aerial vistas and two chase-camera frames of the
   * whole camp with the HUD in them. The state dumps say exactly what happened:
   * `strip-0` onward report `active: false, phase: 'drop'`. The `burning` frame
   * had — correctly, on request — set the marshmallow alight; nothing put it
   * out; the next section stepped four seconds of simulation through it; the
   * marshmallow melted off the stick, went in the fire, played its drop beat and
   * the view LEFT, exactly as it is supposed to when that happens to a player.
   * From there every `setSpin` wrote a field nobody was reading, every `step`
   * returned false, and the camera had been handed back to the rig.
   *
   * The mini-game's behaviour was right. What was wrong was that the debug
   * surface let a tool go on driving a view that was no longer there, silently.
   * There are two possible contracts and only one of them is any use: either
   * every entry point fails loudly, or the surface picks the stick back up. It
   * picks it back up — a harness asking for `setDoneness(0.55)` wants a
   * marshmallow at 0.55, and `enter()` already means "a fresh marshmallow on a
   * fresh stick", so re-entering is both the cheap answer and the honest one.
   *
   * Deliberately NOT called from `eat`, `drop` or `blowOut`: those three are
   * requests to change a marshmallow that has to already exist, and conjuring
   * one to eat would be a lie about what was photographed.
   *
   * @returns true if there is a live view to act on.
   */
  _ensure() {
    if (this.prop) return true;
    const found = this._anyStick();
    if (!found?.obj) return false;
    this.enter(found.obj, found.camp);
    if (!this.prop) return false;
    // Straight to the settled pose. A tool that had to wait 0.75 s of wall
    // clock after every call would be unusable, and it did not ask to re-enter
    // — it asked for a marshmallow.
    this.t = 1;
    this._holdT = null;
    this._repose();
    return true;
  }

  /**
   * Pose everything for the CURRENT state, advancing nothing.
   *
   * `_drive` is the per-frame path and it integrates: it moves `t`, it steps the
   * heat, it damps `uGlow`. A harness needs the other half — "put the camera and
   * the stick where the numbers I just set say they are, and change nothing
   * else" — because with the engine stopped there is no next frame to do it in,
   * and with the engine running a `_drive` would fold a frame of simulation into
   * a state the tool has just asserted on.
   *
   * Round 1 had no such call. `setSpin` wrote `this.spin` and returned; the
   * stick was posed the next time a frame ran, which with a stopped engine is
   * never — which is why `strip-0..7` were byte-identical even before the view
   * had let go of the camera.
   *
   * `_stepToast` is not called (dt would be zero and it would be a no-op with a
   * side effect on `_fire`), but `_writeUniforms` is, with dt = 0 so the damped
   * glow snaps rather than eases — a stopped engine has no seconds to ease over.
   */
  _repose() {
    if (!this.prop) return;
    const cam = this.ctx.camera;
    this._settledPose();
    // The same two curves `_drive` uses, so `setT(0.4)` lands on exactly the
    // pose the fortieth percent of a real walk passes through. At t = 1 both
    // reduce to the settled seat.
    const e = smoothstep(0, 1, clamp01(this.t));
    const soft = e * e * (3 - 2 * e);
    cam.position.lerpVectors(this._from.p, this._eye, soft);
    cam.quaternion.copy(this._from.q).slerp(this._camQ, soft);
    const fov = lerp(this._from.fov, this._fov, soft);
    if (Math.abs(cam.fov - fov) > 0.005) { cam.fov = fov; cam.updateProjectionMatrix(); }
    this.overlay.set(smoothstep(0.22, 0.80, this.t));
    this.prop.visible = this.t < 0.46;
    if (this.held) this.held.visible = this.t > 0.52;
    this._poseStick();
    cam.updateMatrixWorld(true);
    this._writeUniforms(0);
    this._dressFlames();
    this._dampHearth(soft);
    // The same once-per-seat solve `_drive` runs, for the engine-stopped path a
    // tool drives. Without it every harness frame would be shot at the authored
    // seed, which is the round-5 pose, and no capture could ever see this work.
    if (this._holdDirty && !this._holdPin) this._solveHold();
  }

  /** The numbers, in one object. Also the shape `state()` returns to a tool. */
  state() {
    const t = this.toast;
    return {
      active: this.active,
      t: this.t,
      heldT: this._holdT,        // non-null: `setT` has the step-in pinned
      closing: this.closing,
      // `phase` answers "what is this view doing", so an inactive view is `off`
      // and says so. Round 1 reported `drop` on a view that had been released
      // ten frames into a contact sheet and went on reporting it for the rest of
      // the run, which is how eight aerial vistas got past a tool that was
      // checking the state before every shutter.
      phase: !this.prop ? 'off'
        : this.eating >= 0 ? 'eat' : this.dropping >= 0 ? 'drop'
        : this.closing ? 'out' : this.t < 1 ? 'in' : 'roast',
      overlay: this.overlayOn,
      // THE HAND-OFF ASSERTION. `handedOff` is photo mode holding the frame:
      // the stick is standing in the world at the pose the hand had it, the rig
      // has the camera and this view is driving nothing. `detached` is the
      // lower-level fact underneath it — the stick is not a camera child — and
      // a harness raises that on its own for the macro framings, so the two are
      // published separately rather than as one flag. `handedOff && !detached`
      // is impossible and worth failing on; `detached && !handedOff` is
      // `roastshot.mjs` shooting a macro.
      //
      // `stickParent` is the whole feature in one string, because "is the
      // marshmallow in the photograph" is not a question a boolean answers:
      // `camera` is welded to the lens, `scene` is standing over the fire,
      // `none` is the round-12 defect — deleted from the graph entirely.
      handedOff: this._handedOff,
      detached: this._detached,
      stickParent: !this.held?.parent ? 'none'
        : this.held.parent === this.ctx.camera ? 'camera'
        : this.held.parent === this.ctx.scene ? 'scene'
        : (this.held.parent.name || this.held.parent.type),
      forceCamera: typeof window !== 'undefined' ? !!window.__forceCamera : false,
      took: this._took,
      controlsHeldBy: this.ctx.systems?.vehicle?.controlsHeldBy ?? null,
      fov: this.ctx?.camera?.fov ?? 0,

      spin: this.spin,
      spinVel: this.spinVel,
      height: this.height,
      heightCmd: this.heightCmd,

      doneness: t?.doneness ?? 0,
      evenness: t?.evenness ?? 0,
      peak: t?.peak ?? 0,
      ruined: t?.ruined ?? 0,
      burning: !!(t?.burning),
      alight: this.alight,
      cool: this.cool,
      slip: this.slip,

      sag: this.uniforms?.uSag?.value ?? 0,
      swell: this.uniforms?.uSwell?.value ?? 0,
      glow: this.uniforms?.uGlow?.value ?? 0,
      // `heat` is what the sizzle actually hears — the DAMPED glow, 0.17 s
      // behind the hand. `heatTarget` is `_heatNow()` undamped, which is what
      // the height control asked for on this frame. A strip that steps the
      // stick down the band asserts on the second and watches the first chase
      // it; they differ only while the hand is moving.
      heat: this.heat,
      heatTarget: this._heatNow(),
      // The plume's own strength as it is DRAWN — zero when it is not, so a
      // harness cannot read a stale opacity off a hidden object.
      steam: this.steam?.visible ? (this.steam.userData.steamMat?.opacity ?? 0) : 0,

      result: this.result?.key ?? null,
      resultLabel: this.result?.label ?? null,
      roasted: this.roasted,
      made: this.roasted,
      perfect: this.perfect,
      burnt: this.burnt,
      dropped: this.dropped,
      time: this.time,

      bearing: this._bearing,
      eye: { x: this._eye.x, y: this._eye.y, z: this._eye.z },
      // `pitch` is derived from `POSE.aim` and the seat's own ground height,
      // so it is a RESULT rather than a setting and a harness reading it across
      // two camps should expect two numbers. See `_settledPose`.
      eyeH: POSE.eye, seatOut: POSE.out, pitch: this._pitch, aim: POSE.aim,
      // The datum `eyeH` is measured from, and how far it sits above the fire's
      // own origin. A harness that sees `seatOverFire` swing between camps is
      // looking at the ground the camp stands on, not at a bug — but a
      // `seatY` equal to `fire.y` means `_measureSeatY` found no camp ground
      // and every height in the frame is the fire's datum again.
      seatY: this._seatY,
      seatOverFire: Number.isFinite(this._seatY)
        ? this._seatY - this._firePos(new THREE.Vector3()).y : 0,
      // THE OCCLUSION ASSERTION. `clear` false is the player's round-4 report,
      // measured: something opaque is between the lens and the marshmallow.
      // See `_clearance`.
      ...(() => { const c = this._clearance(); return {
        clear: c.clear, blockedFrac: c.frac, blockedBy: c.by, blockedAt: c.at }; })(),
      // THE BACKDROP ASSERTION, and it sits beside `clear` on purpose: those
      // are the two halves of "I could never see the roasting". `clear` says
      // nothing opaque is in FRONT of the marshmallow; `distinct` says nothing
      // BEHIND it is within HOLD_MARGIN stops of its own value — which is the
      // other way a pale 80-pixel disc goes missing, and the way it was still
      // going missing at three bearings in eight after round 5.
      //
      // `margin` is the SEPARATION at the worst tenth of the outline, in stops
      // of linear luma and unsigned — either direction counts, a charred
      // marshmallow on lit dirt reads as well as a white one on dark dirt —
      // and `lost` is the fraction of the outline inside HOLD_MARGIN of its
      // backdrop or sitting on blown white. Both are LIVE, recomputed for the
      // pose as it stands like `clear` is, and memoised so a poll loop does
      // not pay twice for the same pose. `backdrop.doneness` says which
      // marshmallow they were measured on. See `_backdropLive`.
      ...(() => { const b = this._backdropLive(); return {
        distinct: b ? b.distinct : null,
        margin: b ? b.margin : null,
        lost: b ? b.lost : null,
        backdrop: b ? { ...b } : null }; })(),
      // Where the hand actually holds it, against where POSE seeds it. `rho`
      // is the quantity `marshmallow_toast.js` reads and it is carried through
      // the solve unchanged — a `rho` here that differs from `rhoSeed` is a
      // cook rate that differs from the one the mini-game was tuned at.
      hold: { ...this._hold, pinned: this._holdPin, dirty: this._holdDirty },
      pose: { ...POSE },
      mallowR: this._mallowWorldR(),
      mallow: this.mallow
        ? (() => { const p = this.mallow.getWorldPosition(new THREE.Vector3()); return { x: p.x, y: p.y, z: p.z }; })()
        : null,
      // THE CAMPFIRE, ASKED FOR RATHER THAN REMEMBERED.
      //
      // ── the reporting bug this fixes ──────────────────────────────────
      //
      // This published `this._fire` — the scratch record `_stepToast` fills in
      // and hands to the toast map — and that record is written in exactly one
      // place: inside `_stepToast`, which `_repose` does not call and which
      // returns early during both closing beats. So every path that poses the
      // view without stepping it left the published fire at the Vector3's
      // birth value of (0, 0, 0) while `state().mallow` reported a real world
      // position, and a harness subtracting the two computed a marshmallow
      // 1312 m from the fire it was being held over. The simulation was never
      // wrong — `_stepToast` builds the record fresh every step — the
      // PUBLICATION was, and only ever on frames nobody had stepped.
      //
      // So it is queried now, from the same `_firePos` the pose is struck
      // against, and `top` is this view's own FLAME_TOP rather than whatever
      // the last step happened to leave behind. `roastshot.mjs` reads
      // `fire.x/y/z + top` to aim its macro camera at the campfire and carries
      // a caution about this field switching to the marshmallow's own position
      // while it is alight; that can no longer happen, and the caution is now
      // dead code rather than a live hazard.
      //
      // What the heat model was last handed is not lost, it is just no longer
      // wearing the campfire's name: `fire.src` is the record verbatim,
      // including the alight case where the source IS the marshmallow.
      fire: {
        ...(() => { const p = this._firePos(new THREE.Vector3());
          return { x: p.x, y: p.y, z: p.z }; })(),
        top: FLAME_TOP,
        power: this._firePower(),
        src: {
          x: this._fire.pos.x, y: this._fire.pos.y, z: this._fire.pos.z,
          top: this._fire.top, power: this._fire.power,
          // False until the first `_stepToast` of this session: nothing has
          // been handed to the map yet, so `src` is a birth value and not a
          // measurement. A tool reading `src` must check this.
          stepped: this._fire.pos.lengthSq() > 0,
        },
        // The damped falloff, so a capture tool can prove `_dampHearth` ran
        // rather than inferring it from a frame that has three other things
        // wrong with it. `was` is what the fire itself asked for this frame.
        decay: this.camp?.fire?.light?.decay ?? 0,
        reach: this.camp?.fire?.light?.distance ?? 0,
        lightI: this.camp?.fire?.light?.intensity ?? 0,
        wasDecay: this._fireWas?.decay ?? 0,
        wasReach: this._fireWas?.distance ?? 0,
        wasI: this._fireWas?.intensity ?? 0,
      },
      stickLen: this.stickLen,
    };
  }

  /** The first roasting stick in the world, for `window.__roast.enter()`. */
  _anyStick() {
    for (const camp of this.ctx.systems?.camp?.camps ?? []) {
      for (const p of camp.props ?? []) {
        if (p.obj?.userData?.roast) return { obj: p.obj, camp };
      }
    }
    return null;
  }

  /** The camp a prop belongs to, when the caller did not say. */
  _campOf(prop) {
    for (const camp of this.ctx.systems?.camp?.camps ?? []) {
      for (const p of camp.props ?? []) if (p.obj === prop) return camp;
    }
    return null;
  }

  // ── writing into the toast map ─────────────────────────────────────────────
  //
  // The map's contract exposes its texture and its readings but no way to SET
  // them, and the ladder frames the critic loop is built on need exactly that.
  // Both of these therefore try the toast author's own hook first and fall back
  // to writing the `DataTexture` the contract already publishes — RGBA8, R =
  // toast, A = char, `rings` across and `bands` down. That is a reach into a
  // neighbour's data through their own public getter, and it is flagged in the
  // report: if the toast author would rather own it, these two methods become
  // one-line forwards and nothing else in this file changes.

  _setDoneness(k) {
    if (this.toast?.setDoneness) { this.toast.setDoneness(k); return; }
    const tex = this.toast?.texture;
    const img = tex?.image;
    if (!img?.data) return;
    const d = img.data;
    const char = Math.round(clamp01(smoothstep(0.80, 1.0, k)) * 255);
    const val = Math.round(clamp01(k) * 255);
    for (let i = 0; i < d.length; i += 4) { d[i] = val; d[i + 3] = char; }
    tex.needsUpdate = true;
  }

  _paint(u, v, r, a) {
    if (this.toast?.paint) { this.toast.paint(u, v, r, a); return; }
    const tex = this.toast?.texture;
    const img = tex?.image;
    if (!img?.data) return;
    const { data, width: W, height: H } = img;
    const val = clamp01(a);
    for (let y = 0; y < H; y++) {
      const vv = (y + 0.5) / H;
      for (let x = 0; x < W; x++) {
        const uu = (x + 0.5) / W;
        // `u` wraps: the map is a cylinder and a brush at u = 0.02 has to
        // reach round to u = 0.98 or the seam is a visible unpainted stripe.
        let du = Math.abs(uu - u);
        if (du > 0.5) du = 1 - du;
        const dv = vv - v;
        const dist = Math.hypot(du, dv);
        if (dist > r) continue;
        // Smooth brush, so a painted patch has an edge a toast ramp can work
        // with rather than a hard disc.
        const w = smoothstep(r, r * 0.25, dist);
        const i = (y * W + x) * 4;
        const cur = data[i] / 255;
        const next = lerp(cur, val, w);
        data[i] = Math.round(next * 255);
        data[i + 3] = Math.round(clamp01(smoothstep(0.80, 1.0, next)) * 255);
      }
    }
    tex.needsUpdate = true;
  }

  // ───────────────────────────────────────────────────────────────────────────

  dispose() {
    this._release();
    if (typeof window !== 'undefined' && window.__roast?.view === this) delete window.__roast;
    this.overlay.dispose();
    this._probeRT?.dispose();
    this._probeRT = null;
    this._imgA = this._imgB = null;
    this.toast?.dispose?.();
    this.mat?.dispose?.();
    for (const grp of [this.flame, this.burst, this.steam]) {
      if (!grp) continue;
      // A group of nested shells over one shared material — dispose each
      // geometry, and the material exactly once.
      grp.traverse((o) => o.geometry?.dispose?.());
      grp.userData.flameMat?.dispose?.();
      grp.userData.steamMat?.dispose?.();
    }
    this.held?.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      // The marshmallow's material is `this.mat`, disposed above; anything else
      // under the stick is the geometry author's own and is disposed here.
      if (o.material && o.material !== this.mat) o.material.dispose?.();
    });
    this.held = null;
    this.mallow = null;
    this.toast = null;
    this.mat = null;
    this.uniforms = null;
  }
}
