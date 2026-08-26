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
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, lerp, smoothstep, mulberry32 } from '../core/MathUtils.js';
import { buildEnvMap } from '../vehicle/model_kit.js';
import { journalFontsReady } from './journal_fonts.js';
import { JournalPage, ROWS_PER_PAGE, loadPhoto, disposePaperCache } from './journal_page.js';
import {
  BOOK, buildJournal, poseJournal, setJournalPages, samplePage, disposeJournalMaterials,
  PAPER_GAIN,
} from './journal_model.js';
import { hunt } from '../game/hunt_store.js';

// ── the script ───────────────────────────────────────────────────────────────
// Every duration in the ceremony, in seconds, in one place. `gap` values are
// the pause BEFORE that beat starts, measured from the end of the previous one.
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

// Framing. The camera never moves; the BOOK moves, which is both cheaper to
// reason about and the right way round — a camera that swoops at a stationary
// object reads as a cutscene, and this is a thing the player picked up.
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
const POSE_LAID = { pos: [0, 0.008, 0.0], rot: [-1.005, 0.0, 0.0], scale: 1.10 };

// ── leaning in on one entry ──────────────────────────────────────────────────
//
// Click a print and the book comes up toward you, centred on that row, so the
// photograph and the line it belongs to are big enough to read. Click again,
// or press Escape, and it goes back to the spread.
//
// **It is the ROW that is framed, not the print.** A photograph in this book is
// landscape and sits beside its line, not over it, so framing the print alone
// puts the entry it belongs to off the side of the screen — which is the half
// of the pair somebody leaning in is actually trying to read. The print is the
// TARGET (it is the visible affordance, and a small one is easier to aim at
// than a whole band is to leaf past); the row is the FRAME.
//
// Three numbers, and each is a decision:
//
//  · `STUDY_TILT` is added to the laid pose's `rotation.x`. The spread lies at
//    -1.005 rad, and the camera looks down at it from 23.5 degrees, which
//    leaves the page 34 degrees off face-on; -0.41 rad would be dead face-on.
//    0.42 takes about seventy per cent of that. Going the whole way was tried
//    and it is worse: a page exactly perpendicular to the lens has no
//    perspective in it at all and the book stops being an object in a room —
//    it becomes a texture, which is precisely the "reads as a UI panel" failure
//    the whole model is built to avoid.
//  · `STUDY_ZOOM` scales the BOOK rather than dollying the camera, because
//    `_fitCamera` owns the camera's position and a second author of it is a
//    fight (and because the composition note above still holds: the book
//    moves, the camera does not). 2.55 takes the row from ~26% of the frame's
//    width to ~66%.
//  · `STUDY_IN`/`STUDY_OUT`. It has to be a move and not a cut, and it has to
//    stay READABLE while it moves — so easeInOut over four tenths of a second,
//    with no spin and no arc. The book leans; it does not swing.
//
// `STUDY_LOOK` is where the row's centre is put, and the offset that puts it
// there is recomputed from the LIVE posed page every frame rather than baked at
// the click. That is what makes the blend work at all: at k = 0.5 the book is
// half-tilted and half-scaled, and the offset that centres the row is not half
// the offset that centres it at k = 1.
const STUDY_IN = 0.42;
const STUDY_OUT = 0.34;
const STUDY_TILT = 0.42;
const STUDY_ZOOM = 2.55;
const STUDY_LOOK = new THREE.Vector3(0, 0.004, 0.02);
// The print's own rect, grown a little, as the click target. 1.18 is about
// 10 mm of page all round at book scale — enough that a thumb on a phone does
// not have to be accurate to the millimetre, and small enough that the two
// prints on a page are still nowhere near each other.
const SLOT_PICK = 1.18;

const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** Overshoot-and-settle. The book arrives with a little weight. */
const easeBack = (t) => {
  const c = 1.34;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

export class Journal {
  constructor(ctx) {
    this.ctx = ctx ?? {};
    this.onClose = null;             // integrator hook; called once, on close

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
    // whole spread is in frame), `_studyTo` is 0 or 1 and `_studyK` is the
    // eased blend between the two poses. `_study` is kept while `_studyK` runs
    // back down to zero — the pose needs the row it is coming away FROM.
    this._study = null;
    this._studyTo = 0;
    this._studyK = 0;
    this._studyT = 1;
    this._studyFrom = 0;
    this._cursor = null;

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
    // A leaf has two sides. Pad so the last one is not half a sheet — the
    // physical block would show a page with nothing behind it.
    if (specs.length % 2) specs.push({ kind: 'notes', index: nList + 2, seed: 10, rows: [] });

    this._pages = specs.map((s, i) => new JournalPage({ ...s, verso: i % 2 === 1 }));
    this._pageTex = this._pages.map((p) => p.texture);
    this._sheets = Math.max(1, Math.ceil(this._pages.length / 2));
    // Which page (and row) each item lives on, so an award can find its seat.
    this._seat = new Map();
    for (let k = 0; k < nList; k++) {
      const page = this._pages[1 + k];
      page.spec.rows.forEach((r, i) => this._seat.set(r.id, { page: 1 + k, row: i }));
    }
  }

  _progressLine() {
    const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
      'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];
    const n = hunt.doneCount?.() ?? 0, t = hunt.total ?? 0;
    const w = (v) => WORDS[v] ?? String(v);
    return n >= t && t > 0 ? 'all of them found' : `${w(n)} of ${w(t)} found`;
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
      for (const row of p.spec.rows ?? []) {
        const done = hunt.isDone(row.id);
        const url = done ? hunt.photoFor(row.id) : null;
        if (force || done !== row.done || (!!url !== !!row.photo)) dirty.add(i);
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
   * @param award { id, photoDataURL } | null
   *
   * With an award the full ceremony runs, including however many page turns it
   * takes to reach the item's own page. With none, the book opens to the
   * checklist and stops.
   */
  open({ award = null } = {}) {
    if (this._active && !this._closing) return;
    this._active = true;
    this._visible = true;
    this._closing = false;
    this._t = 0;
    this._pose.leaf = 0;
    this._leafFrom = this._leafTo = 0;
    this._leafT = 1;
    this._leafDur = SCRIPT.seekLeaf;
    // A book opened from shut is a book at the spread. Snapped rather than
    // eased: there is nothing on screen yet to ease from.
    this._study = null;
    this._studyTo = this._studyK = 0;
    this._studyT = 1;
    // Every latch the ceremony sets, reset in one place. Forgetting one of
    // these is how the second open of a session skips a beat.
    this._seatOf = null;
    this._awardLeaf = null;
    this._seekPad = null;
    this._seekDone = false;
    this._seekQueue = 0;
    this._seekExtra = 0;
    this._coverCued = false;
    this._crossStarted = false;
    this._crossed = false;
    this._ticked = false;
    this._slapped = false;
    this._taped = false;
    this._bakedPhoto = false;
    this._card.visible = false;

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
    this._prep.then(() => this._armAward(award)).catch(() => {});
    this._script = this._makeScript(award);
  }

  async _armAward(award) {
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
    row.photo = await loadPhoto(award.photoDataURL ?? hunt.photoFor(award.id));
    for (const p of this._pages) if (p.spec.progress != null) p.spec.progress = this._progressLine();
    page.paint();
    this._drawCard(row.photo);
    // The spread the award lives on. Page p is on spread ceil(p/2) — see
    // journal_page.js: page 0 is alone on the right of the first spread.
    this._awardLeaf = Math.ceil(seat.page / 2);
  }

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
    if (award) {
      add('cross', S.crossGap, S.cross);
      add('tick', S.tickGap, S.tick);
      add('photo', S.photoGap, S.photo);
      add('tape', S.tapeGap, S.tape);
    }
    return { beats, end: t, hasAward: !!award };
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
    // The put-down animation is 0.46 s of a book dropping away, and it drops
    // away from the SPREAD. Eased out over the close rather than snapped, so a
    // player who shuts the book while leaning in sees it go back and go down as
    // one movement instead of jumping a hand's width first.
    this.unstudy();
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
    const gated = this._script?.hasAward && this._awardLeaf == null &&
                  this._t >= this._seekAt - 0.02;
    if (!gated) this._t += d;

    if (this._closing) {
      const k = clamp01(this._t / SCRIPT.close);
      this._pose.lift = 1 - easeInOut(k);
      this._pose.cover *= 1 - easeInOut(k) * 0.9;
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
    if (fly > 0 && fly < 1 && this._leafT >= 1 && this._pose.leaf < 1) {
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
   * @param dt real seconds since the last call. Only the lean uses it — every
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

    // The lean, on top of the laid pose and nothing else — it adds to what is
    // already on the root rather than replacing it, so the rise, the dip and
    // the recentre above all keep working underneath it.
    this._applyStudy(r, dt);

    this._scrim.material.opacity = 0.78 * clamp01(P.scrim);
    // Everything downstream of this frame — the photograph finding the page it
    // lands on, most of all — reads world matrices, and three only refreshes
    // them inside render(). One walk of a 20-node tree is nothing.
    this._bookRoot.updateMatrixWorld(true);
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
    // Leaning in adds a level, and every way out of it backs out ONE level.
    // Escape from a leaned-in entry returns to the spread and a second Escape
    // shuts the book; a page key does not teleport back to the spread and turn
    // a page in the same keystroke. The alternative — dead keys while leaning —
    // was tried on paper and rejected: a key that does nothing is how a player
    // decides a mode is stuck.
    this._onKey = (e) => {
      if (!this._active) return;
      stop(e);
      switch (e.code) {
        case 'Escape': case 'KeyJ': case 'Enter':
          e.preventDefault();
          if (this._studyTo > 0) this.unstudy(); else this.close();
          break;
        case 'ArrowRight': case 'KeyD': case 'PageDown': case 'Space':
          e.preventDefault();
          if (this._studyTo > 0) this.unstudy(); else this.leaf(+1);
          break;
        case 'ArrowLeft': case 'KeyA': case 'PageUp':
          e.preventDefault();
          if (this._studyTo > 0) this.unstudy(); else this.leaf(-1);
          break;
        default: break;
      }
    };
    this._onKeyUp = (e) => { if (this._active) stop(e); };
    this._onWheel = (e) => {
      if (!this._active) return;
      e.preventDefault(); stop(e);
      // One detent per turn, with a hold-off: a trackpad emits a burst of
      // twenty events for one flick and the book would riffle to the end.
      const now = performance.now();
      if (now - (this._wheelAt ?? 0) < 260) return;
      if (Math.abs(e.deltaY) < 4) return;
      this._wheelAt = now;
      if (this._studyTo > 0) this.unstudy(); else this.leaf(e.deltaY > 0 ? +1 : -1);
    };
    this._onPointer = (e) => {
      if (!this._active) return;
      stop(e);
      if (e.type === 'pointermove') {
        // Hover only; the pick is cheap (four `samplePage` lookups per
        // photographed row, of which a spread holds at most eight) and it is
        // the only thing telling the player a print is worth clicking.
        this._cursorTo(this._studyTo > 0 ? 'zoom-out'
          : (this._rowAt(e.clientX, e.clientY) ? 'zoom-in' : ''));
        return;
      }
      if (e.type !== 'pointerdown') return;
      e.preventDefault();
      // Already leaning in: anywhere is "put it back". Nothing inside a
      // leaned-in entry is clickable, so a hit test here would only be a way to
      // get the gesture wrong.
      if (this._studyTo > 0) { this.unstudy(); this._cursorTo(''); return; }
      // A print. Lean in and read that entry.
      const seat = this._rowAt(e.clientX, e.clientY);
      if (seat) { this.study(seat.page, seat.row); this._cursorTo('zoom-out'); return; }
      // Click the half of the frame you want to go to. The book fills the
      // middle, so this is "click the page you can see", which needs no label.
      this.leaf(e.clientX > window.innerWidth * 0.5 ? +1 : -1);
    };
    window.addEventListener('keydown', this._onKey, { capture: true });
    window.addEventListener('keyup', this._onKeyUp, { capture: true });
    window.addEventListener('wheel', this._onWheel, { capture: true, passive: false });
    for (const t of ['pointerdown', 'pointerup', 'pointermove'])
      window.addEventListener(t, this._onPointer, { capture: true });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Leaning in on one entry
  // ───────────────────────────────────────────────────────────────────────────

  /** True while the book is leaning in on a single row (or on its way there). */
  get studying() { return this._studyTo > 0; }

  /**
   * Lean in on one row of the spread that is currently open.
   *
   * @param page  index into `_pages`
   * @param row   index into that page's `spec.rows`
   */
  study(page, row) {
    const p = this._pages[page];
    if (!p?.spec?.rows?.[row]) return;
    // Nothing to lean in on mid-turn: `samplePage` reads the leaf that is at
    // rest, and there isn't one while a page is in flight.
    if (this._leafT < 1 || this._seekQueue > 0) return;
    // The ceremony has right of way, on the same test `leaf()` uses. The
    // photograph flies to a page it locates with `samplePage` every frame, and
    // leaning the book in underneath it would move the target it is aiming at.
    if (this._script?.hasAward && !this._taped &&
        this._t < (this._script.end + (this._seekPad ?? 0))) return;
    this._study = { page, row, verso: p.spec.verso, ...p.rowUV(row) };
    this._studyOff?.set(0, 0, 0);
    this._studyFrom = this._studyK;
    this._studyTo = 1;
    this._studyT = 0;
    this._studyDur = STUDY_IN * (1 - this._studyFrom);
  }

  /** Back out to the spread. Keeps `_study` until the move has finished. */
  unstudy() {
    if (this._studyTo === 0) return;
    this._studyFrom = this._studyK;
    this._studyTo = 0;
    this._studyT = 0;
    this._studyDur = STUDY_OUT * this._studyFrom;
  }

  /**
   * Advance the lean, and hold the row's centre on `STUDY_LOOK`.
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
    if (k <= 0.0002 || !this._study) return;

    const S = this._study;
    root.rotation.x += STUDY_TILT * k;
    root.scale.multiplyScalar(lerp(1, STUDY_ZOOM, k));

    // Where that row's centre has ended up, with the lean already on the book.
    // The offset is then scaled by `k` so it is zero at the spread and exact at
    // full lean — see the STUDY_* header for why it cannot be precomputed.
    root.updateMatrixWorld(true);
    const off = this._studyOff ??= new THREE.Vector3();
    const mesh = S.verso ? this._J.pageLeft : this._J.pageRight;
    // The last good offset is KEPT when the page stops being sampleable, which
    // happens on exactly one path and it matters: `close()` eases the lean out
    // while the cover swings shut, and the moment the cover takes the leaves
    // back (`J.inside` goes false) they are no longer visible and there is
    // nothing to sample. Recomputing to zero there would snap a scaled, tilted
    // book a hand's width sideways on the first frame of the put-down.
    if (mesh?.visible && samplePage(mesh, S.u, S.v, this._tmpP)) {
      off.subVectors(STUDY_LOOK, this._tmpP);
    }
    root.position.addScaledVector(off, k);
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
   * Only rows that HAVE a print are offered. An empty slot is a corner mark on
   * a page and leaning in on nothing is a worse outcome than the click falling
   * through to a page turn, which is what it does instead.
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
        if (!p.spec.rows[r].done || !p.spec.rows[r].photo) continue;
        const slot = p.slotUV(r);
        if (this._inSlot(mesh, slot, px, py)) return { page: idx, row: r };
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
   * A print you can lean in on has to say so, and the journal has no chrome to
   * say it with — the whole feature is a book with no labels on it. `zoom-in`
   * over a print and `zoom-out` while leaning is the browser's own vocabulary
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
    const to = Math.max(0, Math.min(this._sheets - 1, Math.round(this._pose.leaf) + dir));
    if (to === Math.round(this._pose.leaf)) return;
    this._leafFrom = this._pose.leaf;
    this._leafTo = to;
    this._leafT = 0;
    this._cue('page');
  }

  // ───────────────────────────────────────────────────────────────────────────

  dispose() {
    window.removeEventListener('keydown', this._onKey, { capture: true });
    window.removeEventListener('keyup', this._onKeyUp, { capture: true });
    window.removeEventListener('wheel', this._onWheel, { capture: true });
    for (const t of ['pointerdown', 'pointerup', 'pointermove'])
      window.removeEventListener(t, this._onPointer, { capture: true });

    this._cursorTo('');
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
