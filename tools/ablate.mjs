#!/usr/bin/env node
/**
 * Ablation harness — find out what the frame time is actually being spent on.
 *
 * perf.mjs and dprtest.mjs tell you THAT a frame is slow. Neither tells you
 * WHICH system is slow, and the notes scattered through PostFX.js and
 * WorldConfig.js show what that costs: guesses that survive for months because
 * nobody could price them. This prices them.
 *
 * Findings from the first full run are written up in docs/PERF_FINDINGS.md.
 * Read that before re-deriving anything — it already answers "is it the CPU"
 * (no), "is it draw calls" (no) and "is it geometry" (no).
 *
 *   node tools/ablate.mjs                            # leave-one-out, still + drive
 *   node tools/ablate.mjs --mode still --ladder      # strip to the floor, add back
 *   node tools/ablate.mjs --mode motion --rounds 3   # reproducible movement
 *   node tools/ablate.mjs --only fx.dof,fx.ssao      # price two things quickly
 *   node tools/ablate.mjs --only tier.low,tier.medium --rounds 2
 *
 * ── WHAT IT MEASURES ────────────────────────────────────────────────────────
 *
 * A "knob" is one thing that can be switched off at runtime. Four families:
 *
 *   draw.<system>   hide that system's geometry. Removes raster, shadow-map and
 *                   overdraw cost; leaves its CPU update running.
 *   cpu.<system>    stop that system's update(). Leaves its geometry on screen.
 *   fx.<feature>    a render feature: the whole post chain, one post effect,
 *                   shadows, the shadow map render alone, flat shading.
 *   px.<scale>      pixel count. tier.<name> switches quality preset.
 *
 * Splitting draw from cpu is the point. "Grass is expensive" is useless until
 * you know whether it is the 500k blades or the streaming rebuild.
 *
 * Two report shapes:
 *
 *   default    LEAVE-ONE-OUT. Everything on, one thing off. Answers "what would
 *              removing this buy me from where I am now".
 *   --ladder   CUMULATIVE ADD-BACK. Everything off, handed back one at a time.
 *              Answers "where does the budget actually go" and shows the row
 *              at which the frame crosses below 60 fps. Where the two disagree,
 *              the disagreement is the finding: it means two systems contend.
 *
 * ── METHOD, AND WHY EACH PART IS THERE ──────────────────────────────────────
 *
 * Every one of these was added because the version without it produced a
 * confidently wrong number. Do not remove one without reproducing its failure.
 *
 *  1. ONE PAGE LOAD. Every arm runs in the same browser, on the same world,
 *     with the same compiled shaders. Two page loads cannot be compared: the
 *     bake, the streaming state and the GPU's thermal state all differ.
 *
 *  2. PAIRED BASELINES — the schedule is A B A B A, and each arm is scored
 *     against the MEAN OF ITS OWN TWO NEIGHBOURING BASELINES.
 *     The first version interleaved arms and alternated direction each round,
 *     on the theory that drift is slow and roughly linear. It is not. One run
 *     measured baseline at 42.7 ms and, thirty seconds later, measured
 *     `draw.water` — water HIDDEN, strictly less work — at 62.3 ms. Anything
 *     that compares an arm against a baseline taken a minute earlier is
 *     measuring the clock. This costs twice the wall time and is not optional.
 *
 *  3. ADAPTIVE RESOLUTION AND AUTO-TIER OFF. Engine scales the internal render
 *     targets toward its configured fps budget. Left on, a
 *     heavy arm quietly renders fewer pixels and measures FASTER than the
 *     truth. Every arm here draws exactly the same number of pixels.
 *
 *  4. A DETERMINISTIC POSE. "Standing still" has to mean the same thing twice.
 *     The first version held the brake from wherever boot left the camper, and
 *     two runs of the identical command disagreed by 27 ms on the cost of
 *     grass — the readout showed the camper at y -6.1 doing -16 m/s, rolling
 *     backwards down a hill through a different part of the valley each time.
 *     Every mode now teleports to a named anchor first, prints the resulting
 *     camera and camper pose, warns if the camper will not come to rest, and
 *     `--shot <dir>` writes the frame that was measured. A frame-time number
 *     without the frame it was measured on is not evidence.
 *
 *  5. SETTLE ON CONVERGENCE, NOT ON A TIMER. Grass rings, ground-cover cells
 *     and terrain LOD rebuild on a per-frame millisecond budget, so a scene
 *     measured too early is still filling in and every later arm is compared
 *     against a lighter world. Uses main.js's `__settleStable`, which holds
 *     until drawn triangle and draw-call counts stop moving.
 *
 *  6. LONGER WARM-UP FOR EXPENSIVE FLIPS. Toggling shadows marks every material
 *     for recompile; changing the pixel count reallocates the drawing buffer,
 *     measured at 450-2500 ms in Engine.js. Measuring the transition instead of
 *     the steady state is the classic way to get an ablation exactly backwards.
 *     See SLOW_FLIP.
 *
 *  7. HAND `renderToScreen` TO WHATEVER IS NOW LAST. EffectComposer marks the
 *     last pass `renderToScreen`, so switching that pass off leaves nothing
 *     writing to the default framebuffer: the canvas goes stale, the compositor
 *     has no work, and the rig reports 3.3 ms / 303 fps for a frame it never
 *     presented. Every pass toggle fixes the flag. See fixRenderToScreen.
 *
 * ── HOW TO READ THE OUTPUT ──────────────────────────────────────────────────
 *
 *  - `spread` is the disagreement between rounds. A saving smaller than its own
 *    spread is marked "(within noise)" and must not be ranked.
 *  - The `drift` line reports how far the baseline moved across the whole run.
 *    If min and max differ by more than ~20%, the machine was not steady; the
 *    paired scoring absorbs it, but treat close calls with suspicion. After
 *    ~90 minutes of continuous measurement this rig's parked baseline drifted
 *    from 36 ms to 70 ms. Let the GPU rest between long runs.
 *  - HIDING AN OBJECT ALSO REMOVES ITS OCCLUSION. `draw.trees` measures as
 *    NEGATIVE 5.2 ms — hiding the trees exposes the whole hillside behind them,
 *    and shading that costs more than the trees did. `fx.flatShade` and
 *    `px.half` change nothing about what is drawn and have no such confound;
 *    they are the trustworthy global diagnostics. Prefer them.
 *  - `fx.flatShade` (`scene.overrideMaterial` = flat MeshBasicMaterial) keeps
 *    every draw call, triangle and overlapping fragment and removes only the
 *    shading. It is the single most informative knob here, and the hard upper
 *    bound on what any material change can buy.
 *  - The anchor a mode teleports to depends on `--res`, because POI ranking
 *    reads the heightmap. Only compare runs taken at the same `--res`.
 *
 * ── MODES ───────────────────────────────────────────────────────────────────
 *
 *   still    parked at the anchor, brake and handbrake held. Reproducible.
 *   motion   the camera on a fixed circle at 14 m/s, PHASE-RESET at the start
 *            of every block, so every arm sees identical footage while still
 *            exercising terrain LOD, grass tile recycling and cover streaming.
 *   drive    the real vehicle at full throttle. Realistic and NOT reproducible:
 *            its baseline ranged 33.8 to 106.7 ms over one sweep, because full
 *            throttle climbs out of the meadow into whatever is up the hill.
 *            Use it to show that driving is worse, not to attribute why.
 *            `motion`'s ladder matches `still`'s to 0.1 ms on every clean row,
 *            which is the evidence that movement adds no NEW bottleneck.
 *
 * The default viewport is the one the player actually has (1920x1080 CSS at
 * devicePixelRatio 2), not the deviceScaleFactor-1 configuration the rest of
 * the harness measures. See the note on pixelRatioCap in WorldConfig.js.
 *
 * ── ADDING A KNOB ───────────────────────────────────────────────────────────
 *
 * Add it to the `K` registry inside the page.evaluate below with an `off()` and
 * an `on()`, and give it a `group` so it lands in the right family. `on()` must
 * restore exactly what `off()` saved — an arm that does not fully restore
 * poisons every arm measured after it, and the paired baseline will show it as
 * drift rather than as a bug.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const W        = parseInt(arg('w', '1920'), 10);
const H        = parseInt(arg('h', '1080'), 10);
const DPR      = parseFloat(arg('dpr', '2'));
const PORT     = arg('port', '5180');
const RES      = arg('res', '1536');
// Pin 20261018 when comparing with the historical archives; both that seed and
// WorldConfig.SEED have bakes on disk. A seed without a bake generates the full
// world live and holds the exclusive capture lock for minutes.
const SEED     = arg('seed', null);
const QUALITY  = arg('quality', null);          // null = let pickQuality decide
const ROUNDS   = parseInt(arg('rounds', '3'), 10);
const BLOCK_MS = parseFloat(arg('block', '2000'));
const WARM_MS  = parseFloat(arg('warm', '900'));
const MODES    = (arg('mode', 'still,drive')).split(',').map((s) => s.trim()).filter(Boolean);
const ONLY     = arg('only', null);             // comma list of knob names
const LADDER   = has('ladder');
// Where the camper is parked / laps. Any key of window.__cameraAnchors.
const ANCHOR   = arg('anchor', 'meadow');
const STEER    = parseFloat(arg('steer', '0.42'));
const RADIUS   = parseFloat(arg('radius', '70'));    // motion mode: metres
const SPEED    = parseFloat(arg('speed', '14'));     // motion mode: m/s (~50 km/h)

// A timing run cannot share a GPU with another capture.
await acquire('ablate', { exclusive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });

// Stub the HMR socket. A peer saving a file mid-run destroys the execution
// context and takes a ten-minute measurement with it.
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, p);
  };
  window.WebSocket.prototype = R.prototype;
  Object.assign(window.WebSocket, R);
});

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 220)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 220)); });

let navigations = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });

const params = new URLSearchParams({ res: RES });
if (SEED) params.set('seed', SEED);
if (QUALITY) params.set('quality', QUALITY);
// Pin the car — see the same note in perf.mjs. Paired baselines inside one
// page load would survive a random vehicle; the ladder printed across runs
// would not.
params.set('car', arg('car', 'camper'));
if (SEED) params.set('seed', SEED);
await page.goto(`http://127.0.0.1:${PORT}/?${params}`, { waitUntil: 'domcontentloaded' });
const navAtStart = navigations;
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

// ── install the in-page controller ──────────────────────────────────────────
await page.evaluate(() => {
  const e = window.__engine;
  const S = window.__systems;
  const scene = e.scene;
  const renderer = e.renderer;
  const postfx = window.__postfx;
  const THREE = window.__THREE;

  // Freeze every automatic quality lever. A heavy arm must be allowed to be
  // slow; if the engine is permitted to rescue it by drawing fewer pixels or
  // dropping a tier, the measurement reports the rescue, not the cost.
  e.adaptive = false;
  e.autoQuality = false;

  const byName = (...names) => {
    const set = new Set(names);
    return scene.children.filter((c) => set.has(c.name));
  };
  const byPrefix = (p) => scene.children.filter((c) => (c.name || '').startsWith(p));

  // ── knob registry ────────────────────────────────────────────────────────
  // Each knob has an `off()` and an `on()`. `group` is only for reporting.
  //
  // DRAW knobs hide geometry: they remove raster, shadow-map and overdraw cost
  // but leave the system's CPU update running. CPU knobs stop a system's
  // update() but leave its geometry on screen. Splitting them is the whole
  // point — "trees are expensive" is useless until you know whether it is the
  // 300k triangles or the streaming rebuild.
  const K = {};
  const draw = (name, get) => {
    K[name] = {
      group: 'draw',
      _saved: null,
      off() { const o = get(); this._saved = o.map((x) => x.visible); o.forEach((x) => { x.visible = false; }); },
      on()  { const o = get(); if (this._saved) o.forEach((x, i) => { x.visible = this._saved[i] ?? true; }); },
    };
  };

  draw('draw.sky',         () => byName('Sky'));
  draw('draw.clouds',      () => byName('Clouds'));
  draw('draw.weather',     () => byName('WeatherLeaves', 'WeatherMotes', 'WeatherShafts'));
  draw('draw.terrain',     () => byName('Terrain', 'TerrainApron'));
  draw('draw.rocks',       () => byName('Rocks'));
  draw('draw.water',       () => byName('Water'));
  draw('draw.waterfalls',  () => byName('Waterfalls'));
  draw('draw.trees',       () => byName('Trees'));
  draw('draw.groundCover', () => byName('GroundCover'));
  draw('draw.grass',       () => byName('Grass'));
  draw('draw.wildlife',    () => byName('Wildlife', 'Birds'));
  draw('draw.vehicle',     () => byName('vehicleRig', 'vehicleParticles', 'tyreTracks', 'camperContactShadow'));
  draw('draw.camp',        () => byPrefix('camp'));

  // ── CPU: per-system update() ──────────────────────────────────────────────
  for (const name of Object.keys(S)) {
    K[`cpu.${name}`] = {
      group: 'cpu',
      off() { this._was = S[name].enabled; S[name].enabled = false; },
      on()  { if (this._was !== undefined) S[name].enabled = this._was; },
    };
  }
  // Terrain streaming is driven straight from main's updater, not through the
  // system registry, so it needs its own knob.
  K['cpu.terrainStream'] = {
    group: 'cpu',
    off() { const t = window.__terrain; this._u = t.update; t.update = () => {}; },
    on()  { if (this._u) window.__terrain.update = this._u; },
  };

  // ── render features ───────────────────────────────────────────────────────
  K['fx.postAll'] = {
    group: 'fx',
    off() {
      this._r = e._render;
      e.setRenderCallback(() => renderer.render(scene, e.camera));
    },
    on() { if (this._r) e._render = this._r; },
  };
  K['fx.ssao'] = {
    group: 'fx',
    off() { if (postfx.ao) { this._was = postfx.ao.enabled; postfx.ao.enabled = false; fixRenderToScreen(); } },
    on()  { if (postfx.ao && this._was !== undefined) { postfx.ao.enabled = this._was; fixRenderToScreen(); } },
  };
  K['fx.mainPass'] = {          // bloom + veil + tone + vignette + grade + SMAA + DOF
    group: 'fx',
    off() { if (postfx.mainPass) { this._was = postfx.mainPass.enabled; postfx.mainPass.enabled = false; fixRenderToScreen(); } },
    on()  { if (postfx.mainPass && this._was !== undefined) { postfx.mainPass.enabled = this._was; fixRenderToScreen(); } },
  };
  // Rebuild the merged EffectPass without one named effect, to price it alone.
  // `postprocessing` compiles every effect in one pass into one fragment
  // shader, so an effect can only be priced by recompiling without it.
  const rebuildWithout = (drop) => {
    const old = postfx.mainPass;
    if (!old) return false;
    const all = [postfx.dof, postfx.bloom, postfx.veil, postfx.tone, postfx.vignette, postfx.grade, postfx.smaa];
    const keep = all.filter((x) => x && x !== drop);
    const Ctor = old.constructor;
    postfx.composer.removePass(old); old.setEffects([]); old.dispose();
    const p = new Ctor(e.camera, ...keep);
    p.needsDepthTexture = true;
    postfx.mainPass = p;
    postfx.composer.addPass(p);
    return true;
  };
  for (const [n, get] of [['bloom', () => postfx.bloom], ['smaa', () => postfx.smaa],
                          ['dof', () => postfx.dof], ['grade', () => postfx.grade]]) {
    K[`fx.${n}`] = {
      group: 'fx',
      // A tier without depth of field has nothing to drop; record that so `on()`
      // does not pay a shader recompile undoing something it never did.
      off() { const x = get(); this._did = !!x && rebuildWithout(x); },
      on()  { if (this._did) rebuildWithout(null); this._did = false; },
    };
  }

  // The single most informative knob in the file.
  //
  // Every draw call, every triangle, every overlapping fragment still happens —
  // only the SHADING is gone. So `baseline - this` is the total cost of every
  // fragment shader in the scene (PBR lighting, shadow-map sampling, the
  // Stylize patch, the grass translucency epilogue), and whatever is LEFT is
  // geometry, draw-call submission and raw fill. Without it, "terrain is
  // expensive" cannot be told apart from "terrain covers the screen".
  K['fx.flatShade'] = {
    group: 'fx',
    off() {
      this._m ??= new THREE.MeshBasicMaterial({ color: 0x808080 });
      scene.overrideMaterial = this._m;
    },
    on() { scene.overrideMaterial = null; },
  };

  // ── the three override materials, which together price a material change ──
  //
  // fx.flatShade answers "what does ALL shading cost". These two split that
  // number the way docs/PERF_FINDINGS.md item 2 asks it to be split, on
  // identical geometry with every custom shader in the game stripped out:
  //
  //   fx.overrideBasic     = fx.flatShade. No lighting at all.
  //   fx.overrideLambert   Gouraud-era lighting: the light loop, the shadow
  //                        plumbing, no BRDF.
  //   fx.overrideStandard  the same scene shaded by a stock
  //                        MeshStandardMaterial: GGX, Fresnel, the multi-
  //                        scatter energy compensation, the IBL path.
  //
  // (standard - lambert) is therefore the ENTIRE cost of the physical model,
  // measured rather than estimated, and it is the ceiling on re-basing every
  // material on Lambert. (lambert - basic) is what lighting and shadow
  // sampling cost at all. (baseline - standard) is everything this project
  // wrote itself: terrain's texture fetches, grass, ground cover, rock, and
  // the Stylize patch.
  //
  // CAVEAT, AND IT APPLIES TO fx.flatShade TOO: overrideMaterial replaces the
  // VERTEX shader as well. Grass, ground cover and the tree cards build their
  // geometry there, so under any override they do not rasterise the same
  // pixels. Read the frames these arms write, do not just read their numbers.
  const overrideKnob = (name, make) => {
    K[name] = {
      group: 'fx',
      off() { this._m ??= make(); scene.overrideMaterial = this._m; },
      on() { scene.overrideMaterial = null; },
    };
  };
  overrideKnob('fx.overrideBasic', () => new THREE.MeshBasicMaterial({ color: 0x808080 }));
  overrideKnob('fx.overrideLambert', () => new THREE.MeshLambertMaterial({ color: 0x808080 }));
  overrideKnob('fx.overrideStandard',
    () => new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.9, metalness: 0 }));

  // fx.flatShade done correctly — see the STYLIZE_FLATSHADE note in
  // src/render/Stylize.js. Compiles the shading out of every lit material and
  // leaves the vertex shaders, so the grass, the ground cover and the canopy
  // still rasterise every fragment they normally do. This is the real ceiling
  // on what a material change can buy; fx.flatShade's is inflated by the near
  // field disappearing. Recompiles, so it is in SLOW_FLIP.
  K['fx.shadeOnly'] = {
    group: 'fx',
    off() { const st = window.__stylize; st.harvest(); this._n = st.setFlatShade(true); },
    on() { if (this._n) window.__stylize.setFlatShade(false); },
  };

  // The half of fx.flatShade that can actually be shipped.
  //
  // fx.flatShade removes ALL shading and is therefore only a ceiling. This
  // removes exactly one thing from it: the physical specular lobe — BRDF_GGX
  // per light, plus the indirect multi-scatter energy compensation — on every
  // material that is matte, metalness-0 and env-map-free, which is everything
  // in the world except the camper. Stylize already replaces the direct
  // lighting response wholesale, so the lobe is scaled to 14% and mixed into a
  // band-quantised response that has no highlights in it.
  //
  // `off()` = the lobe is gone, so `saved` reads the same direction as every
  // other knob here: what shipping this change would buy.
  //
  // It recompiles every affected program, so it is in SLOW_FLIP. `harvest()`
  // first because materials stream in and the registry is only swept every
  // 16 frames.
  K['fx.physicalSpec'] = {
    group: 'fx',
    off() {
      const st = window.__stylize;
      st.harvest();
      this._n = st.setMatteSpecular(true);
    },
    on() { if (this._n) window.__stylize.setMatteSpecular(false); },
  };

  // The post chain minus its effects: the HDR render targets, the copies
  // between them and the NaN guard, but no AO, no bloom, no grade. Paired with
  // fx.postAll this separates "the effects are expensive" from "rendering
  // through a composer at all is expensive".
  // Disabling a composer pass is only half the job. EffectComposer marks the
  // LAST pass `renderToScreen`, so switching that pass off leaves nothing
  // writing to the default framebuffer: the canvas goes stale, the compositor
  // has no work, and the rig measures 3.3 ms and reports 303 fps for a frame it
  // never presented. Every pass toggle has to hand the flag to whatever is now
  // last, or the number is a fiction.
  const fixRenderToScreen = () => {
    const ps = postfx.composer.passes;
    let lastEnabled = -1;
    for (let i = 0; i < ps.length; i++) { ps[i].renderToScreen = false; if (ps[i].enabled) lastEnabled = i; }
    if (lastEnabled >= 0) ps[lastEnabled].renderToScreen = true;
  };
  K['fx.postEffects'] = {
    group: 'fx',
    off() {
      if (postfx.ao) { this._ao = postfx.ao.enabled; postfx.ao.enabled = false; }
      if (postfx.mainPass) { this._mp = postfx.mainPass.enabled; postfx.mainPass.enabled = false; }
      fixRenderToScreen();
    },
    on() {
      if (postfx.ao && this._ao !== undefined) postfx.ao.enabled = this._ao;
      if (postfx.mainPass && this._mp !== undefined) postfx.mainPass.enabled = this._mp;
      fixRenderToScreen();
    },
  };
  K['fx.sanityPass'] = {
    group: 'fx',
    off() { if (postfx.sanity) { this._was = postfx.sanity.enabled; postfx.sanity.enabled = false; fixRenderToScreen(); } },
    on()  { if (postfx.sanity && this._was !== undefined) { postfx.sanity.enabled = this._was; fixRenderToScreen(); } },
  };

  K['fx.shadows'] = {
    group: 'fx',
    off() {
      this._was = renderer.shadowMap.enabled;
      renderer.shadowMap.enabled = false;
      scene.traverse((o) => { if (o.material) { const m = Array.isArray(o.material) ? o.material : [o.material]; m.forEach((x) => { x.needsUpdate = true; }); } });
    },
    on() {
      renderer.shadowMap.enabled = this._was ?? true;
      scene.traverse((o) => { if (o.material) { const m = Array.isArray(o.material) ? o.material : [o.material]; m.forEach((x) => { x.needsUpdate = true; }); } });
    },
  };
  // Shadow MAP cost alone (the extra depth-only scene pass), with receivers
  // still sampling. Distinguishes "rendering the shadow map is expensive" from
  // "sampling it in every material is expensive".
  K['fx.shadowMapUpdate'] = {
    group: 'fx',
    off() { this._was = renderer.shadowMap.autoUpdate; renderer.shadowMap.autoUpdate = false; },
    on()  { renderer.shadowMap.autoUpdate = this._was ?? true; },
  };
  K['fx.shadowRes1k'] = {
    group: 'fx',
    off() {
      const L = window.__lighting;
      this._saved = [];
      for (const l of [L.sun, L.moon]) {
        if (!l?.shadow) continue;
        this._saved.push([l, l.shadow.mapSize.x, l.shadow.mapSize.y]);
        l.shadow.mapSize.set(1024, 1024);
        l.shadow.map?.dispose(); l.shadow.map = null;
      }
    },
    on() {
      for (const [l, x, y] of this._saved ?? []) {
        l.shadow.mapSize.set(x, y);
        l.shadow.map?.dispose(); l.shadow.map = null;
      }
    },
  };

  // ── shipping quality tiers ────────────────────────────────────────────────
  // The four presets in WorldConfig are the escape hatch a struggling player
  // actually has, and until now nobody had priced them against each other in
  // one page load at the pixel count a real display asks for. Measured as arms
  // rather than as four separate runs for the usual reason: two page loads
  // differ in bake, streaming state and thermal state, and the difference
  // between tiers is smaller than the difference between loads.
  for (const t of ['ultra', 'high', 'medium', 'low']) {
    K[`tier.${t}`] = {
      group: 'tier',
      off() { this._was = e.quality; if (this._was !== t) e.setQuality(t); },
      on()  { if (this._was && this._was !== e.quality) e.setQuality(this._was); },
    };
  }

  // Pixel count. Halving the linear scale is a quarter of the pixels; anything
  // that scales with it is fill-bound, anything that does not is not.
  K['px.half'] = {
    group: 'px',
    off() { this._was = e.resolutionScale; e.resolutionScale = 0.5; e._applyResolution(); },
    on()  { e.resolutionScale = this._was ?? 1; e._applyResolution(); },
  };
  K['px.native'] = {
    group: 'px',
    off() { this._was = e.resolutionScale; e.resolutionScale = Math.min(1, 1 / e.basePixelRatio); e._applyResolution(); },
    on()  { e.resolutionScale = this._was ?? 1; e._applyResolution(); },
  };

  // Internal render scale (the upscale path in PostFX). Unlike px.*, these do
  // not touch the drawing buffer — they resize the composer's offscreen
  // targets, which is exactly what ships. The quality-biased boot default is
  // effective device ratio 1.15 (raw scale 0.85 at `high`), so
  // `px.iscale100` prices full-cap internal rendering and the smaller ones
  // price the adaptive scaler's lower rungs or historical settings.
  const iscaleKnob = (name, s) => {
    K[name] = {
      group: 'px',
      off() { this._was = e.internalScale; e.internalScale = s; postfx.setInternalScale(s); },
      on()  { const w = this._was ?? 1; e.internalScale = w; postfx.setInternalScale(w); },
    };
  };
  iscaleKnob('px.iscale100', 1.0);
  iscaleKnob('px.iscale85', 0.85);
  iscaleKnob('px.iscale74', 0.74);
  iscaleKnob('px.iscale63', 0.63);

  // ── the measurement itself ────────────────────────────────────────────────
  const rec = { on: false, t: [], calls: [], tris: [], upd: [], late: [], sub: [] };
  let last = performance.now();

  // Sentinels at both ends of the updater lists. main.js registered its own
  // updater first and every system runs inside it, so bracketing the whole
  // array measures all of it.
  e._updaters.unshift(() => { window.__mk.u0 = performance.now(); });
  e._updaters.push(() => { window.__mk.u1 = performance.now(); });
  e._lateUpdaters.unshift(() => { window.__mk.l0 = performance.now(); });
  window.__mk = {};

  const wrapRender = () => {
    const r0 = e._render;
    e._render = (dt, t) => { const a = performance.now(); r0(dt, t); window.__mk.sub = performance.now() - a; };
  };
  // Re-wrap whenever fx.postAll swaps the callback.
  const origSetRender = e.setRenderCallback.bind(e);
  e.setRenderCallback = (fn) => { origSetRender(fn); wrapRender(); };
  wrapRender();

  e.onLateUpdate(() => {
    const now = performance.now();
    if (rec.on) {
      const i = renderer.info.render;
      rec.t.push(now - last);
      rec.calls.push(i.calls);
      rec.tris.push(i.triangles);
      rec.upd.push((window.__mk.u1 ?? 0) - (window.__mk.u0 ?? 0));
      rec.late.push(now - (window.__mk.l0 ?? now));
      rec.sub.push(window.__mk.sub ?? 0);
    }
    last = now;
  });

  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

  window.__ab = {
    knobs: Object.keys(K),
    groups: Object.fromEntries(Object.entries(K).map(([k, v]) => [k, v.group])),
    state: {},
    set(name, want) {
      const k = K[name];
      if (!k) return false;
      const cur = this.state[name] !== false;      // default: on
      if (cur === want) return true;
      if (want) k.on(); else k.off();
      this.state[name] = want;
      return true;
    },
    allOn() { for (const n of Object.keys(K)) this.set(n, true); },
    // Only `off` the named knobs; everything else back on.
    apply(offList) {
      const off = new Set(offList);
      for (const n of Object.keys(K)) this.set(n, !off.has(n));
    },
    start() { rec.on = true; rec.t.length = 0; rec.calls.length = 0; rec.tris.length = 0; rec.upd.length = 0; rec.late.length = 0; rec.sub.length = 0; },
    stop() {
      rec.on = false;
      return {
        n: rec.t.length,
        p50: +pct(rec.t, 0.50).toFixed(3),
        p95: +pct(rec.t, 0.95).toFixed(3),
        fps: +(1000 / (pct(rec.t, 0.50) || 1)).toFixed(2),
        updMs: +mean(rec.upd).toFixed(3),
        lateMs: +mean(rec.late).toFixed(3),
        submitMs: +mean(rec.sub).toFixed(3),
        calls: Math.round(mean(rec.calls)),
        tris: Math.round(mean(rec.tris)),
      };
    },
    // ── posing ───────────────────────────────────────────────────────────
    //
    // "Standing still" has to mean the same thing twice. The first version of
    // this just held the brake from wherever boot left the camper, and two runs
    // of the identical command disagreed by 27 ms on the cost of grass: the
    // readout showed the camper at y -6.1 doing -16 m/s, i.e. rolling backwards
    // down a hill through a completely different part of the valley each time.
    // A teleport to a named anchor fixes the view; the assert in `moving()`
    // catches it if the camper will not stay put.
    place(anchor) {
      const a = (window.__cameraAnchors[anchor] ?? window.__cameraAnchors.road)();
      window.__vehicleTeleport?.(a.x, a.z, a.yaw ?? 0);
      return { x: +a.x.toFixed(1), z: +a.z.toFixed(1) };
    },
    moving() { return Math.abs(window.__systems.vehicle?.speed ?? 0); },

    drive(on, steer) {
      window.__abDrive = on;
      if (!on) return;
      // A CIRCLE, not the weave the other harnesses use. A weave translates
      // across the valley, so an arm measured thirty seconds later is looking
      // at different ground — which is exactly the confound the paired baseline
      // is trying to remove, re-introduced through the back door. Constant
      // steer keeps the camper lapping one patch, so every block drives
      // comparable terrain at comparable speed.
      const tick = () => {
        if (!window.__abDrive) return;
        const inp = window.__ctx.input;
        inp.axes.throttle = 1; inp.axes.brake = 0; inp.axes.handbrake = 0;
        inp.axes.steer = steer;
        requestAnimationFrame(tick);
      };
      tick();
    },
    /**
     * A fixed camera path instead of the vehicle.
     *
     * `drive` is realistic and unreproducible: over one sweep its baseline
     * ranged 34 to 90 ms, because full throttle at constant steer climbs out of
     * the meadow and into whatever is up the hill, and no two blocks look at
     * the same thing. `motion` moves the camera around a fixed circle at
     * driving speed and PHASE-RESETS at the start of every block, so every arm
     * sees the identical arc of the identical world — while still exercising
     * everything that only costs money when the camera moves: terrain LOD,
     * grass tile recycling, ground-cover streaming, shadow-camera refit.
     */
    motion(anchor, radius, speed, height) {
      window.__abDrive = false;
      window.__forceCamera = true;
      if (S.cameraRig) S.cameraRig.enabled = false;
      const a = (window.__cameraAnchors[anchor] ?? window.__cameraAnchors.road)();
      const p = this._path = { cx: a.x, cz: a.z, r: radius, v: speed, h: height, t: 0 };
      if (!this._pathHooked) {
        this._pathHooked = true;
        e.onUpdate((dt) => {
          const q = this._path;
          if (!q) return;
          q.t += dt;
          const w = q.v / q.r;                       // angular speed, rad/s
          const ang = q.t * w;
          const cam = e.camera;
          const x = q.cx + Math.cos(ang) * q.r, z = q.cz + Math.sin(ang) * q.r;
          cam.position.set(x, window.__world.getHeight(x, z) + q.h, z);
          // Look along the tangent, angled down the way a chase camera is.
          cam.rotation.set(-0.16, Math.atan2(-Math.sin(ang), -Math.cos(ang)) + Math.PI / 2, 0, 'YXZ');
        });
      }
      void p;
      const tick = () => {
        const inp = window.__ctx.input;
        inp.axes.throttle = 0; inp.axes.steer = 0; inp.axes.brake = 1; inp.axes.handbrake = 1;
        if (this._path) requestAnimationFrame(tick);
      };
      tick();
    },
    resetPhase() { if (this._path) this._path.t = 0; },

    stand() {
      window.__abDrive = false;
      const tick = () => {
        if (window.__abDrive) return;
        const inp = window.__ctx.input;
        inp.axes.throttle = 0; inp.axes.steer = 0; inp.axes.brake = 1; inp.axes.handbrake = 1;
        requestAnimationFrame(tick);
      };
      tick();
    },
    env() {
      const gl = renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        quality: e.quality,
        pixelRatio: renderer.getPixelRatio(),
        basePixelRatio: e.basePixelRatio,
        buffer: [renderer.domElement.width, renderer.domElement.height],
        megapixels: +((renderer.domElement.width * renderer.domElement.height) / 1e6).toFixed(2),
        devicePixelRatio: window.devicePixelRatio,
        gpuTimerQuery: !!ext,
        gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        shadowMapSize: window.__lighting?.sun?.shadow?.mapSize?.x,
        preset: window.__ctx?.preset,
      };
    },
  };
});

const env = await page.evaluate(() => window.__ab.env());
const knobs = await page.evaluate(() => ({ names: window.__ab.knobs, groups: window.__ab.groups }));

console.log('\n── configuration ────────────────────────────────────────────');
console.log(`viewport   ${W}x${H} css @ dpr ${DPR}   ->  ${env.buffer[0]}x${env.buffer[1]} (${env.megapixels} MP)`);
console.log(`quality    ${env.quality}   pixelRatio ${env.pixelRatio}   shadowMap ${env.shadowMapSize}`);
console.log(`gpu        ${env.gpu ?? 'unknown'}   timerQuery ${env.gpuTimerQuery}`);

const sleep = (ms) => page.waitForTimeout(ms);

// Some knobs cost far more to FLIP than they do to hold, and that cost lands
// inside the block if the warm-up is too short. Toggling shadows marks every
// material for recompile (110 programs); changing the pixel count reallocates
// the drawing buffer, measured at 450-2500 ms in Engine.js. Measuring those
// transitions instead of the steady state is the classic way to get an ablation
// exactly backwards.
const SLOW_FLIP = /^(px\.|tier\.|fx\.shadows$|fx\.bloom$|fx\.smaa$|fx\.dof$|fx\.grade$|fx\.shadowRes1k$|fx\.physicalSpec$|fx\.shadeOnly$)/;
const warmFor = (offList, prevOff) => {
  const changed = [...new Set([...offList, ...prevOff])].filter(
    (n) => offList.includes(n) !== prevOff.includes(n));
  return changed.some((n) => SLOW_FLIP.test(n)) ? Math.max(WARM_MS, 3000) : WARM_MS;
};

/** Measure one arm: apply the off-list, settle, record. */
let _prevOff = [];
async function measure(offList) {
  const warm = warmFor(offList, _prevOff);
  _prevOff = [...offList];
  await page.evaluate((l) => window.__ab.apply(l), offList);
  await sleep(warm);
  // Every block starts at the same point on the camera path, so two arms are
  // never compared across different footage.
  await page.evaluate(() => window.__ab.resetPhase());
  await page.evaluate(() => window.__ab.start());
  await sleep(BLOCK_MS);
  return page.evaluate(() => window.__ab.stop());
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

/**
 * Paired sweep: every arm is bracketed by a fresh baseline measurement.
 *
 * The first version of this interleaved arms and alternated direction, on the
 * theory that drift over a run is slow and roughly linear. It is not. A run of
 * this rig measured baseline at 42.7 ms and, thirty seconds later, measured
 * `draw.water` — water HIDDEN, strictly less work — at 62.3 ms. Whatever the
 * cause (thermal, another process, the compositor), a scheme that compares an
 * arm against a baseline taken a minute earlier is measuring the clock, not the
 * arm.
 *
 * So the schedule is A B A B A …, and each arm's delta is taken against the
 * MEAN OF ITS OWN TWO NEIGHBOURING BASELINES. Drift that is linear across one
 * ~6 s pair cancels exactly; drift that is not linear across 6 s shows up as
 * disagreement between rounds, which is printed as the spread. It costs twice
 * the wall clock and it is the only version worth trusting.
 */
async function sweep(arms, label) {
  const acc = new Map(arms.map((a) => [a.name, []]));
  const baselines = [];
  const baseStats = [];
  for (let r = 0; r < ROUNDS; r++) {
    let prevBase = await measure([]);
    baselines.push(prevBase.p50);
    baseStats.push(prevBase);
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      const s = await measure(a.off);
      const nextBase = await measure([]);
      baselines.push(nextBase.p50);
      baseStats.push(nextBase);
      const localBase = (prevBase.p50 + nextBase.p50) / 2;
      acc.get(a.name).push({ ...s, base: localBase, save: localBase - s.p50 });
      prevBase = nextBase;
      process.stdout.write(`\r  ${label} round ${r + 1}/${ROUNDS}  [${String(i + 1).padStart(2)}/${arms.length}] ` +
        `${a.name.padEnd(22)} ${s.p50.toFixed(1)} vs base ${localBase.toFixed(1)}      `);
    }
  }
  process.stdout.write('\r' + ' '.repeat(92) + '\r');
  const out = [];
  for (const [name, runs] of acc) {
    const saves = runs.map((x) => x.save);
    out.push({
      name,
      p50: +median(runs.map((x) => x.p50)).toFixed(2),
      base: +median(runs.map((x) => x.base)).toFixed(2),
      save: +median(saves).toFixed(2),
      spread: +(Math.max(...saves) - Math.min(...saves)).toFixed(2),
      fps: +(1000 / median(runs.map((x) => x.p50))).toFixed(1),
      p95: +median(runs.map((x) => x.p95)).toFixed(2),
      updMs: +median(runs.map((x) => x.updMs)).toFixed(2),
      lateMs: +median(runs.map((x) => x.lateMs)).toFixed(2),
      submitMs: +median(runs.map((x) => x.submitMs)).toFixed(2),
      calls: Math.round(median(runs.map((x) => x.calls))),
      tris: Math.round(median(runs.map((x) => x.tris))),
    });
  }
  const drift = { n: baselines.length, min: +Math.min(...baselines).toFixed(2), max: +Math.max(...baselines).toFixed(2),
                  median: +median(baselines).toFixed(2), first: +baselines[0].toFixed(2), last: +baselines[baselines.length - 1].toFixed(2) };
  // The CPU split of the BASELINE blocks. This used to be read off one of the
  // ablation arms (the SSAO arm, of all things) and printed as though it were
  // the scene's — an arm with a system switched off does not have the scene's
  // update cost, and nothing in the output said so.
  const baseSplit = {
    updMs: +median(baseStats.map((x) => x.updMs)).toFixed(2),
    lateMs: +median(baseStats.map((x) => x.lateMs)).toFixed(2),
    submitMs: +median(baseStats.map((x) => x.submitMs)).toFixed(2),
  };
  return { out, drift, baseSplit };
}

const report = { env, viewport: [W, H], dpr: DPR, rounds: ROUNDS, blockMs: BLOCK_MS, modes: {} };

const names = ONLY ? ONLY.split(',') : knobs.names;
const LOO = [{ name: 'baseline', off: [] }, ...names.map((n) => ({ name: n, off: [n] }))];

// The floor: everything this harness knows how to switch off, off at once.
// Not a shippable configuration — it is the answer to "is 60 fps even reachable
// on this machine at this pixel count", which has to be yes before any of the
// per-system numbers mean anything.
const ALL_DRAW = names.filter((n) => knobs.groups[n] === 'draw');
const ALL_CPU  = names.filter((n) => knobs.groups[n] === 'cpu');
const FLOOR    = [...ALL_DRAW, ...ALL_CPU, 'fx.postAll', 'fx.shadows'];

for (const mode of MODES) {
  console.log(`\n── ${mode} ─────────────────────────────────────────────────────`);
  const at = await page.evaluate((a) => window.__ab.place(a), ANCHOR);
  if (mode === 'drive') await page.evaluate((st) => window.__ab.drive(true, st), STEER);
  else if (mode === 'motion') await page.evaluate((c) => window.__ab.motion(c.a, c.r, c.v, c.h),
                                                  { a: ANCHOR, r: RADIUS, v: SPEED, h: 5.5 });
  else await page.evaluate(() => window.__ab.stand());

  // Wait for streaming to CONVERGE, not for a fixed number of frames. Grass
  // rings, ground-cover cells and terrain LOD all rebuild on a per-frame
  // millisecond budget, so a scene measured too early is still filling in and
  // every arm after it is compared against a lighter world. __settleStable
  // holds until the drawn triangle and draw-call counts stop moving, which is
  // what "streaming has caught up" actually means.
  const settled = await page.evaluate(() => window.__settleStable());
  await sleep(1500);
  // A frame-time number is meaningless without the frame it was measured on.
  // The first version of this had no shot, and two runs of the same command
  // disagreed by 27 ms on the cost of grass — because they were pointed at
  // different things and nothing in the output said so.
  if (arg('shot')) {
    mkdirSync(resolve(arg('shot')), { recursive: true });
    await page.screenshot({ path: resolve(arg('shot'), `${mode}-baseline.png`) });
  }
  const pose = await page.evaluate(() => {
    const c = window.__engine.camera;
    const v = window.__systems.vehicle;
    return { cam: [c.position.x, c.position.y, c.position.z].map((n) => +n.toFixed(1)),
             pitch: +c.rotation.x.toFixed(2), yaw: +c.rotation.y.toFixed(2),
             veh: v?.position ? [v.position.x, v.position.y, v.position.z].map((n) => +n.toFixed(1)) : null,
             speed: +(v?.speed ?? 0).toFixed(2) };
  });
  console.log(`  camera     ${JSON.stringify(pose.cam)} yaw ${pose.yaw}   camper ${JSON.stringify(pose.veh)} ` +
              `speed ${pose.speed} m/s   anchor ${ANCHOR} ${JSON.stringify(at)}`);
  if (mode === 'still' && Math.abs(pose.speed) > 0.5) {
    console.log(`  WARNING    the camper has not come to rest (${pose.speed} m/s). ` +
                `The "still" view is drifting and these numbers are not reproducible.`);
  }
  console.log(`  settled after ${settled.frames} frames ` +
              `(${settled.converged ? 'converged' : 'HIT THE CAP — still streaming'}), ` +
              `${settled.calls} calls, ${(settled.triangles / 1e6).toFixed(2)} M tris`);

  let arms;
  if (LADDER) {
    // Strip to the floor, then hand systems back one at a time, cumulatively.
    // Leave-one-out prices a system against a full scene; this prices it
    // against an empty one. When they disagree the difference IS the finding —
    // it means two systems are contending for the same resource.
    const order = ['fx.shadows', 'fx.postAll', 'draw.terrain', 'draw.grass', 'draw.groundCover',
                   'draw.trees', 'draw.water', 'draw.rocks', 'draw.waterfalls', 'draw.camp',
                   'draw.vehicle', 'draw.sky', 'draw.clouds', 'draw.weather', 'draw.wildlife',
                   ...ALL_CPU];
    const seq = order.filter((n) => FLOOR.includes(n));
    arms = [{ name: 'FLOOR (all off)', off: [...FLOOR] }];
    const remaining = new Set(FLOOR);
    for (const n of seq) {
      remaining.delete(n);
      arms.push({ name: `+ ${n}`, off: [...remaining] });
    }
  } else {
    arms = [...LOO.filter((a) => a.name !== 'baseline'), { name: 'FLOOR (all off)', off: FLOOR }];
  }

  const { out: rows, drift, baseSplit } = await sweep(arms, mode);
  report.modes[mode] = { rows, drift, baseSplit, settled };

  const b = drift.median;
  console.log(`\n  baseline   ${b.toFixed(2)} ms  =  ${(1000 / b).toFixed(1)} fps` +
              `   (median of ${drift.n} interleaved baseline blocks)`);
  console.log(`  drift      baselines ranged ${drift.min}–${drift.max} ms over the run ` +
              `(first ${drift.first}, last ${drift.last}) — each arm is scored against its own two neighbours`);
  console.log(`  cpu split  update ${baseSplit.updMs.toFixed(2)} ms   late ${baseSplit.lateMs.toFixed(2)} ms   ` +
              `render-submit ${baseSplit.submitMs.toFixed(2)} ms  (baseline blocks; blocking in submit means GPU-bound)`);

  if (LADDER) {
    console.log('\n  cumulative add-back (each row adds one system to the row above):');
    console.log('  ' + 'arm'.padEnd(26) + 'ms'.padStart(8) + 'fps'.padStart(8) + 'step'.padStart(9) + '   calls   Mtris');
    let prev = null;
    for (const r of rows) {
      const step = prev === null ? '' : `${(r.p50 - prev) >= 0 ? '+' : ''}${(r.p50 - prev).toFixed(2)}`;
      const mark = r.fps < 60 && (prev === null || 1000 / prev >= 60) ? '   <-- drops below 60 fps' : '';
      console.log('  ' + r.name.padEnd(26) + r.p50.toFixed(2).padStart(8) + r.fps.toFixed(1).padStart(8) +
                  step.padStart(9) + String(r.calls).padStart(8) + (r.tris / 1e6).toFixed(2).padStart(8) + mark);
      prev = r.p50;
    }
  } else {
    const scored = [...rows].sort((a, b2) => b2.save - a.save);
    console.log('\n  leave-one-out — ms saved by switching this ONE thing off:');
    console.log('  ' + 'knob'.padEnd(24) + 'saved'.padStart(8) + 'spread'.padStart(9) +
                'ms left'.padStart(9) + 'fps'.padStart(7) + '   calls   Mtris');
    for (const r of scored) {
      // A saving smaller than the disagreement between its own rounds is not a
      // saving. Say so rather than let a reader rank noise.
      const noise = Math.abs(r.save) < r.spread;
      const pctSave = (r.save / r.base) * 100;
      console.log('  ' + r.name.padEnd(24) + r.save.toFixed(2).padStart(8) +
                  `±${r.spread.toFixed(2)}`.padStart(9) + r.p50.toFixed(2).padStart(9) +
                  r.fps.toFixed(0).padStart(7) +
                  String(r.calls).padStart(8) + (r.tris / 1e6).toFixed(2).padStart(8) +
                  (noise ? '   (within noise)' : `   ${pctSave.toFixed(0)}%`));
    }
  }
}

await page.evaluate(() => { window.__abDrive = false; window.__ab.allOn(); });

if (navigations !== navAtStart) {
  console.error('\nWARNING — the page reloaded mid-run. Numbers are not trustworthy; re-run.');
}
await browser.close();

if (errors.length) console.log('\nconsole errors:', JSON.stringify([...new Set(errors)].slice(0, 6), null, 1));

if (arg('json')) {
  mkdirSync(dirname(resolve(arg('json'))), { recursive: true });
  writeFileSync(resolve(arg('json')), JSON.stringify(report, null, 1));
  console.log(`\nwrote ${arg('json')}`);
}
