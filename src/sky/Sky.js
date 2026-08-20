// ─────────────────────────────────────────────────────────────────────────────
//  Sky — an art-directed gradient dome with a sun aureole, a starfield, a
//  Milky Way and a moon.
//
//  ── the post chain, which is the constraint everything here is shaped by ───
//  The dome writes *scene-linear* radiance. `renderer.toneMapping` is
//  NoToneMapping (Engine.js), so `toneMapped: true` on this material is a
//  no-op and nothing is compressed at the point of writing. The chain that
//  follows, in order, is: bloom (luminanceThreshold 0.80, on the linear scene
//  buffer, so that threshold is in the same units this file writes), then
//  exposure 0.88 and a Khronos PBR Neutral curve, then the grade.
//
//  The comment that used to sit here said "AgX, threshold 0.62, display
//  referred". All three were stale — PostFX moved to PBR Neutral and the bloom
//  now runs before the curve. The number that matters today is **0.80 linear**:
//  that is where this file's output starts to bloom.
//
//  The rule the old shader obeyed was "the gradient stays under ~0.85 linear
//  and only the aureole and the 0.6 deg disc go over 1.0", because an earlier
//  pass sat the whole sky at 1.5 and turned the upper frame into white paper.
//  That constraint is real and it is kept: the *base gradient* is still B's
//  keys and nothing here multiplies it up.
//
//  What changed is the aureole. Measured whole-frame, our twilight frames top
//  out at lumaP95 0.61 where `sunset.jpg` reaches 0.927 and `morning.jpg`
//  0.980 — the missing range is entirely at the top of the histogram, because
//  there is no blown highlight anywhere in any frame we have ever shipped. So
//  the aureole is now deliberately allowed over the bloom threshold, but as a
//  *broad exponential in angle* rather than as the old cliff: an amplitude
//  that is enormous within a few degrees of the disc, still substantial at 20,
//  and down to a few percent by 60. The old lobes were pow(cos, 14/110/1400),
//  which is a far tighter family than Mie scattering actually is — the 20 deg
//  lobe carried 0.055 of a unit-scale sky and could not read as a halo at any
//  exposure.
//
//  The aureole is also *whitened* as it approaches the disc. `morning.jpg` puts
//  #fefcf0 — chroma 0.055, essentially neutral — immediately around the sun and
//  only turns peach several degrees out, and whole-frame our chromaMean is 0.35
//  against its 0.18 with zero near-neutral pixels against its 7.4%. Pushing a
//  saturated orange glow harder would have made the standing "reads as
//  monochrome orange" complaint worse, not better.
//
//  ── the dome must be a pure direction field ───────────────────────────────
//  A sky is at infinity, so the dome must be a *direction field* and nothing
//  else. Dropping the translation column of the model-view (mat3(...)) does
//  exactly that: the dome is rigidly attached to the camera's orientation and
//  is completely unaffected by where the camera — or the mesh — happens to be.
//
//  The obvious alternative, parking the mesh at the camera every frame, is what
//  this used to do, and it is a trap. The dome's radius is 1 m, so a positional
//  mismatch of Δ metres tilts the whole sky by about Δ radians: 0.3 m of drift
//  is 17° of sky. And a mismatch is guaranteed, because CameraRig writes the
//  camera pose in *lateUpdate*, after every system has already run — so the
//  mesh was always parked at the previous frame's position, plus the camera-
//  shake offset, which is why the sky swung about whenever the player drove or
//  dragged the mouse. Measured at 22 m/s: one frame of travel displaced the sky
//  ~2400x more than that frame's true parallax.
//
//  This is also why the starfield below can be a static function of `dir` and
//  still be correct: `dir` is world-oriented, so stars are nailed to the world
//  and cannot crawl.
//
//  All colours come from the shared time-of-day record in Lighting.js.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { PALETTE } from '../world/WorldConfig.js';
import { SKY_STATE } from '../render/Lighting.js';
import { STAR_GLSL } from './starfield.js';
import { MOON_GLSL } from './moon.js';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = vec4(mat3(modelViewMatrix) * position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;   // always at the far plane
}`;

const FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;

uniform vec3  uSunDir;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uSunHorizon;   // horizon colour in the sun's azimuth
uniform vec3  uGround;       // value multiplier applied below the skyline
uniform vec3  uGlow;
uniform vec3  uSunColor;
uniform float uGlowIntensity;
uniform float uDiscIntensity;
uniform float uAureoleGate;  // keeps the glow alive under the horizon, then off
uniform float uLowSun;       // 1 at/under the horizon, 0 with the sun overhead
uniform float uSunUnder;     // 1 once the sun is below the skyline
uniform float uNightF;       // SKY_STATE.nightFactor
uniform float uTime;

// Night colour fallback — see the block in Sky.js's update().
uniform vec3  uNightZenith;
uniform vec3  uNightHorizon;
uniform float uNightKeyMix;

uniform float uStarAmount;
uniform float uMilkyWay;

uniform vec3  uMoonDir;
uniform vec3  uMoonColor;
uniform float uMoonPhase;
uniform float uMoonDiscI;
uniform float uMoonHaloI;

${STAR_GLSL}
${MOON_GLSL}

float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  float up = clamp(h, 0.0, 1.0);
  float pxAng = length(fwidth(dir));

  // ── base gradient ────────────────────────────────────────────────────────
  // Cream hugs the skyline, blue is well established by ~15°. The canonical
  // camera views only ever see up to about 15° of sky, so the whole daylight
  // gradient has to happen inside that band or the frame reads as one flat
  // cream wash.
  //
  // Night is the opposite picture and needs the opposite curve. Both reference
  // night plates run luma 0.050 at the zenith to 0.056 at the skyline: a gentle
  // *rise* of about 12% across the whole dome, not a ramp. At exponent 3.4 that
  // shape is impossible — 3.4 spends the entire transition in the bottom 20° —
  // so the exponent is a function of how night it is, and lands near 1 (linear
  // in cos of the zenith angle) at full night.
  vec3 zen = mix(uZenith,  uNightZenith,  uNightKeyMix);
  vec3 hor = mix(uHorizon, uNightHorizon, uNightKeyMix);

  float gexp = mix(3.4, 1.05, uNightF);
  vec3 col = mix(zen, hor, pow(1.0 - up, gexp));
  // The extra hug of horizon colour in the last few degrees is a daylight haze
  // term. At night there is no haze band to speak of and it only reintroduces
  // the ramp the plates do not have, so it fades out with the exponent.
  col = mix(col, hor, pow(1.0 - up, 11.0) * mix(0.45, 0.06, uNightF));
  // Below the skyline: keep the *same* hue and only lose value. A separate
  // ground colour here reads as a flat fake sea in any view that sees past
  // the last ridge, which is most vista shots. At night the plates keep full
  // value separation right down to the terrain, so the drop is gentler.
  col = mix(col, col * uGround, smoothstep(0.01, -0.30, h) * mix(1.0, 0.45, uNightF));

  // Keep the gradient as it is *before* anything the sun does to it. The star
  // guard below is a ratio against this, which is what makes it survive the
  // frame's absolute level moving under it.
  float baseLuma = dot(col, vec3(0.2126, 0.7152, 0.0722));

  float cosT = dot(dir, uSunDir);
  float ang  = acos(clamp(cosT, -1.0, 1.0));
  float c    = max(cosT, 0.0);

  // ── the warm wedge ───────────────────────────────────────────────────────
  // Haze scatters sunlight sideways, so the sky *toward* the sun and near the
  // horizon runs warm. Driven off cosT rather than azimuth so it follows the
  // sun up and down without a second set of numbers.
  //
  // sunset.jpg measures chroma 0.564 at the skyline falling to 0.400 at the
  // zenith — the wedge is where the frame's colour lives, and the old 0.76 cap
  // was leaving a third of the horizon colour on the table. It is also the one
  // place saturation is *wanted*: the complaint is a monochrome orange frame,
  // and the fix for that is a neutral core with a saturated skirt, not a
  // desaturated everything.
  float wedge = pow(c, 2.6) * pow(1.0 - up, 3.2);
  col = mix(col, uSunHorizon, clamp(wedge * 0.86, 0.0, 0.92));

  // ── aureole ──────────────────────────────────────────────────────────────
  // Four exponential lobes in *angle*. Exponentials in angle, not powers of
  // cos: pow(cos, n) is a far narrower family than aerosol forward-scattering
  // actually is, and it is why every previous attempt at a wide halo had to be
  // set so low it vanished.
  //
  //   1/1.55  ≈ 37°   the halo. Low amplitude, and the only lobe wide enough
  //                   to be seen as a halo rather than as a hotspot.
  //   1/5.6   ≈ 10°   the bright inner glow.
  //   1/34    ≈ 1.7°  the flare that hugs the disc.
  //   1/230   ≈ 0.25° the ring immediately around the limb.
  //
  // The two wide lobes scale with uLowSun: the aureole is a long-path effect,
  // so it belongs to the golden hours and should not blow the sky out at noon.
  // The two tight ones do not, so the sun is always a sun.
  float l1 = exp(-ang * 1.55);
  float l2 = exp(-ang * 5.60);
  float l3 = exp(-ang * 34.0);
  float l4 = exp(-ang * 230.0);

  float broad = l1 * (0.18 + 0.62 * uLowSun) + l2 * (0.45 + 1.20 * uLowSun);
  float core  = l3 * 3.60 + l4 * 9.00;

  // Once the sun is under the horizon its aureole stops being a circular halo.
  // The light now arrives over the skyline, so the glow flattens into a band
  // along it and the upper sky keeps its own colour. Without this term the
  // below-horizon lobes lift the WHOLE upper sky: measured on sunvista-h19,
  // every visible direction sat over 1.4 linear and the frame came back as one
  // flat white wash with no value structure in it at all — which is precisely
  // what sunset.jpg is not. sunset.jpg is an orange sky with a white-hot core
  // over the mesas, and the core is only a few degrees tall.
  // The exponent is the lever between the two sun-facing framings. At 1.6 the
  // 37 deg lobe still covered enough of dome's 62 deg pitched-up framing to
  // take it to lumaP95 0.992 while sunvista, which is horizon-level, measured
  // 0.912 at the same hour through the same chain. At 2.2 the near-horizon glow
  // that sunvista is built on loses 5% and the sky 45 deg up loses 56%, which
  // is exactly the trade that was wanted.
  broad *= mix(1.0, 0.55 * pow(1.0 - up, 2.2), uSunUnder);

  // Whitened toward the core. See the header: the plate is neutral white
  // around the disc and only peach several degrees out.
  vec3 warmCol = uGlow;
  vec3 coreCol = mix(uGlow, vec3(1.0), 0.80);
  float gi = uGlowIntensity * uAureoleGate;
  col += (warmCol * broad + coreCol * core) * gi;

  // ── sun disc ─────────────────────────────────────────────────────────────
  // ~0.55° across with a pixel-aware limb, so it neither aliases at 4K nor
  // disappears at 720p.
  float dR = 0.0048;
  float dW = max(pxAng, 0.0006);
  float disc = 1.0 - smoothstep(dR - dW, dR + dW, ang);
  col += mix(uSunColor, vec3(1.0), 0.55) * disc * uDiscIntensity;

  // ── night: stars, the Milky Way and the moon ─────────────────────────────
  //
  // The gate is NOT 1 - dayFactor. That reaches full strength the instant the
  // sun touches the horizon, which put 435 stars/Mpx over the salmon sky of
  // sunvista-h19. It is SKY_STATE.starAmount, shaped, times a guard on the
  // dome's own brightness:
  //
  //  * the cube of starAmount. When this was written B's ramp was linear in sun
  //    elevation and handed the dome 0.41 at 19:48, with the sun 5° down — civil
  //    twilight, when the naked eye has Venus and nothing else. Cubing keeps
  //    both of B's anchors exactly (0 and 1 are fixed points of x³) and moves
  //    the knee out to where the sky is actually dark: a shaping of B's curve,
  //    not a replacement of it. B has since rebuilt all three night ramps on
  //    hours-since-sunset and now publishes 0.00 at 19:00 and 0.12 at 19:48 —
  //    and their keyframe table is written knowing this cube is here, so the
  //    two agree at both ends. Do not remove one without the other.
  //  * a directional guard, below, for the thing a single scalar structurally
  //    cannot know: at sunset the sky is dark overhead and blown ten degrees
  //    off the sun, and starAmount is one number for the whole dome.
  // The guard is a RATIO, not a pair of absolute thresholds, and that is the
  // whole point of it. It asks "how much brighter is this direction than the
  // dome's own base gradient, because of the sun" — so it reads the same at any
  // exposure. The first version of this compared skyLuma against constants
  // 0.34 and 0.15, and it would have started deleting stars from a correctly
  // dark sky the moment the night level moved, which it did, twice, in one
  // afternoon while three other authors worked on it.
  //
  // The division of labour with B is clean: B's starAmount ramp knows *when*
  // it is dark, this knows *which directions* are, and a single scalar for the
  // whole dome structurally cannot know the second — at sunset the sky is dark
  // overhead and blown ten degrees off the sun.
  float litLuma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float sunLift = litLuma / max(baseLuma, 1e-5);
  // The second factor is a backstop, not the mechanism: it only engages over a
  // genuinely blown sky, an order of magnitude above any plausible night.
  float darkGuard = (1.0 - smoothstep(1.25, 2.40, sunLift))
                  * (1.0 - smoothstep(0.55, 1.20, litLuma));
  float starVis = uStarAmount * uStarAmount * uStarAmount * darkGuard;
  float mwVis   = uMilkyWay * uMilkyWay * darkGuard;

  if (starVis > 0.002) {
    // Extinction toward the skyline: real, and it also keeps the field from
    // fighting the terrain silhouette. Deliberately shallow — the plates have
    // stars a long way down.
    float ext = smoothstep(-0.02, 0.20, h);
    vec2 mw = skMilkyWay(dir);
    // The band is unresolved starlight, so it is very slightly warm-neutral
    // rather than the blue-white of the resolved stars.
    //
    // 0.058, up from 0.034. The band's *resolved* half went up far harder at
    // the same time — SK_FILL_MW now saturates through the spine — so this is
    // no longer carrying the band on its own the way it was. Raising it past
    // about 0.07 with that many stars in the band turns it back into fog: the
    // haze fills the gaps between the points and the granularity that makes it
    // read as a star cloud goes with it.
    col += vec3(0.86, 0.83, 0.95) * mw.x * mwVis * 0.058 * ext;
    col += skStars(dir, uTime, mw.y * mwVis) * starVis * ext;
  }

  if (uMoonDiscI > 0.0001 || uMoonHaloI > 0.0001) {
    col += mnMoon(dir, uMoonDir, uSunDir, uMoonPhase, uMoonColor,
                  pxAng, uMoonDiscI, uMoonHaloI);
  }

  // Dithering kills banding across a very smooth 4000-pixel-wide gradient.
  float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(max(col + dither, 0.0), 1.0);
}`;

// ── the night key fallback — STOOD DOWN, and left here as a record ──────────
//
// This existed for exactly one round. At the start of it the night keys in
// Lighting.js were navy — zen 0x0d1226, linear 1 : 1.42 : 4.7, luma 0.006 —
// while both reference plates measure a desaturated violet at 1 : 0.72 : 1.60
// and luma 0.050, i.e. red *above* green and eight times the value. Since
// re-authoring those keys is Author B's job and not this file's, the dome
// lerped toward its own target, scaled by nightFactor.
//
// The lerp deliberately targeted an absolute colour rather than applying a
// multiplier or a hue rotation, so that it would be **self-cancelling**: once
// B published violet keys, mix(published, target, m) would have published ≈
// target and the override would stop doing anything. B has now landed
// 0x6e5a80 / 0x6c5f8e, which is that colour, so the mechanism has done its job
// and the constants below are set to B's own values — the mix is a no-op in
// both directions and the dome reads the contract straight through.
//
// It is left in place, at zero, rather than deleted, because the *shape* of
// the night gradient below still depends on nightFactor and someone will
// eventually want this switch back. Set NIGHT_KEY_OVERRIDE to 1 to re-arm it.
//
// The one thing this must never become is a level control. Measured through
// the current chain, B's 0x6e5a80 renders at display luma 0.45 against the
// plates' 0.050 — a factor of nine — and it is *very* tempting to fix that
// here, in one line, since the dome is the only thing in the frame at night.
// That is the trap the lead named: the frame's absolute level is one global
// thing and it belongs to Author C. Darkening the dome to hit a luma target
// would hide a chain calibration error inside a sky shader, where the next
// author to touch exposure would have no way to find it. The number is in the
// report and in the requests section instead.
const NIGHT_ZENITH  = 0x6e5a80;
const NIGHT_HORIZON = 0x6c5f8e;
const NIGHT_KEY_OVERRIDE = 0.0;

// Moon radiance. The disc has to be the brightest thing in the frame and the
// halo has to clear the 0.80 linear bloom threshold for the first couple of
// disc radii and then fall under it — that shape is what makes a bloom read as
// a halo rather than as a fogged lens.
const MOON_DISC = 1.9;
const MOON_HALO = 0.42;

export class Sky {
  constructor(scene) {
    this.uniforms = {
      uSunDir:        { value: new THREE.Vector3(0.4, 0.35, 0.85).normalize() },
      uZenith:        { value: PALETTE.skyZenith.clone() },
      uHorizon:       { value: PALETTE.skyHorizon.clone() },
      uSunHorizon:    { value: PALETTE.skyHorizon.clone() },
      uGround:        { value: new THREE.Vector3(0.86, 0.87, 0.92) },
      uGlow:          { value: PALETTE.sunDisc.clone() },
      uSunColor:      { value: PALETTE.sunDisc.clone() },
      uGlowIntensity: { value: 1.0 },
      uDiscIntensity: { value: 9.0 },
      uAureoleGate:   { value: 1.0 },
      uLowSun:        { value: 0.0 },
      uSunUnder:      { value: 0.0 },
      uNightF:        { value: 0.0 },
      uTime:          { value: 0 },

      uNightZenith:   { value: new THREE.Color(NIGHT_ZENITH) },
      uNightHorizon:  { value: new THREE.Color(NIGHT_HORIZON) },
      uNightKeyMix:   { value: 0.0 },

      uStarAmount:    { value: 0.0 },
      uMilkyWay:      { value: 0.0 },

      uMoonDir:       { value: new THREE.Vector3(0, -1, 0) },
      uMoonColor:     { value: new THREE.Color(0.82, 0.86, 1.0) },
      uMoonPhase:     { value: 0.32 },
      uMoonDiscI:     { value: 0.0 },
      uMoonHaloI:     { value: 0.0 },
    };

    const geo = new THREE.SphereGeometry(1, 64, 40);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'Sky';
    scene.add(this.mesh);
    this.scene = scene;
  }

  update(dt, elapsed, camera, sunDir) {
    const u = this.uniforms;
    const s = SKY_STATE;
    const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
    const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

    u.uTime.value = elapsed;
    u.uSunDir.value.copy(sunDir ?? s.sunDir);

    u.uZenith.value.copy(s.zenith);
    u.uHorizon.value.copy(s.horizon);
    u.uSunHorizon.value.copy(s.sunHorizon);
    u.uGlow.value.copy(s.glow);
    u.uSunColor.value.copy(s.glow);
    u.uGlowIntensity.value = s.glowIntensity;
    u.uNightF.value = s.nightFactor;
    u.uNightKeyMix.value = s.nightFactor * NIGHT_KEY_OVERRIDE;

    // Below the horizon the *disc* has to go, or the dome lights up from under
    // the terrain on any downhill view that sees past the last ridge. But it
    // used to go at (elev + 0.01)/0.03, which is 1.7° of arc — the sun did not
    // set, it switched off. Widened to about 4° so it sinks.
    const above = smooth(-0.052, 0.006, s.sunElev);
    // Extinction. The old curve kept 30% of the disc at the horizon, and a
    // setting sun is exactly the hour the brief calls the headline. A real low
    // sun does lose intensity — but it loses it to *scattering*, which is the
    // aureole below, not to nothing. So the disc keeps 60% and the light it
    // loses is handed to the halo.
    const ext = 0.60 + 0.40 * clamp01(s.sunElev / 0.30);
    u.uDiscIntensity.value = above * ext * 14.0;

    // The aureole outlives the disc: the glow over the ridge after the sun has
    // gone is the whole of `sunset.jpg`, which has no disc in it at all.
    u.uAureoleGate.value = smooth(-0.225, -0.035, s.sunElev);
    u.uLowSun.value = 1 - smooth(0.05, 0.45, s.sunElev);
    u.uSunUnder.value = 1 - smooth(-0.02, 0.06, s.sunElev);

    u.uStarAmount.value = s.starAmount;
    u.uMilkyWay.value = s.milkyWay;

    u.uMoonDir.value.copy(s.moonDir);
    u.uMoonColor.value.copy(s.moonColor);
    u.uMoonPhase.value = s.moonPhase;
    u.uMoonDiscI.value = s.moonIntensity * MOON_DISC;
    // The halo is scattered moonlight, so it belongs to a dark sky: at h19,
    // with the moon already 30° up over a salmon twilight, a full-strength halo
    // reads as a lens artefact. It fades in with the same curve the stars use.
    const moonSky = s.starAmount * s.starAmount;
    u.uMoonHaloI.value = s.moonIntensity * MOON_HALO * (0.18 + 0.82 * moonSky);

    // Cosmetic only — the dome's *image* no longer depends on this (see VERT),
    // but keeping the mesh near the camera stops it being an outlier in any
    // bounds or sorting pass that walks the scene.
    this.mesh.position.copy(camera.position);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.scene.remove(this.mesh);
  }
}
