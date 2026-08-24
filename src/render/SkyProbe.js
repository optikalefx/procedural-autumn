// ─────────────────────────────────────────────────────────────────────────────
//  SkyProbe — the dome, as a thing a MeshStandardMaterial can actually sample.
//
//  WHY THIS EXISTS
//
//  Nothing in the game sets `scene.environment` and no prop material carries an
//  `envMap`, so every `envMapIntensity` in the camp and boat kits multiplies a
//  term that is never summed. Two authors have now tuned those numbers against
//  a frame they could not move: camp_table.js measured its anodised top and its
//  aluminium leg landing on rgb(51,41,33), the same value to the last bit
//  (docs/CAMP_REQUESTS.md, opened 2026-08-20), and boat_materials.js raised the
//  hull's fill to 1.15 to stop it going near-black on the shadow side and
//  changed nothing at all. Measured on the boat at h19.0, seed 20261018: hull
//  luma 32 under a sky at 193, which is a diffuse object 28x darker in linear
//  than the unobstructed dome above it.
//
//  WHY IT IS BAKED FROM THE KEYS AND NOT ONCE AT BOOT
//
//  `model_kit.buildEnvMap` already bakes a probe, and the first pass at this
//  used it. It is a cream-horizon / blue-zenith gradient with a near-white sun
//  blob — a fixed DAYTIME sky — and pointing it at a boat in a violet twilight
//  frame lights the hull like noon. The boat came back pale cream and mint
//  against a lake and a treeline that had both gone blue, and read as brighter
//  than anything around it (user, at h19.4). A fill whose colour does not track
//  the sky is a light leak, not a fill.
//
//  So the dome below is painted from SKY_STATE — the same `zenith`, `horizon`,
//  `sunHorizon`, `glow` and `glowIntensity` that Sky.js draws the visible dome
//  from, which is Lighting's own keyframe table. At golden hour the probe is
//  gold; at 19:00 its sun wedge is `sunHor` 0xff9450 and its glow term is at
//  the highest value it takes all day; by 21:00 it is the violet the plates
//  ask for. The prop gets the sky the player is looking at, for free, at every
//  hour, with no second art-direction surface to keep in sync.
//
//  WHY PER-MATERIAL AND NOT scene.environment
//
//  Terrain, grass and ground cover are hijacked MeshStandardMaterials
//  (TerrainMaterial.js) while the tree canopy is on raw ShaderMaterials, so a
//  scene-wide probe relights the ground and not the trees. Measured: it takes
//  the bank from luma 58 to 180 and pulls the frame apart. Hand `texture()` to
//  a prop kit's own material set instead — see setBoatEnv.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { SKY_STATE } from './Lighting.js';

// How far the hour has to move before the probe is re-baked. The bake is a
// PMREM off a 24-segment sphere, which is cheap but not free, and the fill it
// produces is a broad irradiance term — nothing in it changes visibly inside
// two and a half minutes of game time. At the shipping cycle speed this is a
// bake every few seconds, and it is skipped entirely when the clock is parked
// (the scrubbed-hour case every capture harness runs in).
const REBAKE_HOUR_DELTA = 0.04;

// Blur applied during the PMREM bake. The probe is a diffuse fill for matte
// props, not a reflection anybody reads detail in, so it is blurred hard: a
// sharp sun blob in a probe at envMapIntensity 1.15 puts a specular hotspot on
// a varnished gunwale that swims as the boat yaws.
const BAKE_SIGMA = 0.08;

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

// The dome, in four parts: the vertical gradient, the horizon wedge in the
// sun's azimuth, the aureole around the disc, and the bounce below the
// waterline. Authored in LINEAR — SKY_STATE colours are already working-space,
// and this output is irradiance, not a display-referred pixel.
const FRAG = /* glsl */`
varying vec3 vDir;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uSunHor;
uniform vec3  uGlow;
uniform float uGlowI;
uniform vec3  uSunDir;
uniform vec3  uGround;
uniform float uGroundMix;

void main() {
  vec3 d = normalize( vDir );

  // ── the vertical gradient ────────────────────────────────────────────────
  // Weighted low. A boat sits under a dome whose lower band subtends most of
  // the sky it can actually see, and that band is the horizon key; pushing the
  // knee up toward the zenith is what made the first pass read cool.
  float up = clamp( d.y, 0.0, 1.0 );
  vec3 sky = mix( uHorizon, uZenith, smoothstep( 0.0, 0.72, up ) );

  // ── the sunset wedge ─────────────────────────────────────────────────────
  // The sun's half of the sky is not the same colour as the other half, and at
  // the hours this probe was written for that difference IS the look. Gated on
  // azimuthal alignment with the sun and on being low in the dome, so it paints
  // the wedge Sky.js paints and does not tint the whole hemisphere.
  vec3  sunFlat = normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) );
  float az      = clamp( dot( normalize( vec3( d.x, 0.0, d.z ) ), sunFlat ), 0.0, 1.0 );
  float lowBand = 1.0 - smoothstep( 0.0, 0.45, up );
  sky = mix( sky, uSunHor, pow( az, 2.2 ) * lowBand * 0.85 );

  // ── the aureole ──────────────────────────────────────────────────────────
  // Added, not mixed: it is light around the disc, not a repaint of the sky
  // behind it. uGlowI peaks at 1.60 at 19:00, which is the whole reason a
  // sunset probe is brighter on the sun side than a noon one.
  float halo = pow( clamp( dot( d, normalize( uSunDir ) ), 0.0, 1.0 ), 6.0 );
  sky += uGlow * ( halo * uGlowI * 0.6 );

  // ── below the waterline ──────────────────────────────────────────────────
  // A boat's lower hemisphere is water, and water at sunset is a dim mirror of
  // the sky above it rather than the warm meadow bounce the hemisphere light's
  // ground key assumes. So the bounce is the sky's own colour, darkened, and
  // lerped toward the authored ground tint by uGroundMix for props that stand
  // on dirt instead.
  vec3 below = mix( sky * 0.34, uGround, uGroundMix );
  vec3 c = mix( below, sky, smoothstep( -0.06, 0.06, d.y ) );

  gl_FragColor = vec4( max( c, vec3( 0.0 ) ), 1.0 );
}
`;

export class SkyProbe {
  /**
   * @param renderer   the live WebGLRenderer
   * @param groundMix  0 = the lower hemisphere is dimmed sky (a boat on water),
   *                   1 = it is the authored ground tint (a prop on dirt).
   * @param onBake     called with the new texture after EVERY bake, including
   *                   the one in this constructor.
   *
   *   onBake is not a convenience. A PMREM bake returns a NEW render target and
   *   the old one is freed, so a material holding the previous texture is left
   *   pointing at a disposed target and renders as if it had no probe at all —
   *   which is exactly the silent failure this callback exists to make
   *   impossible. It cost an hour to find once already: a harness called
   *   update(true) directly, the materials were never re-pointed, and the boat
   *   went back to the black silhouette this whole probe was written to fix
   *   while every diagnostic still reported "probe: true". Re-point HERE, in
   *   the one place that knows a swap happened, and no caller can get it wrong.
   */
  constructor(renderer, { groundMix = 0.25, onBake = null } = {}) {
    this._onBake = onBake;
    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._uni = {
      uZenith:    { value: new THREE.Color(0.4, 0.55, 0.85) },
      uHorizon:   { value: new THREE.Color(1.0, 0.9, 0.78) },
      uSunHor:    { value: new THREE.Color(1.0, 0.8, 0.55) },
      uGlow:      { value: new THREE.Color(1.0, 0.81, 0.56) },
      uGlowI:     { value: 1.0 },
      uSunDir:    { value: new THREE.Vector3(0, 1, 0) },
      uGround:    { value: new THREE.Color(0.42, 0.30, 0.20) },
      uGroundMix: { value: groundMix },
    };
    this._geo = new THREE.SphereGeometry(10, 32, 24);
    this._mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, uniforms: this._uni, vertexShader: VERT, fragmentShader: FRAG,
    });
    this._scene = new THREE.Scene();
    this._scene.add(new THREE.Mesh(this._geo, this._mat));
    this._rt = null;
    this._lastHour = Number.NaN;
    this.update(true);
  }

  /** The current probe, or null before the first bake. */
  texture() { return this._rt?.texture ?? null; }

  /**
   * Re-bake if the clock has moved far enough. Returns true when a new texture
   * was produced, so a caller can re-point its materials at it.
   *
   * Cheap to call every frame — the common path is one subtraction.
   */
  update(force = false) {
    const s = SKY_STATE;
    if (!force && Math.abs(s.hour - this._lastHour) < REBAKE_HOUR_DELTA) return false;
    this._lastHour = s.hour;

    this._uni.uZenith.value.copy(s.zenith);
    this._uni.uHorizon.value.copy(s.horizon);
    this._uni.uSunHor.value.copy(s.sunHorizon);
    this._uni.uGlow.value.copy(s.glow);
    this._uni.uGlowI.value = s.glowIntensity;
    this._uni.uSunDir.value.copy(s.sunDir);

    const old = this._rt;
    this._rt = this._pmrem.fromScene(this._scene, BAKE_SIGMA);
    // Re-point BEFORE the old target is freed, so no consumer holds a disposed
    // texture even for an instant. See the onBake note in the constructor.
    this._onBake?.(this._rt.texture);
    old?.dispose();
    return true;
  }

  dispose() {
    this._rt?.dispose(); this._rt = null;
    this._pmrem?.dispose(); this._pmrem = null;
    this._geo?.dispose(); this._mat?.dispose();
    this._scene = null;
  }
}
