// ─────────────────────────────────────────────────────────────────────────────
//  Camping Season — world constants & art direction
//  Every subsystem reads its numbers from here so the world stays coherent.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

// export const SEED = 20261018;
export const SEED = 20262018;

// ── World extents ────────────────────────────────────────────────────────────
export const WORLD = {
  size: 3072,           // metres, square, centred on origin
  half: 1536,
  heightmapRes: 1536,   // texels across; 2m per texel
  get texelSize() { return this.size / this.heightmapRes; },

  maxAltitude: 340,     // peak height above sea level
  seaLevel: 0,          // lakes/ocean plane
  valleyFloor: 14,      // typical drivable meadow height
};

// ── Terrain chunking / LOD ───────────────────────────────────────────────────
export const TERRAIN = {
  chunkSize: 96,               // metres per chunk
  get chunksPerSide() { return Math.round(WORLD.size / this.chunkSize); },
  lodDistances: [180, 380, 720, 1300],   // switch radii
  lodResolutions: [64, 32, 16, 8, 4],    // verts per side per LOD
  viewDistance: 2400,
};

// ── Colour: an art-directed autumn palette ───────────────────────────────────
// Authored in linear-ish sRGB hex; converted to working space on read.
const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

export const PALETTE = {
  // Ground
  grassGoldLit:    C(0xf0ad46),
  grassGoldDeep:   C(0xd4832a),
  grassOlive:      C(0x9aa845),
  grassDry:        C(0xe8c46a),
  grassShadow:     C(0x4a4f86),   // cool violet — the complementary anchor
  dirtPath:        C(0xb99a72),
  dirtDark:        C(0x7d6248),
  sand:            C(0xd9c49a),

  // Rock
  rockLit:         C(0xc3bfcc),
  rockMid:         C(0x9d9aad),
  rockShadow:      C(0x5c5a75),
  rockWarm:        C(0xb9a89c),
  scree:           C(0xa8a4b4),
  snow:            C(0xf4f2f8),

  // Foliage
  leafOrange:      C(0xe8622a),
  leafAmber:       C(0xf09a2c),
  leafGold:        C(0xf3cf45),
  leafCrimson:     C(0x9e2b28),
  leafRust:        C(0xb8471f),
  leafOlive:       C(0x8fa83c),
  leafLimeFade:    C(0xc3cf5c),
  coniferLit:      C(0x4e7346),
  coniferMid:      C(0x375638),
  coniferDeep:     C(0x1f3527),

  // Bark
  barkBirch:       C(0xe9e6dd),
  barkAspen:       C(0xd7d2c4),
  barkMaple:       C(0x6b4b38),
  barkPine:        C(0x4a3628),

  // Water
  waterShallow:    C(0x9dc4d8),
  waterDeep:       C(0x2f5f86),
  waterFoam:       C(0xf6fbff),
  waterSubsurface: C(0x63a9b8),

  // Atmosphere
  skyZenith:       C(0x6f9fd8),
  skyHorizon:      C(0xfbe3c8),
  sunDisc:         C(0xfff2d6),
  sunLight:        C(0xffd9a0),
  fogNear:         C(0xf6d5b0),
  fogFar:          C(0xf2c8a8),
  ambientSky:      C(0x7d94c9),   // cool bounce from sky
  ambientGround:   C(0xc08a4e),   // warm bounce from gold meadow
  cloudLit:        C(0xfff6ea),
  cloudShadow:     C(0xc4b4c8),
};

// ── Time of day presets (index by keyframe hour) ─────────────────────────────
export const CYCLE_SPEEDS = {
  frozen: 0.0,
  slow: 0.02,
  fast: 0.2,
};

export const TOD = {
  hour: 16.6,            // late-afternoon golden hour by default
  cycleSpeed: CYCLE_SPEEDS.slow, // hours per second. Tunable in the HUD.
  sunAzimuth: 2.32,      // radians
};

// ── Biome bands: elevation + moisture driven ─────────────────────────────────
export const BIOME = {
  MEADOW: 0,
  FOREST: 1,
  RIVERBANK: 2,
  ALPINE: 3,
  ROCKY: 4,
  WETLAND: 5,
};

// ── Vegetation density (instances per hectare, pre-biome-weight) ─────────────
export const VEG = {
  grassBladesPerChunk: 26000,
  grassRadius: 150,
  treeDensity: 0.010,
  bushDensity: 0.020,
  flowerDensity: 0.012,
  rockDensity: 0.005,
  fernDensity: 0.014,
};

// ── Vehicle ──────────────────────────────────────────────────────────────────
export const VEHICLE = {
  mass: 1850,
  wheelBase: 3.05,
  trackWidth: 1.86,
  wheelRadius: 0.44,
  suspensionRest: 0.55,
  suspensionStiffness: 34000,
  suspensionDamping: 3400,
  maxSteer: 0.62,
  // 12000 N against 1850 kg is 6.5 m/s^2 of thrust. Gravity down a 30-degree
  // slope is 4.9 m/s^2 and down 40 degrees is 6.3 — so the camper had almost
  // nothing left for a real hill and simply stalled on the steep ones.
  engineForce: 21000,
  brakeForce: 22000,
  comHeight: -0.32,
};

// pixelRatioCap is the single most expensive number in this file. The renderer
// draws `min(devicePixelRatio, cap)` device pixels per CSS pixel, so on a Retina
// display a cap of 2.0 is FOUR TIMES the pixels of a cap of 1.0 — and the post
// chain, measured at 56-59% of frame time, is fixed cost per pixel. These caps
// were originally authored and tested at deviceScaleFactor 1, where the setting
// had no effect at all; on the player's machine it was the difference between
// 47 fps and 16 fps before window size was even accounted for.
//
// AdaptiveResolution in Engine scales below these at runtime, so treat them as
// a ceiling for a fast machine rather than a target.
//
// `preferredEffectiveRatio` is optional and overrides
// ADAPTIVE_RESOLUTION.preferredEffectiveRatio for that tier — it is the
// effective ratio the adaptive scaler BOOTS at and is allowed to recover back
// up to. Only Ultra sets it, and Ultra sets it to its own cap. See below.
export const QUALITY_PRESETS = {
  // Terrain uses the same optimized painter at every tier. A distance ring
  // between two materially different painters was visible while driving, so
  // quality is spent on pixels, vegetation, shadows and post effects instead.
  // 3K at Ultra is deliberate: paired at the dense river view it recovers
  // 1.1 ms versus 4K, while still matching High's already art-approved shadow
  // density. SSAO is deliberately off at every tier: it cost 3.25 +/- 0.70 ms
  // (22% of the Ultra frame) in a paired river run, yet three canonical A/B
  // plates were visually indistinguishable. Authored lighting and contact
  // shadows already provide the cue; spend that budget on sharp pixels.
  //
  // ── Ultra means native, and nothing less ────────────────────────────────
  // Ultra used to cap at 1.5 while the scaler preferred 1.25, so on a Retina
  // panel the top tier drew 39% of the display's pixels and called itself
  // Ultra. A player reported the result exactly as it reads: the bloomed,
  // low-frequency parts of the frame (the campfire) looked right and the
  // thin hard-surface props (a telescope tripod, a chair frame, a radiator
  // grille) looked low-resolution — the signature of undersampling, at 60 fps
  // with headroom to spare and no control that could spend it.
  //
  // Ultra is now the tier that means "the best this display can show": the cap
  // is 2.0 and `preferredEffectiveRatio` matches it, so the scaler boots at one
  // rendered pixel per device pixel and the reconstruction pass switches off
  // entirely. The scaler still rescues a struggling frame — it just recovers
  // back to native instead of to 1.25.
  //
  // 2.0 rather than uncapped: it is native on every Retina-class display, and
  // it is a real ceiling for the dpr-3 panels where "native" would be 9x the
  // pixels of a 1x display. Below native the honest lever is a lower tier.
  //
  // This makes Ultra roughly 2x the frame cost it was (measured: 2.56x the
  // pixels for 1.97x the frame time), which is why `pickQuality` now rarely
  // auto-selects it on a Retina laptop — its pixel-load step-down reads this
  // cap. That is the intended shape: Ultra is a deliberate choice, not a
  // default handed to any 8-core machine.
  ultra:  { shadowMapSize: 3072, cascades: 4, grassMul: 1.0,  ssao: false, dof: false, volumetric: true,  reflections: true,  pixelRatioCap: 2.0,  preferredEffectiveRatio: 2.0, treeMul: 1.0, terrainDetailDistance: 0 },
  high:   { shadowMapSize: 3072, cascades: 3, grassMul: 0.8,  ssao: false, dof: false, volumetric: true,  reflections: true,  pixelRatioCap: 1.35, treeMul: 0.9, terrainDetailDistance: 0 },
  medium: { shadowMapSize: 2048, cascades: 3, grassMul: 0.55, ssao: false, dof: false, volumetric: false, reflections: false, pixelRatioCap: 1.15, treeMul: 0.7, terrainDetailDistance: 0 },
  low:    { shadowMapSize: 1024, cascades: 2, grassMul: 0.3,  ssao: false, dof: false, volumetric: false, reflections: false, pixelRatioCap: 1.0,  treeMul: 0.5, terrainDetailDistance: 0 },
};

export const QUALITY_TIERS = Object.freeze(Object.keys(QUALITY_PRESETS));

// The yardstick `pickQuality` measures a display's pixel load against.
//
// It is a fixed number rather than a tier's cap on purpose. Its thresholds
// (3.5 MP / 6.0 MP) were calibrated when Ultra capped at 1.5, and they describe
// how much a machine is being asked to draw — not what the most expensive tier
// aspires to. Ultra's cap moved to 2.0 when Ultra came to mean native; reading
// the cap here would have doubled every figure and demoted the DEFAULT tier on
// every Retina display. Change this only alongside re-measuring those
// thresholds.
export const AUTOPICK_REFERENCE_RATIO = 1.5;

// Dynamic resolution is a quality fallback, not the default look. These are
// effective device pixels per CSS pixel after internal scaling, so the policy
// has the same visual meaning at every quality tier and display DPR.
//
// The first reconstruction build started at 1.0 and could fall to 0.78 while
// chasing 60 fps. The upscaler made that better than browser bilinear, but not
// free: in motion the bottom rungs still read as a soft, low-resolution game.
// Prefer a sharper 50 fps frame, keep a 0.90 emergency floor, and only descend
// through two rungs per measurement so a short heavy vista cannot immediately
// turn the whole image to mush.
export const ADAPTIVE_RESOLUTION = Object.freeze({
  targetFps: 50,
  // The terrain and Ultra shadow cuts bought enough real headroom for this
  // sharper starting rung: paired Ultra motion at ~1.28x stays inside the
  // 60 fps frame budget. Adaptation can still step through 1.15/1.05/0.98.
  preferredEffectiveRatio: 1.25,
  minEffectiveRatio: 0.90,
  downscaleThreshold: 1.08,
  // The downscale threshold already provides the hysteresis. At 0.95 a 60 Hz
  // browser reporting the vsync floor (16.7 ms) could never prove that the
  // 0.90 -> 0.98 rung fit inside 19 ms, so one transient downscale became
  // permanent even with GPU headroom. A full target budget lets that first
  // recovery step happen; the 1.08 downscale threshold prevents oscillation.
  upscaleHeadroom: 1.0,
  maxDownRungs: 2,
  // 1.75 and 1.5 exist for Ultra: booting at a native 2.0, the next rung down
  // used to be 1.35, which is a 46% cut in pixels for a frame that may be a
  // few percent over budget. Rungs above a tier's ceiling are filtered out in
  // `_adapt`, so these two are invisible to High, Medium and Low.
  effectiveRungs: Object.freeze([1.75, 1.5, 1.35, 1.25, 1.15, 1.05, 0.98]),
});
