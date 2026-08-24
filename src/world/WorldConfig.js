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
export const TOD = {
  hour: 16.6,            // late-afternoon golden hour by default
  cycleSpeed: 0.0,       // hours per second; 0 = frozen. Tunable in the HUD.
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
export const QUALITY_PRESETS = {
  ultra:  { shadowMapSize: 4096, cascades: 4, grassMul: 1.0,  ssao: true,  dof: false,  volumetric: true,  reflections: true,  pixelRatioCap: 1.5,  treeMul: 1.0 },
  high:   { shadowMapSize: 3072, cascades: 3, grassMul: 0.8,  ssao: true,  dof: false,  volumetric: true,  reflections: true,  pixelRatioCap: 1.35, treeMul: 0.9 },
  medium: { shadowMapSize: 2048, cascades: 3, grassMul: 0.55, ssao: true,  dof: false, volumetric: false, reflections: false, pixelRatioCap: 1.15, treeMul: 0.7 },
  low:    { shadowMapSize: 1024, cascades: 2, grassMul: 0.3,  ssao: false, dof: false, volumetric: false, reflections: false, pixelRatioCap: 1.0,  treeMul: 0.5 },
};
