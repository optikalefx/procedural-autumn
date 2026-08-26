// ─────────────────────────────────────────────────────────────────────────────
//  lens_models — the two lenses in the photographer's bag, and the optics that
//  make swapping between them mean something.
//
//  Photo mode has always had exactly one field of view: whatever the chase
//  camera happened to be running (about 50 degrees vertical, which off a 36 mm
//  full-frame width is a 22 mm lens). That is a perfectly good walking-around
//  view and it is the reason every photograph the game has produced so far is
//  the same photograph — a wide establishing shot of a camper in a valley. You
//  cannot take a portrait of a deer with a 22 mm lens; you can only walk closer
//  until it leaves.
//
//  So: two lenses, with a real gap between them.
//
//   · `wide` — a 24-70 mm f/2.8. Fat, stubby, front-heavy. 111 mm long on an
//     88 mm barrel, which is a length-to-diameter ratio of 1.26 : 1. At its
//     wide end it is almost exactly the view the game already had, so putting
//     it on changes nothing and that is the point: it is the lens that is
//     already fitted.
//   · `tele` — a 200-400 mm f/4. 365 mm on a 124 mm barrel, 4 : 1, with a
//     tripod collar, a foot it stands on, and a hood you could post a letter
//     into. At 400 mm it sees 5.2 degrees across.
//
//  ── what makes a cylinder read as a lens ────────────────────────────────────
//
//  Everything in this file is a surface of revolution, and the first version
//  proved that surfaces of revolution alone are not enough: two smooth dark
//  tubes of different lengths, correct to the millimetre, that a photographer
//  would have called "pipe". What was missing, in the order the fixes mattered:
//
//   1. THE RINGS, AS GEOMETRY. A zoom ring is rubber with 26 to 30 axial ribs
//      standing 2.6 mm proud. Painted on as a texture it is invisible; as
//      geometry it throws 26 specular lines that curve with the barrel, and
//      that curve is what says "round" and "grippable". `ribbed()` below does
//      it by displacing the radius of a lathe, which costs a few hundred
//      triangles rather than the 5 000 the first attempt spent scattering
//      rounded boxes around a circle.
//   2. THE COATING FLARE. The single most recognisable thing about a modern
//      lens is the oil-slick magenta/cyan sheen on the front glass, and it is
//      nearly free — a Fresnel term on a dark, smooth material, hue-rotated
//      with the grazing angle. Nothing else in this file changes the read as
//      much per line of code. See `coatingPatch`.
//   3. RECESSION. The element is 12 mm inside the filter ring on the wide and
//      30 mm inside on the tele, down a black tube with four baffle ridges in
//      it. A front element flush with the rim reads as a painted disc.
//   4. PRINT. "24-70mm 1:2.8" around the barrel is what turns "a lens" into
//      "a 24-70". There are no texture assets in this repo and there is not
//      going to be one; the markings are drawn into a canvas at build time and
//      alpha-tested onto a 0.3 mm proud band. See `decalBand`.
//
//  ── things that are true here and were not obvious ──────────────────────────
//
//  **Barrel plastic is not black.** Authored at 0x1a1a1a both lenses read as
//  holes cut in the frame — the same finding `camp_telescope.js` records for
//  its gloss black, which photographs at about 12% reflectance and looks like a
//  cut-out at 3%. They are a very dark warm grey now, and the contrast is
//  bought from the white print, the bright mount and the gold ring instead.
//
//  **There is no metal in this game.** No system sets `scene.environment` and
//  the shared material sets carry `envMapIntensity` with no `envMap`, so a
//  standard material at high metalness has no diffuse term and nothing to
//  reflect: it renders flat near-black. `camp_table.js` measured this,
//  `camp_telescope.js` re-measured it, and this file makes the same choice —
//  every part is a dielectric with its colour carried by the vertex tint.
//
//  **`toCreasedNormals` does not work at this scale, and fails silently.** The
//  addon hashes vertex positions at `1e2`, i.e. it welds everything within one
//  CENTIMETRE. On a prop whose entire feature set is millimetres, that averages
//  the normal of the front glass with the normal of the filter ring, and the
//  first ribbed ring came back looking like a smooth tube with a slight glow.
//  `crease()` below scales the geometry by 100 before calling it and back
//  afterwards, which puts the weld threshold at 0.1 mm. Do not remove the
//  scaling because it looks redundant.
//
//  ── the frame ───────────────────────────────────────────────────────────────
//
//  Group space: the lens lies on its side on a table. `+Z` is the direction it
//  points (out of the front element), `+Y` is up as the lens hangs on a camera,
//  and `y = 0` is the table — the wide rests on its hood and mount, the tele on
//  its tripod foot, which is exactly what each does in life. The optical axis
//  is therefore at `userData.anchors.axisY`, not at zero, and every anchor
//  below is published in group space so no caller has to rederive it:
//
//      anchors.mount   flange plane centre
//      anchors.front   centre of the front element's rim
//      anchors.entry   the front vertex of the glass itself
//      anchors.axisY   height of the optical axis above the table
//      anchors.length  mount to front rim, in metres (hood excluded)
//
//  Same discipline as `camp_telescope.js`'s eyepiece anchor and for the same
//  reason: a system that has to guess where the front of a prop is will guess
//  wrong the first time somebody changes a dimension.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';
// Imported rather than copied. It is four lines and it is not optional: this
// prop is built the same way the camper and the camp props are — a few hundred
// merged primitives, several of them lathes that pinch to a point — so it
// produces exactly the same zero-length normals, which become NaN in the
// fragment shader and then an ~800 px black square out of the bloom mip chain.
// The full autopsy is in `camp_materials.js` and `model_kit.js`.
import { sanitizeNormals } from '../camp/camp_materials.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;

// ─────────────────────────────────────────────────────────────────────────────
//  Optics
// ─────────────────────────────────────────────────────────────────────────────

/** Full-frame sensor, in millimetres. The whole reason "35 mm" means anything. */
export const FRAME_W = 36;
export const FRAME_H = 24;

/**
 * Horizontal angle of view, in degrees, for a focal length in millimetres.
 *
 * The honest formula off a 36 mm frame width, and it is worth being honest
 * because the numbers are the whole feeling of the mechanic: 24 mm is 73.7
 * degrees, 70 mm is 28.8, 200 mm is 10.3 and 400 mm is 5.2. A tele that gave
 * 15 degrees would be a slightly tighter wide, not a telephoto.
 */
export function fovForFocal(mm) {
  return 2 * Math.atan(FRAME_W / (2 * Math.max(1, mm))) * DEG;
}

/** The inverse: what focal length is this horizontal angle of view? */
export function focalForFov(deg) {
  return FRAME_W / (2 * Math.tan((deg / DEG) * 0.5));
}

/**
 * The number three actually wants: a VERTICAL fov, in degrees, for a focal
 * length and a viewport aspect.
 *
 * `PerspectiveCamera.fov` is vertical, and a 36×24 frame is 3:2 while the game
 * window is whatever the player dragged it to. Matching the *horizontal* angle
 * and deriving the vertical from the real aspect is the only version that
 * behaves: it means a 24 mm lens frames the same amount of valley left-to-right
 * on every monitor, and a window that gets taller shows more sky rather than
 * silently becoming a wider lens.
 *
 * The first version returned `2*atan(24/2f)` — the vertical angle off the film
 * height — which is right only at 3:2 and gave a 16:9 player a view 12% wider
 * than the focal length printed on the barrel.
 */
export function cameraFovForFocal(mm, aspect = 16 / 9) {
  const h = (fovForFocal(mm) / DEG) * 0.5;
  return 2 * Math.atan(Math.tan(h) / Math.max(0.2, aspect)) * DEG;
}

/** The inverse of the above — "what lens is the camera wearing right now?" */
export function focalForCameraFov(vFovDeg, aspect = 16 / 9) {
  const v = (vFovDeg / DEG) * 0.5;
  return focalForFov(2 * Math.atan(Math.tan(v) * Math.max(0.2, aspect)) * DEG);
}

/**
 * Whole stops, for anything that wants to offer an aperture (see B's PhotoFocus).
 *
 * f/32 is on this list because the tele claims `fStopMin: 32` and a lens that
 * advertises a minimum aperture it can never be set to is a lie in the data:
 * `stopsFor` filtered against a ladder that stopped at 22, so the tele's own
 * `stops` array quietly disagreed with its own `fStopMin`. A long lens really
 * does stop down to 32 — it is the aperture you would use on a ridgeline — so
 * the ladder was the thing that was short.
 */
// Must MATCH `STOPS` in photo_focus.js — that file owns the ring and this one
// only says which rungs a given barrel reaches. They disagreed once already
// (32 here against a ring that stopped at 22) and the symptom was a stop the
// table offered and nothing could set. 28 is the last rung and it is the
// pinhole; see `PostFX.setPinhole`.
export const APERTURE_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22, 28];

/** The stops a given lens can actually be set to. */
export function stopsFor(lens) {
  return APERTURE_STOPS.filter((f) => f >= lens.fStop - 1e-6 && f <= lens.fStopMin + 1e-6);
}

/**
 * The bag.
 *
 * `mmMin`/`mmMax` are the barrel; everything else is what a mode needs to
 * actually USE one. `id` is stable — it goes into a saved setting.
 *
 * The ranges deliberately do not meet. 70 mm to 200 mm is a real gap in a real
 * bag and it is the most interesting fact about owning these two lenses rather
 * than one 24-400 superzoom, so the mechanic leans on it rather than papering
 * over it: the ring stops at the barrel's own limits and crossing the gap is
 * an act — `cycle()`, the `L` key, the rail's swap button. See the `LensKit`
 * header for why the ring used to cross it by itself and no longer does.
 */
export const LENSES = [
  {
    id: 'wide',
    name: '24-70mm',
    display: '24-70mm f/2.8',
    blurb: 'The lens that is already on the camera. Landscapes, camp, the whole valley.',
    mmMin: 24,
    mmMax: 70,
    mmDefault: 35,
    // Constant f/2.8 across the range, like the lens it is modelled on.
    fStop: 2.8,
    fStopMin: 28,
    minFocus: 0.38,        // metres — it will focus on a marshmallow
    filter: 82,            // mm, printed on the barrel
    build: buildWideZoomLens,
  },
  {
    id: 'tele',
    name: '200-400mm',
    display: '200-400mm f/4',
    blurb: 'Heavy glass on a tripod collar. Wildlife, ridgelines, the moon.',
    mmMin: 200,
    mmMax: 400,
    mmDefault: 200,        // entering from the gap should land on the wide end
    fStop: 4,
    // 22, not 32, and the difference is a promise this table cannot keep:
    // `PhotoFocus` owns the aperture ring and its ladder stops at f/22, so a
    // 32 here is a row `stopsFor` would hand out and nothing could ever set.
    // A real 200-400 does stop to f/32; this game's does not, and a table that
    // says otherwise is the kind of quiet lie the rest of this file exists to
    // avoid. Raise it if the ring's range ever grows.
    fStopMin: 28,
    minFocus: 2.0,
    filter: 52,            // drop-in rear filter, as on the real thing
    build: buildTeleZoomLens,
  },
];

/** Derived once, so nothing downstream has to remember which end is which. */
for (const l of LENSES) {
  l.fovWide = fovForFocal(l.mmMin);     // degrees across, at the wide end
  l.fovTight = fovForFocal(l.mmMax);
  l.stops = stopsFor(l);
}

export const lensById = (id) => LENSES.find((l) => l.id === id) ?? LENSES[0];

// ─────────────────────────────────────────────────────────────────────────────
//  LensKit — the switching mechanic
// ─────────────────────────────────────────────────────────────────────────────
//
//  The state a photo mode needs is small: which lens, and where its zoom ring
//  is. It lives here rather than in the HUD because the interesting behaviour
//  is entirely about the pair, and a rule about the pair kept in the file that
//  draws sliders is a rule that gets re-derived the next time the rail changes.
//
//  THE ONE IDEA: the zoom ring stops where the barrel stops.
//
//  This used to be the opposite idea, and the opposite idea is written up at
//  length in `docs/LENS_NOTES.md` §2 because it was argued for and shipped:
//  `zoom()` walked ONE log-spaced ladder across BOTH lenses and changed the
//  body when the ring ran off the top of the wide, after a banked detent of
//  resistance so it could not happen on a flick. It felt good to whoever knew
//  it was there. It is gone, because the person the mode is for said plainly
//  that it should not be there: *"the zoom ring should not change lenses
//  automatically. It should just toast saying 'cannot zoom out further, switch
//  lenses' same in the max direction."* That settles it, and it settles it in
//  the direction of the less clever design — a ring that silently swaps the
//  glass on your camera is a ring that did something you did not ask for.
//
//  So `zoom()` now walks ONE lens and parks at its limits, returning `'end'`
//  at either. `setLens`/`cycle` — the `L` key and the rail's swap button — are
//  the only way to change bodies. The gap between 70 mm and 200 mm is still
//  real and still the most interesting fact about owning these two lenses; it
//  is now something you cross deliberately rather than something the ring
//  crosses for you. The caller is expected to say so out loud when `'end'`
//  comes back (`hud_photo._ringStop` ticks and toasts); the barrel going quiet
//  at the stop was, in the old design, the one moment of the gesture with no
//  feedback at all.
//
//  Detents are LOG-SPACED, which is the only spacing that feels even: 24 -> 26
//  is a visible change and 380 -> 400 is not, so a linear ring is dead for its
//  whole top half. 28 detents cover 24-70; the same ratio per detent covers
//  200-400 in 19, and the whole ladder 24 -> 400 in 47 — counted by walking it,
//  not by dividing logs in a comment, which is how it came to say 26 and 39.
//
//  The constant used to be called DETENTS_PER_STOP, which in a file that also
//  models APERTURE STOPS reads as "detents per f-stop". It is detents per RING,
//  across one lens's whole travel.

const RING_DETENTS = 28;                           // over the wide's 24 -> 70
const DETENT = Math.pow(70 / 24, 1 / RING_DETENTS);

export class LensKit {
  /**
   * @param opts.lens    starting lens id
   * @param opts.focal   starting focal length in mm (clamped into the lens)
   * @param opts.onChange fn({ lens, focal, reason }) — 'zoom' | 'swap' | 'set'
   */
  constructor(opts = {}) {
    this.lens = lensById(opts.lens ?? 'wide');
    this.focal = clamp(opts.focal ?? this.lens.mmDefault, this.lens.mmMin, this.lens.mmMax);
    this.onChange = opts.onChange ?? null;
  }

  get index() { return LENSES.indexOf(this.lens); }
  /** 0 at the wide end of the fitted lens, 1 at the tight end. */
  get t() {
    const l = this.lens;
    return clamp01(Math.log(this.focal / l.mmMin) / Math.log(l.mmMax / l.mmMin));
  }
  get fov() { return fovForFocal(this.focal); }
  cameraFov(aspect) { return cameraFovForFocal(this.focal, aspect); }

  /** "24-70mm · 35mm · f/2.8" — one line, for a rail label. */
  label() {
    return `${this.lens.name} · ${Math.round(this.focal)}mm · f/${this.lens.fStop}`;
  }

  setFocal(mm, reason = 'set') {
    // `clamp` is Math.min/Math.max, and both propagate NaN. Without this line
    // `setFocal(NaN)` returned true, put NaN in `focal`, and every derived
    // number went with it — `fov`, `cameraFov`, and then `rig.fov`, which is a
    // NaN projection matrix and a black screen two systems away from here.
    if (!Number.isFinite(mm)) return false;
    const v = clamp(mm, this.lens.mmMin, this.lens.mmMax);
    if (Math.abs(v - this.focal) < 1e-4) return false;
    this.focal = v;
    this._emit(reason);
    return true;
  }

  /** Put the ring at a normalised 0..1 position — what a slider drives. */
  setT(t) {
    const l = this.lens;
    return this.setFocal(l.mmMin * Math.pow(l.mmMax / l.mmMin, clamp01(t)));
  }

  /**
   * Fit a lens outright. Keeps the ring where it was in *ratio* terms, so
   * swapping at the tight end of the wide lands at the tight end of the tele
   * rather than snapping to a default nobody asked for. Pass `focal` to
   * override; `setLens(id, { at: 'wide' })` for the wide end.
   */
  setLens(id, o = {}) {
    const next = lensById(id);
    if (next === this.lens && o.focal === undefined) return false;
    const t = o.at === 'wide' ? 0 : o.at === 'tight' ? 1 : this.t;
    this.lens = next;
    this.focal = o.focal !== undefined
      ? clamp(o.focal, next.mmMin, next.mmMax)
      : next.mmMin * Math.pow(next.mmMax / next.mmMin, t);
    this._emit('swap');
    return true;
  }

  /**
   * Next lens in the bag, wrapping. What the `L` key does.
   *
   * KEEPS THE RING WHERE IT WAS, which is the rule the whole mechanic is
   * documented on and which this method used to be the one exception to. It
   * passed `at: 'wide'` going up and `at: 'tight'` coming down — the rule that
   * belongs to `zoom()`, whose job is to keep the *ladder* continuous across
   * the gap — and the result was a ratchet: wide at t 0.5, `cycle(1)` to the
   * tele at 200, `cycle(1)` back to the wide at 24 rather than at the 35 it
   * started on. Two presses of one key are not supposed to move the ring.
   *
   * `L` is a deliberate swap, not a ring gesture, so it takes the deliberate
   * swap's rule: `setLens` with no `at` preserves the ratio position.
   */
  cycle(dir = 1) {
    const n = LENSES.length;
    const i = (this.index + (dir < 0 ? -1 : 1) + n) % n;
    return this.setLens(LENSES[i].id);
  }

  /**
   * Turn the zoom ring by `steps` detents. Positive is toward telephoto.
   *
   * @returns 'zoom' | 'end' | null
   *
   * `'end'` means the ring is against a stop and the focal did not get any
   * further. It NEVER changes the lens — see the class header. The caller is
   * the one that says so, because only the caller has a toast and a speaker.
   *
   * `'swap'` used to be a fourth return value here. It is gone rather than
   * left dormant: a verb no code path can produce is a verb the next reader
   * has to prove is dead.
   *
   * TWO THINGS THAT WERE WRONG HERE and are still worth keeping true.
   *
   *  · A GESTURE THAT RUNS INTO THE STOP STOPS THERE, whatever it had left to
   *    spend. `zoom(3)` from 65 mm parks on 70 and discards the other two
   *    steps; it does not keep pushing. That mattered enormously when the
   *    third step could change the lens and it still matters now, because the
   *    remaining steps would otherwise each report `'end'` and the caller
   *    would toast three times for one press.
   *  · A CLAMPED FOCAL STILL FIRES `onChange`. `result` is `'end'` on the step
   *    that clamps and `this.focal` has still MOVED (65 -> 70). The emit is
   *    driven by whether the focal moved, not by which verb came out —
   *    `onChange` is the only thing that writes `rig.fov` and the rail's
   *    label, so gating it on the verb left the camera at 65 while the kit
   *    said 70.
   */
  zoom(steps = 1) {
    if (!steps) return null;
    const dir = steps > 0 ? 1 : -1;
    const from = this.focal;
    let result = null;
    for (let i = 0; i < Math.abs(steps); i++) {
      const l = this.lens;
      const next = this.focal * (dir > 0 ? DETENT : 1 / DETENT);
      const past = dir > 0 ? next > l.mmMax + 1e-6 : next < l.mmMin - 1e-6;
      if (past) {
        this.focal = dir > 0 ? l.mmMax : l.mmMin;
        result = 'end';
        break;
      }
      this.focal = clamp(next, l.mmMin, l.mmMax);
      result = 'zoom';
    }
    if (this.focal !== from) this._emit('zoom');
    return result;
  }

  _emit(reason) { this.onChange?.({ lens: this.lens, focal: this.focal, reason }); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Materials
// ─────────────────────────────────────────────────────────────────────────────
//
//  One set, shared by both lenses, created lazily. Every one is a dielectric —
//  see the header on why there is no metal in this game — and every one carries
//  `vertexColors`, so a part gets its colour from the tint callback in
//  `LensParts.add` rather than from a new material.
//
//  Values, and the arguments for them:
//
//  BARREL. A modern lens barrel is glass-filled polycarbonate with a fine matte
//  crackle finish. Authored at 0x1a1a1a first, and both lenses read as holes;
//  authored at 0x6a6668 they read as galvanised pipe. 0x4a4547 photographs at
//  about the 12% a "black" plastic really reflects, and is warm rather than
//  neutral, because a neutral dark grey in a valley whose whole grade is gold
//  takes the light's chroma entirely and camouflages — the same measurement
//  the telescope author made about a white tube, arriving from the other end.
//
//  RUBBER. Darker AND warmer than the barrel, never the same value. What makes
//  a ring read as rubber and not as a groove is that it is a different black.
//
//  METAL. The bayonet flange and the filter ring. A bright dielectric standing
//  in for chromed steel with no specular to help it, so the albedo does all of
//  it, and it stays desaturated so it cannot be mistaken for the gold.
//
//  GOLD. The pro-grade band on the tele and the mount contacts. Held well under
//  a highlight: this is a 3 mm band and a saturated yellow ring on a dark tube
//  is the loudest thing on either model if you let it be.

let _mats = null;

export function lensMaterials() {
  if (_mats) return _mats;
  const std = (name, o) => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, ...o });
    m.name = `lens.${name}`;
    return m;
  };
  _mats = {
    barrel: std('barrel', { color: C(0x4d4a4e), roughness: 0.46, metalness: 0.0 }),
    rubber: std('rubber', { color: C(0x383233), roughness: 0.88, metalness: 0.0 }),
    metal:  std('metal',  { color: C(0xb6b8bc), roughness: 0.30, metalness: 0.0 }),
    gold:   std('gold',   { color: C(0xb9924a), roughness: 0.34, metalness: 0.0 }),
    accent: std('accent', { color: C(0xb03127), roughness: 0.44, metalness: 0.0 }),
    // The inside of the barrel and the inside of the hood. Flat, deep, and
    // still lifted off true black — a hood interior authored at 0x000000 is a
    // hole that the eye reads as a modelling error rather than as depth.
    flock:  std('flock',  { color: C(0x191719), roughness: 0.97, metalness: 0.0 }),
    glass:  glassMaterial(),
  };
  return _mats;
}

export function disposeLensMaterials() {
  if (!_mats) return;
  for (const m of Object.values(_mats)) m.dispose();
  _mats = null;
}

/**
 * The front element.
 *
 * A dark, smooth dielectric with a Fresnel coating flare added to its emissive
 * term. Three things had to be true at once and only the last combination got
 * all three:
 *
 *  · it must be DARK face-on. A modern multicoated element reflects about half
 *    a percent at normal incidence; anything brighter reads as a plastic lid.
 *  · it must be COLOURED at the edge, and the colour must rotate. That
 *    magenta-into-cyan sweep around the rim is the tell, and a single fixed
 *    tint reads as a coloured filter instead.
 *  · it must not be `transparent`. The first version was, with opacity 0.4 over
 *    the black barrel interior, and the depth sort put it behind the baffles
 *    from half the angles the gallery turntable passes through. It is opaque
 *    and dark, and the depth is bought by actually recessing it.
 *
 * `keepPhysicalSpecular` is Stylize's documented opt-in — its own comment names
 * "wet rock, glass, a lantern lens" — so the specular lobe is not compiled out
 * of a material whose entire appearance is specular. Harmless in the gallery
 * and in the preview, both of which never run Stylize at all.
 */
function glassMaterial() {
  const m = new THREE.MeshStandardMaterial({
    color: C(0x090b11), roughness: 0.035, metalness: 0.0, vertexColors: true,
  });
  m.name = 'lens.glass';
  m.userData.keepPhysicalSpecular = true;
  m.onBeforeCompile = coatingPatch;
  return m;
}

/**
 * Inject the coating flare.
 *
 * Added to `totalEmissiveRadiance` rather than folded into the diffuse, and
 * that is the whole point: irradiance is multiplied by albedo, and the albedo
 * here is 4% grey, so a coating routed through the lighting path is 4% of a
 * coating. Light bouncing off a thin film is not the surface's own colour —
 * exactly the argument `Stylize.js` makes for putting its golden-hour rim on
 * `directSpecular` instead.
 *
 * Chained safely: `uniformPatch.captureShader` also installs an
 * `onBeforeCompile` and chains onto whatever it finds, so registering this
 * material with Atmosphere or Stylize later cannot silently drop the coating.
 */
function coatingPatch(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_fragment_end>',
    /* glsl */`#include <lights_fragment_end>
    {
      // Fresnel against the shading normal. On a spherical cap this is also a
      // radial gradient: face-on at the centre, grazing at the rim, which is
      // where a real coating shows its colour and nowhere else.
      vec3 N = normalize( normal );
      vec3 vDir = normalize( vViewPosition );
      float ndv = clamp( dot( N, vDir ), 0.0, 1.0 );

      // TERM ONE: the rim. Fresnel against the shading normal, which on a
      // spherical cap is also a radial gradient — face-on at the centre,
      // grazing at the edge, which is where a real coating shows its colour.
      float rim = pow( 1.0 - ndv, 4.6 );

      // TERM TWO: the sky in the glass, and this is the one the first two
      // rounds were missing. A rim term alone is correct and it is not what a
      // lens looks like: face-on, an element is a broad coloured wash, because
      // what you are seeing is the whole sky reflected in a curved mirror. Both
      // earlier versions therefore produced a lens that was a flat teal disc
      // from three-quarters (too much constant) and a dead black hole head-on
      // (no constant at all), and neither ever looked like glass.
      //
      // There is no env map anywhere in this game to reflect (see the header),
      // so the sky is faked: reflect the view about the normal and read how far
      // UP the reflected ray goes. On a curved cap that sweeps smoothly across
      // the element and moves when the lens turns, which is the entire read.
      vec3 R = reflect( -vDir, N );
      float sky = smoothstep( -0.40, 0.95, R.y );

      // The oil slick. Two coating colours, swapped through by angle, so
      // turning the lens sweeps it from cyan to magenta the way a real
      // multicoating does. A single tint here reads as a coloured filter.
      vec3 cyan    = vec3( 0.07, 0.40, 0.48 );
      vec3 magenta = vec3( 0.46, 0.09, 0.50 );
      vec3 coat = mix( cyan, magenta, smoothstep( 0.08, 0.62, rim * 1.30 + sky * 0.58 ) );

      totalEmissiveRadiance += coat * ( rim * 0.90 + sky * 0.14 + 0.008 );
    }`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Geometry kit
// ─────────────────────────────────────────────────────────────────────────────

const M = () => new THREE.Matrix4();
const at = (x, y, z, rx = 0, ry = 0, rz = 0) => M().compose(
  new THREE.Vector3(x, y, z),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')),
  new THREE.Vector3(1, 1, 1),
);

/**
 * Average normals across edges softer than `angle`, keep the hard ones hard.
 *
 * THE SCALE FACTOR IS NOT DECORATION — see the header. `toCreasedNormals`
 * hashes vertex positions with a multiplier of 1e2, which welds anything within
 * a centimetre. Every feature on this prop is smaller than that, so unscaled it
 * averages the front glass into the filter ring, silently, and the only symptom
 * is that a ribbed ring stops having ribs.
 */
const CREASE_SCALE = 100;
function crease(g, angle = Math.PI / 5) {
  g.scale(CREASE_SCALE, CREASE_SCALE, CREASE_SCALE);
  const out = toCreasedNormals(g, angle);
  out.scale(1 / CREASE_SCALE, 1 / CREASE_SCALE, 1 / CREASE_SCALE);
  return out;
}

/**
 * A surface of revolution about +Z.
 *
 * `LatheGeometry` revolves about +Y, so this rotates the result a quarter turn
 * about X — which maps (r cos φ, h, r sin φ) to (r cos φ, −r sin φ, h): the
 * axis lands on Z and the radius stays in the XY plane, which is what every
 * helper below assumes.
 *
 * Close the profile (repeat the first point last) to get a solid shell with
 * thickness; leave it open for a single-sided skin.
 *
 * WHICH WAY IT FACES IS DECIDED BY THE ORDER OF THE POINTS. Three derives the
 * normal by rotating the profile tangent `(dr, dz)` to `(dz, -dr)`, so a
 * profile written with z INCREASING faces outward and one written with z
 * decreasing faces inward. That is the whole rule, it is not written down
 * anywhere in three, and getting it wrong produces a surface that is dark from
 * every angle — the failure this repo has now shipped five times and
 * misdiagnosed as a lighting problem every time. Interiors here (the throat,
 * the baffles, the inside of the hood) are written backwards ON PURPOSE.
 *
 * `phiLength` MUST BE POSITIVE. Three clamps it to [0, 2π], so a negative arc
 * silently becomes a zero-width lathe: real vertices, real indices, every
 * triangle degenerate, nothing on screen and nothing on the console. The first
 * version of `decalBand` passed a negative arc to mirror the text and every
 * marking on both lenses was invisible for a whole round.
 *
 * @param prof [[radius, z], …]
 */
function revolve(prof, seg = 48, phiStart = 0, phiLength = TAU) {
  const pts = prof.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-5), z));
  const g = new THREE.LatheGeometry(pts, seg, phiStart, Math.abs(phiLength));
  g.rotateX(Math.PI / 2);
  return g;
}

/**
 * Displace a geometry's radius with a periodic function of the angle: the
 * ribbing on a rubber grip ring, or the fine knurl on a metal filter ring.
 *
 * `pow(max(0, cos), 0.55)` rather than a plain cosine. A cosine gives a
 * sine-wave surface whose crests and troughs are the same width, which reads as
 * a wobble; real moulded ribbing is a narrow-ish ridge with a flat valley
 * between, and the exponent shapes exactly that with one multiply.
 *
 * The z window fades the ribs out over the last 0.6 mm at each end so they die
 * into the ring's shoulder rather than being sheared off, which is what the
 * moulding actually does and what stops the ring edge from sparkling.
 *
 * IT CAN ONLY MOVE VERTICES THAT EXIST. The first ring was a four-point lathe
 * profile — two chamfer points and two face points — so the only vertices in
 * the ribbed span sat exactly ON the fade boundaries, where the window is zero.
 * Every rib was displaced by precisely nothing, the geometry was correct, the
 * maths was correct, and both lenses came back with smooth rings. `gripRing`
 * below is the fix: it subdivides the ring face so the window has something to
 * act on. If a ribbed surface ever looks smooth again, count its vertices
 * before touching this function.
 */
function ribbed(g, { count = 28, depth = 0.0018, z0, z1, fade = 0.0006, sharp = 0.55 }) {
  const p = g.attributes.position;
  const a = p.array;
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    const r = Math.hypot(x, y);
    if (r < 1e-6) continue;
    const w = Math.min(smoothstep(z0, z0 + fade, z), 1 - smoothstep(z1 - fade, z1, z));
    if (w <= 0) continue;
    const th = Math.atan2(y, x);
    const ridge = Math.pow(Math.max(0, Math.cos(th * count)), sharp);
    const k = (r + depth * w * ridge) / r;
    a[i] = x * k; a[i + 1] = y * k;
  }
  p.needsUpdate = true;
  return g;
}

/**
 * A rubber grip ring: a chamfer, a subdivided face, a chamfer, ribbed.
 *
 * The subdivision is the whole reason this is a function — see `ribbed`. Eight
 * spans across the face is enough that the fade window has room to work at each
 * end and the middle stands at full depth, and it costs 5 more rings of quads
 * on a part that is already the most expensive thing on the lens.
 */
function gripRing(r, z0, z1, { ribs, depth, sharp = 0.55, chamfer = 0.0016, inset = 0.0026 }) {
  const a = z0 + chamfer, b = z1 - chamfer;
  const prof = [[r - inset, z0]];
  const n = 8;
  for (let i = 0; i <= n; i++) prof.push([r, lerp(a, b, i / n)]);
  prof.push([r - inset, z1]);
  const g = revolve(prof, ribs * 6);
  // The window sits INSIDE the vertex range, not on its boundary.
  return ribbed(g, { count: ribs, depth, sharp, z0: a - 0.0002, z1: b + 0.0002,
    fade: (b - a) / n * 0.9 });
}

/**
 * Push the vertices near the front rim of a hood forward by a function of the
 * angle — which is how a four-petal tulip hood gets made here.
 *
 * Done as a post-pass on a closed lathe rather than as a swept patch, because
 * a lathe's winding is correct by construction and a hand-swept shell's is not.
 * Three separate authors in this repo have shipped geometry whose winding
 * disagreed with its normals (`frond`, `tube`, `buildBarkGeometry`) and every
 * time it was misdiagnosed as a lighting problem first; a closed lathe cannot
 * make that mistake, so the petals are bent into one instead of being built as
 * one.
 *
 * `blend` falls off with distance back from the rim so the petal curve runs
 * down the flare rather than starting as a step at the lip.
 */
function petalled(g, { petals = 2, amp = 0.016, zRim, zBack, phase = Math.PI / 2 }) {
  const p = g.attributes.position;
  const a = p.array;
  const span = Math.max(1e-5, zRim - zBack);
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    if (z <= zBack) continue;
    const blend = Math.pow(clamp01((z - zBack) / span), 1.35);
    const th = Math.atan2(y, x);
    a[i + 2] = z + amp * Math.cos(petals * (th - phase)) * blend;
  }
  p.needsUpdate = true;
  return g;
}

/**
 * Merge-by-material bins, `model_kit.js`'s pattern with one addition.
 *
 * The addition is `crease`. The camp and vehicle kits delete the normals and
 * `computeVertexNormals()` on a non-indexed geometry, which is flat shading —
 * correct for those props (a six-sided chair leg WANTS its facets) and wrong
 * for this one, where a 48-facet barrel flat-shaded reads as a nut rather than
 * as a tube. So each part names the crease angle it wants, and the default
 * (36 degrees) smooths a barrel while keeping every profile corner hard.
 */
class LensParts {
  constructor(label = 'lens') { this.bins = new Map(); this.label = label; }

  /**
   * @param geo   source geometry (consumed)
   * @param key   material key
   * @param m     placement matrix, or null
   * @param tint  [r,g,b] or fn(x,y,z)->[r,g,b], baked into the colour attribute
   * @param opt.crease  crease angle in radians; 0 for flat shading
   */
  add(geo, key, m = null, tint = null, opt = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    const ang = opt.crease ?? Math.PI / 5;
    // Before the placement matrix: the crease hash is position-based, and a
    // part creased after being moved out to its final home is creased against
    // its neighbours as well as itself.
    g = ang > 0 ? crease(g, ang) : (g.deleteAttribute('normal'), g.computeVertexNormals(), g);
    if (m) g.applyMatrix4(m);
    if (!g.attributes.uv) {
      const n = g.attributes.position.count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const p = g.attributes.position.array;
    if (typeof tint === 'function') {
      for (let i = 0; i < n; i++) {
        const c = tint(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      }
    } else {
      const c = tint || [1, 1, 1];
      for (let i = 0; i < n; i++) { col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    sanitizeNormals(g);
    if (!this.bins.has(key)) this.bins.set(key, []);
    this.bins.get(key).push(g);
    return this;
  }

  flush(parent, mats) {
    for (const [key, list] of this.bins) {
      const mat = mats[key];
      if (!mat) { console.warn(`[${this.label}] no material "${key}"`); continue; }
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) { console.warn(`[${this.label}] merge failed for "${key}"`); continue; }
      if (list.length > 1) for (const g of list) g.dispose();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `${this.label}_${key}`;
      parent.add(mesh);
    }
    this.bins.clear();
    return parent;
  }
}

/**
 * A very low-amplitude value drift along the barrel.
 *
 * Not noise for its own sake — the brief names uniform noise as an anti-pattern
 * and it is right. This is one low-frequency thing: the barrel gets very
 * slightly lighter toward the front, the way a lens that has been in and out of
 * a bag for five years does, plus a whisper of circumferential variation so a
 * 48-facet tube is not exactly one value all the way round. Amplitude is 4%;
 * at 8% it read as dirt and at 15% as a texture bug.
 */
function barrelTint(base, len, wear) {
  return (x, y, z) => {
    const k = 1 + (z / Math.max(len, 1e-3)) * 0.055 * (0.4 + wear)
              + Math.cos(Math.atan2(y, x) * 3) * 0.018;
    return [base[0] * k, base[1] * k, base[2] * k];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Print
// ─────────────────────────────────────────────────────────────────────────────
//
//  There are no texture assets in this repo and this does not add one: the
//  markings are drawn into a canvas at build time with the browser's own font
//  stack, exactly the way `tree_textures.js` builds its cluster atlas. The band
//  is alpha-tested rather than blended, so it needs no sorting and cannot pick
//  up the halo an under-resolved blended decal gets at a grazing angle.
//
//  TWO TRAPS, both of which produced a lens that says in code that it is
//  printed and shows nothing, or shows nonsense:
//
//   · A NEGATIVE `phiLength` IS SILENTLY ZERO. The band was first generated
//     with a negative arc, on the theory that running φ backwards would put the
//     text the right way round. Three clamps `phiLength` to [0, 2π], so every
//     marking on both lenses became a zero-width lathe — real vertices, real
//     indices, every triangle degenerate, nothing on screen and nothing on the
//     console. `revolve` now takes `Math.abs` of it so this cannot recur.
//   · AND THE MIRROR WAS NOT NEEDED. Having "fixed" the arc, the next round
//     mirrored the texture as well (`repeat.x = -1`) and both lenses came back
//     reading "mm004-002". A lathe's `u` runs with φ, φ runs the same way the
//     text does, and the plain mapping was right all along. Two wrongs.
//
//  THE ASPECT TRAP, which is subtler: a band's proportions are its ARC LENGTH
//  by its axial height, and a canvas authored at a convenient 4:1 onto a band
//  that is 7.8:1 stretches every glyph vertically by two. `bandTexture` derives
//  the canvas height from the band's real geometry so the type cannot distort.

/** Is there a DOM to draw into? Node-side harnesses import this module too. */
const CAN_DRAW = typeof document !== 'undefined';

function decalTexture(w, h, draw) {
  if (!CAN_DRAW) return null;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  draw(g, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/**
 * A band of barrel carrying a texture.
 *
 * TWELVE O'CLOCK IS φ = π, NOT π/2, and every printed marking on both lenses
 * was at three o'clock for a whole round because of it. `LatheGeometry` puts a
 * profile point at angle φ at `(r sin φ, h, r cos φ)`, so φ = 0 is +Z; then
 * `revolve`'s `rotateX(π/2)` maps that to `(r sin φ, −r cos φ, h)`, i.e. the
 * bearing you actually see is `ψ = φ − π/2`. The old default of π/2 therefore
 * put the headline print, the focal scale and both index marks flat on the +X
 * side of the barrel — measured at `[0.051, …, 0.275]` on a 60 mm radius,
 * dead sideways — while three separate comments claimed twelve o'clock. The
 * distance band, offset from that, ended up low and on the far side, so one of
 * the two authored print bands was essentially never seen.
 *
 * `ARC_UP` is that bearing. Anything else that wants a clock position on a
 * lathe should be written as `ARC_UP + <radians anticlockwise from noon>`.
 *
 * @param r         barrel radius the band wraps (it sits 0.4 mm proud)
 * @param z0,z1     axial extent
 * @param arc       radians of barrel it covers
 * @param up        which way is "up" on the barrel for this band, in radians
 */
const ARC_UP = Math.PI;                    // lathe φ that lands at +Y, i.e. noon

function decalBand(r, z0, z1, arc, up = ARC_UP) {
  return revolve([[r + 0.0004, z0], [r + 0.0004, z1]],
    Math.max(16, Math.round(arc * 26)), up - arc * 0.5, arc);
}

/**
 * A finished band: geometry, an aspect-correct canvas, and the mesh.
 *
 * `draw(g, W, H)` gets a canvas whose proportions are the band's own — see the
 * aspect trap above — so type drawn square comes out square on the barrel.
 */
function bandMesh(name, { r, z0, z1, arc, up = ARC_UP, px = 1024 }, draw, owned) {
  const arcLen = arc * r;
  const h = Math.max(1e-4, z1 - z0);
  const tex = decalTexture(px, Math.max(24, Math.round(px * h / arcLen)), draw);
  if (!tex) return null;
  const mat = printMaterial(tex);
  owned.push(tex, mat);
  const mesh = new THREE.Mesh(decalBand(r, z0, z1, arc, up), mat);
  mesh.name = name;
  return mesh;
}

/** The white/grey ink every lens is printed with. */
const INK = '#e8e4dc';
const INK_DIM = '#9a948c';

const FACE = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/**
 * Set a font at `size`, then shrink it until the string fits `maxW`.
 *
 * A BAND HAS TWO DIMENSIONS AND THE TYPE WAS ONLY EVER CHECKED AGAINST ONE.
 * Every size in this file is a fraction of the canvas HEIGHT, which is derived
 * from the band's own aspect so that glyphs come out square — correct, and
 * completely silent about whether the string is longer than the band is wide.
 * The tele's headline band is 1024 x 358, so `H * 0.44` is 158 px type, and
 * "200-400mm  1:4" measures 1185 px at that size: 161 px of overflow, about 80
 * off each end, and the lens read "00-400mm 1:" on the barrel.
 *
 * `measureText` is the only honest test, because the answer depends on the
 * font stack the browser actually resolved, which is not knowable from here.
 */
function fitText(g, str, weight, size, maxW) {
  g.font = `${weight} ${Math.round(size)}px ${FACE}`;
  const w = g.measureText(str).width;
  if (w <= maxW || w <= 0) return size;
  const s = Math.max(8, Math.floor(size * (maxW / w)));
  g.font = `${weight} ${s}px ${FACE}`;
  return s;
}

function printMaterial(tex) {
  const m = new THREE.MeshStandardMaterial({
    map: tex, transparent: false, alphaTest: 0.45,
    roughness: 0.52, metalness: 0.0, side: THREE.FrontSide,
  });
  m.name = 'lens.print';
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A 24-70 mm f/2.8 standard zoom.
 *
 * @param rnd   seeded RNG; used for wear and for the ring rest positions only
 * @param opts.hood   fit the tulip hood (default true)
 * @param opts.wear   0..1 how used it looks (default 0.35)
 * @param opts.zoom   0..1 initial zoom ring position (default 0)
 */
export function buildWideZoomLens(rnd, opts = {}) {
  return assemble(WIDE, rnd, opts);
}

/**
 * A 200-400 mm f/4 telephoto zoom, with a tripod collar and foot.
 *
 * @param rnd   seeded RNG
 * @param opts.hood   fit the deep hood (default true)
 * @param opts.wear   0..1 (default 0.35)
 * @param opts.zoom   0..1 initial zoom ring position (default 0)
 */
export function buildTeleZoomLens(rnd, opts = {}) {
  return assemble(TELE, rnd, opts);
}

// ── the two specifications ───────────────────────────────────────────────────
//
// Everything below is millimetres divided by a thousand, taken off the two
// lenses these are modelled on. They are written out rather than derived from
// each other because the whole point of the pair is that they are NOT the same
// object at two scales, and a shared parametric barrel would have quietly made
// them one — the same argument `camp_telescope.js` makes about its refractor
// and its reflector.

const WIDE = {
  key: 'wide',
  lens: 'wide',
  seg: 48,
  print: '24-70mm  1:2.8',
  printSub: 'ø82',
  scale: ['24', '35', '50', '70'],
  distance: ['∞', '3', '1.5', '0.8', '0.5', '0.38'],
  // r = radius, z = distance forward of the mount flange
  mountR: 0.0295, throatR: 0.0208,
  rear: { r: 0.0378, z0: 0.0045, z1: 0.0135 },
  zoomRing: { r: 0.0437, z0: 0.0135, z1: 0.0470, ribs: 26, depth: 0.0026 },
  window: { r: 0.0402, z0: 0.0470, z1: 0.0665 },
  focusRing: { r: 0.0420, z0: 0.0665, z1: 0.0880, ribs: 44, depth: 0.0011 },
  frontBarrel: { r: 0.0412, z0: 0.0880, z1: 0.1030 },
  filterRing: { r: 0.0428, z0: 0.1030, z1: 0.1110 },
  // The element: apex 12 mm inside the filter ring, and a shallow crown.
  glass: { r: 0.0292, zApex: 0.0920, sag: 0.0082 },
  hood: { r0: 0.0448, r1: 0.0512, z0: 0.1040, z1: 0.1500, wall: 0.0026,
          petals: 2, amp: 0.0170 },
  extendMax: 0.022,        // how far the front group travels over the zoom range
  gold: false,
  collar: null,
  switches: null,
  length: 0.1110,
};

const TELE = {
  key: 'tele',
  lens: 'tele',
  seg: 52,
  print: '200-400mm  1:4',
  printSub: 'ED  VR',
  scale: ['200', '250', '300', '400'],
  distance: ['∞', '15', '8', '5', '3', '2'],
  mountR: 0.0295, throatR: 0.0208,
  rear: { r: 0.0425, z0: 0.0045, z1: 0.0300 },
  // The foot is an Arca plate and runs 118 mm, not 82. A short foot puts the
  // whole support under the back fifth of a 345 mm lens, which is both wrong
  // (every long lens carries a plate you can slide fore and aft to balance on)
  // and reads wrong — the tele looked propped up rather than stood up. It does
  // not move the COLLAR, which stays where the barrel's z-ladder leaves room
  // for it; see the honest-weaknesses note.
  collar: { r: 0.0520, z0: 0.0300, z1: 0.0760, footZ0: 0.0300, footZ1: 0.1480,
            footDrop: 0.0900, footW: 0.0322 },
  zoomRing: { r: 0.0552, z0: 0.0790, z1: 0.1470, ribs: 30, depth: 0.0030 },
  window: { r: 0.0522, z0: 0.1470, z1: 0.1760 },
  focusRing: { r: 0.0560, z0: 0.1760, z1: 0.2360, ribs: 52, depth: 0.0013 },
  goldRing: { r: 0.0578, z0: 0.2390, z1: 0.2465 },
  frontBarrel: { r: 0.0600, z0: 0.2465, z1: 0.3300 },
  filterRing: { r: 0.0620, z0: 0.3300, z1: 0.3450 },
  glass: { r: 0.0452, zApex: 0.3140, sag: 0.0128 },
  hood: { r0: 0.0632, r1: 0.0700, z0: 0.3320, z1: 0.4520, wall: 0.0030,
          petals: 0, amp: 0 },
  // 38 mm of extension, AND THE REAL LENS DOES NOT DO THIS. A 200-400 f/4 is
  // an internal zoom; this was authored at 0 for that reason and the note is
  // still true. It is overruled by where the model is actually seen.
  //
  // The player meets this lens in a 188 x 128 rail panel, where the whole thing
  // is about 120 px long. Everything an internal zoom can offer — the ring
  // turning, the printed scale travelling under the index — is sub-pixel at
  // that size: measured, the ring alone moved 1.9% of the panel's pixels across
  // the entire 200 -> 400 travel, which is to say the control had no visible
  // response on the only surface that ships. Extension moves 9.4%, because it
  // changes the SILHOUETTE, and the silhouette is all a 120 px lens has.
  //
  // So the trade is stated rather than hidden: 38 mm on a 345 mm barrel, about
  // what a consumer 150-600 does, bought at the cost of a detail that is right
  // about the reference lens and invisible to the player either way.
  extendMax: 0.0380,
  gold: true,
  switches: { z0: 0.0075, z1: 0.0270 },
  length: 0.3450,
};

/**
 * Build one lens from a spec.
 *
 * The result is a `THREE.Group` in the frame described in the file header, with
 * four named children so a presenter can pose it:
 *
 *   userData.parts.zoom    the zoom ring        (rotates about the optical axis)
 *   userData.parts.focus   the focus ring       (rotates)
 *   userData.parts.front   the telescoping front group (translates on the wide)
 *   userData.parts.hood    so it can be taken off without a rebuild
 *   userData.setZoom(t)    poses all of the above for t in 0..1
 *   userData.setFocus(t)   turns the focus ring
 *   userData.dispose()     the print textures and materials this build owns
 *
 * `setZoom` exists because a lens that does not move when you turn the ring is
 * a photograph of a lens. It is the cheapest possible animation — one rotation
 * and one translation — and it is what makes the preview read as the mechanic
 * rather than as an icon.
 */
function assemble(S, rnd, opts = {}) {
  const R = typeof rnd === 'function' ? rnd : Math.random;
  const mats = lensMaterials();
  const hoodOn = opts.hood === undefined ? true : !!opts.hood;
  const wear = clamp01(opts.wear ?? 0.35);
  const owned = [];                    // textures/materials this build created

  const root = new THREE.Group();
  root.name = `lens_${S.key}`;
  const rig = new THREE.Group();       // everything, lifted to the table below
  root.add(rig);

  const body = new THREE.Group();      // static barrel, mount, collar
  const zoomG = new THREE.Group();     // the zoom ring alone
  const focusG = new THREE.Group();    // the focus ring alone
  const frontG = new THREE.Group();    // everything forward of the focus ring
  rig.add(body, zoomG, focusG, frontG);

  const P = new LensParts(`lens_${S.key}`);
  const barrelBase = [1, 1, 1];
  const tint = barrelTint(barrelBase, S.length, wear);

  // ── bayonet mount ─────────────────────────────────────────────────────────
  //
  // Only ever seen from behind, and worth its two thousand triangles anyway:
  // the back of a lens is the half a photographer recognises fastest, and a
  // flat disc there undoes the front. Flange, three tabs, ten contacts, a
  // weather gasket and a throat that is actually a hole.
  {
    // Flange plus the rear wall, as one closed profile: outer edge, forward
    // face, throat, back face.
    P.add(revolve([
      [S.throatR, 0.0000], [S.mountR, 0.0000], [S.mountR, 0.0022],
      [S.rear.r - 0.0015, 0.0030], [S.rear.r, 0.0045],
      [S.rear.r, 0.0060], [S.throatR, 0.0060], [S.throatR, 0.0000],
    ], S.seg), 'metal', null, [1, 1, 1], { crease: 0.55 });

    // The three bayonet tabs, reaching inward from the throat. 52 degrees each
    // with 68-degree gaps — the asymmetry is what stops the mount reading as a
    // gear, and it is what a real bayonet has so the lens can only go on one
    // way round.
    for (let i = 0; i < 3; i++) {
      const a0 = i * (TAU / 3) + 0.21;
      P.add(revolve([
        [S.throatR - 0.0026, 0.0022], [S.throatR, 0.0022],
        [S.throatR, 0.0040], [S.throatR - 0.0026, 0.0040],
        [S.throatR - 0.0026, 0.0022],
      ], 8, a0, 0.90), 'metal', null, [0.88, 0.88, 0.9], { crease: 0.5 });
    }

    // Ten electrical contacts on a 78-degree arc. Gold, small, and the only
    // gold on the wide lens at all.
    for (let i = 0; i < 10; i++) {
      const a = -1.05 + i * 0.152;
      P.add(revolve([
        [S.throatR - 0.0009, 0.0022], [S.throatR + 0.0004, 0.0022],
        [S.throatR + 0.0004, 0.0044], [S.throatR - 0.0009, 0.0044],
        [S.throatR - 0.0009, 0.0022],
      ], 3, a, 0.085), 'gold', null, [1, 1, 1], { crease: 0.5 });
    }

    // Weather gasket: the blue-black rubber lip that squashes against the body.
    P.add(revolve([
      [S.mountR - 0.0016, 0.0000], [S.mountR - 0.0004, -0.0012],
      [S.mountR - 0.0034, -0.0012], [S.mountR - 0.0016, 0.0000],
    ], S.seg), 'rubber', null, [0.9, 0.92, 1.0], { crease: 0.9 });

    // The throat is a hole, not a disc. A short dark tube down the middle with
    // a rear element glinting at the bottom of it. Written z-DECREASING so it
    // faces inward: it is the only surface on the back of the lens you are
    // meant to be looking at the inside of.
    P.add(revolve([
      [S.throatR, 0.0180], [S.throatR, 0.0060],
    ], S.seg), 'flock', null, [1, 1, 1], { crease: 0.9 });

    // The rear element, and it has to be SEEN or the back of the lens is a
    // hole. It was a cone — apex on the axis, 3 mm forward of the throat rim —
    // and a cone has ONE normal all the way down its profile, so the coating
    // patch (whose whole output is a function of the normal) produced one
    // constant, near-zero value across the entire surface. Correctly wound,
    // correctly placed, and indistinguishable from the flocking behind it: the
    // captures came back with a black void where the glass should be.
    //
    // A spherical cap instead, bulging BACKWARD out of the throat the way a
    // rear element does. The curvature is the point, not the shape: it sweeps
    // `ndv` from face-on at the centre to grazing at the rim, which is the
    // gradient the coating flare needs to exist at all. Written apex-first with
    // z increasing, which is the winding that faces the way you are looking —
    // the opposite of the front element, because you view this one from behind.
    {
      const rg = S.throatR - 0.0012, sag = 0.0042, zRim = 0.0182;
      const Rs = (rg * rg + sag * sag) / (2 * sag);
      const prof = [];
      const n = 6;
      for (let i = 0; i <= n; i++) {
        const rr = (i / n) * rg;
        prof.push([rr, zRim - sag + (Rs - Math.sqrt(Math.max(0, Rs * Rs - rr * rr)))]);
      }
      P.add(revolve(prof, S.seg), 'glass', null, [0.72, 0.80, 0.96], { crease: 1.4 });
    }
  }

  // ── rear barrel, and the core tube under the rings ────────────────────────
  P.add(revolve([
    [S.rear.r, S.rear.z0], [S.rear.r, S.rear.z1],
  ], S.seg), 'barrel', null, tint);

  // THE RINGS ARE NOT SOLID. A grip ring is a lathe of its own outer skin —
  // there is nothing behind it — so with only a rear barrel and a front barrel
  // the middle of the lens was a floating pair of tubes, and from any angle
  // that let you see down the chamfer at the end of a ring you were looking
  // through the lens and out the far side. It showed up first as a mirrored
  // distance scale apparently printed on the inside of the mount, which is the
  // sort of clue that takes a while to read. One continuous tube underneath
  // everything, a millimetre inside the tightest ring inset, closes every one
  // of those sight lines for two hundred triangles.
  {
    const core = Math.min(S.zoomRing.r, S.focusRing.r) - 0.0036;
    P.add(revolve([
      [core, S.rear.z1 - 0.0004], [core, S.frontBarrel.z0 + 0.0010],
    ], S.seg), 'barrel', null, [0.86, 0.85, 0.86]);
  }

  // ── the inner barrel the front group slides out of ────────────────────────
  //
  // Only the wide extends, and the first version of `setZoom` simply translated
  // the front group — which at 70 mm pulled it 26 mm clear of the focus ring
  // and left the front element hanging in mid-air behind an open gap, with the
  // coating flare visible as a magenta crescent floating in the middle of the
  // lens. It is a good example of a pose that looks fine in the one state you
  // authored and is broken in the other, which is exactly what `--zoom 1` in
  // the gallery harness exists to catch.
  //
  // A real extending zoom hides that travel behind a smaller-diameter inner
  // barrel that is always there and is progressively revealed. So is this one:
  // static, half a millimetre inside the front group's rear opening, and long
  // enough to cover the whole range.
  //
  // AND THAT WAS THE SAME BUG AGAIN, ONE STATE FURTHER ON. The fix above was
  // authored for the gap and not re-checked at the other end: the barrel ran to
  // `frontBarrel.z0 + extendMax + 0.0060` = 116 mm, and at full extension the
  // front element's rim is at 105.8 mm and its apex at 114. A static tube of
  // radius 39.4 mm ending 2 mm PAST the apex of a 29.2 mm element does not hide
  // anything — it stands in front of the glass and silhouettes its own 48-gon
  // rim across it as a sawtooth crown, visible down the mouth of the hood at
  // `--zoom 1` and at no other setting.
  //
  // The end of this tube is not a clearance number, it is a JOINT: it must stop
  // at the front group's rear opening at full extension and never pass it.
  // Written as that expression so it tracks `extendMax` if anybody retunes the
  // travel.
  if (S.extendMax > 0) {
    const r = S.focusRing.r - 0.0026;
    P.add(revolve([
      [r, S.focusRing.z1 - 0.0020],
      [r, S.frontBarrel.z0 - 0.0002 + S.extendMax],
    ], S.seg), 'barrel', null, [0.74, 0.73, 0.74]);
  }

  // The mount index: the white dot you line up with the body. 4 mm, at twelve
  // o'clock, and it is the one marking on a lens that is always in the same
  // place, which makes it a free orientation cue on a model of one.
  P.add(revolve([
    [S.rear.r, S.rear.z0 + 0.0035], [S.rear.r + 0.0009, S.rear.z0 + 0.0035],
    [S.rear.r + 0.0009, S.rear.z0 + 0.0075], [S.rear.r, S.rear.z0 + 0.0075],
  ], 6, ARC_UP - 0.055, 0.11), 'metal', null, [1.12, 1.12, 1.1], { crease: 0.5 });

  // ── tripod collar and foot (tele only) ────────────────────────────────────
  //
  // The single biggest silhouette difference between the two lenses after
  // length, and the reason the tele can stand up on a table at all. First
  // version hung the foot straight off the barrel with no collar and it read as
  // a handle; a real foot is bolted to a ROTATING RING, and the ring — with its
  // split line and its clamp knob — is most of what says "this lens is heavy".
  if (S.collar) buildCollar(P, S, tint);

  // ── switch panel (tele only) ──────────────────────────────────────────────
  if (S.switches) buildSwitches(P, S);

  P.flush(body, mats);

  // ── zoom ring ─────────────────────────────────────────────────────────────
  //
  // The wide ring. Rubber, 30 ribs 1.9 mm proud, with a hard metal-ish shoulder
  // at each end so it reads as a component clamped onto the barrel rather than
  // as a groove cut in it.
  {
    const Z = new LensParts('zoom');
    const z = S.zoomRing;
    // Eight facets per rib, and FLAT SHADED. Both were arrived at the hard way.
    // At five facets a rib is a triangle and the ring reads as a coarse gear;
    // at eight it is a ridge. And creasing the ring at the same 36 degrees as
    // the barrel averages the rib flanks into each other — the whole ring came
    // back looking like a smooth tube with a slight sheen, which is precisely
    // the failure mode this geometry exists to avoid. Flat shading gives every
    // facet its own normal, so the ribs are drawn by the diffuse term and do
    // not need a specular highlight to exist.
    Z.add(gripRing(z.r, z.z0, z.z1, { ribs: z.ribs, depth: z.depth }),
      'rubber', null, [1, 1, 1], { crease: 0 });
    // A thin bright witness line on the leading edge — every zoom ring has one,
    // and it is what the printed focal scale is read against.
    Z.add(revolve([
      [z.r - 0.0021, z.z1 - 0.0004], [z.r - 0.0007, z.z1 - 0.0004],
    ], S.seg), 'metal', null, [0.7, 0.7, 0.72], { crease: 0.9 });
    // And a single bright dash across it at noon. A full ring is rotationally
    // symmetric and so is a ribbed one to within a rib period — the tele's
    // whole 200 -> 400 travel is 5.7 of its 30 rib periods, which is to say the
    // ring came back to almost exactly the same geometry it left. The dash is
    // the one feature on the ring that has a POSITION, so it is what makes the
    // rotation itself legible in the gallery, where the printed numbers are
    // readable and the ring's own ribbing tells you nothing.
    Z.add(revolve([
      [z.r - 0.0004, z.z1 - 0.0060], [z.r + 0.0007, z.z1 - 0.0052],
      [z.r + 0.0007, z.z1 - 0.0016], [z.r - 0.0004, z.z1 - 0.0008],
    ], 5, ARC_UP - 0.030, 0.060), 'metal', null, [1.16, 1.16, 1.14], { crease: 0.5 });
    Z.flush(zoomG, mats);
  }

  // ── the window band: focal scale, index line, distance scale ──────────────
  {
    const W = new LensParts('win');
    const w = S.window;
    // A shallow step down from the rings on either side, so the printed band
    // sits in a recess. Print on a surface flush with its neighbours reads as a
    // sticker.
    W.add(revolve([
      [S.zoomRing.r - 0.0022, w.z0 - 0.0002], [w.r, w.z0 + 0.0022],
      [w.r, w.z1 - 0.0022], [S.focusRing.r - 0.0022, w.z1 + 0.0002],
    ], S.seg), 'barrel', null, tint);
    // The red index line at twelve o'clock. This is the mark the focal lengths
    // are read against and it is the only saturated colour on the wide lens.
    // Thin. The first one was 70 milliradians of arc over the full width of
    // the band and read as a red block rather than as the hairline you line a
    // focal length up against — it was the loudest thing on the wide lens.
    //
    // It is also SHORT, and now that the numbers travel under it that matters:
    // it used to run the whole length of the window, which put a red bar
    // straight through the middle of whichever focal length it was selecting.
    // A real index sits beside the numbers, against their tick marks — the z
    // window below is the tick band of `addWindowPrint`'s canvas, which is why
    // it is written off the same `zc`.
    {
      const zc = (w.z0 + w.z1) * 0.5;
      W.add(revolve([
        [w.r + 0.0005, zc - 0.0071], [w.r + 0.0005, zc - 0.0026],
      ], 4, ARC_UP - 0.017, 0.034), 'accent', null, [1, 1, 1], { crease: 0.9 });
    }
    W.flush(body, mats);
    // The focal scale goes on the RING, not on the barrel. See addWindowPrint.
    addWindowPrint({ fixed: body, ring: zoomG }, S, owned);
  }

  // ── focus ring ────────────────────────────────────────────────────────────
  {
    const F = new LensParts('focus');
    const f = S.focusRing;
    // Narrower, shallower, sharper ribs than the zoom ring. The two rings on a
    // real lens are deliberately different to the fingertips, and modelling
    // them the same is the fastest way to make a lens look generic.
    F.add(gripRing(f.r, f.z0, f.z1,
      { ribs: f.ribs, depth: f.depth, sharp: 0.78, chamfer: 0.0014, inset: 0.0022 }),
    'rubber', null, [0.94, 0.94, 0.96], { crease: 0 });
    F.flush(focusG, mats);
  }

  // ── everything forward of the focus ring ──────────────────────────────────
  {
    const A = new LensParts('front');
    const fb = S.frontBarrel;
    const fr = S.filterRing;

    A.add(revolve([
      [S.focusRing.r - 0.0020, fb.z0 - 0.0002], [fb.r, fb.z0 + 0.0026],
      [fb.r, fb.z1],
    ], S.seg), 'barrel', null, tint);

    // The gold band. Only the tele gets one, and it is the fastest read on the
    // model: three millimetres of warm metal on a dark tube says "this is the
    // expensive one" before the length does.
    if (S.goldRing) {
      const gr = S.goldRing;
      A.add(revolve([
        [fb.r - 0.0002, gr.z0 - 0.0006], [gr.r, gr.z0],
        [gr.r, gr.z1], [fb.r - 0.0002, gr.z1 + 0.0006],
      ], S.seg), 'gold', null, [1, 1, 1], { crease: 0.55 });
    }

    // Filter ring: bright, finely knurled OUTSIDE, matte black on the face.
    //
    // TWO MATERIALS, AND THE SPLIT IS THE WHOLE POINT. It was one lathe — the
    // taper, the knurled outer wall and the forward-facing annulus that frames
    // the glass — all of it `metal` at 0.72 grey. That annulus sits INSIDE the
    // mouth of the hood (97.4 mm against the wide's hood at 104, 323 against
    // the tele's 332), so the brightest object on either lens was a cream ring
    // buried in a cavity whose entire job is to be matte black. It framed the
    // element in a lighter value than the element, which visually shrinks the
    // glass — the exact opposite of what the recession and the baffles below
    // are spending triangles to achieve.
    //
    // The knurl is what you see with the hood off and it stays bright. The face
    // is black anodising, which is what a real filter ring's front face is.
    {
      const g = revolve([
        [fb.r, fr.z0], [fr.r, fr.z0 + 0.0018], [fr.r, fr.z1],
      ], 108);
      ribbed(g, { count: 54, depth: 0.00055, z0: fr.z0 + 0.0018, z1: fr.z1, sharp: 1.0 });
      A.add(g, 'metal', null, [0.72, 0.72, 0.74], { crease: 0.5 });
      A.add(revolve([
        [fr.r, fr.z1], [fr.r - 0.0060, fr.z1],
      ], 108), 'flock', null, [1, 1, 1], { crease: 0.5 });
    }

    // ── the barrel interior and the baffles ─────────────────────────────────
    //
    // What makes an element read as recessed is not the depth, it is seeing the
    // WALL of the recess: a dark tube with four step baffles in it, each one
    // catching a slightly different amount of light. Without them the recess is
    // a flat black ring and the element looks painted on.
    {
      const inner = fr.r - 0.0060;
      const prof = [[inner, fr.z1]];
      const nBaf = 4;
      const zTop = fr.z1;
      const zBot = S.glass.zApex - S.glass.sag * 0.4;
      for (let i = 0; i < nBaf; i++) {
        const z = lerp(zTop, zBot, (i + 1) / (nBaf + 1));
        const r = lerp(inner, S.glass.r + 0.0016, (i + 1) / (nBaf + 1));
        prof.push([r + 0.0016, z + 0.0016], [r, z], [r, z - 0.0012]);
      }
      prof.push([S.glass.r + 0.0010, zBot]);
      A.add(revolve(prof, S.seg), 'flock', null, [1, 1, 1], { crease: 0.5 });
    }

    // ── the front element ───────────────────────────────────────────────────
    //
    // A shallow spherical cap, apex forward. Two of them, actually: the second
    // sits 9 mm behind the first at 78% of the radius, because what you see
    // down the front of a real lens is never one surface — it is a stack, each
    // element throwing its own coloured reflection at its own scale, and one
    // extra cap buys most of that for 400 triangles.
    {
      const gl = S.glass;
      A.add(cap(gl.r, gl.zApex, gl.sag, S.seg), 'glass', null, [1, 1, 1], { crease: 1.4 });
      A.add(cap(gl.r * 0.78, gl.zApex - 0.0090, gl.sag * 0.7, S.seg), 'glass', null,
        [0.7, 0.78, 0.95], { crease: 1.4 });
      // The rim of the front element: the thin bright line of the retaining
      // ring around the glass. Without it the element floats.
      A.add(revolve([
        [gl.r, gl.zApex - gl.sag], [gl.r + 0.0014, gl.zApex - gl.sag + 0.0006],
      ], S.seg), 'metal', null, [0.5, 0.5, 0.52], { crease: 0.7 });
    }

    A.flush(frontG, mats);
    addBarrelPrint(frontG, S, owned);
  }

  // ── hood ──────────────────────────────────────────────────────────────────
  let hoodG = null;
  if (hoodOn) {
    hoodG = new THREE.Group();
    frontG.add(hoodG);
    buildHood(hoodG, S, mats);
  }

  // ── posing ────────────────────────────────────────────────────────────────
  //
  // THE RING AND THE NUMBERS ARE ONE MECHANISM, and this is where that is
  // enforced. The first version rotated the ring by an arbitrary 60 degrees
  // while the printed focal scale and the red index it is read against both sat
  // on the FIXED barrel, so nothing ever moved relative to anything: the tele,
  // which had no extension at all, changed 0.09% of its pixels across its
  // entire 200 -> 400 travel and printed an index sitting between 250 and 300
  // while the lens was at 200. `setZoom` on the tele was a no-op that lied.
  //
  // The scale now rides `zoomG` (see `addWindowPrint`) and the ring turns by
  // exactly the arc the numbers occupy, so the number under the fixed index IS
  // the focal length. `ZOOM_TURN` is derived from the print layout rather than
  // chosen, because the two agreeing is the whole property — a hand-picked
  // rotation next to a hand-picked scale span is a pair of numbers that drift
  // apart the first time either is retuned.
  //
  // It is centred on the middle of the range (t = 0.5 is the ring's rest
  // angle), which is why it is `k - 0.5`: the travel is then symmetric, ±34
  // degrees, and the whole 69 is inside the 70-90 a real zoom ring runs.
  const setZoom = (t) => {
    const k = clamp01(t);
    zoomG.rotation.z = -(k - 0.5) * ZOOM_TURN;
    frontG.position.z = k * S.extendMax;
    root.userData.zoomT = k;
  };
  const setFocus = (t) => { focusG.rotation.z = -clamp01(t) * 1.6; };

  setZoom(opts.zoom ?? 0);
  // Rings do not rest at exactly zero on a lens that has been used. A degree or
  // two of jitter is the difference between "a model" and "an object somebody
  // put down", and it costs one RNG call.
  focusG.rotation.z = (R() - 0.5) * 0.10;

  // ── stand it on the table ─────────────────────────────────────────────────
  //
  // The wide lies on its hood and its mount flange; the tele stands on its
  // tripod foot, which is exactly what each does in life. A model whose lowest
  // point is not zero either floats or sinks in the gallery, and the gallery is
  // the loop this whole prop was built in.
  //
  // MEASURED, NOT PREDICTED, and that is the fix. The height used to be two
  // hand-written guesses at where the lowest vertex would end up, and both were
  // wrong in a way nothing but a capture could show:
  //
  //  · the tele's `collar.footDrop + 0.0055` floated the foot 3.9 mm off the
  //    table, because `ExtrudeGeometry`'s bevel puts the sole 1.6 mm BELOW the
  //    shape's own `bottom` and the guess went the other way. Lit ground under
  //    the foot, and a contact shadow detached from the thing casting it.
  //  · the wide's `max(hood.r1, filterRing.r)` reads the hood off the SPEC, not
  //    off whether a hood was actually fitted, so `{ hood: false }` floated it
  //    5.6 mm — the difference between the two radii.
  //
  // TWO THINGS THIS MEASUREMENT HAS TO GET RIGHT, and the first draft got both
  // wrong, which cost a capture each:
  //
  //  · IT MUST RUN AFTER THE POSE. The rings are rotated a line above this.
  //  · IT MUST BE `precise`. `Box3.expandByObject` defaults to transforming
  //    each geometry's own AABB, which for a ring rotated 34 degrees about Z is
  //    a box rotated 34 degrees — an AABB √2 too big at 45. The wide came back
  //    with a lowest point at −64 mm on a hood whose radius is 51, and buried
  //    itself 13 mm in the table. `true` walks the vertices instead: one pass
  //    over a prop that is built once, and it cannot lie.
  const axisY = -new THREE.Box3().setFromObject(root, true).min.y;
  rig.position.y = axisY;

  root.userData.spec = S;
  root.userData.lens = lensById(S.lens);
  root.userData.parts = { rig, body, zoom: zoomG, focus: focusG, front: frontG, hood: hoodG };
  root.userData.setZoom = setZoom;
  root.userData.setFocus = setFocus;
  root.userData.anchors = {
    axisY,
    length: S.length,
    mount: new THREE.Vector3(0, axisY, 0),
    front: new THREE.Vector3(0, axisY, S.filterRing.z1),
    entry: new THREE.Vector3(0, axisY, S.glass.zApex),
  };
  root.userData.dispose = () => { for (const o of owned) o.dispose?.(); owned.length = 0; };
  return root;
}

/**
 * A spherical cap, apex at `zApex`, rim at radius `r` and `sag` behind it.
 *
 * Sampled on the sphere rather than on a parabola. At these sags the two are
 * within a few microns of each other and it makes no visual difference at all —
 * but the Fresnel coating is a function of the normal, and a profile whose
 * curvature is not constant puts a faint ring in the flare where the two
 * approximations disagree. Cheaper to be right than to explain the ring.
 *
 * WRITTEN RIM-FIRST, i.e. with z increasing, because that is the order that
 * faces forward — see `revolve`. The first version ran apex-first and both
 * front elements rendered as unlit black discs at the bottom of the barrel,
 * which looked exactly like a correctly modelled deep recess and cost a round
 * to notice.
 */
function cap(r, zApex, sag, seg) {
  const Rs = (r * r + sag * sag) / (2 * sag);       // sphere radius from sag
  const prof = [];
  const n = 9;
  for (let i = n; i >= 0; i--) {
    const rr = (i / n) * r;
    prof.push([rr, zApex - (Rs - Math.sqrt(Math.max(0, Rs * Rs - rr * rr)))]);
  }
  return revolve(prof, seg);
}

/**
 * The tripod collar and its foot.
 *
 * The foot is an Arca-Swiss dovetail — narrower at the bottom than at the top —
 * and that taper matters more than its size does: a plain rectangular block
 * reads as a stand, and the two 45-degree chamfers are the entire difference
 * between "stand" and "tripod foot". Built with ExtrudeGeometry over a shape,
 * which is `model_kit.js`'s `extrudeAcross` pattern applied down a different
 * axis.
 */
function buildCollar(P, S, tint) {
  const c = S.collar;
  const seg = S.seg;
  // Bearing of the clamp knob, as a real angle in XY (five o'clock). The split
  // is written off the same constant: a clamp knob that is not over the split
  // it closes is a knob glued to a band, which is what the first version was —
  // the split ran at six o'clock, buried inside the foot, where the only thing
  // that could ever have seen it was the table.
  const knobAt = -0.92;

  // The ring itself, with a shoulder at each end.
  P.add(revolve([
    [S.rear.r, c.z0 - 0.0002], [c.r - 0.0018, c.z0 + 0.0030],
    [c.r, c.z0 + 0.0075], [c.r, c.z1 - 0.0075],
    [c.r - 0.0018, c.z1 - 0.0030], [S.zoomRing.r - 0.0060, c.z1 + 0.0002],
  ], seg), 'barrel', null, tint);

  // The split line — the gap the clamp closes. A collar with no split is a
  // band, and a band does not rotate.
  P.add(revolve([
    [c.r - 0.0009, c.z0 + 0.0080], [c.r - 0.0009, c.z1 - 0.0080],
  ], 6, knobAt + Math.PI / 2 - 0.13, 0.26), 'flock', null, [1, 1, 1], { crease: 0.9 });

  // The clamp knob, out at five o'clock so it does not fight the foot. A
  // knurled stub on a short neck, both built along Y (a cylinder's own axis)
  // and rotated out along the barrel's radius — which is a rigid transform, so
  // the creased normals survive it.
  {
    const a = knobAt;
    const zc = (c.z0 + c.z1) * 0.5;
    // A cylinder stands on +Y; rotate it to point along the +X radius, then
    // spin that radius round to the bearing we want.
    const outward = (dist) => M()
      .makeTranslation(Math.cos(a) * dist, Math.sin(a) * dist, zc)
      .multiply(M().makeRotationZ(a))
      .multiply(M().makeRotationZ(-Math.PI / 2));

    P.add(new THREE.CylinderGeometry(0.0055, 0.0062, 0.0130, 12),
      'barrel', outward(c.r + 0.0055), [0.9, 0.9, 0.92], { crease: 0.5 });

    // The knob itself, knurled. Built along Y so the knurl displaces in XZ,
    // then carried out on the same radius.
    const knob = new THREE.CylinderGeometry(0.0088, 0.0088, 0.0075, 24).toNonIndexed();
    {
      const arr = knob.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], z = arr[i + 2];
        const r = Math.hypot(x, z);
        if (r < 0.0060) continue;
        const th = Math.atan2(z, x);
        const k = (r + 0.0006 * Math.pow(Math.max(0, Math.cos(th * 18)), 0.6)) / r;
        arr[i] = x * k; arr[i + 2] = z * k;
      }
    }
    P.add(knob, 'rubber', outward(c.r + 0.0138), [1, 1, 1], { crease: 0.62 });
  }

  // ── the foot ──────────────────────────────────────────────────────────────
  const top = -(c.r - 0.0020);
  const bottom = -c.footDrop;
  const hw = c.footW * 0.5;
  const shape = new THREE.Shape();
  // Cross-section in (x, y), looking down the barrel: a waisted post widening
  // into a dovetail plate.
  shape.moveTo(-hw * 0.52, top);
  shape.lineTo(hw * 0.52, top);
  shape.lineTo(hw * 0.40, bottom + 0.0180);
  shape.lineTo(hw, bottom + 0.0105);
  shape.lineTo(hw, bottom + 0.0058);
  shape.lineTo(hw - 0.0042, bottom);        // the 45-degree dovetail chamfer
  shape.lineTo(-hw + 0.0042, bottom);
  shape.lineTo(-hw, bottom + 0.0058);
  shape.lineTo(-hw, bottom + 0.0105);
  shape.lineTo(-hw * 0.40, bottom + 0.0180);
  shape.closePath();
  const foot = new THREE.ExtrudeGeometry(shape, {
    depth: c.footZ1 - c.footZ0, bevelEnabled: true,
    bevelThickness: 0.0016, bevelSize: 0.0016, bevelSegments: 2, curveSegments: 2, steps: 1,
  });
  foot.translate(0, 0, c.footZ0);
  P.add(foot, 'barrel', null, [0.88, 0.88, 0.90], { crease: 0.55 });

  // Rubber pad on the sole. Every foot has one, and it is what stops the
  // dovetail reading as a solid lump of plastic.
  P.add(new THREE.BoxGeometry(c.footW * 0.66, 0.0022, (c.footZ1 - c.footZ0) * 0.78),
    'rubber', M().makeTranslation(0, bottom + 0.0011, (c.footZ0 + c.footZ1) * 0.5),
    [1, 1, 1], { crease: 0.5 });

  // Strap lug: a small loop on the side of the collar.
  const lug = new THREE.TorusGeometry(0.0052, 0.0016, 6, 14);
  lug.rotateY(Math.PI / 2);
  P.add(lug, 'barrel', M().makeTranslation(c.r + 0.0010, -0.0180, c.z1 - 0.0090),
    [0.8, 0.8, 0.82], { crease: 0.7 });
}

/**
 * The switch panel: AF/M, focus limiter, VR.
 *
 * Sunk into a flat on the barrel at eight o'clock, which is where a right-
 * handed photographer's thumb lands. Three slide switches in one recess; the
 * recess matters more than the switches, because a raised plate on a curved
 * barrel reads as something stuck on and a sunken one reads as moulded in.
 */
function buildSwitches(P, S) {
  const sw = S.switches;
  const a = -2.30;                            // eight o'clock
  const zc = (sw.z0 + sw.z1) * 0.5;
  const w = 0.0165, h = sw.z1 - sw.z0;

  // One local frame for the whole panel: origin on the barrel surface at that
  // bearing, local +X tangential, local +Y radially outward, local +Z along the
  // barrel. Every piece below is then authored in millimetres of "across, out,
  // along", which is the only way this stayed readable — the first version
  // composed a matrix per box and two of the three switches ended up inside
  // the barrel.
  const base = M()
    .makeTranslation(Math.cos(a) * (S.rear.r - 0.0016), Math.sin(a) * (S.rear.r - 0.0016), zc)
    .multiply(M().makeRotationZ(a - Math.PI / 2));
  const place = (dx, dy, dz) => M().makeTranslation(dx, dy, dz).premultiply(base);

  // The recessed plate.
  P.add(new THREE.BoxGeometry(w, 0.0030, h), 'flock', place(0, 0, 0), [1, 1, 1], { crease: 0.5 });

  // Three switch bodies, each with a bright sliding tab pushed to one end.
  for (let i = 0; i < 3; i++) {
    const dz = (i - 1) * (h * 0.30);
    P.add(new THREE.BoxGeometry(w * 0.80, 0.0020, h * 0.20), 'barrel',
      place(0, 0.0014, dz), [1.10, 1.10, 1.12], { crease: 0.5 });
    P.add(new THREE.BoxGeometry(w * 0.28, 0.0016, h * 0.13), 'metal',
      place((i % 2 ? -1 : 1) * w * 0.16, 0.0026, dz), [0.66, 0.66, 0.68], { crease: 0.5 });
  }
}

/**
 * The hood.
 *
 * Three open lathes rather than one closed one: an outer skin, an inner skin
 * and the rim that joins them. The closed-lathe version was tried first, on the
 * theory that one watertight shell cannot get its winding wrong — true, and
 * useless, because the outside of a hood is barrel plastic and the inside is
 * flocking, and one shell is one material. Separating them by vertex tint
 * needed a "which side of the wall is this vertex on" test that the petal
 * displacement immediately falsified, and the first captures came back with a
 * pale band inside the mouth of the hood where the test had guessed wrong.
 *
 * Split, the winding rule from `revolve` does the whole job with no test at
 * all: the outer skin is written z-increasing (faces out), the inner skin
 * z-decreasing (faces in), and the rim runs outer-to-inner so it faces
 * forward. All three take the same petal displacement, which is a function of
 * z and θ only, so they stay joined.
 *
 * The dark interior is most of why a hood reads as a hood: what you see of one
 * at three-quarters is a bright rim, a deep cave, and the glass at the bottom
 * of it.
 */
function buildHood(parent, S, mats) {
  const h = S.hood;
  const H = new LensParts('hood');
  const seg = Math.max(64, S.seg);
  const zMid = lerp(h.z0, h.z1, 0.55);
  const rMid = lerp(h.r0, h.r1, 0.62);
  const w = h.wall;

  const bend = (g) => {
    // Long petals at top and bottom, short at the sides. That way round on
    // purpose: it is what a real tulip does (the long lobes cover the short
    // sides of the frame) and it also means the hood's silhouette from the side
    // — the angle a lens is almost always drawn from — is the interesting one.
    if (h.petals) {
      petalled(g, { petals: h.petals, amp: h.amp, zRim: h.z1, zBack: h.z0 + 0.006,
        phase: Math.PI / 2 });
    }
    return g;
  };

  // The mounting collar, and it is not decoration. Without it the hood's outer
  // wall and the barrel it clamps onto are within two millimetres of each other
  // in radius and read as ONE continuous tube — on the tele that made the front
  // 55% of the lens a single smooth cone with a printed line on it. A 1.4 mm
  // step and a dark groove is the whole fix, and it is where the seam is on the
  // real thing.
  H.add(revolve([
    [h.r0 - w, h.z0 - 0.0040], [h.r0 + 0.0014, h.z0 - 0.0026],
    [h.r0 + 0.0014, h.z0 + 0.0030], [h.r0, h.z0 + 0.0044],
  ], seg), 'barrel', null, [0.80, 0.79, 0.80], { crease: 0.55 });

  // Outer skin — barrel plastic, and a touch lighter than the barrel itself,
  // because a hood is a separate moulding and always is.
  H.add(bend(revolve([
    [h.r0, h.z0], [rMid, zMid], [h.r1, h.z1],
  ], seg)), 'barrel', null, [1.08, 1.07, 1.07], { crease: 0.55 });

  // Rim: outer lip to inner lip, facing forward.
  H.add(bend(revolve([
    [h.r1, h.z1], [h.r1 - w, h.z1 - 0.0012],
  ], seg)), 'barrel', null, [0.72, 0.71, 0.72], { crease: 0.55 });

  // Inner skin — the cave. Written backwards on purpose.
  H.add(bend(revolve([
    [h.r1 - w, h.z1 - 0.0012], [rMid - w, zMid], [h.r0 - w, h.z0],
  ], seg)), 'flock', null, [1, 1, 1], { crease: 0.55 });

  // A rubber lip on the round hood — the thing that lets you stand the lens on
  // its face. The tulip does not get one; a petal hood cannot have one.
  if (!h.petals) {
    H.add(revolve([
      [h.r1 - h.wall, h.z1 - 0.0010], [h.r1 + 0.0012, h.z1 + 0.0008],
      [h.r1 + 0.0012, h.z1 + 0.0060], [h.r1 - h.wall - 0.0010, h.z1 + 0.0056],
      [h.r1 - h.wall - 0.0010, h.z1 - 0.0010], [h.r1 - h.wall, h.z1 - 0.0010],
    ], seg), 'rubber', null, [1, 1, 1], { crease: 0.55 });
  }

  // Locking button on the side of the hood collar — three o'clock, which is
  // where the comment always said it was. Written as a bare lathe φ of 0 it
  // came out at six, i.e. underneath, pressed against the table the wide lens
  // rests its hood on. See `decalBand` for the bearing this file uses.
  H.add(revolve([
    [h.r0 + 0.0004, h.z0 + 0.0055], [h.r0 + 0.0030, h.z0 + 0.0065],
    [h.r0 + 0.0030, h.z0 + 0.0125], [h.r0 + 0.0004, h.z0 + 0.0135],
  ], 8, Math.PI / 2 - 0.16, 0.32), 'rubber', null, [1.5, 1.5, 1.5], { crease: 0.55 });

  H.flush(parent, mats);
}

// ─────────────────────────────────────────────────────────────────────────────
//  The printing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The focal-length scale and the distance window, on the band between the
 * rings.
 *
 * Two separate bands, because they are two separate things on a real lens and
 * they are read from different places: the focal scale is read against the red
 * index at noon, and the distance scale is in a recessed window a third of the
 * way round.
 *
 * THE SCALE IS PARENTED TO THE ZOOM RING and the index to the barrel, which is
 * the arrangement on every zoom lens that has ever had numbers on it, and it is
 * the only one where turning the ring can be WRONG — which is what makes it
 * worth anything. Both used to be on the fixed barrel: the numbers and the mark
 * that reads them never moved relative to each other, so the index printed
 * whatever focal length it happened to have been authored over, forever.
 *
 * `SCALE_ARC` and `SCALE_INSET` are the layout, and `ZOOM_TURN` is derived from
 * them: the ring must rotate by exactly the arc between the first number and
 * the last, or the index drifts off the scale somewhere in the middle. Retune
 * the layout and the rotation follows; that is the point of deriving it.
 */
const SCALE_ARC = 1.50;                    // radians of barrel the band covers
const SCALE_INSET = 0.10;                  // fraction of the band before "24"
const ZOOM_TURN = SCALE_ARC * (1 - 2 * SCALE_INSET);   // 1.20 rad ≈ 69 degrees

function addWindowPrint(parents, S, owned) {
  const w = S.window;
  const zc = (w.z0 + w.z1) * 0.5;

  // ── focal scale, on the ring, read at twelve o'clock ──────────────────────
  const scale = bandMesh(`lens_${S.key}_scale`,
    { r: w.r, z0: zc - 0.0075, z1: zc + 0.0075, arc: SCALE_ARC },
    (g, W, H) => {
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      g.fillStyle = INK;
      g.font = `600 ${Math.round(H * 0.52)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      const n = S.scale.length;
      for (let i = 0; i < n; i++) {
        // Spaced the way a real zoom scale is: bunched toward the long end,
        // because the ring's rotation is linear in log focal length — and
        // because `LensKit.t` is too, so the same t drives both.
        const t = Math.log(+S.scale[i] / +S.scale[0])
                / Math.log(+S.scale[n - 1] / +S.scale[0]);
        const x = lerp(W * SCALE_INSET, W * (1 - SCALE_INSET), t);
        g.fillText(S.scale[i], x, H * 0.60);
        g.fillRect(x - H * 0.03, H * 0.72, H * 0.06, H * 0.22);
      }
    }, owned);
  if (scale) parents.ring.add(scale);

  // ── distance window, round at four o'clock ────────────────────────────────
  // A third of a turn from noon, i.e. `ARC_UP - 2π/3`. It was written as a bare
  // -0.95, which in the bearing this file actually uses (see `decalBand`) is
  // about eight o'clock — low and on the far side, where nothing ever saw it.
  const dist = bandMesh(`lens_${S.key}_dist`,
    { r: w.r, z0: zc - 0.0062, z1: zc + 0.0062, arc: 1.15,
      up: ARC_UP - TAU / 3, px: 768 },
    (g, W, H) => {
      // The window itself: a dark recess with a bright hairline top and bottom,
      // which is what a real distance window looks like from any distance at
      // which you cannot read the numbers — and being right at THAT distance is
      // what matters, since this is 12 mm of barrel.
      g.fillStyle = '#101014';
      g.fillRect(0, H * 0.12, W, H * 0.76);
      g.fillStyle = '#6f6a64';
      g.fillRect(0, H * 0.12, W, Math.max(2, H * 0.04));
      g.fillRect(0, H * 0.84, W, Math.max(2, H * 0.04));
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `500 ${Math.round(H * 0.46)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      const n = S.distance.length;
      for (let i = 0; i < n; i++) {
        g.fillStyle = i === 0 ? INK : INK_DIM;
        g.fillText(S.distance[i], lerp(W * 0.09, W * 0.91, i / (n - 1)), H * 0.51);
      }
    }, owned);
  if (dist) parents.fixed.add(dist);
}

/**
 * "24-70mm 1:2.8" on the front barrel.
 *
 * This is the line that turns a cylinder into a specific lens, so it gets the
 * biggest type on the model and it goes where a lens actually carries it: on
 * the fixed front barrel, at twelve o'clock, ahead of the focus ring. Two
 * rounds of this were illegible because the arc was too wide — 2.4 radians of
 * an 82 mm barrel curves the baseline so hard that the ends of the string point
 * at the floor. 1.7 radians, larger type, and it reads.
 *
 * A THIRD ROUND WAS ILLEGIBLE FOR THE OPPOSITE REASON: the type fitted the band
 * and the STRING did not. `half` was hand-set per lens and the tele's 17 mm
 * made a band twice as tall in proportion as the wide's, so the height-derived
 * type came out at 158 px against a string that measures 1185 on a 1024 canvas.
 * Both halves of that are fixed here — `half` is derived so the two bands have
 * the same proportions and the same type size on both lenses, and `fitText`
 * catches anything the derivation cannot know about.
 */
function addBarrelPrint(parent, S, owned) {
  const fb = S.frontBarrel;
  const arc = 1.62;
  const zc = lerp(fb.z0, fb.z1, S.key === 'tele' ? 0.34 : 0.46);
  // The band's proportions are its ARC LENGTH by its axial height. Fix the
  // ratio and both lenses print at the same size relative to their own type,
  // however different their barrels are: the tele's 97 mm of arc gets a 17 mm
  // band, the wide's 67 mm gets 12.
  const half = arc * fb.r / (2 * 5.75);
  const mesh = bandMesh(`lens_${S.key}_print`,
    { r: fb.r, z0: zc - half, z1: zc + half, arc },
    (g, W, H) => {
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = INK;
      fitText(g, S.print, 700, H * 0.44, W * 0.86);
      g.fillText(S.print, W * 0.5, H * 0.37);
      g.fillStyle = INK_DIM;
      fitText(g, S.printSub, 500, H * 0.24, W * 0.86);
      g.fillText(S.printSub, W * 0.5, H * 0.74);
    }, owned);
  if (mesh) parent.add(mesh);
}

// ─────────────────────────────────────────────────────────────────────────────
//  LensPreview — the mounted lens, in the photo rail
// ─────────────────────────────────────────────────────────────────────────────
//
//  Self-contained on purpose, and this is the design decision worth arguing
//  for. Two ways to put a 3D object into a HUD panel:
//
//   1. Render it into the main renderer with a scissored viewport, after the
//      post chain. That is free of a second GL context — and it means sharing a
//      renderer whose state is owned by PostFX with a mode that has just pinned
//      the resolution, restores an exposure on exit, and has a scar in its own
//      header about a mode restoring the wrong number. Every frame of this
//      preview would be a chance to leave something set.
//   2. Its own canvas, its own renderer, its own scene, its own lights, drawn
//      on demand. One extra WebGL context (a budget of ~16 exists; the game
//      uses one), created lazily the first time photo mode opens and reused
//      afterwards.
//
//  (2), decisively. Nothing in here can touch the game's renderer, its post
//  chain, its Atmosphere or its Stylize, and the preview keeps working if any
//  of them changes. It draws only when the pose has actually changed, which in
//  practice means every frame it is ticked with a real dt — the idle turntable
//  never stops — and NOTHING when it is ticked at dt 0. Do not read that as "a
//  still rail is free": the way a rail stops paying for this panel is by not
//  calling `update`. The earlier version of this comment claimed the render was
//  conditional while `update` rendered unconditionally and the `_dirty` flag it
//  set was never read by anything.
//
//  ── the lighting, and why it is NOT the gallery's ───────────────────────────
//
//  It started as a copy of the gallery stage's: warm key, cool sky fill, gold
//  bounce off the ground, at roughly Lighting.js's ratios, on the argument that
//  a prop which reads in the gallery reads here. That argument is wrong in one
//  direction. The gallery draws a lens 700 px wide against a dark violet page
//  and the eye has the whole barrel to average; this panel draws it at 188 px
//  against the HUD, and at that size a warm key over a gold ground bounce is
//  not "a dark grey lens in warm light", it is a brown lens. The tele read as a
//  brass telescope — measured at mean [35, 23, 14], a red-minus-blue of 21 on a
//  barrel authored at 0x4d4a4e, which is neutral to within 4 counts.
//
//  So the ground bounce here is a dim neutral and the exposure is 1.0, while
//  the KEY stays warm — the tint on the lit side is the game's light and it
//  should stay; what had to go was the warm fill on the shadow side, which is
//  the half of the barrel that was deciding the colour. The gallery is not the
//  shipping surface. This panel is, and it is judged on its own captures.

const PREVIEW_KEY = 0xffeeda;
const PREVIEW_SKY = 0x9dbce0;
const PREVIEW_BOUNCE = 0x6e6e72;

/** The turntable's fixed downward tilt. `_frame` and `update` must agree. */
const PREVIEW_PITCH = 0.30;

export class LensPreview {
  /**
   * @param opts.width/height  CSS pixels
   * @param opts.dpr           device pixel ratio to render at (capped at 2)
   * @param opts.lens          starting lens id
   */
  constructor(opts = {}) {
    this.width = opts.width ?? 188;
    this.height = opts.height ?? 128;
    this.ok = false;
    this._swap = 0;
    this._spin = 0;
    // The last pose actually drawn, so `update(0)` — a rail that is ticking but
    // paused — costs a comparison instead of a draw. See the header.
    this._drawn = null;
    this._models = new Map();

    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(2, opts.dpr ?? (globalThis.devicePixelRatio || 1)));
      this.renderer.setSize(this.width, this.height, false);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      // 1.0, not 1.15. The extra sixth of a stop was bought before the bounce
      // was neutral and it was paying for the wrong thing: it lifted the warm
      // half of the barrel, not the dark half.
      this.renderer.toneMappingExposure = 1.0;
    } catch (e) {
      console.warn('[lens] preview renderer unavailable', e);
      return;
    }
    this.canvas = this.renderer.domElement;
    // An inline style beats any stylesheet rule, so a fixed pixel height here
    // is a size the host cannot argue with — and the host is a flex column in
    // an `em`-scaled panel that gets narrower with the window. Measured: the
    // rail gave this 138 px of column and the canvas drew 188, centred, hanging
    // 25 px off both sides of its own group, and `hud.css`'s `width: 100%` had
    // been quietly losing to this line the whole time.
    //
    // So the pixel width is a DEFAULT and the other two lines are the licence
    // to shrink: `max-width` lets a narrower box win, and `height: auto` makes
    // the canvas keep its own aspect while it does. Standing on its own with
    // nothing constraining it, this still draws at exactly `width x height`.
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.maxWidth = '100%';
    this.canvas.style.height = 'auto';

    this.scene = new THREE.Scene();
    const key = new THREE.DirectionalLight(new THREE.Color(PREVIEW_KEY), 2.5);
    key.position.set(-0.7, 0.85, 1.0);
    const fill = new THREE.DirectionalLight(new THREE.Color(PREVIEW_SKY), 1.05);
    fill.position.set(1.0, 0.55, -0.6);
    const bounce = new THREE.HemisphereLight(new THREE.Color(PREVIEW_SKY),
      new THREE.Color(PREVIEW_BOUNCE), 0.45);
    this.scene.add(key, fill, bounce);

    this.camera = new THREE.PerspectiveCamera(26, this.width / this.height, 0.02, 4);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this.lens = null;
    this.setLens(opts.lens ?? 'wide', { animate: false });
    this.ok = true;
  }

  /**
   * Build (once) and show a lens.
   *
   * EVERY LENS HANGS IN A HOLDER, and the holder is not ceremony. The framing
   * offset and the swap animation both want to write a position, and when both
   * wrote it on the same object the animation won on frame one: `setLens`
   * recentred the model (tele z −0.2284), `update` then assigned
   * `model.position.z` outright, and the recentre was gone by the first tick —
   * measured `[0, −0.0853, −0.2284]` in, `[0, −0.0853, 0]` one frame later.
   * The model was then mounted 228 mm off the pivot it turns about, so the idle
   * turntable ORBITED it: it swung across the panel, changed size as it came
   * and went, parked in a corner with the front element clipped off the edge,
   * and left the bottom half of a 188 x 128 slot empty. Every one of those
   * reads as a broken panel rather than as a lens.
   *
   * So the centring lives on the model and the animation lives on the holder,
   * one transform each, and they compose instead of racing. The holder's origin
   * IS the model's centre, which is also what makes `pivot.rotation.y` a
   * turntable rather than an orbit.
   */
  setLens(id, o = {}) {
    if (!this.renderer) return;
    const l = lensById(id);
    if (this.lens === l && !o.force) return;
    this.lens = l;
    let m = this._models.get(l.id);
    if (!m) {
      // A fixed seed: the preview must not roll a different lens each time
      // photo mode opens.
      let s = 0x9e37 + l.id.length * 977;
      const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      const lens = l.build(rnd, { hood: true, wear: 0.3 });
      // Frame it: recentre on its own bounding box and size the camera to it,
      // once, so both lenses fill the panel to the same degree despite one
      // being four times the length of the other.
      const box = new THREE.Box3().setFromObject(lens);
      lens.position.sub(box.getCenter(new THREE.Vector3()));
      m = new THREE.Group();
      m.name = `preview_${l.id}`;
      m.add(lens);
      m.userData.lens = lens;
      const size = box.getSize(new THREE.Vector3());
      m.userData.fitRadius = size.length() * 0.5;
      // What the framing below actually needs: the radius the model sweeps as
      // the turntable yaws (invariant, because yaw is about Y), and its half
      // height. Not the same number, and on a lens they are wildly different.
      m.userData.fit = {
        rXZ: Math.hypot(size.x, size.z) * 0.5,
        halfY: size.y * 0.5,
      };
      this._models.set(l.id, m);
    }
    for (const other of this._models.values()) this.pivot.remove(other);
    this.pivot.add(m);
    this.model = m;
    this._swap = o.animate === false ? 0 : 1;
    this._frame();
    this._drawn = null;
  }

  setZoomT(t) {
    this.model?.userData.lens?.userData.setZoom?.(t);
    this._drawn = null;
  }

  /**
   * Distance the camera so the whole lens fits, with a little air.
   *
   * A LENS IS NOT A SPHERE and this panel is not square, so fitting a bounding
   * sphere into the SMALLER of the two half-angles wasted both dimensions at
   * once: the tele's bounding sphere is dominated by its 459 mm length, that
   * radius was fitted into the 13-degree vertical, and the result stood the
   * lens 51% further away than it needed to be — 8.5% of the panel covered, an
   * empty bottom half, and a 200-400 mm telephoto rendered as a smudge in a
   * 188 px slot. The lens is the only thing in this panel; it should fill it.
   *
   * The two constraints are genuinely different and both are cheap to state:
   *
   *  · HORIZONTALLY the model sweeps a circle as the turntable yaws, of radius
   *    `hypot(sizeX, sizeZ)/2`. Yaw is about Y, so that radius is invariant —
   *    fit it once and no rotation can ever push the model out of frame.
   *  · VERTICALLY the extent is the model's own height, plus whatever the fixed
   *    downward tilt tips the LENGTH into: `sin(pitch)` of that same sweep
   *    radius. That term is most of it on the tele and it is the one a naive
   *    "fit the height" would miss.
   *
   * `sin` rather than `tan` on both, which is the bounding-sphere form and so
   * errs 2.5% long at this fov — the margin a solid the camera can be inside
   * the extent of needs anyway.
   */
  _frame() {
    const f = this.model?.userData.fit ?? { rXZ: 0.2, halfY: 0.1 };
    const v = (this.camera.fov / DEG) * 0.5;
    const h = Math.atan(Math.tan(v) * this.camera.aspect);
    const halfV = f.halfY * Math.cos(PREVIEW_PITCH) + f.rXZ * Math.sin(PREVIEW_PITCH);
    // 1.10: air, and headroom for the swap animation, which brings the model
    // 9% of its own radius toward the camera on the way in.
    const d = Math.max(f.rXZ / Math.sin(h), halfV / Math.sin(v)) * 1.10;
    this.camera.position.set(0, 0, d);
    this.camera.lookAt(0, 0, 0);
  }

  /**
   * @param dt REAL seconds — photo mode pauses the world and this is a UI
   *           object, so it must not be driven by the frozen world clock.
   */
  update(dt) {
    if (!this.ok) return;
    // A very slow idle turn. Fast enough that the coating flare sweeps the rim
    // (which is the thing worth looking at), slow enough not to pull the eye
    // off the photograph the player is composing.
    this._spin += dt * 0.28;
    let a = this._spin;
    if (this._swap > 0) {
      this._swap = Math.max(0, this._swap - dt * 2.6);
      // The swap: the new lens twists on the way a bayonet does — a third of a
      // turn about the optical axis, arriving with a small overshoot — and
      // drops back into the frame from slightly forward. It is 380 ms and it is
      // the entire physical feeling of changing a lens.
      //
      // On the HOLDER, so it composes with the model's centring rather than
      // replacing it — see `setLens`.
      const e = 1 - Math.pow(this._swap, 3);
      this.model.rotation.z = (1 - e) * 1.15;
      this.model.position.z = (1 - e) * 0.09 * (this.model.userData.fitRadius ?? 0.2);
      a -= (1 - e) * 0.5;
    } else if (this.model) {
      this.model.rotation.z = 0;
      this.model.position.z = 0;
    }
    // Three-quarter view, from slightly above: the angle every lens has ever
    // been photographed from, because it is the one that shows the length, the
    // rings and the front element at once.
    const yaw = a * 0.35 + 0.55;
    if (this._drawn !== null && this._drawn === yaw + this._swap) return;
    this._drawn = yaw + this._swap;
    this.pivot.rotation.set(-PREVIEW_PITCH, yaw, 0);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    for (const m of this._models.values()) {
      m.userData.lens?.userData.dispose?.();
      m.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
    }
    this._models.clear();
    // `dispose()` frees three's own objects; it does NOT release the WebGL
    // context, which the browser then holds until it garbage-collects the
    // canvas — and the context budget is about 16. One leak does not matter;
    // a mode that can be opened and closed all session, each time building a
    // preview, is exactly the shape that runs the budget down. `forceContextLoss`
    // hands it back immediately. It throws on some drivers, and a failure to
    // tidy up must not take the caller's teardown with it.
    try { this.renderer?.forceContextLoss?.(); } catch { /* driver said no */ }
    this.renderer?.dispose();
    this.ok = false;
  }
}
