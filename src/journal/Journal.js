// ─────────────────────────────────────────────────────────────────────────────
//  Journal — the scavenger-hunt book, and the ceremony of opening it.
//
//  Public shape is the one in docs/HUNT_CONTRACT.md:
//
//      new Journal(ctx) · active · open({award}) · close() · toggle()
//      update(dt)  — REAL seconds, runs while the world is paused
//      render(renderer) — called immediately after postfx.render(dt)
//      dispose()
//
//  ── it is a 3D object drawn over the finished frame, not a DOM panel ───────
//  Its own scene, its own camera, its own lights, drawn straight to the canvas
//  after the post chain with the depth buffer cleared. That has three
//  consequences worth stating out loud because each one has a rule attached:
//
//   · No tone mapping and no grade. The main renderer runs NoToneMapping (the
//     post chain owns the curve), so what this scene puts in the framebuffer is
//     what the player sees, in sRGB. Every value here is authored for that. Do
//     not "fix" a dark book by raising a light past the point where the paper
//     clips — there is no highlight rolloff behind it to catch the overflow.
//     The paper's headroom is bought on the PAGE instead, by `PAPER_GAIN` in
//     journal_model.js; its header records the three levers that were rejected,
//     including why a shoulder on this overlay's own blit is not one of them.
//   · No Stylize, no Atmosphere. Those harvest the WORLD scene; this scene is
//     not in it. The book gets three's own PBR, which is why the leather's
//     roughness map is doing real work here and a camp prop's is not.
//   · Every renderer flag this touches is put back. `render()` is a borrowed
//     renderer in the middle of somebody else's frame — see its header for the
//     list, and for the two flags it deliberately does NOT touch because
//     changing them recompiles the entire world.
//
//  ── the ceremony ───────────────────────────────────────────────────────────
//  book rises → elastic slips off → cover swings open and the whole book lies
//  DOWN as it does (it starts held up facing you and ends flat on an imaginary
//  table, which is the beat that makes the open feel like a real gesture rather
//  than a hinge animating) → the flyleaf turns → if there is an award, the book
//  leafs to its page, the line is struck off in pencil, the box is ticked, the
//  photograph flies in and slaps down, and two pieces of tape go over it.
//
//  There is a SECOND ceremony on the same object, for the shutter's other
//  answer: photograph something already crossed off and the book leafs to a
//  blank leaf with that print beside the new one and asks which to keep. It
//  shares the first half of the timeline and then diverges — see the `CMP_*`
//  block for how the two interleave, which is "they cannot", and why.
//
//  Timings are in ONE table (`SCRIPT`) and every one of them is real seconds.
//  The first version drove the whole thing off `leaf`, `cover` and a pile of
//  ad-hoc `if (t > 1.3)` branches and it was unreadable within a day; the award
//  branch has a variable number of page turns in the middle of it, which is
//  what makes a scripted timeline worth the machinery.
//
//  ── input ──────────────────────────────────────────────────────────────────
//  While open, the journal owns the keyboard, the wheel and the pointer, and it
//  does that WITHOUT editing Input.js or HUD.js (it does not own them): it
//  listens in the CAPTURE phase on window and stops propagation, so the game's
//  own listeners — which are all on the bubble phase — never see the event.
//  `journal.wantsInput` is exported for the integrator so the HUD can also gate
//  itself; the capture listeners mean nothing breaks if it does not.
//
//  The verbs, in full:
//    click a print      go in on it (one move — the lean was removed, §15.3)
//    click elsewhere    turn to the page on that half of the frame
//    left drag          tilt and turn the book
//    middle drag        slide it
//    wheel              zoom
//    Escape / J / Enter square the book if it has been driven, else back out
//                      one level, else shut it
//    arrows / PgUp/Dn   the same, then turn a page
//  A press that moves more than `DRAG_SLOP` is a drag and never also a click,
//  which is why the click fires on pointerUP.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, mulberry32 } from '../core/MathUtils.js';
import { buildEnvMap } from '../vehicle/model_kit.js';
import { journalFontsReady } from './journal_fonts.js';
import {
  JournalPage, ROWS_PER_PAGE, loadPhoto, forgetPhoto, disposePaperCache,
} from './journal_page.js';
import {
  BOOK, buildJournal, poseJournal, setJournalPages, samplePage, disposeJournalMaterials,
  PAPER_GAIN,
} from './journal_model.js';
import { hunt, makeThumb } from '../game/hunt_store.js';

// ── the script ───────────────────────────────────────────────────────────────
// Every duration in the ceremony, in seconds, in one place. `gap` values are
// the pause BEFORE that beat starts, measured from the end of the previous one.
// The beat between the last award's tape settling and the book leafing on to
// the mystery leaf. Long enough to read as a separate thought rather than as
// part of the same animation — somebody finishing a list, sitting back, and
// then remembering the other thing.
const REVEAL_GAP = 0.9;

const SCRIPT = {
  rise: 0.60,
  bandGap: 0.16, band: 0.40,
  coverGap: -0.24, cover: 0.80,      // the cover starts before the rise settles
  flyleafGap: -0.18, flyleaf: 0.62,
  // Each extra page turn on the way to the award. 0.46 measured a 3.92 s
  // first-page ceremony and 5.42 s at the far end of the book, and 5.4 s is
  // where a beat stops being a beat and starts being a wait. Somebody riffling
  // to a page they know the number of does not turn it at reading speed.
  seekLeaf: 0.30,
  crossGap: 0.30, cross: 0.52,
  tickGap: -0.10, tick: 0.26,
  photoGap: 0.10, photo: 0.46,
  tapeGap: 0.06, tape: 0.34,
  close: 0.46,
};

// Framing. The camera never moves and the BOOK moves — for everything the book
// does on its OWN account, which is both cheaper to reason about and the right
// way round: a camera that swoops at a stationary object reads as a cutscene,
// and this is a thing the player picked up. The one exception is the free
// camera the player drives themselves (`PAN_*`), which moves the camera,
// because that is what a camera the player is holding is.
const CAM_POS = new THREE.Vector3(0, 0.255, 0.600);
const CAM_LOOK = new THREE.Vector3(0, -0.004, 0.005);
const CAM_FOV = 30;
// ── the framing has to survive a phone ────────────────────────────────────
// `CAM_FOV` is VERTICAL, so with only `camera.aspect` written the horizontal
// coverage shrinks with the window while the spread stays stubbornly two pages
// wide. Measured before this existed: 1.78 and 1.25 fine, 1.33 tight, and at
// 0.75 the heading was cut to "p Scavenger Hunt" — on the branch whose whole
// point is that the checklist IS the interface on a device with no keyboard.
//
// So the framing fits HORIZONTALLY below `DESIGN_AR` (the aspect the pose was
// composed at) and is untouched above it. The extra coverage is bought two
// ways, in this order:
//   · open the lens, up to `FOV_MAX`. This is a held object and some near-field
//     perspective is part of the read;
//   · past that, DOLLY THE CAMERA BACK instead. A 90-degree lens 600 mm from a
//     spread laid nearly flat turns the far page into a wedge, and a checklist
//     you have to read is the last place to spend perspective on drama.
// And the margin is not a constant either. At the design aspect the spread
// fills about two thirds of the width and the third that is left is the frame
// the book sits in; on a phone held upright the frame is nothing BUT margin,
// so the book is allowed to grow into it — to ~88% of the width — because the
// hint under each line has to stay readable and that is the whole feature.
const DESIGN_AR = 1.55;
const TIGHT_AR = 0.80;      // at and below this, the full margin is reclaimed
const TIGHT_MAX = 1.30;
const FOV_MAX = 54;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// The two poses the book blends between. `held` is what you are handed; `laid`
// is the book open on a table. See the ceremony note in the header.
const POSE_HELD = { pos: [0.012, 0.004, 0.055], rot: [-0.30, 0.44, -0.055], scale: 1.02 };
// `rot.x` was -1.005 (57.6 degrees), which left the page 34 degrees off
// face-on and the spread reading as a book seen across a table rather than one
// held up to read. -0.700 brings it 17.5 degrees back toward the reader.
// `PAN_SPREAD_FACE` below records the resulting angle and MUST move with it —
// the pitch clamp is expressed against the page's angle, so leaving it behind
// would let the player tilt 17 degrees past the old floor on one side and stop
// 17 short on the other.
const POSE_LAID = { pos: [0, 0.008, 0.0], rot: [-0.700, 0.0, 0.0], scale: 1.10 };

// ── clicking a print: one move, from the spread to the print ─────────────────
//
// Click a print and the book comes up toward you until the photograph is about
// 80% of the screen. It is still ON the book — the paper, the tape and the page
// around it stay in frame — because this is a close look at a print resting in
// a journal and not an image viewer. Escape, a page key, a wheel detent or a
// click anywhere goes back to the spread.
//
// ── this used to be two rungs, and is now one ──────────────────────────────
// *"Then get rid of the first zoom, clicking a photo takes you the close up
// only. Now that the user can zoom on their own."*
//
// The removed rung was the LEAN: the book came up centred on the row, and a
// second click on the same print came the rest of the way. Its argument was
// that a photograph sits beside its line rather than over it, so the entry and
// its picture are a pair and the pair is the subject. That argument is now
// answered by the free camera instead (`PAN_*`) — a player who wants to read
// the line beside the print can pan and zoom to it, and does not need a rung of
// a ladder authored for them. What is kept from the close look is everything
// that was measured: the contain-fit, the per-frame solve and `printPatch`.
//
// What is left is a two-state ladder: 0 the spread, 1 the print. Every way in
// or out still moves it by exactly one, so `_zoomTo` and `_studyK` are what
// they were with one fewer value to take.
//
//  · `STUDY_TILT` is added to the laid pose's `rotation.x`. The spread lies at
//    -1.005 rad, and the camera looks down at it from 23.5 degrees, which
//    leaves the page 34 degrees off face-on; -0.41 rad would be dead face-on.
//    0.42 takes about seventy per cent of that. Going the whole way was tried
//    and it is worse: a page exactly perpendicular to the lens has no
//    perspective in it at all and the book stops being an object in a room —
//    it becomes a texture, which is precisely the "reads as a UI panel" failure
//    the whole model is built to avoid. It is unchanged from the lean, which is
//    where it was authored: the rung that went away was the ZOOM stop, not the
//    angle, and the close look always inherited this exact tilt.
//  · `STUDY_LOOK` is where the print's centre is put, and the offset that puts
//    it there is recomputed from the LIVE posed page every frame rather than
//    baked at the click. That is what makes the blend work at all: at k = 0.5
//    the book is half-tilted and half-scaled, and the offset that centres the
//    print is not half the offset that centres it at k = 1.
//  · The BOOK scales, not the camera: `_fitCamera` owns the camera's position
//    and a second author of it is a fight, and the composition rule in this
//    file's header still holds — the book moves, the camera does not.
// 0.115 rad (6.6 degrees), down from 0.42 (24). This is ADDED to the laid
// pose's `rotation.x`, so it is not an angle in its own right — it is the
// distance from the spread to the close look, and the spread moved. From the
// old spread's 34 degrees off face-on, 24 landed the print at 10; from the new
// 16.6 it would land at MINUS 7.4, i.e. tilted past face-on and leaning away
// from the reader at the top, which is the one direction a page must never go.
// 6.6 keeps the close look where it was, at about 10 degrees.
const STUDY_TILT = 0.115;
const STUDY_LOOK = new THREE.Vector3(0, 0.004, 0.02);
// The print's own rect, grown a little, as the click target. 1.18 is about
// 10 mm of page all round at book scale — enough that a thumb on a phone does
// not have to be accurate to the millimetre, and small enough that the two
// prints on a page are still nowhere near each other.
const SLOT_PICK = 1.18;

// ── the close look: one more click, and the print fills the frame ────────────
//
// Click the print AGAIN while already leaning in and the book comes the rest of
// the way, until the photograph is about 80% of the screen. It is still ON the
// book — the paper, the tape and the page around it stay in frame — because
// this is a close look at a print resting in a journal and not an image viewer.
//
// ── what "80% of the screen" resolves to, and why it is not width ───────────
// The print is 36.4 x 27.5 mm on the page (a 252 x 190 px slot on a 148 x 210 mm
// leaf), i.e. **1.32:1 landscape**, and it has to sit inside anything from an
// ultrawide to a phone held upright. All three of the obvious readings of "80%"
// put it off the screen on some real display, and the numbers are worth writing
// down because they are the whole argument:
//
//   · 80% of the WIDTH — on 16:9 that is 0.80 x **1.07** of the frame. The top
//     and bottom of the photograph are outside the window.
//   · 80% of the HEIGHT — on a 700 x 1520 phone that is **2.30x** the width.
//   · 80% of the AREA — 0.77 x **1.04** on 16:9, and worse on the phone. It is
//     the only one of the three whose answer depends on the frame's aspect and
//     STILL bounds neither axis, which makes it the worst rather than the
//     cleverest.
//
// So `CLOSE_FILL` is 80% of whichever axis runs out first: the print's own
// projected box, largest side against the matching side of the frame. On 16:9
// that binds on the height and comes out 0.80 x 0.60; on phone portrait it
// binds on the width and comes out 0.80 x 0.28. Both leave at least a tenth of
// the frame of page and tape on every side, which is the "still on the book"
// half of the brief, and neither ever clips.
//
// It is a fit, not a fixed zoom, so it is SOLVED rather than authored — see
// `_trackCloseZoom`. The scale that satisfies it depends on the window's aspect
// (through `_fitCamera`'s lens and dolly), on which of the two pages the print
// is on and on where in the leaf's bend it sits, and a constant tuned at
// 1600x900 would be wrong at every other size. `CLOSE_ZOOM_MAX` is a guard rail
// against a bad measurement, not a design value; measured, the solve lands at
// 9.09x on 1600x900 and 7.93x on a 700x1520 phone, both a long way under it.
const CLOSE_FILL = 0.80;
const CLOSE_ZOOM_MAX = 40;
// ── how long the move takes, now that it is ONE move ────────────────────────
//
// It used to be two: 0.42 s out to the lean and 0.34 s from there to the print,
// with a stop between them. One click now covers the whole distance, so the
// question is whether the old timings still read over twice as far.
//
// Measured rather than felt. The scale is `lerp(1, closeZ, easeInOut(t))`, and
// this file's `easeInOut` is the 4t³ cubic whose slope peaks at **3x its mean**
// at the midpoint — so the peak rate of a move is 3 (end - start) / T. The eye
// reads a zoom multiplicatively, so the rate that matters is that divided by
// the scale it happens at. At 1600 x 900, where the fit solves to 9.095:
//
//                          peak d(scale)/dt    at scale    peak d(ln scale)/dt
//   the lean,  1 -> 2.55        11.1             1.78            6.2 /s
//   the close, 2.55 -> 9.09     57.7             5.82            9.9 /s
//   ONE move,  1 -> 9.095 @0.60 40.5             5.05            8.0 /s
//
// So 0.60 s is **19% gentler at its fastest than the move it replaces**, while
// covering the whole distance; matching the old close look's peak exactly would
// be 0.49 s. Confirmed against the real game rather than left as arithmetic —
// `_jsweep.mjs --TRACE=1` samples `_studyK`, the scale on the book and the fit's
// solve on rAF through the whole move, and the measured peak log rate is
// 7.9 /s against the 8.0 predicted here.
//
// Out is 0.52 by the same table (9.3 /s against the old 11.2 /s): coming back
// is a move to something you have already seen, so it is allowed to be brisker
// than going in, and it was in the old pair too (0.30 against 0.34).
const CLOSE_IN = 0.60;
const CLOSE_OUT = 0.52;
// Where the fit's solve STARTS, before it has measured anything. Not a design
// value and not a fallback — `_trackCloseZoom` overwrites it on the first frame
// it can measure and converges within a few — but the trajectory of the move
// is smoother the closer this is to the answer, and it is measurably 9.09 on
// 1600x900 and 7.93 on a 700x1520 phone. 8 is between them. The compare leaf
// seeds its own (1), because a whole page at 80% is 1.19x and 8 would send the
// book in and back out inside one move.
const CLOSE_ZOOM_SEED = 8;
// How long the pointer has to rest on a print before its detail patch is drawn.
// See `_hoverAt`. Long enough that sweeping across a spread does not raster
// every print on it, short enough that it is always done before the click:
// measured at 1600x900, a print's pick rectangle is 112 px across the screen at
// the spread, so a pointer would have to be travelling over 900 px/s to cross
// one inside this — about three times a comfortable mouse sweep.
const HOVER_ARM = 0.12;

// ── the player drives the book: pan, tilt and zoom ───────────────────────────
//
// *"add the ability to pan, tilt and zoom on the journal."*
//
// **The verbs are photo mode's, exactly.** `CameraRig._free` is the camera every
// player of this game already has in their hands, and the photo rail prints its
// three gestures on screen: left drag orbits, middle drag translates, the wheel
// dollies. Same three here, at the SAME sensitivities — 0.0042 rad per pixel of
// yaw, 0.0032 of pitch, `exp(deltaY * 0.0016)` on the dolly — so the muscle
// memory transfers rather than having to be relearned on one screen.
//
// **And it moves the CAMERA, not the book, which is a departure.** Everything
// else in this file moves the book and holds the camera still, on the argument
// in the header: a camera that swoops at a stationary object reads as a
// cutscene. That argument is about the CEREMONY's authored framing, and it does
// not survive contact with a free camera — the whole point of which is that it
// is the player's. It is also the only version that works: `_applyStudy`
// recentres the book by measuring where a point on the page has ended up and
// pushing it back to `STUDY_LOOK`, so a free transform on the book would be
// measured and cancelled on the very same frame. Tried first, and the book sat
// there refusing to move.
//
// So the free pose orbits, dollies and slides the CAMERA about `STUDY_LOOK` —
// the point the framing centres, which is the print at the close look and the
// middle of the spread otherwise — and every world-space thing in this file
// (`samplePage`, the patch placement, the picking) is untouched by it and
// follows for free.
//
// ── the clamps, and what each one is protecting ────────────────────────────
//
//  · `PAN_FACE_MIN` / `PAN_FACE_MAX` bound the PAGE's angle off face-on rather
//    than the camera's pitch, which is the thing that actually matters and the
//    only form of the clamp that composes with the close look's own tilt. At
//    the spread the page is 34 degrees off face-on (§13.1); `STUDY_TILT` takes
//    24 of those; so the range left to the player is computed per frame rather
//    than written down. It runs from **15 degrees PAST face-on** — far enough
//    to see the paper's tooth catch the light from the other side, not far
//    enough to be looking at the back of the leaf — to **65 degrees**, where
//    the spread is a steep oblique and the far page's hint text starts running
//    into the gutter shadow. Past either end the book stops being a book.
//  · `PAN_YAW_MAX` 0.6 rad (34 degrees) is where the far page of a spread is
//    foreshortened to cos 34 = 83% and its inner margin begins to disappear
//    into the fold. It is the same failure the gutter margin exists to prevent
//    (journal_page's header), arriving from the camera instead of the layout.
//  · `PAN_ZOOM_MIN` / `MAX` 0.55 and 3.0 are multipliers on whatever the
//    framing has already chosen. 0.55 at the spread puts the whole book in the
//    middle third of the frame with the scrim around it; 3.0 at the close look
//    is a print at 240% of the frame, which is past the point where the stored
//    photograph has anything left to give (§14.3: the emulsion is 878 CSS px on
//    a dpr-1 1600x900 against 1024 px of source, so 1.17x is where it becomes
//    an upscale). The ceiling is a comfort limit, not a resolution one — the
//    page's own ink holds up further than the photograph does.
//  · `PAN_EDGE` 0.9 keeps the point the framing centred inside 90% of the frame
//    from the middle. That is the clamp that stops a player panning the book
//    off the screen entirely and then having nothing on screen to pan back.
//
// **Getting back to square is one action.** Escape (and J, Enter, and both page
// keys) puts the book back before it does anything else — so the first press
// undoes the tumbling and the second does what it always did. It is only a rung
// when the pose is actually off square, past `PAN_SQUARE`, so a book nobody has
// touched behaves exactly as it did. Changing zoom level squares it too, which
// is why the two never happen in one keystroke.
const PAN_YAW_MAX = 0.60;
const PAN_FACE_MIN = -0.26;      // rad past face-on, toward the reader
const PAN_FACE_MAX = 1.14;       // rad off face-on, oblique
const PAN_SPREAD_FACE = 0.288;   // the spread's own 16.5 degrees, in radians
const PAN_ZOOM_MIN = 0.55;
const PAN_ZOOM_MAX = 3.0;
const PAN_EDGE = 0.90;
const PAN_HOME = 0.28;           // seconds to ease back to square
const PAN_SQUARE = 0.004;        // below this the pose counts as square
// How far a pointer may travel between down and up and still be a CLICK. Below
// this a drag is a click and the book turns a page when the player meant to
// tilt it; above it, a slow deliberate click on a print gets eaten. 4 px is the
// same threshold a browser uses to cancel a click into a drag.
const DRAG_SLOP = 4;
// Device pixels per page pixel in the detail patch (journal_page's
// `printPatch`), which is what makes the close look a view of the STORED photo
// rather than of the page texture — the argument is in `_detailPrepare` and the
// numbers are in docs/JOURNAL_NOTES.md 14.3. This is a ceiling, not a target:
// the scale actually used comes from the decoded photo's own width, and 4.7 is
// what a 1024 px one asks for (1024 / 220). A 512 px store would come out at
// 2.33 and never reach this.
const DETAIL_PX_MAX = 4.7;

// ── photographing something that is already in the book ──────────────────────
//
// *"If you take a photo that could go in the book, but already is, we should
// pull up the photo in a preview frame next to the old one and ask if they want
// it replaced."*
//
// The book opens on a blank leaf with the two prints taped side by side, the
// player hovers to say which and clicks to keep it, and the one they keep slaps
// down. `journal_page._paintCompare` owns the page; this file owns the two
// print quads over it, the pick and the beat.
//
// ── how it interleaves with the award ceremony ─────────────────────────────
// It does not, and it cannot: `hunt.award` returns true exactly once per item,
// so a shutter press is either an award or a replace and never both for the
// same id. Where a single frame holds two subjects — a deer at a waterfall —
// the shutter still ticks everything it finds and the AWARD wins the book, for
// the same reason the existing comment there gives: one ceremony per press.
// The replace is simply what the second-best outcome does with the book instead
// of nothing, which is what it did before.
//
// Inside this file the two share the timeline's first half (rise, cover,
// flyleaf, and however many turns it takes to reach the leaf) and then diverge:
// `_makeScript` gives a replace no cross/tick/photo/tape beats at all, because
// nothing is being crossed off. `hasSeek` rather than `hasAward` is what holds
// the clock while the destination leaf is worked out, since both need that and
// only one of them is an award.
//
// ── the numbers ───────────────────────────────────────────────────────────
//  · `CMP_TILT` is `STUDY_TILT`, deliberately the same lean the close look
//    uses. This is a page being read, and a second tilt for a second kind of
//    reading would be two answers to one question.
//  · `CMP_LIFT` is a fraction of the PRINT'S OWN measured width rather than a
//    distance, so the hover reads the same whatever scale the fit has put the
//    book at — 6% of a print is about 4 mm of page at the framing this lands
//    on, which is a print picked up off the paper rather than one floating.
//  · `CMP_DIM` is what the print you are NOT hovering falls to. 0.55 is dark
//    enough to be unmistakable at a glance and light enough that the player can
//    still see the photograph they are deciding against, which is the whole
//    point of showing them side by side.
//  · `CMP_SLAP` is the squash on the one that is kept, and it is the ceremony's
//    own `_flyPhoto` squash (0.075 over the tail of the move) so the two beats
//    are the same gesture. `journal.slap` fires with it, as the request asked.
const CMP_TILT = STUDY_TILT;
const CMP_LIFT = 0.06;
const CMP_GROW = 1.035;
const CMP_DIM = 0.55;
const CMP_HOVER = 0.11;      // seconds for the hover to ease in or out
const CMP_SLAP = 0.30;       // the chosen print settling onto the page
const CMP_HOLD = 0.34;       // and the beat before the book leafs back

const _UP = new THREE.Vector3(0, 1, 0);

const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** Overshoot-and-settle. The book arrives with a little weight. */
const easeBack = (t) => {
  const c = 1.34;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

/**
 * A small number in words, up to ninety-nine. `none` for zero, because the
 * progress line reads "none of eighteen found" and "zero" is a quantity where
 * this wants a word.
 */
const _ONES = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const _TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function _words(v) {
  const n = Math.max(0, Math.round(v || 0));
  if (n < 20) return _ONES[n];
  if (n < 100) return _TENS[(n / 10) | 0] + (n % 10 ? `-${_ONES[n % 10]}` : '');
  return String(n);
}

export class Journal {
  constructor(ctx) {
    this.ctx = ctx ?? {};
    this.onClose = null;             // integrator hook; called once, on close
    // Integrator hook, called whenever the target moves: `(id, subject)`, with
    // a null id when it was cleared. Same shape and same reason as `onClose` —
    // the book knows which line was ringed and has no business knowing that
    // there is a HUD to say so on.
    this.onTarget = null;

    this._active = false;
    this._visible = false;
    this._t = 0;                     // seconds into the current script
    this._script = null;
    this._closing = false;
    this._ready = false;
    this._pageErr = false;

    // Live pose, written by the script and read by `_apply`.
    this._pose = { lift: 0, cover: 0, band: 0, leaf: 0, scrim: 0 };
    // Where the player has leafed to by hand, and where the animation is going.
    this._leafFrom = 0;
    this._leafTo = 0;
    this._leafT = 1;

    // Leaning in on one entry. `_study` is the seat being read (null when the
    // whole spread is in frame), and there are now THREE levels rather than
    // two, so `_studyTo` is 0, 1 or 2 and `_studyK` is a continuous position
    // along that ladder: 0 the spread, 1 leaning in on the row, 2 the close
    // look at the print. One scalar rather than two blends because every pose
    // term is a piecewise function of it and every way in or out moves it by
    // exactly one — see `_zoomTo`. `_study` is kept while `_studyK` runs back
    // down to zero: the pose needs the row it is coming away FROM.
    this._study = null;
    this._studyTo = 0;
    this._studyK = 0;
    this._studyT = 1;
    this._studyFrom = 0;
    this._cursor = null;
    // The solved scale for the close look, and the scale actually on the book
    // this frame (which `_trackCloseZoom` divides by). Seeded at
    // `CLOSE_ZOOM_SEED` so the solve starts near its own answer rather than at
    // the spread's scale — see there.
    this._closeZ = CLOSE_ZOOM_SEED;
    this._zoomNow = 1;

    this._buildScene();
    this._bindInput();

    // Fonts, the store and the page paint all happen off the first frame. The
    // book itself is built synchronously because it is what `open()` needs in
    // the same tick if somebody opens it immediately.
    this._prep = this._prepare();
  }

  get active() { return this._active; }

  /** True while the journal should be taking keys, wheel and pointer. */
  get wantsInput() { return this._active; }

  /**
   * True while there is anything to DRAW — which is not the same as `active`.
   *
   * `close()` drops `active` on the frame the key is pressed and then runs a
   * 0.46 s drop-and-fade, so a caller that gates `render()` on `active` alone
   * (`src/main.js` does) never draws that animation and the book vanishes
   * instead of being put down. Gating on `journal.active || journal.visible`
   * is the one-word fix; the journal cannot make it itself, because `active`
   * also means "the journal owns the keyboard" and holding that through the
   * close would swallow the next keypress.
   */
  get visible() { return this._visible; }

  /** How many leaves the book has. Useful to the integrator for nothing; here for tests. */
  get sheets() { return this._sheets; }

  /** True once the fonts have loaded and every page has been painted once. */
  get ready() { return this._ready; }

  // ───────────────────────────────────────────────────────────────────────────
  //  Scene
  // ───────────────────────────────────────────────────────────────────────────

  _buildScene() {
    const scene = this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.05, 4);
    this.camera.position.copy(CAM_POS);
    this.camera.lookAt(CAM_LOOK);

    // ── lights ──────────────────────────────────────────────────────────────
    // Warm key from the upper left, cool fill from the right, warm rim from
    // behind: the design brief's complementary split, done with three lights
    // instead of with a shader, because this scene is outside Stylize's reach.
    // The rim is what separates the book's silhouette from a dark scrim; drop
    // it and the whole object goes flat against the background.
    const key = new THREE.DirectionalLight(0xfff0d6, 1.95);
    key.position.set(-0.62, 0.92, 0.72);
    const fill = new THREE.DirectionalLight(0x9db6ea, 0.40);
    fill.position.set(0.86, 0.16, 0.42);
    const rim = new THREE.DirectionalLight(0xffd6a0, 0.62);
    rim.position.set(0.22, -0.30, -0.95);
    const amb = new THREE.HemisphereLight(0xfff2dd, 0x5a4062, 0.58);
    scene.add(key, fill, rim, amb);
    this._lights = [key, fill, rim, amb];

    // ── the scrim ───────────────────────────────────────────────────────────
    // The world behind the book has to go down or the page is unreadable over
    // a sunlit meadow. It is drawn in the canvas rather than as a DOM overlay
    // because a CSS panel sits above the canvas and would therefore also cover
    // the book.
    //
    // It gets its OWN SCENE AND ITS OWN PASS, and that is not fussiness. A
    // transparent mesh inside the book's scene is drawn in three's transparent
    // queue, which runs entirely AFTER the opaque queue — so `renderOrder: -100`
    // does nothing at all and the scrim lands on top of the book. That is
    // exactly what the first version did, and the symptom (a book the colour of
    // the scrim, uniformly, with the type gone) reads as a lighting bug rather
    // than as a sort-order one, which is why it is worth this paragraph.
    this._scrimScene = new THREE.Scene();
    this._scrimCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._scrim = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({
        color: 0x140c18, transparent: true, opacity: 0, depthTest: false,
        depthWrite: false, toneMapped: false,
      }));
    this._scrim.frustumCulled = false;
    this._scrimScene.add(this._scrim);
    scene.add(this.camera);

    // ── the book ────────────────────────────────────────────────────────────
    this._bookRoot = new THREE.Group();
    this.book = buildJournal(mulberry32(0x0b00c), { colorway: 0, open: 0 });
    this._bookRoot.add(this.book);
    scene.add(this._bookRoot);
    this._J = this.book.userData.journal;

    // A little gradient environment so the leather and the elastic have
    // something to reflect. `scene.environment` rather than a per-material
    // envMap: it reaches every standard material in here for free, including
    // the ones the model made before this scene existed.
    const renderer = this.ctx.renderer ?? this.ctx.engine?.renderer;
    if (renderer) {
      try {
        this._maxAniso = renderer.capabilities?.getMaxAnisotropy?.() ?? 1;
        this._env = buildEnvMap(renderer);
        scene.environment = this._env;
      } catch (e) {
        console.warn('[journal] no environment map; leather will be flatter', e);
      }
    }

    // ── the photograph in flight ────────────────────────────────────────────
    // A single quad with an alpha print card drawn onto it. It exists so the
    // photo can arrive in 3D — flying, tumbling, overshooting and squashing on
    // impact — and is swapped for the flat version baked into the page texture
    // the moment it lands, so leafing away and back carries it.
    this._card = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      // NOT transparent, and NO alphaMap. The first version passed the card's
      // own canvas as `alphaMap` "so the corners could be cut" — alphaMap reads
      // the GREEN channel, so every dark pixel in the photograph became a hole
      // and the print arrived looking like a washed-out ghost of itself. The
      // card is a solid rectangle; it needs no alpha at all.
      //
      // It carries the PAGE's white point, scaled the same way and for the same
      // reason (journal_model.js `PAPER_GAIN`). Not decoration: this card is
      // swapped for the flat print baked into the page texture the instant it
      // lands, so if the two are exposed differently the photograph visibly
      // changes brightness at the moment of the slap — a pop on the one frame
      // the whole award beat is built around.
      new THREE.MeshStandardMaterial({
        color: new THREE.Color().setScalar(PAPER_GAIN),
        roughness: 0.88, metalness: 0,
        emissive: 0xfff2dc, emissiveIntensity: 0.12 * PAPER_GAIN, side: THREE.DoubleSide,
      }));
    this._card.visible = false;
    this._card.renderOrder = 5;
    this._card.frustumCulled = false;
    scene.add(this._card);
    this._cardCv = document.createElement('canvas');
    this._cardCv.width = 512; this._cardCv.height = 400;
    this._cardTex = new THREE.CanvasTexture(this._cardCv);
    this._cardTex.colorSpace = THREE.SRGBColorSpace;
    this._card.material.map = this._cardTex;
    this._card.material.emissiveMap = this._cardTex;

    this._pages = [];
    this._pageTex = [];
    this._sheets = 1;
    // The compare leaf (`CMP_*`): null unless the book is asking which of two
    // prints to keep. `_backTo` is the leaf it walks home to afterwards, and is
    // the only backward page seek in the file.
    this._cmp = null;
    this._cmpQuad = null;
    this._cmpTex = null;
    this._cmpUV = null;
    this._cmpSquash = 0;
    this._backTo = null;
    // The print the pointer is resting on, and how long it has rested. See
    // `_hoverAt`: this is what arms the detail patch a beat before the click.
    this._hoverKey = null;
    this._hoverSeat = null;
    this._hoverT = 0;
    // The player's own framing, on top of whatever the ladder has chosen. See
    // the `PAN_*` block: it moves the CAMERA about `STUDY_LOOK`, so nothing
    // that reads a world matrix has to know it exists. `home` runs it back to
    // square, which is what Escape does first if it is not.
    this._pan = { yaw: 0, pitch: 0, zoom: 1, x: 0, y: 0 };
    this._panFrom = null;
    this._panT = 1;
    // Pointer bookkeeping: a drag has to be told from a click, or every tilt
    // also turns a page.
    this._ptr = { down: false, btn: 0, x: 0, y: 0, moved: 0, drag: false };
    this._size = new THREE.Vector2();
    this._dbSize = new THREE.Vector2();
    this._clearCol = new THREE.Color();
    this._fitAR = -1;
    this._vp = new THREE.Vector4();
    this._sc = new THREE.Vector4();
    this._tmpP = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._from = new THREE.Vector3();
    this._lift = new THREE.Vector3();
    this._q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0.6, 0.9));

    this.camera.updateMatrixWorld(true);
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Pages
  // ───────────────────────────────────────────────────────────────────────────

  async _prepare() {
    await journalFontsReady();
    this._buildPages();
    await this._decorate({ force: true });
    this._ready = true;
    // The hunt can be awarded from outside the journal — the integrator may
    // call `hunt.award()` itself on the shutter, and the store evicts old
    // photos on its own when localStorage fills. Repainting six pages costs
    // six leaves, so it is deferred to the next `open()` rather than done
    // here: this fires while the player is driving.
    this._unsub = hunt.onChange?.(() => { this._storeDirty = true; });
  }

  /**
   * Lay the hunt out as leaves.
   *
   * Reading order: page 0 is the flyleaf (a recto), page 1 is the first
   * checklist page (a verso), and so on. `verso` is simply "odd index", which
   * is what makes the fold land on the correct side of every page with no
   * bookkeeping — see journal_page.js's header for why the side matters.
   */
  _buildPages() {
    for (const p of this._pages) p.dispose();
    const items = hunt.items ?? [];
    const nList = Math.max(1, Math.ceil(items.length / ROWS_PER_PAGE));
    const specs = [];

    specs.push({ kind: 'title', index: null, seed: 1, rows: [] });
    for (let k = 0; k < nList; k++) {
      const rows = items.slice(k * ROWS_PER_PAGE, (k + 1) * ROWS_PER_PAGE).map((it) => ({
        id: it.id,
        subject: it.subject ?? it.id,
        hint: it.hint ?? '',
        done: hunt.isDone(it.id),
        photo: null,
        pending: false,
        // Can this line be gone looking for, and is it the one being looked
        // for? `_decorate` refreshes both — this is only the first paint.
        track: this._canTrack(it.id),
        target: hunt.target === it.id,
      }));
      specs.push({
        kind: 'list',
        index: k + 1,
        heading: k === 0 ? 'Camp Scavenger Hunt' : null,
        progress: k === 0 ? this._progressLine() : null,
        rows,
        seed: 2 + k,
      });
    }
    specs.push({ kind: 'notes', index: nList + 1, seed: 9, rows: [] });

    // ── the mystery leaf ─────────────────────────────────────────────────────
    //
    // Always in the block, whether or not it has anything on it — that is the
    // whole trick. `journal_page` paints it as an ordinary Notes leaf until the
    // sheet is finished, so a player who leafs to the back BEFORE finishing
    // finds blank paper, and the same page later has writing on it. A leaf that
    // appeared out of nowhere would be a page count changing under somebody's
    // hands; a leaf that was always there and is now written on is a book.
    //
    // Padded to land on a RECTO (an even index — page 0 is the flyleaf and is a
    // right-hand page). The eye lands on the right-hand page of a spread, and
    // this is the one leaf in the book that has to be noticed rather than
    // looked up. Computed rather than written down because it moves the moment
    // anybody adds a nineteenth checklist line.
    const myst = hunt.mystery;
    if (myst) {
      let pad = 0;
      while (specs.length % 2 !== 0) {
        specs.push({ kind: 'notes', index: nList + 2 + pad, seed: 11 + pad, rows: [] });
        pad++;
      }
      specs.push({
        kind: 'mystery',
        index: nList + 2 + pad,
        seed: 21,
        open: hunt.mysteryOpen,
        rows: [{
          id: myst.id, subject: myst.subject ?? myst.id, hint: myst.hint ?? '',
          done: hunt.isDone(myst.id), photo: null, pending: false,
          track: false, target: false,
        }],
      });
    }

    // A leaf has two sides. Pad so the last one is not half a sheet — the
    // physical block would show a page with nothing behind it.
    if (specs.length % 2) specs.push({ kind: 'notes', index: nList + 9, seed: 10, rows: [] });

    this._pages = specs.map((s, i) => new JournalPage({ ...s, verso: i % 2 === 1 }));
    this._pageTex = this._pages.map((p) => p.texture);
    this._sheets = Math.max(1, Math.ceil(this._pages.length / 2));
    // Which page (and row) each item lives on, so an award can find its seat.
    this._seat = new Map();
    for (let k = 0; k < nList; k++) {
      const page = this._pages[1 + k];
      page.spec.rows.forEach((r, i) => this._seat.set(r.id, { page: 1 + k, row: i }));
    }
    // …and the mystery, which is row 0 of its own leaf. Seated through the same
    // map as every other line precisely so the award ceremony does not have to
    // know it is special: the book leafs to it, strikes the line, ticks the box
    // and tapes the print with the code that does that for the rabbit.
    this._mysteryPage = null;
    for (let i = 0; i < this._pages.length; i++) {
      if (this._pages[i].spec.kind !== 'mystery') continue;
      this._mysteryPage = i;
      this._seat.set(this._pages[i].spec.rows[0].id, { page: i, row: 0 });
    }
  }

  /**
   * Can this line be made the target — is there a system that could point at
   * it if the player asked?
   *
   * Asked of `Wildlife` rather than answered here, because the honest answer
   * changes when the cast does and this file should not be a second list of
   * animals that has to be kept in step with the first. It covers the wild
   * mammals and the perch-and-fly birds; a bald eagle is the same kind of thing
   * to go and find as a bear, and is treated as one.
   *
   * Everything else on the sheet comes back false and simply draws no ring: the
   * waterfall and the high camp are already compass landmarks, the camp dog's
   * camp is a permanent pin, and the Moon needs no help being found.
   */
  _canTrack(id) {
    return !!this.ctx.systems?.wildlife?.canTrack?.(id);
  }

  /**
   * "three of eighteen found", under the heading, in words.
   *
   * Words rather than digits because the page is hand-lettered and a numeral in
   * the middle of it reads as a receipt. Which means the list has to reach as
   * far as the sheet is long: it stopped at 'sixteen' and the sky items took the
   * hunt to eighteen, so every incomplete line read "three of 18 found" — half
   * written out, half not, in the one place on the page a player looks to see
   * how they are doing.
   *
   * Built to twenty rather than extended by two, and `_words` composes past
   * that, so the next item added does not reintroduce this. The digit fallback
   * stays for a sheet longer than the words can reach, because a slightly ugly
   * number is better than `undefined of undefined`.
   */
  _progressLine() {
    const n = hunt.doneCount?.() ?? 0, t = hunt.total ?? 0;
    return n >= t && t > 0 ? 'all of them found' : `${_words(n)} of ${_words(t)} found`;
  }

  /**
   * Bring the pages back in line with the store, and repaint the ones that
   * actually moved.
   *
   * Called from `open()`, which is a moment the player is watching an
   * animation, so it repaints only the leaves whose rows disagree with the
   * store (plus the one carrying the progress line, if the count changed) and
   * waits a frame between leaves so two repaints never land in one. The cost
   * that motivated all that was measured at "~40 ms a leaf" and is really
   * ~2.5 ms (Chromium defers 2D raster — see journal_page.js's header); the
   * discipline is kept because it is free, not because it is load-bearing.
   */
  async _decorate({ force = false } = {}) {
    const jobs = [];
    const dirty = new Set();
    const count = hunt.doneCount?.() ?? 0;
    if (force) {
      // Everything, including the title and notes leaves — they have no rows,
      // so the row loop below never reaches them, and a leaf that is never
      // painted is a TRANSPARENT canvas, which renders as a solid black page.
      for (let i = 0; i < this._pages.length; i++) dirty.add(i);
    } else if (count !== this._paintedCount) {
      // The progress line lives on the first list page and nowhere else.
      for (let i = 0; i < this._pages.length; i++) {
        if (this._pages[i].spec.progress != null) dirty.add(i);
      }
    }
    this._paintedCount = count;

    for (let i = 0; i < this._pages.length; i++) {
      const p = this._pages[i];
      // The one page whose KIND can change under the player. Checked before the
      // row loop because the row it carries is invisible until this flips, and
      // a leaf repainted for a row change while still in its blank state would
      // paint the entry onto a page that is meant to be empty.
      if (p.spec.kind === 'mystery') {
        const open = hunt.mysteryOpen;
        if (open !== p.spec.open) {
          // …and the transition itself is the reveal. Latched here rather than
          // tested in `update` against some "is the sheet finished" condition,
          // because THIS is the frame it became true on and every later frame
          // it is still true. `update` consumes the flag once and clears it.
          if (open && p.spec.open === false) this._revealPending = true;
          p.spec.open = open;
          dirty.add(i);
        }
      }
      for (const row of p.spec.rows ?? []) {
        const done = hunt.isDone(row.id);
        const url = done ? hunt.photoFor(row.id) : null;
        // The ring, for the book being opened with a target already set — from
        // a previous session, or from before it was last shut. Aiming at a row
        // with the book OPEN does not come through here; see `_repaintTargets`
        // for why that one is not routed through the store's change event.
        const target = hunt.target === row.id;
        const track = this._canTrack(row.id);
        if (force || done !== row.done || (!!url !== !!row.photo)
            || target !== row.target || track !== row.track) dirty.add(i);
        row.target = target;
        row.track = track;
        row.done = done;
        if (!done) { row.photo = null; continue; }
        jobs.push(loadPhoto(url).then((im) => { row.photo = im; }));
      }
    }
    await Promise.all(jobs);

    for (const i of dirty) {
      const p = this._pages[i];
      if (p.spec.progress != null) p.spec.progress = this._progressLine();
      try { p.paint(); } catch (e) {
        if (!this._pageErr) { this._pageErr = true; console.error('[journal] page paint failed', e); }
      }
      // One leaf per frame, so six repaints never land in one tick on the
      // frame the book is rising.
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Opening
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * @param award { id, photoDataURL|photo, replace } | null
   *
   * With an award the full ceremony runs, including however many page turns it
   * takes to reach the item's own page. With none, the book opens to the
   * checklist and stops. With `replace: true` — the shutter's answer to "this
   * one is already crossed off" — the book leafs to a blank leaf and asks which
   * of the two prints to keep instead; see the `CMP_*` block.
   *
   * @param holdTitle Skip the scripted flyleaf turn, so the ceremony rests on
   * the title leaf instead of skipping past it to the checklist. Only HUD's
   * one-time first-run popup passes this; every other caller wants the
   * checklist. See `HUD.maybeShowIntro`.
   *
   * `photo` is accepted alongside `photoDataURL` and is anything `drawImage`
   * takes. It is converted HERE, synchronously, and not one turn of the event
   * loop later: the shutter's thumbnail canvas is a single reused scratch
   * canvas (`hud_photo`'s `_thumbCanvas`), so the next press overwrites it, and
   * everything below this line is a promise. That is the same class of bug as
   * the black print in §6 of the notes — if you did not read it in this task,
   * it is not there.
   */
  open({ award = null, holdTitle = false } = {}) {
    if (this._active && !this._closing) return;
    // Which OPENING this is. `_armAward` and `_armCompare` are promises — they
    // wait on the font load, the store and a photo decode — and a book that is
    // shut and reopened before one of them lands would otherwise have the old
    // session's answer written into the new one: `_awardLeaf` from an award
    // that is over (which queues page turns to a spread nobody asked for), and
    // `_cmp` onto a book with no comparison to make.
    this._gen = (this._gen ?? 0) + 1;
    this._active = true;
    this._visible = true;
    this._closing = false;
    this._t = 0;
    // The one-time first-run open: the cover still rises and swings open, but
    // the scripted flyleaf turn that would otherwise flip straight past the
    // title into the checklist (see the docstring above) is held off, so the
    // ceremony's rest state is the page a brand-new player needs to read.
    this._holdTitle = holdTitle;
    this._pose.leaf = 0;
    this._leafFrom = this._leafTo = 0;
    this._leafT = 1;
    this._leafDur = SCRIPT.seekLeaf;
    // A book opened from shut is a book at the spread. Snapped rather than
    // eased: there is nothing on screen yet to ease from.
    this._detailDrop();
    this._study = null;
    this._studyTo = this._studyK = 0;
    this._studyT = 1;
    this._closeZ = CLOSE_ZOOM_SEED;
    // Every latch the ceremony sets, reset in one place. Forgetting one of
    // these is how the second open of a session skips a beat.
    this._seatOf = null;
    this._awardLeaf = null;
    this._seekPad = null;
    this._seekDone = false;
    this._seekQueue = 0;
    this._seekExtra = 0;
    // NOT cleared here. The reveal is latched by `_decorate`, which runs from
    // this same method one turn of the event loop later — zeroing it on open
    // would race the thing that sets it.
    this._coverCued = false;
    this._crossStarted = false;
    this._crossed = false;
    this._ticked = false;
    this._slapped = false;
    this._taped = false;
    this._bakedPhoto = false;
    this._card.visible = false;
    this._cmpDrop();
    this._backTo = null;
    this._hoverAt(null);
    this._panReset();

    // The shutter's scratch canvas has to become a string before the first
    // await; see the header of this method.
    const a = award?.id
      ? { id: award.id, replace: !!award.replace,
          photoDataURL: award.photoDataURL
            ?? (award.photo ? makeThumb(award.photo) : null) }
      : null;

    // The store may or may not already know about this award — photo mode is
    // free to call `hunt.award()` itself before opening the book, and the
    // reference wiring does. Either way the ROW has to be re-armed as pending
    // so the pencil animates instead of the page simply being repainted with
    // the line already struck, which is the whole point of the ceremony.
    // Anything that happened to the store while the book was shut, first.
    if (this._storeDirty) {
      this._storeDirty = false;
      this._prep.then(() => this._decorate()).catch(() => {});
    }
    const gen = this._gen;
    this._prep.then(() => (a?.replace ? this._armCompare(a, gen) : this._armAward(a, gen)))
      .catch(() => {});
    this._script = this._makeScript(a);
  }

  async _armAward(award, gen) {
    if (gen != null && gen !== this._gen) return;
    if (!award?.id) { this._seatOf = null; return; }
    const seat = this._seat?.get(award.id);
    this._seatOf = seat ?? null;
    if (!seat) {
      // An id the hunt does not know about. The book still opens, and the
      // timeline still has to be released — `_awardLeaf` is what un-gates it.
      console.warn(`[journal] awarded "${award.id}" is not on any page`);
      this._awardLeaf = 1;
      return;
    }
    hunt.award(award.id, award.photoDataURL ?? null);
    const page = this._pages[seat.page];
    const row = page.spec.rows[seat.row];
    row.done = true;
    row.pending = true;                 // painted un-struck; the script strikes it
    // `hunt.award` clears a target it satisfies; this is the row's copy of that,
    // so the ring comes off on the same paint the tick goes on.
    row.target = false;
    row.photo = await loadPhoto(award.photoDataURL ?? hunt.photoFor(award.id));
    if (gen != null && gen !== this._gen) return;
    for (const p of this._pages) if (p.spec.progress != null) p.spec.progress = this._progressLine();
    // The spread the award lives on, BEFORE the paint. Page p is on spread
    // ceil(p/2) — see journal_page.js: page 0 is alone on the right of the
    // first spread. It is assigned first because it is what un-gates the clock
    // (see `update`), and a throw below it would otherwise hold the ceremony at
    // the top of the rise for ever with the rejection swallowed by `open`'s
    // `.catch`. That is the difference between a missing print and a book that
    // never finishes opening.
    this._awardLeaf = Math.ceil(seat.page / 2);
    try { page.paint(); } catch (e) {
      if (!this._pageErr) { this._pageErr = true; console.error('[journal] page paint failed', e); }
    }
    this._drawCard(row.photo);
  }

  /**
   * Set up the "which of these two" leaf, and point the seek at it.
   *
   * Runs in place of `_armAward` when the shutter reports a subject that is
   * already crossed off. Everything it needs is in hand by the time the cover
   * is open: the incoming thumbnail (a string by now — see `open`), the one the
   * store is already holding, and a blank leaf to lay them both on.
   *
   * **The leaf is borrowed, not built.** `spec.compare` is an overlay on the
   * Notes leaf that `paint()` draws instead of the notes, and `_cmpRestore`
   * takes it off again. Adding a real page for this would change `sheets`,
   * which changes the fore edge and the stack split for every book in the game
   * including the one on the camp table, to carry a page that exists for four
   * seconds every few sessions.
   *
   * Anything missing — an id off the sheet, no incoming photo, no blank leaf —
   * falls back to opening the book normally. `_awardLeaf` still has to be set
   * either way: it is what releases the clock.
   */
  async _armCompare(a, gen) {
    if (gen != null && gen !== this._gen) return;
    const seat = this._seat?.get(a.id);
    const leaf = this._pages.findIndex((p) => p.spec.kind === 'notes');
    if (!seat || leaf < 0 || !a.photoDataURL) {
      if (!seat) console.warn(`[journal] cannot compare "${a.id}"; not on any page`);
      this._awardLeaf = 1;
      return;
    }
    const [current, incoming] = await Promise.all([
      loadPhoto(hunt.photoFor(a.id)), loadPhoto(a.photoDataURL),
    ]);
    // The book may have been shut and reopened while those decoded. Give the
    // candidate's decode back before dropping it — see `_cmpDrop`.
    if (gen != null && gen !== this._gen) { forgetPhoto(a.photoDataURL); return; }
    // Nothing to compare AGAINST is not a comparison. The line was crossed off
    // with no picture, or the store evicted it to make room (`hunt_store`'s
    // ladder, rung 2) — in which case the honest thing is to just take the new
    // photograph, which is what the player was trying to do.
    if (!incoming || !current) {
      this._awardLeaf = Math.ceil(seat.page / 2);
      if (incoming) {
        hunt.setPhoto(a.id, a.photoDataURL);
        const row = this._pages[seat.page].spec.rows[seat.row];
        row.photo = incoming;
        try { this._pages[seat.page].paint(); } catch (e) {
          if (!this._pageErr) { this._pageErr = true; console.error('[journal] page paint failed', e); }
        }
      }
      return;
    }
    const page = this._pages[leaf];
    this._cmp = {
      id: a.id, url: a.photoDataURL, seat, page: leaf,
      img: [current, incoming],
      hover: -1, ease: [0, 0], chosen: null, t: 0, up: false,
    };
    page.spec.compare = {
      subject: this._pages[seat.page].spec.rows[seat.row]?.subject ?? a.id,
      hover: -1,
    };
    this._awardLeaf = Math.ceil(leaf / 2);
    try { page.paint(); } catch (e) {
      if (!this._pageErr) { this._pageErr = true; console.error('[journal] compare paint failed', e); }
    }
  }

  /** True while the book is asking which of two prints to keep. */
  get comparing() { return !!this._cmp; }

  /**
   * Build the timeline. Every beat is `{ key, t0, dur }` and `_at(key)` reads
   * one back as 0..1, so `update` has no branches in it at all.
   */
  _makeScript(award) {
    const S = SCRIPT;
    const beats = [];
    let t = 0;
    const add = (key, gap, dur, extra) => {
      t += gap;
      beats.push({ key, t0: t, dur, ...extra });
      t += dur;
      return beats[beats.length - 1];
    };
    add('rise', 0, S.rise);
    add('band', S.bandGap - S.rise, S.band);       // overlaps the rise
    t = S.rise;
    add('cover', S.coverGap, S.cover);
    add('flyleaf', S.flyleafGap, S.flyleaf, { from: 0, to: 1 });
    // Extra turns to reach the award's spread. Unknown until `_armAward` has
    // run, so the script is built for the worst case and the turns it does not
    // need are collapsed to zero length in `_seekBeats`.
    this._seekAt = t;
    // A REPLACE gets the seek and nothing after it. There is no line to strike,
    // no box to tick and no photograph to fly in — the two prints are already
    // on the leaf when the book arrives at it, and what happens next is the
    // player's move rather than the ceremony's. `hasSeek` is what the clock
    // waits on (both cases have to know which leaf they are going to before the
    // turns can be counted); `hasAward` stays the name for "there are beats
    // after the seek", which is what every other reader of it means.
    if (award && !award.replace) {
      add('cross', S.crossGap, S.cross);
      add('tick', S.tickGap, S.tick);
      add('photo', S.photoGap, S.photo);
      add('tape', S.tapeGap, S.tape);
    }
    return { beats, end: t, hasAward: !!award && !award.replace, hasSeek: !!award };
  }

  /** Progress 0..1 through a named beat, clamped, 0 before and 1 after. */
  _at(key) {
    const b = this._script?.beats.find((x) => x.key === key);
    if (!b) return 0;
    return clamp01((this._t - b.t0 - this._seekShift(b)) / b.dur);
  }

  /** How far a beat is pushed back by the page turns on the way to the award. */
  _seekShift(b) {
    if (!this._seekPad) return 0;
    return b.t0 >= this._seekAt ? this._seekPad : 0;
  }

  close() {
    if (!this._active) return;
    this._active = false;
    this._closing = true;
    this._t = 0;
    // Where the cover was when the player shut the book — the put-down eases
    // FROM here, and it has to be captured rather than accumulated. See the
    // decay in `update`.
    this._closeCover = this._pose.cover;
    // The put-down animation is 0.46 s of a book dropping away, and it drops
    // away from the SPREAD. Eased out over the close rather than snapped, so a
    // player who shuts the book while leaning in sees it go back and go down as
    // one movement instead of jumping a hand's width first — and CAPPED at the
    // put-down's own length, because from the close look it is two levels and
    // the ease would otherwise still be running when the book stops being
    // drawn. See `_zoomTo`.
    this._zoomTo(0, SCRIPT.close);
    // The compare leaf is BORROWED. Shutting the book on an unanswered question
    // keeps the print that is in the book — the same answer Escape gives, for
    // the same reason — and the Notes leaf has to be handed back either way, or
    // the next time anyone leafs to the end of the book they find somebody
    // else's two photographs on it.
    this._cmpDrop();
    this._backTo = null;
    this._hoverAt(null);
    // Eased, not snapped, and for the same reason the zoom is: the book goes
    // back and goes down as one movement. `PAN_HOME` (0.28 s) fits inside the
    // put-down's 0.46 s with room to spare.
    this.panHome();
    this._cursorTo('');
    this.onClose?.();
  }

  toggle() { this._active ? this.close() : this.open(); }

  // ───────────────────────────────────────────────────────────────────────────
  //  Update
  // ───────────────────────────────────────────────────────────────────────────

  update(dt) {
    if (!this._visible) return;
    const d = Math.min(dt || 0, 1 / 15);

    // The ceremony cannot pass the point where it needs to know WHICH page the
    // award is on until `_armAward` has resolved (it awaits the font load, the
    // store and a photo decode). Holding the clock is better than either
    // guessing the page or letting the beats fire against a half-built book —
    // in practice the wait is one or two frames and nobody sees a hold at the
    // top of a rise animation.
    const gated = this._script?.hasSeek && this._awardLeaf == null &&
                  this._t >= this._seekAt - 0.02;
    if (!gated) this._t += d;

    if (this._closing) {
      const k = clamp01(this._t / SCRIPT.close);
      this._pose.lift = 1 - easeInOut(k);
      // An assignment, like the two lines around it — NOT `*=`.
      //
      // It used to multiply the ACCUMULATED value by an absolute-progress
      // factor on every frame, so the decay compounded and the cover's real
      // curve depended on how many frames the 0.46 s took: measured, it was
      // under 20% closed by the halfway point where the expression reads as
      // 55%, and faster again at 120 Hz. `lift` and `scrim` on either side of
      // it were already plain functions of `k`; this one was the odd one out
      // and the only reason it looked right is that it was always too fast in
      // the same direction.
      this._pose.cover = (this._closeCover ?? this._pose.cover) * (1 - easeInOut(k) * 0.9);
      this._pose.scrim = 1 - k;
      this._card.visible = false;
      if (k >= 1) { this._visible = false; this._closing = false; }
      this._apply(d);
      return;
    }

    // The number of extra page turns is only known once the award has been
    // seated (a promise), so the pad is computed here rather than in open().
    if (this._awardLeaf != null && this._seekPad == null) {
      const extra = Math.max(0, this._awardLeaf - 1);
      this._seekPad = extra * SCRIPT.seekLeaf;
      this._seekExtra = extra;
    }

    this._pose.lift = easeBack(clamp01(this._at('rise')));
    this._pose.band = easeInOut(this._at('band'));
    const cv = this._at('cover');
    // The cover coming off the text block is the loudest thing in the ceremony
    // and it is LEATHER AND BOARD, not paper. It used to borrow `journal.page`
    // because that was one of the three voices `src/audio/journal_audio.js`
    // shipped, which meant the biggest beat in the feature spoke with a paper
    // rustle 0.6 s before the first actual page turn — two rustles where there
    // should be a creak and then a rustle. It now asks for its own name;
    // `Audio.cue` is a no-op on a name it does not know, so the worst case
    // until that voice is written is silence on one beat rather than the wrong
    // sound on the one everybody hears.
    if (cv > 0 && !this._coverCued) { this._coverCued = true; this._cue('cover'); }
    this._pose.cover = easeInOut(cv);
    this._pose.scrim = clamp01(this._at('rise') * 1.6);

    // ── leafing ─────────────────────────────────────────────────────────────
    // The flyleaf beat, then one beat per extra turn on the way to the award,
    // then whatever the player does by hand. All three write `_leafFrom/To/T`,
    // so there is exactly one place that turns a page.
    const fly = this._at('flyleaf');
    if (!this._holdTitle && fly > 0 && fly < 1 && this._leafT >= 1 && this._pose.leaf < 1) {
      this._leafFrom = 0; this._leafTo = 1; this._leafT = 0;
      this._leafDur = SCRIPT.flyleaf;
      this._cue('page');
    }
    if (this._seekPad != null && !this._seekDone && fly >= 1) {
      this._seekDone = true;
      this._seekQueue = this._seekExtra;
    }
    if (this._seekQueue > 0 && this._leafT >= 1) {
      this._seekQueue--;
      this._leafFrom = this._pose.leaf;
      this._leafTo = Math.round(this._pose.leaf) + 1;
      this._leafT = 0;
      this._leafDur = SCRIPT.seekLeaf;
      this._cue('page');
    }
    // ── the reveal ──────────────────────────────────────────────────────────
    //
    // The eighteenth line has just been crossed off, so there is a nineteenth
    // now, on a leaf that was blank last time anybody looked at it. Leafing to
    // it is not decoration: `_paintMystery`'s whole effect is a page the player
    // has already seen empty, and that only lands if they are shown it rather
    // than left to find it three sessions later.
    //
    // It rides the ordinary forward-seek queue above — same one turn at a time,
    // same page cue, same "everything else is locked out while a scripted turn
    // is running" — and waits for the award ceremony it follows to be
    // completely over first. `_seekQueue` is what the rest of the file tests to
    // know a turn is scripted, so borrowing it means nothing else has to learn
    // about this beat at all.
    if (this._revealPending && this._mysteryPage != null
        && this._seekQueue === 0 && this._leafT >= 1 && fly >= 1
        && this._t >= (this._script?.end ?? 0) + (this._seekPad ?? 0) + REVEAL_GAP) {
      // Clamped to the block. `_seekQueue` is a countdown of one-page turns
      // with nothing watching where they land, so a target past the last leaf
      // would turn pages that are not there, for ever, with every other
      // interaction locked out behind `_seekQueue > 0`.
      const to = Math.min(Math.ceil(this._mysteryPage / 2), this._sheets - 1);
      const at = Math.round(this._pose.leaf);
      if (at < to) this._seekQueue = to - at;
      else this._revealPending = false;
    }
    // Leafing HOME from the compare leaf, one turn at a time and through the
    // same three fields every other page turn writes. The compare lives at the
    // back of the book (the Notes leaf) and the entry it is about is near the
    // front, so this is the only backward seek in the file; it is a queue of
    // one-step moves rather than a single long turn because a book turns pages,
    // it does not scrub.
    // …and it waits for the book to be BACK DOWN first (`_studyK` at zero).
    // Turning a page while the reader is still zoomed onto that page moves the
    // thing they are looking at out from under them, and `_applyStudy` is
    // meanwhile recentring on a leaf that is in flight.
    if (this._backTo != null && this._studyK <= 0.0002
        && this._seekQueue === 0 && this._leafT >= 1) {
      const at = Math.round(this._pose.leaf);
      if (at > this._backTo) {
        this._leafFrom = this._pose.leaf;
        this._leafTo = at - 1;
        this._leafT = 0;
        this._leafDur = SCRIPT.seekLeaf;
        this._cue('page');
      } else this._backTo = null;
    }
    if (this._leafT < 1) {
      this._leafT = clamp01(this._leafT + d / Math.max(0.05, this._leafDur));
      this._pose.leaf = lerp(this._leafFrom, this._leafTo, easeInOut(this._leafT));
      if (this._leafT >= 1) this._pose.leaf = this._leafTo;
    }

    // The pose has to be on the book BEFORE the photograph looks for the page
    // it is landing on: `samplePage` reads a world matrix, and a matrix that is
    // one frame stale puts the photo a visible millimetre off the paper on the
    // exact frame it touches down.
    this._apply(d);

    // The pointer's dwell on a print, which is what arms its detail patch.
    this._hoverTick(d);

    // The compare leaf, after `_apply` for the same reason the award beats are:
    // it places two quads with `samplePage` and needs the pose already on the
    // book. It runs INSTEAD of the award beats below — never alongside them,
    // because `hunt.award` returns true exactly once and a shutter press is one
    // or the other for a given id.
    if (this._cmp) this._cmpTick(d);

    // ── the pencil, the tick, the photograph, the tape ──────────────────────
    if (this._script?.hasAward && this._seatOf) {
      const page = this._pages[this._seatOf.page];
      const cross = this._at('cross');
      if (cross > 0 && !this._crossed) {
        if (!this._crossStarted) { this._crossStarted = true; this._cue('cross'); }
        page.strikeAt(this._seatOf.row, easeOut(cross));
        if (cross >= 1) this._crossed = true;
      }
      const tk = this._at('tick');
      if (tk > 0 && !this._ticked) {
        page.tickAt(this._seatOf.row, easeOut(tk));
        if (tk >= 1) {
          this._ticked = true;
          // The count moves on the beat the tick lands, which is the moment
          // the item is "counted". Until this existed the line under the
          // heading still read "none of fifteen found" through the entire
          // ceremony and for as long as the book stayed open — `_armAward`
          // updates the STRING on every page but only repaints the page the
          // award is on, and the count lives on page 1 and nowhere else.
          this._refreshProgress();
        }
      }
      const tp = this._at('tape');
      this._flyPhoto(this._at('photo'), tp);
      if (tp > 0 && !this._taped) {
        if (!this._bakedPhoto) this._bakePhoto();
        page.tapeAt(this._seatOf.row, easeOut(tp));
        if (tp >= 1) {
          this._taped = true;
          // So a later repaint (the progress line moves on the next award)
          // still comes back with the tape on.
          page.spec.rows[this._seatOf.row].tapeT = 1;
        }
      }
    }
  }

  /**
   * The photograph's flight.
   *
   * It comes in from just under the camera, tumbling, overshoots its slot and
   * settles with a squash — the squash is 6% and lasts a tenth of a second and
   * it is the difference between "the photo appeared" and "the photo landed".
   * `journal.slap` fires at the moment of contact, not at the start of the
   * move, because the sound is the impact.
   */
  _flyPhoto(p, tapeT = 0) {
    if (!this._seatOf || p <= 0) return;
    // Retired the moment the flat, taped version exists on the page: two copies
    // of the same photograph a millimetre apart is a shimmering z-fight, and it
    // happens on the one frame everybody is looking at.
    if (this._bakedPhoto && tapeT > 0) { this._card.visible = false; return; }

    const page = this._pages[this._seatOf.page];
    const slot = page.slotUV(this._seatOf.row);
    const mesh = page.spec.verso ? this._J.pageLeft : this._J.pageRight;
    if (!samplePage(mesh, slot.u, slot.v, this._tmpP, this._tmpQ)) return;

    this._card.visible = true;
    const k = easeOut(clamp01(p));
    // Start pose: below and in front of the camera, tipped away.
    this._from.set(0.055, -0.075, -0.16);
    this.camera.localToWorld(this._from);
    this._card.position.lerpVectors(this._from, this._tmpP, k);
    // Lift the arc: it comes over the top of the book, not through it.
    this._card.position.y += Math.sin(Math.PI * k) * 0.030;
    this._card.quaternion.slerpQuaternions(this._q0, this._tmpQ, easeInOut(clamp01(p * 1.12)));

    const w = slot.w * BOOK.W, h = slot.h * BOOK.H;
    const grow = lerp(1.75, 1.0, k);
    // Squash on impact, then out.
    const hit = clamp01((p - 0.88) / 0.12);
    const sq = Math.sin(Math.PI * hit) * 0.075;
    this._card.scale.set(w * grow * (1 + sq), h * grow * (1 - sq), 1);
    // Held a hair off the paper so it never z-fights the page it is landing on.
    this._lift.set(0, 0, 1).applyQuaternion(this._tmpQ);
    this._card.position.addScaledVector(this._lift, lerp(0.012, 0.0009, k));

    if (p >= 0.86 && !this._slapped) { this._slapped = true; this._cue('slap'); }
  }

  /**
   * Bring every page carrying the progress line up to date, cheaply.
   *
   * A partial blit rather than `paint()`: the page this lands on is usually
   * NOT the spread the player is looking at, but it can be, and a full repaint
   * mid-ceremony is the one thing `strikeAt`/`tickAt`/`tapeAt` exist to avoid.
   */
  _refreshProgress() {
    const line = this._progressLine();
    for (const p of this._pages) {
      if (p.spec.progress == null) continue;
      try { p.progressAt(line); } catch (e) {
        if (!this._pageErr) { this._pageErr = true; console.error('[journal] progress repaint failed', e); }
      }
    }
  }

  /** Fold the flown photo into the page texture and retire the 3D card. */
  _bakePhoto() {
    this._bakedPhoto = true;
    const page = this._pages[this._seatOf.page];
    const row = page.spec.rows[this._seatOf.row];
    row.pending = false;
    row.tapeT = 0;
    page.paint();
    this._card.visible = false;
  }

  /**
   * Ask the game for a one-shot.
   *
   * THE NAMES ARE BARE, and that is a fix rather than a style choice. Every cue
   * in here used to be `journal.page` / `journal.cross` / `journal.slap`, while
   * `Audio.cue` dispatches the book's voices with `JOURNAL_CUES.includes(name)`
   * — so not one of them ever matched and the whole ceremony played in silence.
   * It fails the way audio always fails: nothing throws, nothing logs, and you
   * only find it by reading the other end.
   *
   * `JOURNAL_CUES` is `['cover', 'page', 'cross', 'slap']` (`journal_audio.js`)
   * and ALL FOUR ARE LIVE. `cover` was the odd one out for a while — there was
   * no leather-and-board voice, and `Audio.cue` ignores a name it does not
   * know, so the cover beat stayed silent rather than speaking with the wrong
   * sound. It has one now: a stick-slip envelope peaking 0.230, sat
   * deliberately 1.4 dB under the slap so the first sound of the ceremony opens
   * it without spending its ending. See the ladder in `journal_audio.js`.
   *
   * Nothing on this side has to change when a voice is added or removed — the
   * dispatch is the list over there, not a switch here.
   */
  _cue(name) {
    try { this.ctx.systems?.audio?.cue?.(name); } catch { /* audio is never fatal */ }
  }

  /**
   * Push the pose onto the model and the scene.
   *
   * @param dt real seconds since the last call. Only the zoom uses it — every
   *   other value here is written by the script and simply read. It defaults to
   *   0 so a harness that poses the book by hand (`_jcritic --mode model`
   *   replaces `update` with a bare `_apply()`) gets a still and not a frozen
   *   animation halfway through one.
   */
  _apply(dt = 0) {
    const P = this._pose;
    poseJournal(this.book, {
      cover: P.cover, leaf: P.leaf, sheets: this._sheets, band: P.band,
    });
    setJournalPages(this.book, this._pageTex, P.leaf);

    // Held -> laid. Driven by the COVER, not by time: however long the cover
    // takes, the book is upright while it is shut and flat once it is open.
    const k = smoothstep(0, 1, P.cover);
    const r = this._bookRoot;
    const A = POSE_HELD, B = POSE_LAID;
    // The model centres the CLOSED book on its own origin (journal_model's
    // header). Open, the spread is twice as wide and grows to the LEFT, so the
    // same origin puts a quarter of the page off the side of the screen. Slide
    // it back by half a cover as the covers open — this is the one place that
    // knows the difference between the object's centre and the spread's.
    const recentre = ((BOOK.W + BOOK.SQ) / 2) * k;
    r.position.set(
      lerp(A.pos[0], B.pos[0], k) + recentre,
      lerp(A.pos[1], B.pos[1], k) + lerp(-0.30, 0, clamp01(P.lift)),
      lerp(A.pos[2], B.pos[2], k));
    r.rotation.set(
      lerp(A.rot[0], B.rot[0], k),
      lerp(A.rot[1], B.rot[1], k),
      lerp(A.rot[2], B.rot[2], k));
    // A leaf in flight stands 210 mm off a book that is only 26 mm thick, so at
    // a framing tight enough to read the spread it clips the top of the screen
    // for a third of every turn. Rather than frame for the worst case and leave
    // the resting book floating in a half-empty picture, the BOOK dips while a
    // page is up and comes back when it lands. It is 30 mm and nobody notices
    // it happening; they notice the page not being cut off.
    const flight = Math.sin(Math.PI * (P.leaf - Math.floor(P.leaf)));
    r.position.y -= 0.030 * flight * k;

    const s = lerp(A.scale, B.scale, k) * lerp(0.9, 1, clamp01(P.lift));
    r.scale.setScalar(s);

    // The close look, on top of the laid pose and nothing else — it adds to
    // what is already on the root rather than replacing it, so the rise, the
    // dip and the recentre above all keep working underneath it.
    this._applyStudy(r, dt);

    // And the player's own framing on top of THAT — on the camera, after the
    // book is posed and before anything reads a world matrix. See `PAN_*`.
    this._applyPan(dt);

    this._scrim.material.opacity = 0.78 * clamp01(P.scrim);
    // Everything downstream of this frame — the photograph finding the page it
    // lands on, most of all — reads world matrices, and three only refreshes
    // them inside render(). One walk of a 20-node tree is nothing.
    this._bookRoot.updateMatrixWorld(true);
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  The player's own framing — pan, tilt, zoom
  // ───────────────────────────────────────────────────────────────────────────

  /** True while the book is anywhere other than the framing it chose itself. */
  get panned() {
    const P = this._pan;
    return Math.abs(P.yaw) > PAN_SQUARE || Math.abs(P.pitch) > PAN_SQUARE
        || Math.abs(P.zoom - 1) > PAN_SQUARE
        || Math.abs(P.x) > PAN_SQUARE * 0.1 || Math.abs(P.y) > PAN_SQUARE * 0.1;
  }

  /**
   * Put the free pose on the camera. Called every frame, from `_apply`.
   *
   * The camera is rebuilt from the FIT's pose each time rather than integrated,
   * so there is no drift to accumulate and a window resize re-homes it for
   * free. Four terms, in this order and for this reason:
   *
   *   orbit   about `STUDY_LOOK`, yaw round world up and pitch round the
   *           camera's own right — so pitch is always "up and over the book"
   *           whichever way it has been turned,
   *   dolly   toward the same point, which is what makes the zoom land on what
   *           is in the middle of the frame rather than on the book's origin
   *           (which at 9x is a long way off screen),
   *   pan     a straight translation in the camera's right/up plane, which is
   *           the DCC gesture and the one `CameraRig._free` uses,
   *   home    an ease back to square, over `PAN_HOME`.
   */
  _applyPan(dt) {
    const P = this._pan;
    // The ease home. `_panFrom` is the pose it left, so the ease is on all five
    // terms at once and the book comes back as one movement.
    if (this._panT < 1 && this._panFrom) {
      this._panT = clamp01(this._panT + dt / PAN_HOME);
      const e = 1 - easeInOut(this._panT);
      const F = this._panFrom;
      P.yaw = F.yaw * e; P.pitch = F.pitch * e;
      P.x = F.x * e; P.y = F.y * e;
      P.zoom = 1 + (F.zoom - 1) * e;
      if (this._panT >= 1) this._panFrom = null;
    }
    const cam = this.camera;
    if (!this._camPos0) return;
    if (!this.panned) {
      cam.position.copy(this._camPos0);
      cam.quaternion.copy(this._camQuat0);
      cam.updateMatrixWorld(true);
      return;
    }

    const q = this._panQ ??= new THREE.Quaternion();
    const q2 = this._panQ2 ??= new THREE.Quaternion();
    const right = this._panR ??= new THREE.Vector3();
    const up = this._panU ??= new THREE.Vector3();
    const pos = this._panP ??= new THREE.Vector3();

    // Yaw about world up first, then pitch about the camera's right AFTER that
    // yaw — the order that makes a tilt stay a tilt once the book has been
    // turned. `-pitch` because the drag is read the way photo mode reads it
    // (down raises the camera), and raising the camera is a negative rotation
    // about a right-handed +X.
    q.setFromAxisAngle(_UP, P.yaw);
    right.set(1, 0, 0).applyQuaternion(this._camQuat0).applyQuaternion(q).normalize();
    q2.setFromAxisAngle(right, -P.pitch);
    q.premultiply(q2);

    pos.copy(this._camPos0).sub(STUDY_LOOK).applyQuaternion(q);
    // The dolly. `1 / zoom` because the book is not moving: pulling the camera
    // in is what makes the book bigger.
    pos.multiplyScalar(1 / P.zoom).add(STUDY_LOOK);
    cam.quaternion.copy(this._camQuat0).premultiply(q);
    right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    // The camera slides the OPPOSITE way to the content, which is what makes
    // the point under the cursor stay under the cursor.
    pos.addScaledVector(right, -P.x).addScaledVector(up, -P.y);
    cam.position.copy(pos);
    cam.updateMatrixWorld(true);
  }

  /**
   * The world size of half the frame at the pivot's depth — what the pan clamp
   * and the pan's own metres-per-pixel are both measured against.
   */
  _panFrameHalf() {
    // Measured from the FIT's camera, not the live one. Using the live camera
    // makes the clamp a function of the pan it is clamping: sliding sideways
    // moves the camera further from the pivot, which widens the frame there,
    // which widens the clamp. Measured, that let the vertical pan creep from
    // its 0.152 m limit out to 0.175 before it settled. The dolly is divided
    // out instead, which is the part that SHOULD move the limit — zoomed in,
    // the same fraction of the frame is fewer metres.
    const p0 = this._camPos0 ?? this.camera.position;
    const d = p0.distanceTo(STUDY_LOOK) / Math.max(0.05, this._pan.zoom);
    const h = d * Math.tan(rad(this.camera.fov) / 2);
    return { h, w: h * (this.camera.aspect || 1) };
  }

  /**
   * Take a drag, a wheel or a key and move the free pose, clamped.
   *
   * Every clamp is applied here rather than in `_applyPan`, so the state itself
   * can never hold a pose the book is not allowed to be in — which is what
   * makes the ease home a straight lerp of five numbers with nothing to check.
   */
  _panBy({ yaw = 0, pitch = 0, zoom = 1, x = 0, y = 0 }) {
    // The ceremony has right of way, on the same test `leaf()` and `study()`
    // use: the flying print aims at a page it locates every frame, and moving
    // the camera under it would move the target it is aiming at.
    if (this._script?.hasAward && !this._taped &&
        this._t < (this._script.end + (this._seekPad ?? 0))) return;
    const P = this._pan;
    this._panFrom = null;
    this._panT = 1;

    P.yaw = clamp(P.yaw + yaw, -PAN_YAW_MAX, PAN_YAW_MAX);
    // The pitch clamp is expressed on the PAGE's angle off face-on, not on the
    // camera, so it composes with whatever tilt the ladder has already put on
    // the book. See the `PAN_*` block.
    const tilt = STUDY_TILT * Math.min(this._studyK, 1);
    const face = PAN_SPREAD_FACE - tilt;
    P.pitch = clamp(P.pitch + pitch, face - PAN_FACE_MAX, face - PAN_FACE_MIN);
    P.zoom = clamp(P.zoom * zoom, PAN_ZOOM_MIN, PAN_ZOOM_MAX);

    const f = this._panFrameHalf();
    P.x = clamp(P.x + x, -PAN_EDGE * f.w, PAN_EDGE * f.w);
    P.y = clamp(P.y + y, -PAN_EDGE * f.h, PAN_EDGE * f.h);
  }

  /**
   * Back to the framing the book chose for itself, eased.
   *
   * The one action that undoes any amount of tumbling, and it is bound to the
   * key a player already presses to get out of things. Returns whether it had
   * anything to do, which is what lets Escape spend a press on this and only
   * this — one input, one change.
   */
  panHome() {
    // ALREADY going home is not "still off square". The pose stays non-zero for
    // the whole 0.28 s ease, so without this test a second press re-captured
    // `_panFrom` from the half-eased pose, reset the clock and returned true
    // again — and the caller, which spends a press on a true, never reached
    // `zoomOut()` or `close()`. Held down at the OS repeat rate that is an
    // Escape key that shrinks the pose by 0.7% a press and never shuts the
    // book. An impatient second press now does the next thing, which is also
    // the right reading of it.
    if (this._panFrom) return false;
    if (!this.panned) return false;
    this._panFrom = { ...this._pan };
    this._panT = 0;
    return true;
  }

  /** Square it up with no animation. For `open`, `close` and a rung change. */
  _panReset() {
    const P = this._pan;
    P.yaw = P.pitch = P.x = P.y = 0;
    P.zoom = 1;
    this._panFrom = null;
    this._panT = 1;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  The photo card's own texture
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Draw the print the player is about to be handed.
   *
   * Same visual language as the pasted version in journal_page.js — off-white
   * stock, a caption strip at the foot, a hairline round the emulsion — because
   * the 3D card is swapped for the painted one at the moment of impact and any
   * difference between them shows up as a flicker on the frame it happens.
   */
  _drawCard(img) {
    const cv = this._cardCv, g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const pad = 22, foot = 46;
    g.fillStyle = '#f6efe0';
    g.fillRect(0, 0, W, H);
    const iw = W - pad * 2, ih = H - pad * 2 - foot;
    if (img) {
      g.save();
      g.beginPath(); g.rect(pad, pad, iw, ih); g.clip();
      const ar = img.width / img.height, box = iw / ih;
      let sw = img.width, sh = img.height, sx = 0, sy = 0;
      if (ar > box) { sw = img.height * box; sx = (img.width - sw) / 2; }
      else { sh = img.width / box; sy = (img.height - sh) / 2; }
      g.drawImage(img, sx, sy, sw, sh, pad, pad, iw, ih);
      g.restore();
    } else {
      g.fillStyle = '#cfc3aa';
      g.fillRect(pad, pad, iw, ih);
    }
    g.strokeStyle = 'rgba(52,40,28,0.30)';
    g.lineWidth = 3;
    g.strokeRect(pad, pad, iw, ih);
    this._cardTex.needsUpdate = true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Render
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Fit the framing to the window. See DESIGN_AR / FOV_MAX above.
   *
   * Writes `camera.fov` AND `camera.position`, so it also refreshes the world
   * matrix: `_flyPhoto` calls `camera.localToWorld` to find where the print
   * comes in from, and a stale matrix launches it from the wrong place.
   */
  _fitCamera(aspect) {
    if (aspect === this._fitAR) return;
    this._fitAR = aspect;
    const tanBase = Math.tan(rad(CAM_FOV) / 2);
    const tight = 1 + (TIGHT_MAX - 1) *
      clamp01((DESIGN_AR - aspect) / (DESIGN_AR - TIGHT_AR));
    const want = (tanBase * Math.max(1, DESIGN_AR / aspect)) / tight;
    const cap = Math.tan(rad(FOV_MAX) / 2);
    const use = Math.min(want, cap);
    this.camera.fov = deg(Math.atan(use)) * 2;
    this.camera.aspect = aspect;
    // Whatever the lens could not cover, walk backwards for. Scaling the
    // camera's offset about the look-at point keeps the composition — the
    // book stays where it is in frame and only gets smaller.
    const dolly = want / use;
    this.camera.position.copy(CAM_POS).sub(CAM_LOOK).multiplyScalar(dolly).add(CAM_LOOK);
    this.camera.lookAt(CAM_LOOK);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    // The pose the free camera departs from and comes home to. Taken here
    // rather than remembered from the constructor because the fit re-poses the
    // camera on every aspect change, and a player who resizes the window while
    // panned must come home to the NEW fit, not the old one.
    (this._camPos0 ??= new THREE.Vector3()).copy(this.camera.position);
    (this._camQuat0 ??= new THREE.Quaternion()).copy(this.camera.quaternion);
    // And put the player's own framing straight back on top. The fit runs from
    // `render()`, which is AFTER `update()` has already applied it, so without
    // this the one frame an aspect change lands on is drawn square and the pan
    // reappears on the next — a visible flick on every resize.
    this._applyPan(0);
  }

  /**
   * The multisampled target the book is drawn into.
   *
   * `src/core/Engine.js` builds the context with `antialias: false` because the
   * world's AA is SMAA inside the post chain — and this overlay draws AFTER
   * that chain, into that same raw framebuffer. So every silhouette on the
   * hero object staircased over a perfectly smooth meadow: cover corner, page
   * edge, fore edge as raw stairs and the ribbon as a visible zigzag, which
   * DESIGN_BRIEF 5.1 names as a fail condition outright.
   *
   * Four samples into an offscreen target and one blit is the cheap fix, and
   * it is cheap because it is one full-screen quad on a frame where the world
   * behind it is paused. Supersampling 2x was the alternative and costs four
   * times the fragments for a slightly worse edge.
   *
   * RGBA8 tagged sRGB, deliberately, not half float: it is the same encoding
   * and the same 8 bits the canvas itself has, so the composite is identical to
   * what was there before except for the edges — and half float would have made
   * this 46 MB of multisampled attachment for a book.
   */
  _target(renderer, w, h) {
    if (this._rtFailed) return null;
    if (this._rt && (this._rt.width !== w || this._rt.height !== h)) {
      this._rt.setSize(w, h);
    }
    if (!this._rt) {
      try {
        const rt = new THREE.WebGLRenderTarget(w, h, {
          samples: 4,
          depthBuffer: true,
          stencilBuffer: false,
          type: THREE.UnsignedByteType,
          format: THREE.RGBAFormat,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        });
        rt.texture.generateMipmaps = false;
        rt.texture.colorSpace = THREE.SRGBColorSpace;
        this._rt = rt;
        // The blit. `premultipliedAlpha` is not decoration: the book is drawn
        // over a transparent clear with three's usual separate alpha blend, so
        // what comes out of the target has its colour ALREADY multiplied by
        // coverage. Composited with the ordinary source-alpha blend instead,
        // every antialiased edge pixel is darkened twice and the book gets a
        // grey halo — which looks like a bad matte and is arithmetic.
        this._blitScene = new THREE.Scene();
        this._blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._blitMat = new THREE.MeshBasicMaterial({
          map: rt.texture, transparent: true, premultipliedAlpha: true,
          depthTest: false, depthWrite: false, toneMapped: false,
        });
        const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._blitMat);
        q.frustumCulled = false;
        this._blitScene.add(q);
      } catch (e) {
        // A driver that will not give us a multisampled target is not a reason
        // to lose the journal. Fall back to drawing straight to the canvas.
        this._rtFailed = true;
        console.warn('[journal] no MSAA target; overlay will alias', e);
        return null;
      }
    }
    return this._rt;
  }

  /**
   * Draw the overlay into the canvas that postfx has just finished with.
   *
   * Saved and restored: the render target, autoClear (and its three component
   * flags), the viewport, the scissor rect, the scissor test and the clear
   * colour. `clearDepth()` on the canvas is no longer needed — the book has its
   * own depth buffer in its own target now, which is strictly better: the
   * overlay used to clobber the WORLD's depth buffer to avoid being buried
   * inside whatever the camera happened to be near.
   *
   * Deliberately NOT touched: `toneMapping` and `shadowMap.enabled`. Both are
   * program-affecting state on this renderer, and flipping either one mid-frame
   * recompiles every material in the game — a multi-hundred-millisecond stall,
   * every single time the journal is opened. Tone mapping is already off (the
   * post chain owns the curve), which is why this scene's lights are authored
   * for a linear-to-sRGB path with no highlight rolloff; and none of this
   * scene's lights cast, so the shadow pass finds nothing to do.
   */
  render(renderer) {
    if (!this._visible || !renderer) return;
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevAutoC = renderer.autoClearColor;
    const prevAutoD = renderer.autoClearDepth;
    const prevAutoS = renderer.autoClearStencil;
    const prevScissorTest = renderer.getScissorTest();
    renderer.getViewport(this._vp);
    renderer.getScissor(this._sc);
    renderer.getSize(this._size);
    renderer.getDrawingBufferSize(this._dbSize);
    renderer.getClearColor(this._clearCol);
    const prevClearA = renderer.getClearAlpha();

    this._fitCamera(this._size.x / Math.max(1, this._size.y));
    const rt = this._target(renderer, Math.max(2, this._dbSize.x | 0), Math.max(2, this._dbSize.y | 0));

    try {
      renderer.setRenderTarget(null);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, this._size.x, this._size.y);
      renderer.autoClear = false;
      renderer.autoClearColor = false;
      renderer.autoClearDepth = false;
      renderer.autoClearStencil = false;

      // The scrim stays on the direct path. It is a flat full-screen quad with
      // no silhouette, so it has nothing to antialias — and putting it in the
      // target with the book would move the world-dimming blend from the
      // canvas's sRGB space into the target's linear one, which is a different
      // (and lighter) amount of dimming for no gain.
      if (this._scrim.material.opacity > 0.002) {
        renderer.render(this._scrimScene, this._scrimCam);
      }

      if (rt) {
        renderer.setRenderTarget(rt);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, false);
        renderer.render(this.scene, this.camera);
        renderer.setRenderTarget(null);
        renderer.setViewport(0, 0, this._size.x, this._size.y);
        renderer.render(this._blitScene, this._blitCam);
      } else {
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);
      }
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(this._clearCol, prevClearA);
      renderer.autoClear = prevAuto;
      renderer.autoClearColor = prevAutoC;
      renderer.autoClearDepth = prevAutoD;
      renderer.autoClearStencil = prevAutoS;
      renderer.setViewport(this._vp);
      renderer.setScissor(this._sc);
      renderer.setScissorTest(prevScissorTest);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Input
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Capture-phase listeners on window.
   *
   * Everything in this game listens on the bubble phase, so stopping
   * propagation here takes the event away from the driving controls, the HUD
   * and the camera rig at once — without this module touching a file it does
   * not own. Nothing is swallowed while the journal is shut.
   */
  _bindInput() {
    const stop = (e) => { e.stopPropagation(); };
    // Zooming adds levels, and every way out backs out exactly ONE of them.
    // From the close look, Escape returns to the leaned-in entry; from there to
    // the spread; from there it shuts the book. A page key does the same rather
    // than teleporting back to the spread and turning a page in one keystroke.
    // The alternative — dead keys while zoomed — was tried on paper and
    // rejected: a key that does nothing is how a player decides a mode is stuck.
    this._onKey = (e) => {
      if (!this._active) return;
      stop(e);
      // The compare leaf takes every key that would otherwise move the book,
      // and gives them all one meaning: leave, keeping the print that is
      // already in the book. It is the same rule as the ladder — one press,
      // one level out — and it is the reading the page itself prints at its
      // foot. Turning a page out from under an unanswered question would leave
      // the book somewhere else with two prints still loaded.
      if (this._cmp) {
        switch (e.code) {
          case 'Escape': case 'KeyJ': case 'Enter':
          case 'ArrowRight': case 'KeyD': case 'PageDown': case 'Space':
          case 'ArrowLeft': case 'KeyA': case 'PageUp':
            e.preventDefault();
            this._cmpAbandon();
            break;
          default: break;
        }
        return;
      }
      switch (e.code) {
        case 'Escape': case 'KeyJ': case 'Enter':
          e.preventDefault();
          // A tumbled book comes back to square FIRST. One press, one change:
          // it is only a rung when there is something to undo, so a book nobody
          // has driven closes on the first Escape exactly as it always did.
          if (this.panHome()) break;
          if (this._studyTo > 0) this.zoomOut(); else this.close();
          break;
        case 'ArrowRight': case 'KeyD': case 'PageDown': case 'Space':
          e.preventDefault();
          if (this.panHome()) break;
          if (this._studyTo > 0) this.zoomOut(); else this.leaf(+1);
          break;
        case 'ArrowLeft': case 'KeyA': case 'PageUp':
          e.preventDefault();
          if (this.panHome()) break;
          if (this._studyTo > 0) this.zoomOut(); else this.leaf(-1);
          break;
        default: break;
      }
    };
    this._onKeyUp = (e) => { if (this._active) stop(e); };
    this._onWheel = (e) => {
      if (!this._active) return;
      e.preventDefault(); stop(e);
      // ── the wheel is the DOLLY now ────────────────────────────────────────
      // It used to be a page turn, with a hold-off to stop a trackpad's burst
      // of twenty events riffling the book to the end. JOURNAL_NOTES 14.7
      // flagged that as the one input a player might reasonably expect to work
      // in both directions; it does now, and the burst stops being a problem
      // rather than being suppressed — a continuous zoom is exactly what twenty
      // small multiplications add up to. Same `exp(deltaY * 0.0016)` the free
      // camera in photo mode uses, so one flick moves the book by the same
      // amount it moves the world there.
      //
      // The page keys and a click on the half of the frame you want are what
      // turn pages now. That is a real cost of this change and it is the right
      // trade: leafing has two other bindings and zooming had none.
      this._panBy({ zoom: Math.exp(-e.deltaY * 0.0016) });
    };
    this._onPointer = (e) => {
      if (!this._active) return;
      stop(e);
      // ── a drag is not a click ─────────────────────────────────────────────
      // Everything below used to fire on `pointerdown`. It cannot any more: the
      // same left button now tilts the book, and a tilt that also turned a page
      // would make the book unusable. So the gesture is decided on pointerUP —
      // a press that moved less than `DRAG_SLOP` is a click and does what it
      // always did, and one that moved further has already been spent on the
      // camera. The cost is that a click acts a few milliseconds later than it
      // used to; the alternative is that half of them do two things.
      const T = this._ptr;
      if (e.type === 'pointerdown') {
        e.preventDefault();
        T.down = true; T.btn = e.button; T.drag = false; T.moved = 0;
        T.x = e.clientX; T.y = e.clientY;
        // Decided HERE and not on the move, because the answer has to be about
        // where the gesture STARTED. Tested once per press: a drag that begins
        // on the book is the book's, and one that begins beside it is the
        // camera's, whatever either passes over afterwards.
        T.onBook = this._overBook(e.clientX, e.clientY);
        // Signed, and kept apart from `T.moved` — that one is a path LENGTH
        // (|dx|+|dy| summed) and is the right measure for "has this stopped
        // being a click", but it cannot tell left from right and a there-and-
        // back wobble accumulates in it. A swipe needs displacement.
        T.dx = 0; T.dy = 0;
        return;
      }
      if (e.type === 'pointercancel') { T.down = false; T.drag = false; return; }
      if (e.type === 'pointermove' && T.down) {
        const dx = e.clientX - T.x, dy = e.clientY - T.y;
        T.x = e.clientX; T.y = e.clientY;
        T.moved += Math.abs(dx) + Math.abs(dy);
        T.dx += dx; T.dy += dy;
        if (!T.drag && T.moved < DRAG_SLOP) return;
        // A drag that started on the book does not move the camera. It is a
        // SWIPE — see the note at `pointerup` — so the cursor says so and the
        // direction is read on release.
        if (T.onBook) {
          T.spent = true;
          this._cursorTo('ew-resize');
          return;
        }
        // Left and middle only, the two buttons photo mode uses. A right drag
        // is left alone because `preventDefault` on `pointerdown` does not stop
        // `contextmenu`, so it would tilt the book and then put a menu over it.
        if (T.btn !== 0 && T.btn !== 1) return;
        T.drag = true;
        this._cursorTo(T.btn === 1 ? 'grabbing' : 'move');
        if (T.btn === 1) {
          // Middle drag: translate, the DCC pan. One world unit per screen unit
          // at the pivot's depth, so the point under the cursor stays under the
          // cursor — the same arithmetic and the same reason as
          // `CameraRig._free`, which spells it out at length.
          const h = window.innerHeight || 900;
          const mpp = 2 * this._panFrameHalf().h / h;
          this._panBy({ x: dx * mpp, y: -dy * mpp });
        } else {
          // Left drag: orbit, at photo mode's own sensitivity and signs.
          this._panBy({ yaw: -dx * 0.0042, pitch: dy * 0.0032 });
        }
        return;
      }
      if (e.type === 'pointerup') {
        const wasDrag = T.drag, spent = T.spent;
        T.down = false; T.drag = false; T.spent = false;
        if (wasDrag) { this._cursorTo(''); return; }
        // ── a swipe across the book turns a page ──────────────────────────
        //
        // This is what taking the page turn off the plain click was FOR: the
        // book is a book, and a book is leafed through by pushing a page
        // across. Drag right for the next spread and left for the previous —
        // Drag LEFT for the next spread and right for the previous, which is
        // the book reading: you put a finger on the right-hand leaf and push it
        // across to the left to go forward, exactly as you would on paper. It
        // shipped the other way round first — matched to the arrow keys, which
        // was the wrong thing to match, because a swipe is a hand on the page
        // and not a key that means "next".
        //
        // Gated on being HORIZONTAL and on clearing a real distance: a drag is
        // already only reachable on the book, so the only thing left to guard
        // against is a mostly-vertical wander being read as a page turn.
        // `SWIPE_MIN` scales with the window because the same gesture on a
        // phone and on a 27-inch display should ask for the same fraction of
        // the book, not the same number of pixels.
        if (spent) {
          this._cursorTo('');
          const SWIPE_MIN = Math.max(48, (window.innerWidth || 1200) * 0.045);
          if (Math.abs(T.dx) > SWIPE_MIN && Math.abs(T.dx) > Math.abs(T.dy)) {
            this.leaf(-Math.sign(T.dx));
          }
          return;
        }
        // Fall through to the click, below, with `pointerup`'s coordinates.
      }
      // ── the compare leaf owns the pointer while it is up ───────────────────
      // Hover says which print a click will keep — in three places at once, so
      // no one of them has to carry it: the print comes off the paper, the
      // other one goes down to 55%, and the caption under it goes to full ink
      // with a pencil stroke beneath. Clicking anywhere that is NOT a print
      // does nothing at all. That is the one place in this file where a click
      // is deliberately inert, and it is because the alternative — falling
      // through to "turn the page" or "back out" — would answer a question the
      // player has not answered, with the answer they did not give.
      if (this._cmp) {
        if (e.type === 'pointermove') { this._cmpHover(this._cmpAt(e.clientX, e.clientY)); return; }
        if (e.type !== 'pointerup') return;
        const k = this._cmpAt(e.clientX, e.clientY);
        // On a print: keep it. Anywhere else: square the book up if it has been
        // driven, and otherwise nothing at all. That "nothing" is the one
        // deliberately inert click in this file — falling through to "turn the
        // page" or "back out" would answer an unanswered question with the
        // answer the player did not give — but squaring up is not answering it,
        // and without it a player who has zoomed in to compare the two prints
        // has no way back to the whole page except Escape, which decides.
        if (k >= 0) this._cmpChoose(k); else this.panHome();
        return;
      }
      if (e.type === 'pointermove') {
        // Hover only; the pick is cheap (four `samplePage` lookups per
        // photographed row, of which a spread holds at most eight) and it is
        // the only thing telling the player a print is worth clicking.
        //
        // It also ARMS the detail patch — see `_hoverSeat`. That is where the
        // ~20 ms of canvas raster went when the lean stopped existing: the lean
        // used to be the free moment to spend it in, and a hover is the same
        // beat one step earlier.
        const seat = this._studyTo > 0 ? null : this._rowAt(e.clientX, e.clientY);
        // Only a print arms the detail raster. A target seat has no photograph
        // to sharpen — `printPatch` would hand back null anyway — and passing
        // it through would spend the dwell timer on nothing.
        this._hoverAt(seat?.kind === 'study' ? seat : null);
        this._cursorTo(this._studyTo > 0 ? 'zoom-out'
          : seat?.kind === 'study' ? 'zoom-in'
          : seat ? 'pointer' : '');
        return;
      }
      if (e.type !== 'pointerup') return;
      // At the close look there is nowhere further in, so anywhere is "back" —
      // but a book the player has DRIVEN squares up first, exactly as Escape
      // does, so the click meant to undo a tumble does not also change level.
      // A click on a DIFFERENT print backs out too rather than hopping sideways
      // to it: at this framing the other print is a sliver at the edge of the
      // frame, and a sliver that teleports the book is a way to lose your place,
      // not a shortcut.
      if (this._studyTo > 0) {
        // Straight out. It used to square the book up first and zoom out on a
        // second click, which is the same "a click moved the book" the spread
        // had — see below. Escape still squares up.
        this.zoomOut();
        this._cursorTo('zoom-out');
        return;
      }
      // A print. Go to it — the whole way, in one move. This is checked BEFORE
      // the square-up, because a player who has tilted the book and then aimed
      // at a print has said what they want and it is not "put that back";
      // `study` squares it on the way in anyway.
      const seat = this._rowAt(e.clientX, e.clientY);
      // An empty frame: aim at it, or — clicking the one already ringed — stop
      // aiming. The book does NOT move for this. That is the point of putting
      // it on the slot rather than making it a fifth thing on the zoom ladder:
      // marking your quarry is something you do to the list while reading it,
      // and a page that flew at your face every time would make it a mode.
      if (seat?.kind === 'target') {
        const row = this._pages[seat.page]?.spec?.rows?.[seat.row];
        if (row && hunt.setTracked(row.id)) {
          this._repaintTargets();
          // The ring and the inked paw are the durable answer; this is the
          // immediate one. A click that lands on a page whose mark is a few
          // millimetres of pencil deserves to be acknowledged in the moment,
          // and the subject is the sheet's own wording, so what the toast says
          // is what the line says.
          this.onTarget?.(hunt.target, row.subject);
        }
        return;
      }
      if (seat) { this.study(seat.page, seat.row); this._cursorTo('zoom-out'); return; }

      // ── and nothing else. A plain click does not move the book ────────────
      //
      // Two things used to happen here and both were wrong once the book could
      // be driven:
      //
      //  · `panHome()` — a click on the book eased the camera back to square,
      //    which is a book that TILTS when you click it. It reads as the click
      //    having grabbed something. Escape still squares up, and that is the
      //    right home for it: a key you press deliberately, not a side effect
      //    of every click that misses a print.
      //  · `leaf(clientX > width/2 ? +1 : -1)` — "click the half of the frame
      //    you want". That fired on ANY click, including one out on the table
      //    where the player was reaching for the camera, so the book leafed
      //    while they were trying to frame it. Turning a page is the SWIPE now
      //    (see `pointerup`'s spent branch), which is a gesture that says which
      //    direction it means and cannot be triggered by aiming badly.
      //
      // So: on a print, go to it. Anywhere else, nothing. The space around the
      // book is the camera's and the book's own surface is for its prints and
      // its pages, and neither of them is a place where a stray click should
      // change what you are looking at.
    };
    window.addEventListener('keydown', this._onKey, { capture: true });
    window.addEventListener('keyup', this._onKeyUp, { capture: true });
    window.addEventListener('wheel', this._onWheel, { capture: true, passive: false });
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel'])
      window.addEventListener(t, this._onPointer, { capture: true });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Going in on one print
  // ───────────────────────────────────────────────────────────────────────────

  /** True while the book is in on a single print (or on its way there). */
  get studying() { return this._studyTo > 0; }

  /** Kept as the name for the same thing: the close look at the print. */
  get closeUp() { return this._studyTo > 0; }

  /** 0 the spread, 1 the close look at one print. */
  get zoomLevel() { return this._studyTo; }

  /**
   * Go in on one row's print, all the way, in one move.
   *
   * @param page  index into `_pages`
   * @param row   index into that page's `spec.rows`
   */
  study(page, row) {
    const p = this._pages[page];
    if (!p?.spec?.rows?.[row]) return;
    // The compare leaf owns the book while it is up, and it is already framed
    // at the top of the ladder. Going in on something else from under it would
    // move the page the two prints are being placed on.
    if (this._cmp) return;
    // Nothing to go in on mid-turn: `samplePage` reads the leaf that is at
    // rest, and there isn't one while a page is in flight.
    if (this._leafT < 1 || this._seekQueue > 0) return;
    // The ceremony has right of way, on the same test `leaf()` uses. The
    // photograph flies to a page it locates with `samplePage` every frame, and
    // moving the book underneath it would move the target it is aiming at.
    if (this._script?.hasAward && !this._taped &&
        this._t < (this._script.end + (this._seekPad ?? 0))) return;
    // The slot is the frame. The row's own rectangle is still taken and still
    // spread on `_study` itself rather than nested — the free camera's pan
    // clamp measures against it, `docs/JOURNAL_NOTES.md` documents it and the
    // harnesses read it.
    this._study = {
      page, row, verso: p.spec.verso, ...p.rowUV(row), slot: p.slotUV(row),
    };
    this._studyOff?.set(0, 0, 0);
    this._closeZ = CLOSE_ZOOM_SEED;
    this._solveCloseZoom();
    this._zoomTo(1);
  }

  /**
   * Bring every row's ring back into step with the store, and repaint only the
   * leaves whose answer changed.
   *
   * Called straight from the click rather than through `hunt.onChange`, and
   * that is deliberate. `_decorate` is the general "the store moved" repaint
   * and it only runs on `open()`, because the other thing that moves the store
   * — an award — arrives with a ceremony that owns its own row paint (see
   * `_armAward`: it sets `pending` so the pencil animates). A decorate racing
   * that would repaint the row already struck and eat the animation. Targeting
   * has no ceremony and touches at most two leaves — the one being ringed and
   * the one being un-ringed — so it repaints them itself and leaves the rest of
   * the book alone.
   */
  _repaintTargets() {
    for (const p of this._pages) {
      let dirty = false;
      for (const row of p.spec.rows ?? []) {
        const target = hunt.target === row.id;
        if (target === row.target) continue;
        row.target = target;
        dirty = true;
      }
      if (!dirty) continue;
      try { p.paint(); } catch (e) {
        if (!this._pageErr) { this._pageErr = true; console.error('[journal] page paint failed', e); }
      }
    }
  }

  /** Back out ONE level: the close look to the spread. */
  zoomOut() {
    if (this._studyTo <= 0) return;
    this._zoomTo(this._studyTo - 1);
  }

  /** Back out to the spread. Keeps `_study` until the move has finished. */
  unstudy() { this._zoomTo(0); }

  /**
   * Move to a level on the zoom ladder — 0 the spread, 1 the print.
   *
   * There used to be three of these and the duration was per LEVEL CROSSED so
   * that a two-level move took twice as long as a one-level one. With two rungs
   * `dist` is always 1 and that arithmetic is a no-op, but it is left in place
   * because it is what makes `maxDur` exact rather than approximate, and
   * because `_studyFrom` is a CONTINUOUS position: interrupting a move halfway
   * and sending it back gives `dist` 0.5, and half the distance should take
   * half the time.
   *
   * `maxDur` has exactly one caller: `close()`. The put-down is 0.46 s and
   * `_visible` goes false at the end of it, so an ease that outlasts it is not
   * slow, it is CUT — the book would vanish still half-zoomed instead of going
   * back and going down as one movement. `CLOSE_OUT` is 0.52 s, so this is
   * still doing real work with one rung fewer than it was written for.
   */
  _zoomTo(level, maxDur = Infinity) {
    const to = Math.max(0, Math.min(1, level));
    if (to === this._studyTo) return;
    // A rung change puts the book square — EASED, over `PAN_HOME`, so it is a
    // movement rather than a cut on the first frame of a move. It has to happen
    // at all because the framing about to be solved is measured through the
    // camera, and a player-driven camera underneath it would be solved AROUND
    // rather than solved for; a zoom that arrives somewhere other than the
    // middle of the frame is not a fit. `_solveCloseZoom` squares the camera
    // for the length of its own measurement, so the two do not have to wait for
    // each other. It is also why Escape squares first and changes rung second:
    // the two never coincide.
    this.panHome();
    this._studyFrom = this._studyK;
    this._studyTo = to;
    this._studyT = 0;
    const dist = Math.abs(to - this._studyFrom);
    this._studyDur = Math.min(maxDur, (to > this._studyFrom ? CLOSE_IN : CLOSE_OUT) * dist);
  }

  /**
   * Advance the move, and hold the print's centre on `STUDY_LOOK`.
   *
   * Called from `_apply`, AFTER the base pose is on the root and before the
   * final `updateMatrixWorld` — because it needs the world position of a point
   * on a page that has just been re-posed, which means a matrix walk in the
   * middle. That is the one extra tree update this feature costs, and only
   * while it is running: at rest `_studyK` is 0 and this returns immediately.
   */
  _applyStudy(root, dt) {
    if (this._studyT < 1) {
      this._studyT = this._studyDur > 0
        ? clamp01(this._studyT + dt / this._studyDur) : 1;
      this._studyK = lerp(this._studyFrom, this._studyTo, easeInOut(this._studyT));
      if (this._studyT >= 1) {
        this._studyK = this._studyTo;
        if (this._studyTo === 0) this._study = null;
      }
    }
    const k = this._studyK;
    if (k <= 0.0002 || !this._study) {
      // At the spread the patch is normally thrown away — but not the one the
      // POINTER has armed (`_hoverAt`), which is the whole point of arming it
      // before the click. `_detailHide` puts the leaf's own print back and
      // parks the quad; the canvas stays.
      if (this._detailFor != null && this._detailFor === this._hoverKey) this._detailHide();
      else this._detailDrop();
      return;
    }

    const S = this._study;
    // Every pose term is a function of the one scalar, which is now a straight
    // 0 -> 1 rather than a two-segment piecewise: the tilt, the scale and the
    // recentring all run once, together, over one move.
    root.rotation.x += STUDY_TILT * k;
    this._zoomNow = lerp(1, this._closeZ, k);
    root.scale.multiplyScalar(this._zoomNow);

    // The print is what is centred. The lean centred the ROW and crossfaded to
    // the print on its second segment; with the second segment gone there is
    // nothing to crossfade and the target is simply the slot.
    const tu = S.slot.u, tv = S.slot.v;

    // Where that point has ended up, with the tilt and scale already on the
    // book. The offset is scaled by `k` so it is zero at the spread and exact
    // at the close look — see the STUDY_* header for why it cannot be
    // precomputed.
    root.updateMatrixWorld(true);
    const off = this._studyOff ??= new THREE.Vector3();
    const mesh = S.verso ? this._J.pageLeft : this._J.pageRight;
    // The last good offset is KEPT when the page stops being sampleable, which
    // happens on exactly one path and it matters: `close()` eases the zoom out
    // while the cover swings shut, and the moment the cover takes the leaves
    // back (`J.inside` goes false) they are no longer visible and there is
    // nothing to sample. Recomputing to zero there would snap a scaled, tilted
    // book a hand's width sideways on the first frame of the put-down.
    if (mesh?.visible && samplePage(mesh, tu, tv, this._tmpP)) {
      off.subVectors(STUDY_LOOK, this._tmpP);
    }
    root.position.addScaledVector(off, k);

    // The patch itself is built on HOVER, one beat before the click — see
    // `_hoverAt`. All this does is keep it alive for as long as the book is on
    // this print and throw it away when it is not; `_detailPrepare` returns
    // immediately when it is already holding the right one.
    //
    // `S.row == null` is the compare leaf: a framed rectangle with no print of
    // its own to swap out. It brings its own two quads — see `_cmpPlace`.
    if (S.row != null) this._detailPrepare(S);
    else this._detailDrop();

    if (k >= 1 && mesh?.visible) {
      // ── the recentre goes onto the MATRICES before anything reads them ────
      // Both of the calls below want world positions on the page as it now
      // stands, recentring included. The first version of this passed `off`
      // down and added it to each sample by hand, on the reasoning that a
      // translation of the root is a translation of every point on it and a
      // second tree walk could be saved — which is true, and which produced a
      // print a screen-width off to the left, because it is impossible to say
      // WHICH matrices a given `samplePage` ran against: the call's quaternion
      // branch ends in `mesh.getWorldQuaternion`, and three's implementation of
      // that is `updateWorldMatrix(true, false)` — it silently refreshes the
      // whole ancestor chain mid-frame. So one sampler in this function was
      // reading pre-recentre matrices and its neighbour four lines later was
      // reading post-recentre ones, and both looked correct in isolation.
      // (`_trackCloseZoom` survived it only because it measures a SIZE, and a
      // translation does not change one.)
      //
      // One walk of a 20-node tree, only while the close look is up, buys the
      // question not being askable.
      root.updateMatrixWorld(true);
      // Only once the move has LANDED. The fit is solved up front, in
      // `_solveCloseZoom`, and this is what keeps it honest across a resize —
      // running it mid-move instead means the target the ease is heading for
      // moves while the ease is running. Measured, that is not subtle: sampled
      // on rAF through a single move, the solve went seed 8 -> 4.0 (a
      // meaningless measurement at k = 0.003, clamped) -> 12.2 -> back down to
      // 9.11, and the scale covered half its log distance in the first 40% of
      // the move instead of at the halfway point.
      // …and not while the PLAYER is driving the camera. The fit measures the
      // print's projected box, so with a free camera on top it would read the
      // player's own zoom as an error in its own and scale the book to undo it
      // — the book would fight the wheel. It re-solves the moment the pose
      // comes home, and a resize while panned leaves the fit stale until then,
      // which is the honest cost and is smaller than the alternative.
      if (!this.panned) this._trackCloseZoom(mesh, S.slot);
      if (this._cmp) this._cmpPlace(mesh);
      else this._detailShow(S, mesh);
    } else if (k > 0 && mesh?.visible) {
      root.updateMatrixWorld(true);
      if (this._cmp) this._cmpPlace(mesh);
      else this._detailShow(S, mesh);
    } else {
      this._detailHide();
      if (this._cmpQuad) for (const m of this._cmpQuad) if (m) m.visible = false;
    }
  }

  /**
   * Solve the fit ONCE, before the move starts, by posing the book where the
   * move is going and measuring it there.
   *
   * `_trackCloseZoom` is a one-division correction that is only exact when the
   * framed rectangle is actually sitting on `STUDY_LOOK` — which is true at the
   * END of the move and nowhere else, because the recentring offset is scaled
   * by `k`. Running it every frame of the move was right when the move was the
   * second rung of a ladder and started from a book already leaning; with one
   * rung it starts from the spread, where the measurement is meaningless, and
   * the ease spends the first third of itself chasing a target that is moving.
   *
   * So the pose the move is HEADING for is applied to the root here, off-frame,
   * measured, and put back. Two iterations rather than one, not because the
   * relationship is non-linear — it is linear, and that is arranged rather than
   * lucky (see `_trackCloseZoom`) — but because the first iteration's trial
   * scale can be far enough out that the rectangle's corners project behind the
   * lens and the measurement is refused. The second lands on the answer to four
   * decimal places, which is what the tracker then confirms on arrival.
   *
   * Costs one extra `updateMatrixWorld` of a 20-node tree per click.
   */
  _solveCloseZoom() {
    const S = this._study;
    const root = this._bookRoot;
    const mesh = S?.verso ? this._J.pageLeft : this._J.pageRight;
    if (!S || !mesh?.visible) return;
    const p0 = (this._sp0 ??= new THREE.Vector3()).copy(root.position);
    const s0 = (this._ss0 ??= new THREE.Vector3()).copy(root.scale);
    const rx = root.rotation.x;
    // The measurement projects through the camera, so it is taken through the
    // camera the FIT owns rather than through whatever the player has done to
    // it. Without this a click from a tumbled book solves a scale that is
    // correct for the tumbled view and wrong for the square one it is about to
    // ease back to — and the two are easing at once, so it would never settle.
    const cam = this.camera;
    const cp = (this._scp ??= new THREE.Vector3()).copy(cam.position);
    const cq = (this._scq ??= new THREE.Quaternion()).copy(cam.quaternion);
    if (this._camPos0) {
      cam.position.copy(this._camPos0);
      cam.quaternion.copy(this._camQuat0);
      cam.updateMatrixWorld(true);
    }
    const off = this._solveOff ??= new THREE.Vector3();
    for (let i = 0; i < 2; i++) {
      root.position.copy(p0);
      root.scale.copy(s0);
      root.rotation.x = rx + STUDY_TILT;
      root.scale.multiplyScalar(this._closeZ);
      root.updateMatrixWorld(true);
      if (!samplePage(mesh, S.slot.u, S.slot.v, this._tmpP)) break;
      off.subVectors(STUDY_LOOK, this._tmpP);
      root.position.add(off);
      root.updateMatrixWorld(true);
      // The tracker divides by the scale that is on the book; here that is the
      // trial itself.
      this._zoomNow = this._closeZ;
      this._trackCloseZoom(mesh, S.slot);
    }
    root.position.copy(p0);
    root.scale.copy(s0);
    root.rotation.x = rx;
    root.updateMatrixWorld(true);
    cam.position.copy(cp);
    cam.quaternion.copy(cq);
    cam.updateMatrixWorld(true);
  }

  /**
   * Correct the fit. Called on the frames the move has LANDED on, which is
   * what carries a window resize.
   *
   * The scale that satisfies an 80% contain-fit depends on the window's aspect
   * (which moves both `_fitCamera`'s lens AND its dolly), on which page of the
   * spread the print is on, and on where in the leaf's bend it sits. A fixed
   * number was the first attempt and it cannot be right: tuned at 1600x900 it
   * was 14% off at 1280x1024 and 34% off on a phone.
   *
   * The solve is one division because the relationship is LINEAR and that is
   * arranged rather than lucky: the print is held at `STUDY_LOOK`, a fixed world
   * point, so its distance from the camera does not change with the scale and
   * its projected size is proportional to it. Measure the box at the scale that
   * is on the book right now, divide, done — a second frame changes it by well
   * under a percent, and it re-solves for free when the window is resized.
   *
   * The caller has already put the recentring onto the matrices, so the four
   * corners are read straight off the page — see the note at the call site for
   * the bug that paid for that rule.
   */
  _trackCloseZoom(mesh, slot) {
    const q = this._cq ??= [0, 1, 2, 3].map(() => new THREE.Vector3());
    const hw = slot.w / 2, hh = slot.h / 2;
    const uv = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      if (!samplePage(mesh, slot.u + uv[i][0], slot.v + uv[i][1], q[i])) return;
      q[i].project(this.camera);
      if (q[i].z > 1) return;                     // behind the lens; not a size
      x0 = Math.min(x0, q[i].x); x1 = Math.max(x1, q[i].x);
      y0 = Math.min(y0, q[i].y); y1 = Math.max(y1, q[i].y);
    }
    // NDC spans -1..1 across the frame, so half the span IS the fraction of it.
    const span = Math.max((x1 - x0) / 2, (y1 - y0) / 2);
    if (!(span > 1e-4)) return;
    const want = CLOSE_FILL / span;
    if (Math.abs(want - 1) < 0.004) return;       // already there; leave it be
    // The clamp is a guard against a nonsense measurement (a leaf caught
    // mid-turn, a corner behind the lens), not a rate limit — one step is meant
    // to land, and at [0.5, 4] a fresh close look converges on the first frame.
    const step = Math.max(0.5, Math.min(4, want));
    // The floor is 1 — the spread's own scale — and nothing above it. It used
    // to be `STUDY_ZOOM`, on the argument that the close look must never end up
    // wider than the lean it came through; the lean is gone, and the constant
    // was actively wrong for the compare leaf, where a whole page at 80% of the
    // frame is 1.19x and 2.55 cropped the question off the top of it.
    this._closeZ = Math.max(1, Math.min(CLOSE_ZOOM_MAX, this._zoomNow * step));
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  The detail patch — the print at the resolution the store actually holds
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Draw the studied print once more, at the resolution its own source can pay
   * for, onto its own canvas.
   *
   * ── the finding this exists for, measured at 1600x900 ─────────────────────
   * At the close look the print's emulsion is **878 CSS pixels** across. The
   * page texture holds it at **220 x 126 texels** (`journal_page.printPatch`
   * has that arithmetic), so what the player would be looking at is a **3.99x**
   * magnification of the page — **7.99x** on a dpr-2 display. Meanwhile the
   * store keeps 1024 px of it. So **the page texture, not the store, is what
   * limits this view**: the extra pixels the store pays quota for were being
   * thrown away one step later, at paint time, and raising `THUMB_MAX` on its
   * own would have changed nothing anybody could see. The A/B is
   * `_jclose.mjs --nopatch`, and the two crops are not close.
   *
   * Raising the page's own resolution was the other way to fix it and it is not
   * an option worth having: 2x on six leaves is 143 MB of canvas, and 2x still
   * would not carry a 1024 px photo (it would hold 440 of it).
   *
   * So the print is drawn again on its own canvas and composited over the leaf
   * as a flat quad — the same trick and the same `samplePage` placement the
   * flying print already lands with, so this is a second user of a proven path
   * rather than a new one. **Nothing here names a resolution**: `printPatch`
   * reads the decoded photo's own width, so the view is 0.86x (a downscale, and
   * crisp) at today's 1024 px store, would be 1.72x at 512, and gets better on
   * its own the day the store keeps more.
   *
   * ── why the baked print is HIDDEN rather than covered ──────────────────────
   * Everything in the patch is translucent somewhere — the drop shadow, both
   * pieces of tape, the tape's own shadow — so the copy underneath would show
   * through every one of them and darken it twice. `hidePrint` takes it out of
   * the page texture for as long as the patch is up, and puts it back after.
   *
   * ── and why there is no cross-fade ─────────────────────────────────────────
   * The swap happens on the first frame of the dolly, when the print is still
   * 17% of the frame wide, and the two images are the same drawing from the
   * same seed at two resolutions. Fading between them would mean showing bare
   * paper through a half-transparent print for a fifth of a second, which is a
   * far louder artifact than a sharpness change nobody can see at that size. It
   * is the same argument `_bakePhoto` makes for swapping the flying card the
   * instant it lands.
   */
  /**
   * The pointer is over this print (or over nothing). Arm the detail patch.
   *
   * ── where the raster went when the lean went ──────────────────────────────
   * Drawing the patch is 14-28 ms of canvas work (`_jclose` prints it with the
   * raster forced; Chromium defers 2D raster and JOURNAL_NOTES 9 is the
   * standing warning about timing it any other way). That is two dropped
   * frames, and it has to be spent somewhere the eye is not.
   *
   * It used to be spent on the frame the LEAN landed: a still picture over a
   * paused world, one whole rung before the click that needed it. With the lean
   * gone the click is the only remaining moment — and the click is the START of
   * the move, which is exactly where §14.4 refused to put it.
   *
   * So it moves one beat EARLIER instead of one later: the pointer resting on a
   * print already changes the cursor to `zoom-in`, and a print somebody is
   * about to click is a print they are hovering. `HOVER_ARM` of dwell keeps a
   * pointer sweeping across a spread of eight prints from rastering eight
   * canvases on its way past — measured, a sweep at any speed a hand actually
   * moves crosses a slot in well under it.
   *
   * The canvas is thrown away when the pointer leaves and the book is not on
   * that print, so at most one 9.2 MB canvas exists at a time, exactly as
   * before.
   */
  _hoverAt(seat) {
    const key = seat ? `${seat.page}:${seat.row}` : null;
    if (key === this._hoverKey) return;
    this._hoverKey = key;
    this._hoverT = 0;
    this._hoverSeat = seat;
  }

  /** The dwell, ticked from `update`. */
  _hoverTick(dt) {
    if (!this._hoverSeat || this._studyTo > 0 || this._cmp) return;
    if (this._detailFor === this._hoverKey) return;
    this._hoverT += dt;
    if (this._hoverT < HOVER_ARM) return;
    const p = this._pages?.[this._hoverSeat.page];
    if (!p) return;
    this._detailPrepare({ page: this._hoverSeat.page, row: this._hoverSeat.row });
  }

  _detailPrepare(S) {
    const key = `${S.page}:${S.row}`;
    if (this._detailFor === key) return;
    this._detailDrop();
    const page = this._pages?.[S.page];
    if (!page) return;
    let patch = null;
    try { patch = page.printPatch(S.row, DETAIL_PX_MAX); } catch (e) {
      if (!this._pageErr) { this._pageErr = true; console.error('[journal] detail patch failed', e); }
    }
    if (!patch) return;
    this._detailFor = key;
    this._detailUV = patch.uv;
    // What the patch bought, kept for the harness rather than logged: source
    // width in, drawn width out. `_jclose.mjs` prints it beside the screen size.
    this._detailInfo = { px: patch.px, src: patch.src, dst: patch.dst };
    const m = this._detailMesh();
    this._detailTex = new THREE.CanvasTexture(patch.canvas);
    this._detailTex.colorSpace = THREE.SRGBColorSpace;
    this._detailTex.anisotropy = this._maxAniso ?? 1;
    m.material.map = this._detailTex;
    m.material.emissiveMap = this._detailTex;
    m.material.needsUpdate = true;
  }

  /**
   * Put the prepared patch on the page, and take the baked print off it.
   *
   * Placed off the LIVE page every frame, exactly the way the flying print is:
   * centre and orientation from `samplePage`, size from the world distance
   * between the rectangle's own edge midpoints — MEASURED rather than derived
   * from `BOOK.W`, so it is right at any book scale without this function
   * having to know what that scale is. (Deriving it was the other option and it
   * is wrong by the root scale, which is 1.10 at the spread and 9.09 here.)
   */
  _detailShow(S, mesh) {
    const m = this._detail;
    if (!m || !this._detailUV) return;
    if (!this._placeOnPage(m, mesh, this._detailUV, S.verso)) return;

    if (!this._detailHidden) {
      this._detailHidden = this._detailFor;
      try { this._pages?.[S.page]?.hidePrint(S.row, true); } catch (e) {
        if (!this._pageErr) { this._pageErr = true; console.error('[journal] hidePrint failed', e); }
      }
    }
  }

  /**
   * Lay one quad flat on the live page over UV rect `U`, and return whether it
   * could be done. Shared by the close look's patch and by the two prints on
   * the compare leaf; `m.visible` is written either way.
   *
   * The size is MEASURED — the world distance between the rectangle's own edge
   * midpoints — rather than derived from `BOOK.W`, so it is right at any book
   * scale without this function having to know what that scale is. (Deriving it
   * was the other option and it is wrong by the root scale, which is 1.10 at
   * the spread and 9.09 at the close look.)
   *
   * `lift` is in metres and `grow` scales the quad about its own centre; the
   * compare leaf's hover uses both and the close look uses neither.
   */
  _placeOnPage(m, mesh, U, verso, lift = 0.0009, grow = 1) {
    const a = this._da ??= new THREE.Vector3();
    const b = this._db ??= new THREE.Vector3();
    if (!samplePage(mesh, U.u, U.v, this._tmpP, this._tmpQ)) { m.visible = false; return false; }
    if (!samplePage(mesh, U.u - U.w / 2, U.v, a) ||
        !samplePage(mesh, U.u + U.w / 2, U.v, b)) { m.visible = false; return false; }
    const w = a.distanceTo(b);
    if (!samplePage(mesh, U.u, U.v - U.h / 2, a) ||
        !samplePage(mesh, U.u, U.v + U.h / 2, b)) { m.visible = false; return false; }
    const h = a.distanceTo(b);

    m.visible = true;
    m.position.copy(this._tmpP);
    m.quaternion.copy(this._tmpQ);
    m.scale.set(w * grow, h * grow, 1);
    m.userData.pageW = w;
    // ── A VERSO IS A SHEET THAT HAS BEEN TURNED OVER ─────────────────────────
    // `samplePage` hands back the LEAF's own basis, and the left-hand leaf is
    // bent with p = 1 (`poseJournal`), so `deformPage` writes it a normal of
    // (0, 0, -1) and its tangent runs the other way too — which is why
    // `journal_model` draws that leaf `pageMat(BackSide)` and why
    // `journal_page._toUV` flips u on a verso. Relative to a recto the basis is
    // the same one turned a half-turn about the page's own vertical, which is
    // what this undoes: the quad is a fresh plane with its art the right way
    // round, so it wants the RECTO orientation wherever it lands.
    //
    // Shipped without it, the quad on a verso was back-to-front — front-face
    // culled, and lifted 0.9 mm UNDER the paper by the hold-off below, where
    // the leaf's own depth write covered it. The baked print had already been
    // taken out of the page texture by `hidePrint`, so the symptom was not a
    // misplaced photograph but BARE PAPER at the close look, on pages 1 and 3 —
    // eight of the fifteen lines. It reads as a photo that failed to load,
    // which is why it was first chased in the store and in `_armAward`; neither
    // has anything to do with it. The row is fully populated and `printPatch`
    // hands back its 1825 px canvas on a verso exactly as on a recto.
    //
    // Measured through the real game with `tools/_scratch/_jsweep.mjs`, as the
    // quad's own +Z against the direction the camera is looking:
    //   recto (fox, page 2 · highCamp, page 4)   -0.985 before, -0.985 after
    //   verso (deer, page 1 · owl,      page 3)  +0.985 before, -0.985 after
    //
    // Turning the material double-sided instead would have put the print back
    // on screen MIRRORED — captured, at `shots/journal/round6/`. See
    // `_detailMesh` for why it is still front-sided.
    if (verso) m.quaternion.multiply(this._flipY ??= new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    const n = this._dn ??= new THREE.Vector3();
    n.set(0, 0, 1).applyQuaternion(m.quaternion);
    // The page is 10 degrees off face-on here, so what 0.9 mm costs sideways is
    // 0.9 mm x sin(10) against a print 220 mm wide on screen — 0.07%.
    m.position.addScaledVector(n, lift);
    return true;
  }

  /**
   * Take the patch off the page and give the leaf its own print back — but KEEP
   * the canvas, because the player is still leaning in on this row and may well
   * go back in.
   */
  _detailHide() {
    if (this._detail) this._detail.visible = false;
    if (!this._detailHidden) return;
    const [p, r] = this._detailHidden.split(':');
    this._detailHidden = null;
    try { this._pages?.[+p]?.hidePrint(+r, false); } catch { /* torn down */ }
  }

  /** Hide it and throw the canvas away. */
  _detailDrop() {
    this._detailHide();
    if (this._detailFor == null) return;
    this._detailFor = null;
    this._detailUV = null;
    if (this._detail) {
      this._detail.material.map = null;
      this._detail.material.emissiveMap = null;
      this._detail.material.needsUpdate = true;
    }
    this._detailTex?.dispose();
    this._detailTex = null;
  }

  /** The quad the patch is drawn on. Built once, kept, emptied when not in use. */
  _detailMesh() {
    return this._detail ??= this._printQuad(4);
  }

  /**
   * One quad for a print to be composited onto, over the paper.
   *
   * `order` is where it sits between the leaf and the flying card. Each quad
   * gets its OWN material rather than sharing one, because the compare leaf
   * dims and fades its two independently and a shared material cannot say two
   * things at once.
   */
  _printQuad(order) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      // The PAGE's white point and the PAGE's surface, for the reason the
      // flying card carries them (journal_model's `PAPER_GAIN`): this quad sits
      // in the middle of the paper it is replacing a piece of, and any
      // difference in exposure would draw a rectangle on the leaf.
      //
      // `transparent` because the drop shadow, the tape and the tape's shadow
      // all have to blend into the page; `depthWrite: false` because a
      // transparent surface a millimetre above the paper has no business
      // occluding anything.
      //
      // It stays FRONT-SIDED, and that is a decision rather than a default.
      // `DoubleSide` would also have made the verso bug in `_placeOnPage` go
      // away — the quad would have been visible from behind — and it would have
      // shipped a MIRRORED photograph, because seeing the back of a quad
      // reverses it.
      // A print that is absent is a bug somebody reports in a day; a print that
      // is flipped left-for-right is one nobody ever notices. Front-sided, the
      // quad is culled the moment its orientation disagrees with the paper's,
      // which is the same discipline `journal_model` applies to the leaves
      // themselves (`pageA` FrontSide, `pageB` BackSide) and is what made this
      // bug loud enough to find.
      new THREE.MeshStandardMaterial({
        color: new THREE.Color().setScalar(PAPER_GAIN),
        roughness: 0.88, metalness: 0,
        emissive: 0xfff2dc, emissiveIntensity: 0.12 * PAPER_GAIN,
        transparent: true, depthWrite: false,
      }));
    m.visible = false;
    m.renderOrder = order;          // under the flying card, over the leaf
    m.frustumCulled = false;
    this.scene.add(m);
    return m;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  The compare leaf — which of these two prints do you keep
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Advance the compare. Called from `update` once the leaf exists, and it is
   * the only thing driving this ceremony — there is no beat table for it,
   * because after the book arrives the timing belongs to the player.
   */
  _cmpTick(dt) {
    const C = this._cmp;
    if (!C.up) {
      // The leaf has to be at REST before the prints go on it: they are placed
      // with `samplePage` every frame, and a leaf in flight is not a page.
      if (this._seekQueue > 0 || this._leafT < 1 || this._at('flyleaf') < 1) return;
      C.up = true;
      this._cmpRaise();
      return;
    }
    // The hover eases rather than snapping. A print that jumps 4 mm the instant
    // the pointer crosses its edge reads as a glitch at the edge, and the
    // pointer spends most of its time near one.
    for (let k = 0; k < 2; k++) {
      const want = C.chosen == null && C.hover === k ? 1 : 0;
      const step = dt / CMP_HOVER;
      C.ease[k] = want > C.ease[k]
        ? Math.min(want, C.ease[k] + step) : Math.max(want, C.ease[k] - step);
    }
    if (C.chosen == null) return;
    C.t += dt;
    if (C.t >= CMP_SLAP + CMP_HOLD) this._cmpFinish();
  }

  /** Frame the leaf and build the two print quads. */
  _cmpRaise() {
    const C = this._cmp, p = this._pages[C.page];
    // The compare reuses the close look's framing solve: `_study` with a null
    // row means "frame this rectangle and composite nothing over a print",
    // which is exactly what this page needs — the contain-fit, the recentring
    // and the tilt all come for free and there is one framing solver in the
    // file rather than two.
    const frame = p.compareFrameUV();
    this._study = {
      page: C.page, row: null, verso: p.spec.verso, ...frame, slot: frame,
    };
    this._studyOff?.set(0, 0, 0);
    // Its own seed, not `CLOSE_ZOOM_SEED`: a whole leaf at 80% of the frame is
    // 1.19x, and starting the solve at a print's 8 would send the book in and
    // straight back out inside one move.
    this._closeZ = 1;
    this._solveCloseZoom();
    this._zoomTo(1);
    for (let k = 0; k < 2; k++) {
      const patch = p.comparePatch(k, C.img[k], k === 0 ? 1 : 0, DETAIL_PX_MAX);
      if (!patch) continue;
      const m = (this._cmpQuad ??= [])[k] ??= this._printQuad(4);
      const tex = new THREE.CanvasTexture(patch.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this._maxAniso ?? 1;
      m.material.map = tex;
      m.material.emissiveMap = tex;
      m.material.needsUpdate = true;
      (this._cmpTex ??= [])[k] = tex;
      (this._cmpUV ??= [])[k] = patch.uv;
    }
    this._cursorTo('');
  }

  /**
   * Place both prints on the leaf, with the hover and the slap on top.
   *
   * Called from `_applyStudy` with the matrices already refreshed, for the same
   * reason the close look's patch is placed there: `samplePage` reads world
   * matrices and one frame of staleness is a visible millimetre off the paper.
   */
  _cmpPlace(mesh) {
    const C = this._cmp;
    if (!C.up || !this._cmpUV) return;
    for (let k = 0; k < 2; k++) {
      const m = this._cmpQuad?.[k], U = this._cmpUV[k];
      if (!m || !U) continue;
      const e = C.ease[k];
      let lift = 0.0009, grow = lerp(1, CMP_GROW, e), dim = lerp(1, CMP_DIM, C.ease[1 - k]);
      let fade = 1;
      if (C.chosen != null) {
        const t = clamp01(C.t / CMP_SLAP);
        if (C.chosen === k) {
          // The one that is kept goes DOWN onto the paper with the ceremony's
          // own squash — the same 7.5% over the tail of the move that
          // `_flyPhoto` lands the awarded print with, so the two beats are one
          // gesture rather than two dialects.
          const hit = clamp01((t - 0.55) / 0.45);
          const sq = Math.sin(Math.PI * hit) * 0.075;
          grow = lerp(CMP_GROW, 1, easeOut(t));
          m.scale.z = 1;
          lift = lerp(0.0009 + this._cmpLift(m), 0.0009, easeOut(t));
          dim = 1;
          this._cmpSquash = sq;
        } else {
          // And the one that is not slides off the page and goes.
          fade = 1 - easeInOut(t);
          dim = CMP_DIM;
        }
      } else {
        lift = 0.0009 + this._cmpLift(m) * e;
      }
      if (!this._placeOnPage(m, mesh, U, this._study.verso, lift, grow)) continue;
      if (C.chosen === k) {
        const sq = this._cmpSquash ?? 0;
        m.scale.x *= 1 + sq;
        m.scale.y *= 1 - sq;
      }
      if (C.chosen != null && C.chosen !== k) {
        // Straight down the page, not toward the camera: it is being taken off
        // the paper, not thrown at the reader.
        const d = this._cmpDown ??= new THREE.Vector3();
        d.set(0, -1, 0).applyQuaternion(m.quaternion);
        m.position.addScaledVector(d, (1 - fade) * (m.userData.pageW ?? 0) * 0.45);
      }
      m.material.color.setScalar(PAPER_GAIN * dim);
      m.material.opacity = fade;
      m.visible = m.visible && fade > 0.01;
    }
  }

  /**
   * How far a hovered print comes off the paper, in metres.
   *
   * A FRACTION of the print's own measured width rather than a distance,
   * because the fit has put the book at whatever scale this window needs
   * (9.09x at 1600x900, 7.93x on a phone) and a fixed 4 mm would be a different
   * gesture on each. `pageW` is written by `_placeOnPage` on the frame before,
   * so the first frame of a hover lifts by nothing, which nobody can see.
   */
  _cmpLift(m) { return (m.userData.pageW ?? 0) * CMP_LIFT; }

  /** Which of the two prints is under a screen point, or -1. */
  /**
   * Is the pointer on the book itself?
   *
   * The book's surface belongs to the book — page turns, print clicks, the
   * compare — and the space around it belongs to the camera. Without this, a
   * left-drag that started on a page both tilted the book and (on release,
   * inside the slop) turned a page, which is the one thing that made driving it
   * unusable: you cannot line up a spread with a gesture that also leafs
   * through it.
   *
   * A raycast rather than a bounding box, because at a tilt the box is mostly
   * empty air and the gap between the covers is exactly where a player aims to
   * grab "not the book". The painted contact shadow is excluded: it is a
   * transparent quad lying under the book, several cover-widths across, and
   * treating it as the book would make most of the table undraggable.
   *
   * Bounding spheres are refreshed first. `deformPage` rewrites page positions
   * every frame and never touches the sphere three.js culls against, so a bent
   * leaf can be missed entirely — the hit test would then report "not the book"
   * over the one surface that most obviously is. Once per press is free.
   */
  _overBook(clientX, clientY) {
    if (!this.book || !this.camera) return false;
    const T = this.ctx.THREE ?? globalThis.__THREE;
    if (!T) return false;
    const rc = this._rc ??= new T.Raycaster();
    const nd = this._ndc ??= new T.Vector2();
    nd.set((clientX / Math.max(1, window.innerWidth)) * 2 - 1,
           -((clientY / Math.max(1, window.innerHeight)) * 2 - 1));
    rc.setFromCamera(nd, this.camera);
    this.book.traverse((o) => {
      if (o.isMesh && o.visible && o.geometry?.attributes?.position) {
        o.geometry.computeBoundingSphere();
      }
    });
    for (const h of rc.intersectObject(this.book, true)) {
      if (h.object === this._J?.shadow) continue;
      return true;
    }
    return false;
  }

  _cmpAt(clientX, clientY) {
    const C = this._cmp;
    if (!C?.up || C.chosen != null || this._studyK < 0.5) return -1;
    const p = this._pages[C.page];
    const mesh = p.spec.verso ? this._J.pageLeft : this._J.pageRight;
    if (!mesh?.visible) return -1;
    const px = (clientX / Math.max(1, window.innerWidth)) * 2 - 1;
    const py = -((clientY / Math.max(1, window.innerHeight)) * 2 - 1);
    for (let k = 0; k < 2; k++) {
      if (this._inSlot(mesh, p.compareSlotUV(k), px, py)) return k;
    }
    return -1;
  }

  /** Hover, which repaints the leaf only when it CHANGES. */
  _cmpHover(k) {
    const C = this._cmp;
    if (!C || C.chosen != null || C.hover === k) return;
    C.hover = k;
    const p = this._pages[C.page];
    if (p?.spec?.compare) {
      p.spec.compare.hover = k;
      try { p.paint(); } catch (e) {
        if (!this._pageErr) { this._pageErr = true; console.error('[journal] compare repaint failed', e); }
      }
    }
    this._cursorTo(k >= 0 ? 'pointer' : '');
  }

  /**
   * Keep print `k`. 0 is the one already in the book, 1 is the new one.
   *
   * The STORE is written here and the row's decoded image with it, rather than
   * at the end of the beat: `hunt.setPhoto` is the housekeeping door its own
   * header describes, it is synchronous, and a player who shuts the book
   * mid-slap has still made their choice. Choosing the incumbent writes
   * nothing at all — and still slaps, because the request asked for the beat on
   * whichever one is kept and because a choice that makes no sound reads as a
   * click that was not registered.
   */
  _cmpChoose(k) {
    const C = this._cmp;
    if (!C?.up || C.chosen != null) return;
    C.chosen = k;
    C.t = 0;
    this._cursorTo('');
    if (k === 1) {
      hunt.setPhoto(C.id, C.url);
      const page = this._pages[C.seat.page];
      const row = page?.spec?.rows?.[C.seat.row];
      if (row) {
        row.photo = C.img[1];
        row.tapeT = 1;
        try { page.paint(); } catch (e) {
          if (!this._pageErr) { this._pageErr = true; console.error('[journal] page paint failed', e); }
        }
      }
    }
    this._cue('slap');
  }

  /**
   * Leave the compare without choosing — which KEEPS the one in the book.
   *
   * That is what the line at the foot of the leaf says, and it is the only
   * reading that can be right: the player has not said the new photograph is
   * better, and the book already holds the other one. Nothing is written.
   */
  _cmpAbandon() {
    if (!this._cmp) return;
    this._cmpFinish();
  }

  /** Put the leaf back, drop the prints, and leaf home to the entry. */
  _cmpFinish() {
    const C = this._cmp;
    if (!C) return;
    this._backTo = Math.max(0, Math.ceil(C.seat.page / 2));
    this._cmpDrop();
    this._zoomTo(0);
  }

  /** Take the compare off the book entirely. Safe to call at any time. */
  _cmpDrop() {
    const C = this._cmp;
    this._cmp = null;
    this._cmpSquash = 0;
    if (C) {
      // A candidate the player did NOT keep is never written to the store, so
      // nothing else will ever ask for it again — and `loadPhoto`'s cache is
      // keyed by the data URL and never evicts. Left in, every re-photograph of
      // an already-found subject would pin a full-size decode for the session.
      // The one that was kept stays cached: it is a stored photo now, and the
      // page it is taped into will ask for it every time it repaints.
      if (C.chosen !== 1) forgetPhoto(C.url);
      const p = this._pages?.[C.page];
      if (p?.spec) {
        p.spec.compare = null;
        try { p.paint(); } catch { /* torn down */ }
      }
    }
    for (let k = 0; k < 2; k++) {
      const m = this._cmpQuad?.[k];
      if (m) {
        m.visible = false;
        m.material.map = null;
        m.material.emissiveMap = null;
        m.material.color.setScalar(PAPER_GAIN);
        m.material.opacity = 1;
        m.material.needsUpdate = true;
      }
      this._cmpTex?.[k]?.dispose();
      if (this._cmpTex) this._cmpTex[k] = null;
      if (this._cmpUV) this._cmpUV[k] = null;
    }
  }

  /**
   * The photographed row under a screen point, or null.
   *
   * No raycaster and no second surface: `samplePage` already answers "where in
   * the world is this bit of page", it reads the table `deformPage` left behind
   * rather than re-integrating the bend, and it is the same function the flying
   * print lands with. So the four corners of the print's slot go out through it
   * and into the camera, and the test is point-in-quad on the screen. A
   * raycaster against the leaf geometry would be a second, differently-wrong
   * answer to a question that already has one — and it would need the page
   * meshes to carry a UV lookup the print does not use.
   *
   * Two kinds of seat come back, and which one a slot offers is decided by
   * whether there is a photograph in it:
   *
   *  · `'study'` — a row that HAS a print. Leaning in on it is the whole
   *    close-look ladder, and it is what this function used to be all of.
   *
   *  · `'target'` — a row that has NO print and names something that can be
   *    gone looking for. This used to return nothing at all: "an empty slot is
   *    a corner mark on a page and leaning in on nothing is a worse outcome
   *    than the click falling through to a page turn." That was right about
   *    leaning in and it left the better verb unspoken. An empty frame on a
   *    scavenger hunt is not nothing — it is the shot you have not taken — and
   *    saying "this is the one I am after" is exactly what a reader wants to do
   *    to it. The two never contend: a row has a print or it has a slot, never
   *    both, so this adds a verb where there was none rather than splitting one.
   *
   * A row that can't be tracked (the Moon, the waterfall) still offers nothing,
   * and the click still falls through to the page turn it always did.
   */
  _rowAt(clientX, clientY) {
    if (!this._active || this._leafT < 1 || this._seekQueue > 0) return null;
    const s = Math.floor(this._pose.leaf + 1e-6);
    if (Math.abs(this._pose.leaf - s) > 1e-4) return null;

    const w = window.innerWidth, h = window.innerHeight;
    const px = (clientX / Math.max(1, w)) * 2 - 1;
    const py = -((clientY / Math.max(1, h)) * 2 - 1);

    // The two leaves facing the reader: page 2s-1 on the left, 2s on the right.
    // Exactly the pairing `setJournalPages` binds the materials with.
    for (const idx of [2 * s - 1, 2 * s]) {
      const p = this._pages[idx];
      if (!p?.spec?.rows?.length) continue;
      const mesh = p.spec.verso ? this._J.pageLeft : this._J.pageRight;
      if (!mesh?.visible) continue;
      for (let r = 0; r < p.spec.rows.length; r++) {
        const row = p.spec.rows[r];
        const kind = row.done && row.photo ? 'study'
          : !row.done && row.track ? 'target' : null;
        if (!kind) continue;
        const slot = p.slotUV(r);
        if (this._inSlot(mesh, slot, px, py)) return { page: idx, row: r, kind };
      }
    }
    return null;
  }

  /** Is (px, py) in NDC inside this slot's projected quad? */
  _inSlot(mesh, slot, px, py) {
    const hw = (slot.w * SLOT_PICK) / 2, hh = (slot.h * SLOT_PICK) / 2;
    const q = this._quad ??= [0, 1, 2, 3].map(() => new THREE.Vector3());
    const uv = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    for (let i = 0; i < 4; i++) {
      if (!samplePage(mesh, slot.u + uv[i][0], slot.v + uv[i][1], q[i])) return false;
      q[i].project(this.camera);
      // Behind the camera. `project` mirrors such a point through the origin,
      // which would make a quad that is off-screen behind you test as a hit.
      if (q[i].z > 1) return false;
    }
    // Two triangles rather than four half-plane tests: a page is bent, so the
    // projected quad is not convex and a winding test on it is not reliable.
    const tri = (a, b, c) => {
      const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
      if (Math.abs(d) < 1e-9) return false;
      const l1 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / d;
      const l2 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / d;
      return l1 >= 0 && l2 >= 0 && l1 + l2 <= 1;
    };
    return tri(q[0], q[1], q[2]) || tri(q[0], q[2], q[3]);
  }

  /**
   * The one affordance this feature needs, and the cheapest one available.
   *
   * A print you can go in on has to say so, and the journal has no chrome to
   * say it with — the whole feature is a book with no labels on it. `zoom-in`
   * over a print and `zoom-out` once you are in is the browser's own vocabulary
   * for exactly this and costs nothing.
   *
   * Written straight onto the canvas, the way `Camp._paintCursor` does, and
   * only on a CHANGE — the two do not fight because each caches what it last
   * wrote and neither writes a value it already believes is there. Cleared on
   * close, so the driving view never inherits it.
   */
  _cursorTo(want) {
    if (want === this._cursor) return;
    this._cursor = want;
    const el = (this.ctx.renderer ?? this.ctx.engine?.renderer)?.domElement;
    if (el) el.style.cursor = want;
  }

  /** Turn `dir` leaves, if the book has them and nothing is already moving. */
  leaf(dir) {
    if (this._leafT < 1 || this._seekQueue > 0) return;
    // Leaning in takes the page keys too. See `_bindInput`: everything backs
    // out one level at a time rather than teleporting to the spread and turning
    // a page in the same keystroke.
    if (this._studyTo > 0) return;
    // The ceremony has right of way: leafing away from the award mid-strike
    // would leave a half-drawn pencil line on a page nobody is looking at.
    if (this._script?.hasAward && !this._taped && this._t < (this._script.end + (this._seekPad ?? 0)))
      return;
    // …and so does the compare leaf, and so does the walk home from it.
    if (this._cmp || this._backTo != null) return;
    const to = Math.max(0, Math.min(this._sheets - 1, Math.round(this._pose.leaf) + dir));
    if (to === Math.round(this._pose.leaf)) return;
    this._leafFrom = this._pose.leaf;
    this._leafTo = to;
    this._leafT = 0;
    // Its OWN duration. This line was missing, so a turn by hand inherited
    // whatever the last SCRIPTED turn had left behind — `SCRIPT.flyleaf`
    // (0.62 s) after an ordinary open, `SCRIPT.seekLeaf` (0.30 s) after an
    // award had leafed to its page or the compare had walked home. The same
    // gesture at two speeds depending on how the book was opened. 0.62 is the
    // one it has after a plain open, which is the case a player browsing the
    // book is in, so pinning it there leaves the common feel alone and takes
    // the riffle out of the other one.
    this._leafDur = SCRIPT.flyleaf;
    this._cue('page');
  }

  // ───────────────────────────────────────────────────────────────────────────

  dispose() {
    window.removeEventListener('keydown', this._onKey, { capture: true });
    window.removeEventListener('keyup', this._onKeyUp, { capture: true });
    window.removeEventListener('wheel', this._onWheel, { capture: true });
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel'])
      window.removeEventListener(t, this._onPointer, { capture: true });

    this._cursorTo('');
    this._detailDrop();
    this._detail?.geometry.dispose();
    this._detail?.material.dispose();
    this._detail = null;
    this._cmpDrop();
    for (const m of this._cmpQuad ?? []) {
      m?.geometry.dispose();
      m?.material.dispose();
    }
    this._cmpQuad = null;
    this._unsub?.();
    for (const p of this._pages) p.dispose();
    this._pages = [];
    disposePaperCache();
    this._rt?.dispose();
    this._rt = null;
    this._blitMat?.dispose();
    this._blitScene?.children[0]?.geometry?.dispose();
    this._cardTex?.dispose();
    this._card?.geometry.dispose();
    this._card?.material.dispose();
    this._scrim?.geometry.dispose();
    this._scrim?.material.dispose();
    this.book?.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
    disposeJournalMaterials();
    this._env?.dispose?.();
    this.scene?.clear();
    this._visible = false;
    this._active = false;
  }
}

export default Journal;
