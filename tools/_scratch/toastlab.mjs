// ─────────────────────────────────────────────────────────────────────────────
//  toastlab — the marshmallow surface, big enough to judge.
//
//  Round 1 shipped a material nobody could see. Every frame roastshot.mjs
//  produces renders the marshmallow at about forty pixels across, which is
//  enough to prove the prop is in the right place and not enough to say one word
//  about whether the sugar reads as sugar. A surface iterated at one capture per
//  minute, at forty pixels, against a machine-wide lock three other authors are
//  queuing for, is a surface that will never be finished.
//
//  So this is the same trick tools/_scratch/toastlink.mjs plays — throwaway
//  static server, headless Chromium, real WebGL2, Atmosphere and Stylize patched
//  exactly as the game patches them — with the two things it was missing: it
//  RENDERS, and it writes a PNG. The marshmallow alone, three-quarter front,
//  filling the frame, at eight states, under two lights, tiled into one sheet.
//
//      node tools/_scratch/toastlab.mjs
//      node tools/_scratch/toastlab.mjs --out shots/roast/lab/sheet-r2.png
//      node tools/_scratch/toastlab.mjs --tile 420          # bigger cells
//
//  It takes no capture lock, needs no dev server and costs about eight seconds.
//
//  ── what it is faithful to, and what it is not ──────────────────────────────
//
//  Faithful: the material itself (imported, not copied), the mallow's real
//  geometry (imported from camp_marshmallow.js, so a change to the lathe shows
//  up here), the global shader patches, the game's tone curve (PBR Neutral, the
//  same code PostFX runs) applied to a FLOAT buffer, and the fire's own light
//  colour, intensity, decay and reach off camp_fire.js's constants.
//
//  NOT faithful, and this matters when the lab and the game disagree: no bloom,
//  no veiling glare, no grade, no fog (the scene has none — the game's fog at
//  300 mm is nothing, but the game's *bloom* on a hot crack is not), no flame
//  geometry behind the object, and no exposure ramp. Believe the game.
//
//  ── the measured constraint ────────────────────────────────────────────────
//
//  The brief: at dusk the fire owns the value range. The lab reads the scene in
//  LINEAR light before the tone curve and reports the marshmallow's own peak and
//  99th-percentile radiance against the flame core's, which camp_fire.js's
//  header pins at 1.15 linear at dusk and 2.55 at night. Because the tone curve
//  is monotonic, comparing linear radiance is exposure-independent and settles
//  the question without an argument about which exposure was in force.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(process.cwd());
const NODE_MODULES = path.resolve(ROOT, '../../../node_modules');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const OUT = path.resolve(ROOT, arg('out', 'shots/roast/lab/surface.png'));
const TILE = Math.max(160, parseInt(arg('tile', '340'), 10));
// ── the stylised-lighting ablation ──────────────────────────────────────────
// `--style physical` pokes Stylize's own uniforms on this material back to a
// straight Lambert (wrap 0, banding 0, floor 0) AFTER the program has linked.
// It exists because round 4 needed to know how much of "the marshmallow is one
// flat tan" is this material and how much is the house lighting style, and the
// only honest way to answer that is to render the same surface both ways.
// It is a MEASUREMENT switch. The game never runs it.
const STYLE = arg('style', 'game');
// ── the shoulder, as a sweep knob ───────────────────────────────────────────
// The value ceiling and its knee are the two numbers that decide how much of
// the toast ramp survives to the screen once the object is sitting 244 mm from
// a 19-irradiance-unit lamp, and round 5 needed to sweep them without a capture
// slot. Empty means "whatever marshmallowMaterial's own constants say".
const KNEE = arg('knee', '');
const CEIL = arg('ceil', '');
// ── the near-field source radius, as a sweep knob ───────────────────────────
// marshmallow_toast.js treats the fire as a sphere of finite radius rather than
// as a point (see SRC_RADIUS there). Empty means "whatever the material's own
// constant says"; 0 turns the model off and puts the old point falloff back,
// which is how a before/after is shot.
const SRCR = arg('srcr', '');
// The fire as the GAME leaves it: RoastView._dampHearth writes decay 2.0 and
// 0.62 of the authored intensity every frame the lens is inside the fire. See
// the light block in the page below for why the lab used to disagree.
// The paper lantern's extinction and forward gain. Empty means the material's
// own SCATTER_K / SCATTER_GAIN.
const TRANSL = +arg('transl', '1');
const SK = arg('sk', '');
const SG = arg('sg', '');
// The two numbers of the lantern's MIDDLE: the diffusion floor inside the
// transmittance, and the coefficient on the core-darkening. Both act only where
// the transmittance is small, i.e. only on the part of the object the composed
// frame actually shows.
const SDIFF = arg('diff', '');
const SCORE = arg('core', '');
// ── AND THE LAB WAS ALSO QUOTING THE WRONG INTENSITY, DISTANCE AND COLOUR ──
//
// The note beside the fire below explains the decay. Three more numbers were
// wrong with it, and all three were found the same way — by reading them off
// the shipped capture's own state dump (shots/roast/r8/ROAST.json, ladder-0)
// instead of off the constants at the top of camp_fire.js:
//
//   intensity  the lab ran 2.6 x 0.62 = 1.612, which is LIGHT_DUSK damped. The
//              game does not hold LIGHT_DUSK at the roast hour: Firepit.update
//              writes base * flicker * reveal^2, and the shipped frame records
//              fire.wasI 1.914 and fire.lightI 1.187 after the damping.
//   distance   the lab ran 0.244 m, which is the RESTING height. The ladder is
//              captured at height 0.24, and the recorded mallow and fire
//              positions (with camp_fire.js's own +0.46 lamp offset) put the
//              lamp 0.288 m away. Squared, that is another 39%.
//   colour     the lab ran the flame MATERIAL's 0xffa259 through the sRGB
//              transfer, i.e. linear (1.000, 0.347, 0.112). The light is not
//              that colour: Firepit.update ends with
//              `_sc.setRGB(1.0, lerp(0.50, 0.40, night), lerp(0.22, 0.135, night))`
//              and setRGB is in the LINEAR working space, so the lamp at dusk
//              is (1.000, 0.500, 0.220) — half again as much green and twice
//              the blue. A lab that lights the sugar with the more saturated
//              of the two will always report the object redder than the frame
//              does, which is the shape of the salmon complaint that three
//              rounds have chased and none has caught.
//
// Together the first two are a factor of 1.63 in irradiance: 13.8 units in the
// lab against 8.5 in the game. Every gain in this material was set against the
// brighter of the two, which is why "the limb rests on the value ceiling" was
// true in the lab and false in the frame.
const FIRE_I = +arg('firei', '1.187');
const FIRE_DEC = +arg('fired', '2.0');
const FIRE_DIST = +arg('fireDist', '0.288');
const FIRE_COL = arg('firec', '1.0,0.50,0.22').split(',').map(Number);

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };

const PAGE = `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{
  "three":"/nm/three/build/three.module.js",
  "three/addons/":"/nm/three/examples/jsm/"
}}</script>
<canvas id="gl" width="${TILE}" height="${TILE}"></canvas>
<canvas id="sheet"></canvas>
<script type="module">
import * as THREE from 'three';
import { ToastMap, marshmallowMaterial } from '/src/camp/marshmallow_toast.js';
const SHOULDER = ${JSON.stringify(Object.fromEntries([['valueKnee', KNEE], ['valueCeil', CEIL], ['srcRadius', SRCR], ['scatterK', SK], ['scatterGain', SG], ['scatterDiff', SDIFF], ['coreK', SCORE]].filter(([, v]) => v !== '').map(([k, v]) => [k, +v])))};
import { patchStylizedLighting } from '/src/render/Stylize.js';
import { patchFogChunks } from '/src/render/Atmosphere.js';

const TILE = ${TILE};
const STYLE = '${STYLE}';
const out = { errors: [], notes: [], stats: [], png: null };
window.__done = null;

// ── the game's own tone curve ───────────────────────────────────────────────
// Copied out of src/render/PostFX.js rather than imported, because importing it
// drags in postprocessing, the whole effect chain and a WebGL canvas the lab
// does not own. It is fourteen lines and it is quoted verbatim; if PostFX's
// curve changes and this does not, the lab is lying and that is worth knowing.
const TONE_FRAG = [
  'precision highp float;',
  'uniform sampler2D tMap;',
  'uniform float uExposure;',
  'uniform vec3 uBg;',
  'varying vec2 vUv;',
  'vec3 pbrNeutral( vec3 c ) {',
  '  const float startCompression = 0.8 - 0.04;',
  '  const float desaturation = 0.15;',
  '  float x = min( c.r, min( c.g, c.b ) );',
  '  float offset = ( x < 0.08 ? x - 6.25 * x * x : 0.04 );',
  '  c -= offset;',
  '  float peak = max( c.r, max( c.g, c.b ) );',
  '  if ( peak < startCompression ) return c;',
  '  float d = 1.0 - startCompression;',
  '  float newPeak = 1.0 - d * d / ( peak + d - startCompression );',
  '  c *= newPeak / peak;',
  '  float g = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );',
  '  return mix( c, vec3( newPeak ), g );',
  '}',
  'vec3 toSRGB( vec3 c ) {',
  '  return mix( c * 12.92, 1.055 * pow( max( c, 1e-5 ), vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );',
  '}',
  'void main() {',
  '  vec4 s = texture2D( tMap, vUv );',
  '  vec3 lin = mix( uBg, s.rgb, clamp( s.a, 0.0, 1.0 ) );',
  '  gl_FragColor = vec4( toSRGB( clamp( pbrNeutral( max( lin * uExposure, 0.0 ) ), 0.0, 1.0 ) ), 1.0 );',
  '}',
].join('\\n');

const TONE_VERT = [
  'varying vec2 vUv;',
  'void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
].join('\\n');

try {
  // Both, and in this order, exactly as Engine boots them. Stylize's shadow-cool
  // block reads a varying Atmosphere declares, so patching one without the other
  // fails to compile for a reason that has nothing to do with this material.
  patchFogChunks();
  patchStylizedLighting();

  const canvas = document.getElementById('gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(TILE, TILE, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // No tone mapping here: the scene renders LINEAR into a float target and the
  // curve above is applied as its own pass, which is the shape of the real
  // chain and is also what makes the linear readback meaningful.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  const rt = new THREE.WebGLRenderTarget(TILE, TILE, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    samples: 4,
  });

  // ── the object ────────────────────────────────────────────────────────────
  // The real lathe, imported, so this lab tracks the geometry author's file.
  // Falling back to a cylinder rather than dying, because the geometry file has
  // a second author working in it right now and a lab that cannot run while a
  // peer is mid-edit is a lab nobody uses.
  let geo = null, R = 0.021, HALF = 0.013, geoNote = '';
  try {
    const m = await import('/src/camp/camp_marshmallow.js');
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const stick = m.buildHeldStick(rnd, { rings: 48, bands: 36 });
    const held = stick.userData.held;
    geo = held.mallow.geometry;
    R = held.radius; HALF = held.half;
    geoNote = 'real lathe from camp_marshmallow.js, R=' + R.toFixed(4) + ' half=' + HALF.toFixed(4);
  } catch (e) {
    geo = new THREE.CylinderGeometry(0.021, 0.021, 0.026, 48, 36);
    geo.rotateX(Math.PI / 2);
    geoNote = 'FALLBACK cylinder (camp_marshmallow.js would not load: ' + (e && e.message) + ')';
  }
  out.notes.push('geometry: ' + geoNote);

  const map = new ToastMap({ radius: R, half: HALF });
  const mat = marshmallowMaterial(map.texture, { radius: R, seed: 0.37, ...SHOULDER });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const u = mat.userData.roastUniforms;

  const scene = new THREE.Scene();
  scene.add(mesh);

  // ── the camera: three-quarter front, filling the frame ────────────────────
  // A long lens at the distance the thing is actually held. A 14-degree field at
  // 265 mm puts a 42 mm marshmallow across most of the tile with the perspective
  // of the real view rather than the barrel distortion of a macro.
  const DIR = new THREE.Vector3(0.62, 0.34, 0.71).normalize();
  const camera = new THREE.PerspectiveCamera(14, 1, 0.02, 4);
  camera.position.copy(DIR).multiplyScalar(0.265);
  camera.lookAt(0, 0, 0);

  // ── the two lights ────────────────────────────────────────────────────────
  // (a) DAYLIGHT. Lighting.js's 15:30 keyframe, verbatim: sun 0xffe6c4 at 3.25,
  //     hemi 0xbfbede / 0xd8ae76 at 1.00 x AMBIENT_SCALE 0.72.
  const dayGroup = new THREE.Group();
  {
    const sun = new THREE.DirectionalLight(0xffe6c4, 3.25);
    sun.color.setHex(0xffe6c4, THREE.SRGBColorSpace);
    sun.position.set(0.6, 1.0, 0.5);
    sun.castShadow = true;
    const hemi = new THREE.HemisphereLight(0xbfbede, 0xd8ae76, 0.72);
    hemi.color.setHex(0xbfbede, THREE.SRGBColorSpace);
    hemi.groundColor.setHex(0xd8ae76, THREE.SRGBColorSpace);
    dayGroup.add(sun, hemi);
  }

  // (b) FIRE, at dusk. camp_fire.js: colour 0xffa259, LIGHT_DUSK 2.6,
  //     FIRE_REACH 8.6 — and placed BEHIND and BELOW, which is the only
  //     placement that asks the translucency term to do anything. The ambient
  //     is Lighting.js's 20.4 (interpolated 19.8 -> 21.0), which is a dim cool
  //     sky and nothing else.
  //
  //     The DISTANCE is not a look choice, it is measured out of the two files
  //     that decide it: camp_fire.js puts the light 0.42 m above the fire, and
  //     camp_roast_view.js holds the mallow at FLAME_TOP 0.26 + H_REST 0.30
  //     above it and 0.16 m to one side and 0.12 m toward the lens. That is
  //     0.244 m from the lamp — the number that makes this object's value
  //     problem what it is. Getting it wrong here is how a lab tells you a
  //     surface is fine and the game says otherwise.
  //
  //     ── AND THE LAB WAS QUOTING THE UNDAMPED FIRE, WHICH IS NOT THE ONE ──
  //
  //     For five rounds this ran the fire at camp_fire.js's AUTHORED decay of
  //     1.4, which at 0.244 m is 2.6 / 0.244^1.4 = 18.9 irradiance units, and
  //     the note above said so proudly. The game never shows this material that
  //     light. RoastView._dampHearth runs every frame the lens is in the
  //     fire and leaves the lamp at decay 2.0 and 0.62 of its authored
  //     intensity — 1.612 / 0.244^2 = 27.1 units, a factor of 1.43 more. Every
  //     lab-says-fine / game-says-flat disagreement in rounds 4 and 5 has this
  //     underneath it, so the damped pair is what the lab runs now and the
  //     authored pair is available as --fired 1.4 --firei 2.6.
  //
  //     ── AND THREE MORE OF ITS NUMBERS WERE THE WRONG ONES ─────────────
  //     See the long note beside FIRE_I at the top of this file: the
  //     intensity, the distance and the LIGHT's colour are now read off the
  //     shipped capture's own state dump rather than off camp_fire.js's
  //     constants, and between them they were worth a factor of 1.63 in
  //     irradiance and a large error in chroma. --firei / --fireDist / --firec
  //     put any of them back.
  //
  //     The geometry is still the lab's own: the fire below and behind, which
  //     is the placement that asks the translucency term to do anything. In
  //     the game the lamp is 24 degrees off dead-behind and nearly LEVEL with
  //     the mallow rather than 32 degrees under it, so the lab's msBack is a
  //     little kinder than the frame's. Believe the game.
  const fireGroup = new THREE.Group();
  const FIRE_D = ${FIRE_DIST};
  const FIRE_I = ${FIRE_I};
  const FIRE_DECAY = ${FIRE_DEC};
  const FIRE_POS = new THREE.Vector3(-DIR.x, -0.60, -DIR.z).normalize().multiplyScalar(FIRE_D);
  {
    const fire = new THREE.PointLight(0xffa259, FIRE_I, 8.6, FIRE_DECAY);
    // setRGB, not setHex: this is the LINEAR triple Firepit.update writes, and
    // putting it through the sRGB transfer is what made the lab's lamp more
    // saturated than the game's.
    fire.color.setRGB(${FIRE_COL[0]}, ${FIRE_COL[1]}, ${FIRE_COL[2]});
    fire.position.copy(FIRE_POS);
    const hemi = new THREE.HemisphereLight(0x5a78c3, 0x4d4c63, 0.65 * 0.72);
    hemi.color.setHex(0x5a78c3, THREE.SRGBColorSpace);
    hemi.groundColor.setHex(0x4d4c63, THREE.SRGBColorSpace);
    const moon = new THREE.DirectionalLight(0x6a9df2, 0.18);
    moon.color.setHex(0x6a9df2, THREE.SRGBColorSpace);
    moon.position.set(-0.7, 0.9, -0.4);
    fireGroup.add(fire, hemi, moon);
  }

  // The fire direction the material wants: FROM the mallow TOWARD the fire, in
  // the mallow's own local space. The mesh is unrotated here, so world is local.
  const FIRE_DIR_LOCAL = FIRE_POS.clone().normalize();
  const DAY_DIR_LOCAL = new THREE.Vector3(0.6, 1.0, 0.5).normalize();

  // ── the tone pass ─────────────────────────────────────────────────────────
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.RawShaderMaterial({
      vertexShader: 'attribute vec3 position;\\nattribute vec2 uv;\\n' + TONE_VERT,
      fragmentShader: TONE_FRAG,
      uniforms: {
        tMap: { value: rt.texture },
        uExposure: { value: 1.28 },   // Engine.exposure, the shipped base
        uBg: { value: new THREE.Color(0.055, 0.055, 0.060) },
      },
      depthTest: false, depthWrite: false,
    }),
  );
  const quadScene = new THREE.Scene().add(quad);
  const quadCam = new THREE.Camera();

  // ── the states ────────────────────────────────────────────────────────────
  // Six ladder rungs from the brief, plus the two frames the mechanic is
  // actually about. Each is a state the SIMULATION can reach — the debug hooks
  // reconstruct char and melt from the same curves the integrator uses — so a
  // cell here is a picture of a real marshmallow, not of a slider.
  const STATES = [
    { key: 'raw',    label: 't 0.00  raw',      set: () => map.setDoneness(0.00) },
    { key: 't20',    label: 't 0.20  warmed',   set: () => map.setDoneness(0.20) },
    { key: 't42',    label: 't 0.42  gold',     set: () => map.setDoneness(0.42) },
    { key: 't60',    label: 't 0.60  dark gold',set: () => map.setDoneness(0.60) },
    { key: 't78',    label: 't 0.78  mahogany', set: () => map.setDoneness(0.78) },
    { key: 't95',    label: 't 0.95  char',     set: () => map.setDoneness(0.95) },
    { key: 'uneven', label: 'uneven',           set: () => {
        map.reset();
        // One side cooked hard, the other barely warmed. u is the angle about
        // the mallow's axis from its local +X, and in this framing u = 0.08
        // faces the lens — so the hot patch is centred at 0.95, a sixth of a
        // turn round from it. That is the marshmallow AFTER the player turned
        // it, which is the only pose in which the failure the mechanic is about
        // is visible at all: painted where the fire actually is (u = 0.68) the
        // whole boundary is round the back and the cell is a picture of a raw
        // marshmallow, which is what the first cut of this lab produced.
        // Three overlapping stamps rather than one wide one: paint()'s weight is
        // a smoothstep that only reaches its full amount at the very centre, so
        // a single radius-0.46 stamp is a bright point with a long tail, not a
        // cooked side.
        map.paint(0.99, 0.5, 0.34, 1.0);
        map.paint(0.92, 0.5, 0.34, 1.0);
        map.paint(0.85, 0.5, 0.32, 0.85);
        map.paint(0.45, 0.5, 0.30, 0.14);
      } },
    { key: 'burning', label: 'alight',          set: () => {
        map.setDoneness(0.62);
        map.paint(0.95, 0.5, 0.40, 0.5);
        map.ignite();
      } },
    // The ladder's debug hook gives every rung a live-heat channel, because a
    // ladder frame is a marshmallow being held over a fire. This one is the same
    // char with the fire off: the state a burnt marshmallow is in when the
    // player pulls it back to look at it, and the only cell on the sheet that
    // answers "is the char matte and black" without the ember in the way.
    { key: 'coldchar', label: 't 0.95  off the fire', set: () => {
        map.setDoneness(0.95);
        map.live.fill(0);
        map._recompute();
      } },
  ];

  const LIGHTS = [
    { key: 'day',  label: 'daylight  (sun 15:30)',      group: dayGroup,  dir: DAY_DIR_LOCAL,  bg: [0.055, 0.055, 0.060], glow: 1.0 },
    { key: 'fire', label: 'fire behind + below (20.4)', group: fireGroup, dir: FIRE_DIR_LOCAL, bg: [0.012, 0.012, 0.017], glow: 1.0 },
  ];

  // ── the sheet ─────────────────────────────────────────────────────────────
  const PAD = 10, LBL = 22, HDR = 34, ROWLBL = 24;
  const sheet = document.getElementById('sheet');
  sheet.width = PAD + STATES.length * (TILE + PAD);
  sheet.height = HDR + LIGHTS.length * (ROWLBL + TILE + LBL + PAD) + PAD;
  const g2 = sheet.getContext('2d');
  g2.fillStyle = '#141416';
  g2.fillRect(0, 0, sheet.width, sheet.height);
  g2.fillStyle = '#e8e4dc';
  g2.font = '600 17px system-ui, sans-serif';
  g2.fillText('marshmallow surface lab  —  ' + geoNote, PAD, 23);

  const pix = new Float32Array(TILE * TILE * 4);
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  let y = HDR;
  for (const L of LIGHTS) {
    scene.add(L.group);
    quad.material.uniforms.uBg.value.setRGB(L.bg[0], L.bg[1], L.bg[2]);
    g2.fillStyle = '#9aa0a8';
    g2.font = '600 14px system-ui, sans-serif';
    g2.fillText(L.label, PAD, y + 16);
    let x = PAD;
    for (const S of STATES) {
      S.set();
      // Sag, swell and glow copied line for line out of RoastView._writeUniforms
      // — off DONENESS, not off melt, and with the view's own curves and its
      // 0.45 ceiling on the general slump. The first cut of this lab guessed
      // (melt * 0.85) and produced a mid-ladder that slumped into a bell, which
      // is a defect in the lab reported as a defect in the material. The view's
      // slip term is zero here: the extra 0.85 of sag on a marshmallow sliding
      // off the stick is a moment the view stages, not a surface state.
      const melt = map.melt;
      const done = map.doneness;
      const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
      u.uSwell.value = ss(0.10, 0.66, done);
      u.uSag.value = ss(0.62, 1.00, done) * 0.45;
      // uGlow at the resting height: peak * 0.55 + 0.15.
      u.uGlow.value = Math.min(1, map.peak * 0.55 + 0.15) * L.glow;
      u.uTime.value = 3.1;
      // --transl 0 ablates the whole scatter block, which is how "how much of
      // the object's hue is the transmitted term and how much is the fire
      // reflecting off it" gets an answer instead of an argument.
      mat.userData.uniforms.uTransl.value = ${TRANSL};
      u.uFireDir.value.copy(L.dir);
      mesh.updateMatrixWorld(true);

      if (STYLE === 'physical') {
        const su = mat.userData?.shader?.uniforms;
        if (su && su.uStyleWrap) {
          su.uStyleWrap.value = 0.0;
          su.uStyleBanding.value = 0.0;
          su.uStyleFloor.value = 0.0;
        }
      }

      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);

      // ── the linear readback, before any curve ──────────────────────────
      renderer.readRenderTargetPixels(rt, 0, 0, TILE, TILE, pix);
      let peak = 0, n = 0, sr = 0, sg2 = 0, sb = 0;
      const ls = [];
      for (let i = 0; i < pix.length; i += 4) {
        if (pix[i + 3] < 0.5) continue;
        const v = lum(pix[i], pix[i + 1], pix[i + 2]);
        ls.push(v); if (v > peak) peak = v; n++;
        sr += pix[i]; sg2 += pix[i + 1]; sb += pix[i + 2];
      }
      // The cream-or-salmon test, in linear. D3-2's complaint was that the raw
      // rung renders at hue 15 degrees with a G/R of 0.63, i.e. a salmon pill,
      // against a brief asking for a cream a shade green of neutral. G/R is the
      // whole of that measurement and it costs three adds a pixel, so it is
      // here rather than in a second tool that has to re-render the sheet.
      const mR = sr / Math.max(1, n), mG = sg2 / Math.max(1, n), mB = sb / Math.max(1, n);
      ls.sort((a, b) => a - b);
      const q = (p) => (ls.length ? ls[Math.min(ls.length - 1, Math.floor(p * ls.length))] : 0);
      // ── the limb-to-core traverse ──────────────────────────────────────
      //
      // The aggregate percentiles above cannot tell a lit object from a flat
      // one: a body that is uniformly 0.41 and a body that runs 0.15 in the
      // middle to 0.80 at the edge can share a mean, and rounds 4 and 5 both
      // shipped a term believing a percentile spread was a gradient. So this
      // reads the one profile the contract's paper-lantern is actually about —
      // a horizontal scan through the silhouette's centroid — and reports the
      // limb and the core separately.
      //
      // CORE is the mean of the middle fifth of the covered span; LIMB is the
      // larger of the two outer eighths' means. The eighths are means and not
      // maxima on purpose: a one-pixel edge sample is antialiasing, and the
      // rim this object is supposed to grow is millimetres wide, not one pixel.
      let cy0 = 0, cn = 0;
      for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++)
        if (pix[(j * TILE + i) * 4 + 3] >= 0.5) { cy0 += j; cn++; }
      const row = cn ? Math.round(cy0 / cn) : (TILE >> 1);
      let sx = -1, ex = -1;
      for (let i = 0; i < TILE; i++) {
        if (pix[(row * TILE + i) * 4 + 3] >= 0.5) { if (sx < 0) sx = i; ex = i; }
      }
      let core = 0, coreN = 0, limbL = 0, limbLN = 0, limbR = 0, limbRN = 0;
      const scan = [];
      if (sx >= 0 && ex > sx + 8) {
        const w = ex - sx + 1;
        for (let i = sx; i <= ex; i++) {
          const o = (row * TILE + i) * 4;
          if (pix[o + 3] < 0.98) continue;   // 0.98: the edge pixels are AA
          const v = lum(pix[o], pix[o + 1], pix[o + 2]);
          scan.push(v);
          const t = (i - sx) / (w - 1);
          if (t > 0.40 && t < 0.60) { core += v; coreN++; }
          else if (t <= 0.125) { limbL += v; limbLN++; }
          else if (t >= 0.875) { limbR += v; limbRN++; }
        }
      }
      // hi:lo across the same scan, which is the form the GAME's traverse is
      // quoted in (tools/_scratch/mtraverse.mjs prints a row and the round
      // reports report its ends against its middle). Percentiles rather than
      // max and min so one blister skin does not become the headline.
      scan.sort((a, b) => a - b);
      const sq = (t) => (scan.length ? scan[Math.min(scan.length - 1, Math.floor(t * scan.length))] : 0);
      const hi = sq(0.98), lo = sq(0.02);
      core = coreN ? core / coreN : 0;
      limbL = limbLN ? limbL / limbLN : 0;
      limbR = limbRN ? limbR / limbRN : 0;
      const limb = Math.max(limbL, limbR);

      out.stats.push({
        light: L.key, state: S.key,
        cover: +(n / (TILE * TILE)).toFixed(3),
        core: +core.toFixed(4), limb: +limb.toFixed(4),
        rim: +(core > 1e-5 ? limb / core : 0).toFixed(2),
        hilo: +(lo > 1e-5 ? hi / lo : 0).toFixed(2),
        hi: +hi.toFixed(4), lo: +lo.toFixed(4),
        gr: +(mR > 1e-6 ? mG / mR : 0).toFixed(3),
        br: +(mR > 1e-6 ? mB / mR : 0).toFixed(3),
        linMean: +(ls.reduce((a, b) => a + b, 0) / Math.max(1, ls.length)).toFixed(4),
        linP50: +q(0.5).toFixed(4), linP95: +q(0.95).toFixed(4),
        linP99: +q(0.99).toFixed(4), linPeak: +peak.toFixed(4),
        doneness: +map.doneness.toFixed(3), evenness: +map.evenness.toFixed(3),
        melt: +melt.toFixed(3),
      });

      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCam);
      g2.drawImage(canvas, x, y + ROWLBL, TILE, TILE);
      g2.fillStyle = '#8e949c';
      g2.font = '13px system-ui, sans-serif';
      g2.fillText(S.label, x + 2, y + ROWLBL + TILE + 15);
      x += TILE + PAD;
    }
    scene.remove(L.group);
    y += ROWLBL + TILE + LBL + PAD;
  }

  // ── the value-range card ──────────────────────────────────────────────────
  // A strip of the flame core's own dusk radiance drawn through the same tone
  // curve, so "the fire owns the value range" is a thing the eye can check on
  // the sheet as well as a number in the table.
  const CORE_DUSK = 1.15, CORE_NIGHT = 2.55;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(new THREE.Color(CORE_DUSK * 1.0, CORE_DUSK * 0.62, CORE_DUSK * 0.30), 1);
  renderer.clear(true, true, true);
  renderer.setRenderTarget(null);
  quad.material.uniforms.uBg.value.setRGB(0, 0, 0);
  renderer.render(quadScene, quadCam);
  g2.drawImage(canvas, PAD, y - PAD + 2, TILE, 26);
  g2.fillStyle = '#141416';
  g2.font = '600 13px system-ui, sans-serif';
  g2.fillText('flame core, dusk: 1.15 linear', PAD + 8, y - PAD + 20);

  out.notes.push('flame core reference: dusk ' + CORE_DUSK + ' linear, night ' + CORE_NIGHT + ' linear');
  out.png = sheet.toDataURL('image/png').split(',')[1];

  // ── the shader still has to link ─────────────────────────────────────────
  const gl = renderer.getContext();
  for (const p of renderer.info.programs) {
    if (!gl.getProgramParameter(p.program, gl.LINK_STATUS)) {
      out.errors.push('LINK FAILED: ' + gl.getProgramInfoLog(p.program));
    }
  }
  const err = gl.getError();
  if (err) out.errors.push('gl error ' + err);
} catch (e) {
  out.errors.push('THREW: ' + (e && e.stack || e));
}
window.__done = out;
</script>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
    return;
  }
  const file = url.startsWith('/nm/')
    ? path.join(NODE_MODULES, url.slice(4))
    : path.join(ROOT, url);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('no ' + file); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
const log = [];
page.on('console', (m) => log.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => log.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:' + port + '/');
await page.waitForFunction('window.__done !== null', null, { timeout: 120000 });
const out = await page.evaluate('window.__done');

for (const l of log) console.log('  ' + l);
for (const n of out.notes) console.log(n);

if (out.png) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(out.png, 'base64'));
  console.log('wrote ' + path.relative(ROOT, OUT));
}

// ── the table ───────────────────────────────────────────────────────────────
// linP99 rather than the peak, because a peak is one specular pixel and the
// question the brief asks is about the object's VALUE, not about whether a
// highlight ever touches a number.
const CORE = { dusk: 1.15, night: 2.55 };
console.log('\nlinear radiance, before the tone curve (flame core at dusk = ' + CORE.dusk + ')');
const head = ['light', 'state', 'done', 'linMean', 'linP99', 'core', 'limb', 'hi', 'limb:core', 'hi:lo', 'G/R', 'B/R', 'vs core'];
console.log(head.map((h, i) => h.padStart(i < 2 ? 9 : i === 8 ? 10 : 8)).join(''));
for (const s of out.stats) {
  const ratio = s.linP99 / CORE.dusk;
  const flag = s.linP99 > CORE.dusk ? '  OVER' : '';
  console.log(
    String(s.light).padStart(9) + String(s.state).padStart(9)
    + String(s.doneness).padStart(8)
    + String(s.linMean).padStart(8)
    + String(s.linP99).padStart(8)
    + String(s.core).padStart(8) + String(s.limb).padStart(8)
    + String(s.hi).padStart(8)
    + (s.rim.toFixed(2) + ':1').padStart(10)
    + (s.hilo.toFixed(2) + ':1').padStart(8)
    + String(s.gr).padStart(8) + String(s.br).padStart(8)
    + (ratio.toFixed(2) + 'x' + flag).padStart(9));
}

await browser.close();
server.close();

const over = out.stats.filter((s) => s.light === 'fire' && s.linP99 > CORE.dusk);
if (over.length) {
  console.log('\n!! the fire does NOT own the value range for: ' + over.map((s) => s.state).join(', '));
}
if (out.errors.length) { console.log('\nerrors'); for (const e of out.errors) console.log('  ' + e); }
process.exit(out.errors.length ? 1 : 0);
