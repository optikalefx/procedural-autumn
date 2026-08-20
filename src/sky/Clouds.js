// ─────────────────────────────────────────────────────────────────────────────
//  Clouds — a parallax-sliced cumulus deck over the sky dome, plus a cirrus veil.
//
//  WHY THIS IS NOT A RAYMARCH ANY MORE
//  -----------------------------------
//  The previous pass marched a density slab. A march needs a per-pixel jitter or
//  it bands, and a jitter needs a temporal filter or it stipples. There is no
//  TAA and no blur in this project's post chain — the grade and the bloom belong
//  to another author and neither of them cleans up noise. So every cloud in the
//  game carried a woven cross-hatch, and at the grazing angles the canonical
//  cameras actually use (they never look higher than ~30°) a 26 km slab traverse
//  tore that hatch into horizontal ribbons. That is unfixable inside a march
//  without a filter to hide the sampling.
//
//  So the deck is now a *heightfield*, evaluated analytically:
//
//    · one smooth field  H(uv)  gives the cloud-top altitude over the deck base
//    · the ray is sampled at a handful of FIXED altitudes between base and top,
//      each offset by the true horizontal parallax of the view ray
//    · every sample position varies smoothly across the screen, so there is no
//      per-pixel noise anywhere — the only edges are the silhouette edges, and
//      those are antialiased analytically with fwidth
//
//  The parallax is what keeps this from being a painted backdrop: the crown
//  slices sit further from the camera than the base slices, so a cloud shows its
//  flat lit base on the near side and its billowing crown on the far side, and
//  the silhouette genuinely changes as you drive under it. The parallax is
//  *clamped*, though — an unclamped one smears the deck into ribbons at the
//  horizon, which is the ribbon artifact we started with.
//
//  It also happens to be the right look. The reference plates have no crisply
//  modelled cumulus in them at all: they have broad flat masses of colour with
//  soft edges, which is exactly what a shaded heightfield gives and exactly what
//  a volumetric march fights against.
//
//  Everything is driven from one tiling 4-channel noise tile:
//      R  low-frequency coverage      (also seeds the ground-shadow map)
//      G  mid-frequency billow
//      B  high-frequency fray
//      A  stretched cirrus
//  Deriving the ground shadow from the *same* R field is what makes the shadow
//  on the meadow line up with the cloud you can see overhead — though it goes
//  out through its own pre-thresholded copy, for the reason in
//  buildShadowTexture.
//
//  Ordering note: the dome is `transparent: false` with CustomBlending, which
//  keeps it in three's opaque queue (so renderOrder actually applies and the
//  terrain draws over it) while still alpha-blending onto the sky.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { SEED } from '../world/WorldConfig.js';
import { mulberry32 } from '../core/MathUtils.js';
import { SKY_STATE } from '../render/Lighting.js';

// Cloud deck geometry, in metres. The valley tops out at ~340 m.
//
// The numbers are chosen from the angular size they produce, not from
// meteorology. The canonical cameras see roughly 0…30° of sky. A cell of the
// coverage field is about TILE/3 across; at 20° elevation the deck base is
// ~2.9 km away, so that cell subtends ~27° — three or four cloud masses across
// a 52° frame, which is the composition the reference plates use. Push TILE up
// and one cloud fills the sky; push it down and the deck turns to popcorn.
const BASE = 1500;
const TOP = 2700;
const TILE = 7000;          // world size of one wrap of the noise tile
const CIRRUS_ALT = 6200;
const CIRRUS_TILE = 30000;

// Coverage threshold, as `lo = COVER_BIAS - COVER_SLOPE * cover`, and the
// vertical ramp above it. Both live here in JS rather than as GLSL literals
// because the ground-shadow map has to be baked against exactly the same
// numbers — see buildShadowTexture. The long explanation of why the bias is
// 0.950 is on the `lo` line in the shader.
const COVER_BIAS = 0.950;
const COVER_SLOPE = 0.44;
const RAMP = 0.100;
// The keyframe coverage at the shipping hour, which is what the ground shadow
// is baked for. Lighting's table runs 0.20 at midday to 0.30 at dawn.
const SHADOW_COVER = 0.215;

// Orientation only — see the long note on the same line in Sky.js. The deck's
// parallax has to come from uCamPos and the view ray, never from where this
// 1 m sphere happens to be sitting relative to the eye.
const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = vec4(mat3(modelViewMatrix) * position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;
}`;

const FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;

uniform sampler2D uNoise;
uniform vec3  uCamPos;
// The KEY light, not the sun: the sun by day, the moon once the sky is dark
// enough for it to be the only thing lighting anything. See _key in update().
uniform vec3  uLightDir;
uniform vec2  uKeyAz;       // horizontal unit toward the key light
uniform vec3  uLit;         // lit body — desaturated and lifted in JS
uniform vec3  uDark;        // self-shadowed core
uniform vec3  uAmbient;     // sky bounce into the shadow side
uniform vec3  uRim;         // the hot limb / silver-lining colour
uniform vec3  uHorizon;     // what a cloud fades into at the skyline
uniform vec3  uHorizonSun;  // ...and what it fades into toward the key light
uniform vec2  uWind;
uniform vec2  uWind2;       // detail drift — sheared against uWind, see update()
uniform vec2  uCirrusWind;
uniform float uCover;       // 0..1, from the time-of-day table
uniform float uInvTile;
uniform float uCirrus;      // cirrus opacity
uniform float uOpacity;     // global fade
uniform float uSoft;        // extra silhouette softness
uniform float uLowSun;      // 1 when the key is at or under the horizon
uniform float uBelow;       // 1 when the key is UNDER the deck base
uniform float uRimAmt;      // strength of the directional lighting event
uniform float uSilver;      // silver-lining gain

const float BASE_Y = ${BASE.toFixed(1)};
const float THICK  = ${(TOP - BASE).toFixed(1)};
// Vertical span, in field units, over which a cloud goes from nothing to its
// full height. Narrow = cliff-edged cartoon cloud, wide = mush.
//
// Narrowed along with the threshold below. The coverage field only has ~0.14 of
// headroom above the new threshold, and a ramp wider than that headroom means
// no column ever reaches full height: every cloud comes out a flat wisp with no
// crown for the parallax slices or the normal to shade.
const float RAMP   = ${RAMP.toFixed(3)};

// The coarse coverage field — the only thing sampled per slice, and therefore
// the only thing whose feature size has to stay above the slice spacing. Its
// finest octave is 8 cycles across the tile, i.e. 700 m, against a worst-case
// slice spacing of ~385 m. Break that inequality and the deck stratifies into
// horizontal mackerel rows, which is exactly what the old march did.
float coarse(vec2 uv) {
  return texture2D(uNoise, uv).r;
}

// Cloud-top altitude at uv, as a fraction of the deck thickness. 0 = no cloud.
// det is the fine detail, sampled ONCE per pixel and added to every slice
// alike: a constant offset along the ray cannot stratify the deck, but it still
// varies across the screen, so the silhouette gets its fray back for free.
float topRaw(vec2 uv, float lo, float det) {
  return (coarse(uv) + det - lo) / RAMP;
}
float topAt(vec2 uv, float lo, float det) {
  return clamp(topRaw(uv, lo, det), 0.0, 1.0);
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}

void main() {
  vec3 d = normalize(vDir);
  // Never branch on d.y before the derivatives below — a discard here poisons
  // fwidth for the whole 2x2 quad and puts a dotted line along the skyline.
  float dy = max(d.y, 0.012);

  // Where the view ray crosses the cloud base, and the uv there. Capped: an
  // uncapped 1/dy at the skyline blows the uv derivative up past anything a
  // 512² tile can represent, which is where the venetian-blind moire came from.
  float tBase = min((BASE_Y - uCamPos.y) / dy, 46000.0);
  vec2 uv0 = (uCamPos.xz + d.xz * tBase) * uInvTile + uWind;

  // Horizontal uv travel of the view ray across the full deck thickness. This
  // is the parallax that gives the deck its volume: the crown slices land
  // further from the camera than the base slices, so a cloud shows its flat
  // base on the near side and its billowing crown on the far side.
  //
  // It has to be clamped. The true value at 5° of elevation is two whole tiles,
  // which spreads the slices further apart than the cloud features themselves
  // and stratifies the deck into the horizontal ribbons this shader exists to
  // get rid of. The clamp is set to just under one slice-spacing per feature:
  // past it the deck stops gaining apparent height and flattens toward the
  // skyline, which is what distant cumulus do anyway.
  //
  // Tightened from 0.75 with the coverage cut. 0.75 of a tile is six widths of
  // the coarsest coverage feature, so the eight slices under a low-elevation
  // pixel were six near-independent draws on the coverage field, and their
  // *union* is what the eye reads as sky cover — which is why the deck looked
  // overcast at only half areal coverage. At 0.40 the slices stay inside about
  // three feature widths and a gap in the field survives as a gap in the sky.
  vec2 par = d.xz / dy * (THICK * uInvTile);
  float pl = length(par);
  // Tightened again, from 0.40. Even at 0.40 the eight slices under a
  // 25-degree pixel sample the coverage field over 2800 m — wider than one
  // feature — and the deck draws its own contour map: concentric wood-grain
  // rings through every large mass, plainest at 19:00 where the belly lighting
  // varies most from slice to slice. 0.30 keeps the slices inside about two
  // feature widths. The deck loses a little apparent depth at low elevation and
  // gains a clean surface, which is the right trade for a look whose reference
  // plates are broad flat masses with soft edges in the first place.
  par *= min(pl, 0.30) / max(pl, 1e-4);

  // Coverage threshold. Higher cover = lower threshold = more sky filled.
  //
  // WHY THIS NUMBER IS NOT 0.745
  // ----------------------------
  // 0.745 was picked as if the coverage field were uniform on 0..1 with a mean
  // of 0.5. It is not: normalize01() stretches an fbm min-to-max, and this
  // field's mean comes out at 0.635. So the shipping-hour threshold of 0.650
  // landed within 0.015 of the field's own median and put HALF the deck area
  // under cloud — measured, 50.7% areal at cover 0.215.
  //
  // Areal is not what the player sees, either. Every ray crosses the deck at a
  // grazing angle, so a low-elevation pixel is the union of eight slices spread
  // over several feature widths, and a 50% areal deck reads as an overcast one:
  // measured, 84-99% of visible sky was cloud in the eye-level and hero views,
  // which is exactly the "the sky is like 90% clouds" the player reported.
  //
  // The reference plates are the opposite — open gradient with, at most, a few
  // soft high wisps — and an overcast deck also flattens the light this whole
  // palette is built on. So the threshold is now set from the field's measured
  // distribution rather than an assumed one: 0.86 at the shipping hour is the
  // top ~17% of the field by area, which lands the visible sky around a third
  // cloud. tools/_scratch/cloudfrac.mjs is the measurement.
  float lo = ${COVER_BIAS.toFixed(3)} - ${COVER_SLOPE.toFixed(3)} * uCover;

  // Fine detail: two taps, once, at the middle of the slab. See topAt().
  //
  // The detail taps ride uWind2, not uWind. One tiling field translated at one
  // constant velocity is a scrolling texture and reads as one — the eye locks
  // onto a shape and watches it slide across the frame without ever changing.
  // Shearing the fray against the mass at a different speed and heading is what
  // real cloud does (the layers are at different altitudes and different winds)
  // and it is what makes the deck *evolve* as it drifts. It costs nothing: the
  // coarse coverage field still moves on uWind exactly, which it has to,
  // because Atmosphere's ground-shadow map is scrolled by the same vector.
  vec2  uvM = uv0 + par * 0.5;
  vec2  uvD = uvM + uWind2;
  // Kept well under RAMP: detail this field can outweigh the coarse coverage
  // turns organised cloud masses into an even mottle, which is the other way
  // for a sky to look broken.
  // Scaled down with RAMP, so the detail keeps the same weight against the
  // coarse coverage it perturbs and does not start deciding where clouds are.
  float det = (texture2D(uNoise, uvD * 1.5 + vec2(0.31, -0.17)).g - 0.5) * 0.084
            + (texture2D(uNoise, uvD * 2.6 + vec2(-0.23, 0.41)).b - 0.5) * 0.036;

  // Column height at the middle of the slab: the one value that drives the
  // lighting, so shading costs a few extra taps for the whole pixel rather
  // than a few per slice.
  float ht  = topAt(uvM, lo, det);

  // Analytic antialiasing. fwidth of the height field is exactly the pixel
  // footprint in the units the silhouette threshold uses, so the same number
  // both antialiases nearby cloud edges and melts distant ones into a wash
  // instead of letting them alias.
  // The floor is one slice spacing, not a constant.
  //
  // Each slice crosses its own coverage threshold at f, so with a softness
  // narrower than the gap between slices those crossings never overlap and the
  // deck draws its own contour lines: a set of concentric onion rings around
  // every mass, plainest at 19:00 where the belly lighting varies most from
  // slice to slice. 0.085 against a spacing of 0.143 at eight slices was well
  // inside that failure. Tying it to SLICES also fixes it on the low tiers,
  // where four slices are 0.333 apart and uSoft was a hand-tuned guess at the
  // same quantity.
  float sw = max(fwidth(ht) * 1.4, 1.15 / float(SLICES - 1) + uSoft);

  // ── shading ──────────────────────────────────────────────────────────────
  // The deck is a heightfield, so it has a real normal, and at golden hour the
  // normal is what matters: a 6° sun lights the *flanks* of a cumulus, not its
  // crown. Shading on altitude alone (which is what the first version of this
  // did) leaves every cloud the colour of its own underside — a violet-grey
  // sheet — no matter where the sun is.
  // Differences on the UNCLAMPED height. Clamping first flattens the interior
  // of every cloud to a plateau with a dead-vertical normal, and a plateau lit
  // by a 9° sun comes out the colour of its own shadow — the whole deck went
  // violet-grey at exactly the hour it should be glowing.
  const float EPS = 0.055;
  float raw = topRaw(uvM, lo, det);
  float hx = topRaw(uvM + vec2(EPS, 0.0), lo, det) - raw;
  float hz = topRaw(uvM + vec2(0.0, EPS), lo, det) - raw;
  // dz/dx in world units: a height fraction over a uv distance.
  float k = THICK / (EPS / uInvTile);
  vec3 nrm = normalize(vec3(-hx * k, 1.0, -hz * k));
  // A wide terminator, to sit with the global stylised diffuse the rest of the
  // game uses. A hard lambert here reads as a plastic ball, and at a 9° sun it
  // also leaves nine tenths of the deck unlit.
  //
  // Narrowed from (-0.85, 0.55). That window is 1.40 wide, and dot(nrm, L) at
  // a low sun only travels about ±0.6 across a cloud flank, so the whole deck
  // used to land inside the middle third of the ramp: every column came out
  // within a few percent of the same value and the mass had no lighting in it
  // at all. 1.30 is still soft but it spends the flank on a live part of the
  // curve.
  float lam = smoothstep(-0.60, 0.70, dot(nrm, uLightDir));

  // One step toward the key light, in uv. Used twice, and the second use is
  // the whole point of this round.
  vec2 sunStep = uLightDir.xz / max(abs(uLightDir.y), 0.20) * (THICK * uInvTile);
  float pls = length(sunStep);
  sunStep *= min(pls, 0.60) / max(pls, 1e-4);
  float hs = topAt(uvM + sunStep * 0.7, lo, det);

  // Self-shadow: is the column one step toward the light taller than this one?
  // That single comparison is what puts a cloud in the shadow of its
  // neighbour, and unlike an optical-depth march it cannot stipple.
  float shadow = clamp((hs - ht) * 1.7, 0.0, 1.0);

  // ── THE LIT LIMB, WHICH IS THE SAME COMPARISON READ THE OTHER WAY ─────────
  // hs - ht positive means the neighbour toward the light is taller, i.e. we
  // are in its shadow. Negative means *we* are the taller one, i.e. this is the
  // shoulder of the mass that faces the light — its limb. The old shader threw
  // that half away with a clamp at zero and then wondered why a cloud at golden
  // hour had no bright edge: the term that finds the edge was already being
  // computed and discarded.
  //
  // It dies in the interior of a mass (ht ≈ hs, a plateau), dies on the far
  // side (shadow), and peaks in a band one sun-step wide along the sunward
  // margin — about 840 m against a 700–2300 m cloud feature, which is the
  // proportion the reference plates put their rim at.
  float limb = clamp((ht - hs) * 2.1, 0.0, 1.0);

  // Forward scatter: the silver lining looking toward the light. Two lobes —
  // a tight one for the rim right on the disc and a broad one for the general
  // brightening of the whole sun-side of the sky. One lobe at g=0.74 was a 25°
  // spot; at a sun that is *under* the horizon at 19:00 that spot lands below
  // the skyline where the deck is already faded out, which is why no capture in
  // 44 rounds has ever contained a silver lining.
  float ph = dot(d, uLightDir);
  float silver = clamp(hg(ph, 0.76) * 0.030 + hg(ph, 0.42) * 0.055, 0.0, 1.4)
               * (1.0 - ht * 0.72) * uSilver;

  // Where the saturated colour is allowed to live: toward the light, and low.
  //
  // This is the standing warning made into a number. sunset.jpg measures
  // chroma 0.564 at the horizon band and 0.400 at the zenith; a cloud layer
  // that tints the whole upper sky is the bug the cloudAmbient note in
  // Lighting.js describes. So the rim colour — the only saturated thing this
  // shader has — is weighted down to a quarter strength by 30° of elevation and
  // to a third away from the light's azimuth. The body colour is near-neutral
  // and carries no such term because it does not need one.
  vec2  dxz  = d.xz / max(length(d.xz), 1e-4);
  float azw  = max(dot(dxz, uKeyAz), 0.0);
  float warm = (0.30 + 0.70 * pow(azw, 1.4))
             * (0.34 + 0.66 * (1.0 - smoothstep(0.05, 0.50, d.y)));

  vec3  acc = vec3(0.0);
  float alpha = 0.0;
  float trans = 1.0;

  // Front to back: slice 0 is the deck base, which is the nearest point on the
  // ray, so it occludes the crown behind it.
  for (int i = 0; i < SLICES; i++) {
    float f = float(i) / float(SLICES - 1);
    float h = topAt(uv0 + par * f, lo, det);
    float inside = smoothstep(f - sw, f + sw, h);
    if (inside <= 0.002) continue;

    // Altitude only *biases* the lit fraction — the normal decides it — but
    // WHICH END of the column the bias favours is not a constant. With the sun
    // overhead the crown is lit and the base is the shadow. With the sun under
    // the deck base, which is the entire 18:00–20:00 window this round is
    // about, the light arrives from below and the *belly* is the brightest part
    // of the cloud. sunset.jpg is built on that: the undersides are the
    // brightest thing in the frame. The old fixed (0.50 + 0.50 * f) drew a
    // sunset cloud lit from the top, which is the single most obviously wrong
    // thing a sunset sky can do.
    // The two swings are deliberately smaller than they want to be. Whatever
    // varies with f varies *between slices*, and eight slices is a coarse
    // quantisation of a continuum: push the swing up and the deck stops looking
    // like a lit cloud and starts looking like a contour map of one.
    float vert = mix(0.50 + 0.50 * f, 0.90 - 0.44 * f, uBelow);
    float lit = lam * vert;
    // The 0.07 floor is what a fully self-shadowed core keeps. It was 0.18,
    // which put the darkest cloud in the frame at sky value and collapsed the
    // histogram: sunset.jpg holds lumaP05 0.247 while reaching 0.927 at the
    // top, a range of 0.68, and a deck with no dark in it cannot help with the
    // bottom half of that. Chasing the highlight alone moved everything to the
    // top together and made the range WORSE than the baseline's.
    float energy = (0.07 + 0.93 * lit) * (1.0 - 0.55 * shadow);
    vec3 col = mix(uDark, uLit, energy);
    // Sky bounce fills the face the key is NOT on, so it has to move with the
    // key: filling the belly while the belly is the lit face just washes the
    // event out.
    col = mix(col, uAmbient, mix(1.0 - f, f, uBelow) * 0.18);

    // The event. limb is the sunward shoulder; the second term is the
    // underlit belly. Nothing else in the deck gets the saturated colour.
    //
    // The belly term carries (1 - ht) because an underlit cloud glows where it
    // is THIN — the deep centre of a mass stays opaque and dark, and it is that
    // contrast that makes sunset.jpg's undersides read as lit rather than as a
    // wash. Without it the term paints the whole lower half of every cloud and
    // becomes a body tint wearing a limb's name.
    float ev = clamp(limb * (0.55 + 0.45 * (1.0 - f))
                   + uBelow * (1.0 - f * 0.62) * (1.0 - shadow) * (1.0 - ht * 0.65) * 0.62,
                   0.0, 1.0);
    col = mix(col, uRim, clamp(ev * uRimAmt * warm, 0.0, 1.0));
    // Silver lining, weighted onto the silhouette edge: inside * (1 - inside)
    // peaks exactly where the coverage threshold is being crossed, which is the
    // thin margin that actually scatters.
    // Weighted per PIXEL, on column height, not per slice on inside. The
    // per-slice form placed the glow more precisely on the silhouette and paid
    // for it in banding: anything that steps between slices draws a contour
    // line, and a bright additive one draws the brightest line of all.
    col += uRim * silver;

    float a = inside * 0.64;
    acc   += trans * a * col;
    alpha += trans * a;
    trans *= (1.0 - a);
  }

  // ── cirrus veil, behind the cumulus ──────────────────────────────────────
  if (uCirrus > 0.004 && trans > 0.02) {
    float tc = min((${CIRRUS_ALT.toFixed(1)} - uCamPos.y) / dy, 40000.0);
    vec2 cu = (uCamPos.xz + d.xz * tc) / ${CIRRUS_TILE.toFixed(1)} + uCirrusWind;
    // Anisotropic lookup: squashing one axis turns fbm blobs into wind streaks.
    float ci = texture2D(uNoise, vec2(cu.x * 0.34, cu.y)).a;
    float cw = max(fwidth(ci) * 1.5, 0.05);
    float ca = smoothstep(0.52 - cw, 0.52 + cw + 0.30, ci)
             * uCirrus * smoothstep(0.10, 0.38, d.y);
    // The cirrus veil is the one thing in this file that covers the ZENITH, so
    // it is the one thing that can re-create the lavender-veil bug. The mix was
    // 0.62 toward uLit; uLit is now a near-neutral pale body colour and the
    // saturated colour is in uRim, which arrives here only through warm —
    // i.e. only low and only toward the light. A streak overhead stays a
    // near-neutral pale streak, which is what the plates have.
    vec3 ccol = mix(uAmbient, uLit, 0.58);
    ccol = mix(ccol, uRim, clamp(warm * uRimAmt * (0.30 + silver * 0.9), 0.0, 0.85));
    acc   += trans * ca * ccol;
    alpha += trans * ca;
  }

  if (alpha <= 0.003) discard;

  // Aerial perspective on the deck itself: distant cloud melts into the haze
  // band, which is what stops the horizon reading as a hard cut-off line.
  // Undo the pre-multiply first so the fade is a colour blend, not a dim.
  vec3 col = acc / max(alpha, 1e-4);
  // Aerial fade, on view elevation alone.
  //
  // It is tempting to fade on distance instead, but on a flat deck the distance
  // to the base plane is purely a function of elevation, so a distance fade IS
  // an elevation fade — just a much steeper one, and a steep fade on a
  // horizontal band draws a dead-straight line across the frame. Hence one
  // wide, gentle ramp: full cloud above ~11°, dissolved into the haze band by
  // ~1°, which is what the reference plates do with their skylines.
  // Tightened from smoothstep(0.022, 0.19). That ramp had the deck 90% melted
  // into the haze at 3° of elevation, and 3° is where the hero and ridge
  // cameras spend their entire sky budget — they never look above about 12°.
  // Both sunset plates put their strongest cloud right down on the skyline, so
  // a fade that finishes at 11° deletes the picture to fix an artifact that
  // only shows in the last degree.
  float far = 1.0 - smoothstep(0.014, 0.14, d.y);
  // WHAT it fades into is not one colour. Distant cloud on the anti-sun side
  // genuinely does dissolve into the grey haze band; distant cloud *toward* a
  // setting sun dissolves into glare, which is what sunset2.jpg is a picture
  // of. Fading both into the same neutral haze is what flattened the 19:00
  // skyline into a single dull band and threw away the frame's only chance at a
  // blown highlight.
  float toward = pow(azw, 1.6);
  col = mix(col, mix(uHorizon, uHorizonSun, toward), far * 0.80);

  // Loosened from 0.78, and loosened further still toward the light.
  //
  // A silver lining is a SILHOUETTE phenomenon: it needs an opaque cloud in
  // front of the glare. At 0.78 the deck was 22% opaque by 1° of elevation, so
  // at 19:00 — sun under the horizon, aureole filling the low sky — the glare
  // simply shone through the deck and there was no edge anywhere for a rim to
  // sit on. That is why no capture in this project has ever contained one. On
  // the anti-sun side the old dissolve is right and is kept: distant cloud away
  // from the light genuinely does melt into the haze band.
  float a = clamp(alpha, 0.0, 1.0) * (1.0 - far * mix(0.62, 0.34, toward)) * uOpacity;
  a *= smoothstep(0.004, 0.030, d.y);   // nothing below the skyline
  if (a <= 0.003) discard;
  gl_FragColor = vec4(col * a, a);   // pre-multiplied; see the blend setup
}`;

// ── tiling noise tile ────────────────────────────────────────────────────────

/**
 * Periodic value noise: `freq` lattice cells across the tile, wraps exactly.
 *
 * WHY THE FADE IS QUINTIC AND NOT SMOOTHSTEP
 * ------------------------------------------
 * `3t² - 2t³` has zero first derivative at the cell edges but a *jump* in its
 * second. The field it builds is therefore C1 and its gradient is only C0 —
 * continuous, but with a kink on every lattice line. Nothing shows while the
 * field is only being thresholded. The moment the shader takes finite
 * differences of it to build a surface normal, those kinks become facet edges,
 * and a bilinearly magnified lattice turns them into a diagonal weave across
 * every cloud: measured on `dome-h7.4`, a visible cross-hatch through the whole
 * mid-tone of the deck, and on `dome-h19` a radial fur around the shaded core.
 *
 * It was there before this round and it was invisible, because the terminator
 * was 1.4 wide and the deck had almost no lighting contrast in it. Putting the
 * contrast in is what made the lattice legible — the artifact did not appear,
 * it stopped being hidden.
 *
 * `6t⁵ - 15t⁴ + 10t³` zeroes the first *and* second derivatives at the ends, so
 * the gradient is C1 and there is no facet to catch the light. It is the same
 * reason Perlin replaced his own cubic in 2002, and it costs three multiplies
 * once, at bake time.
 */
function latticeNoise(size, freq, rand) {
  const lat = new Float32Array(freq * freq);
  for (let i = 0; i < lat.length; i++) lat[i] = rand();
  const out = new Float32Array(size * size);
  const scale = freq / size;
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let y = 0; y < size; y++) {
    const fy = y * scale, iy = Math.floor(fy);
    let ty = fy - iy;
    ty = fade(ty);
    const y0 = ((iy % freq) + freq) % freq, y1 = (y0 + 1) % freq;
    for (let x = 0; x < size; x++) {
      const fx = x * scale, ix = Math.floor(fx);
      let tx = fx - ix;
      tx = fade(tx);
      const x0 = ((ix % freq) + freq) % freq, x1 = (x0 + 1) % freq;
      const a = lat[y0 * freq + x0], b = lat[y0 * freq + x1];
      const c = lat[y1 * freq + x0], e = lat[y1 * freq + x1];
      out[y * size + x] = (a + (b - a) * tx) + ((c + (e - c) * tx) - (a + (b - a) * tx)) * ty;
    }
  }
  return out;
}

/**
 * Stretch a field to fill 0..1.
 *
 * This matters more than it looks. An fbm of uniform lattice noise is a sum of
 * random variables, so it piles up around 0.5 with a standard deviation of
 * barely 0.1 — and the deck's cloud-top height is a *threshold* on that field.
 * Un-normalised, no column ever got more than a fifth of the way up the slab,
 * so the whole deck rendered as one flat translucent sheet with no crown, no
 * shadowed base and nothing for the parallax to show. Normalising is what turns
 * the field back into cloud with a top.
 */
function normalize01(a) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < a.length; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
  const k = hi > lo ? 1 / (hi - lo) : 1;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * k;
  return a;
}

/** Sum of octaves; `billow` folds the noise for cauliflower edges. */
function fbm(size, freqs, rand, billow = false) {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0;
  for (const f of freqs) {
    const o = latticeNoise(size, f, rand);
    for (let i = 0; i < out.length; i++) {
      const v = billow ? Math.abs(o[i] * 2 - 1) : o[i];
      out[i] += v * amp;
    }
    norm += amp;
    amp *= 0.52;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// IEEE-754 binary16 encode, for the noise tile. Only ever called with values in
// 0..1, so the subnormal and overflow branches a general converter needs are not
// here — a value that small in this field is indistinguishable from zero anyway.
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function toHalf(v) {
  _f32[0] = v;
  const x = _u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = (x >>> 23) & 0xff;
  let man = x & 0x7fffff;
  if (exp === 0) return sign;                       // zero / subnormal-in
  exp = exp - 127 + 15;
  if (exp <= 0) return sign;                        // underflows binary16
  if (exp >= 31) return sign | 0x7c00;              // overflows to inf
  // Round to nearest, ties to even, on the 13 bits being dropped.
  man = man + 0x1000;
  if (man & 0x800000) { man = 0; exp++; if (exp >= 31) return sign | 0x7c00; }
  return sign | (exp << 10) | (man >>> 13);
}

// Nyquist note: a channel whose top lattice frequency is F, read in the shader
// at `uv * S`, needs F * S <= size / 4 or it aliases into hard blocks — /4
// rather than /2 because bilinear filtering of a value-noise lattice is only
// C1, and the kink shows before the true Nyquist limit does. The highest
// combination here is B at 40 * 1.60 = 64 cycles over a 256-texel tile, which
// is the low tier's budget exactly.
function buildNoiseTexture(size, seed) {
  const rand = mulberry32(seed);
  // R is deliberately the *softest* field: it seeds the ground shadow too, and
  // high-frequency detail there just reads as dirt on the meadow.
  const r = normalize01(fbm(size, [2, 4, 8], rand));
  const g = normalize01(fbm(size, [5, 10, 20], rand, true));
  const b = normalize01(fbm(size, [8, 16, 32], rand, true));
  const a = normalize01(fbm(size, [3, 7, 14], rand));

  // ── AND IT HAS TO BE HALF-FLOAT, NOT 8-BIT ────────────────────────────────
  //
  // The shader builds a surface normal by finite-differencing this field. Work
  // the quantisation through: half an 8-bit step is 1/510 = 0.00196 of the
  // field; the height ramp divides by RAMP = 0.100, so that is 0.0196 of a
  // column height; and the normal scales the horizontal difference by
  // k = THICK / (EPS / invTile) = 3.12. So one bit of storage noise tilts the
  // deck's normal by 0.061, or about 3.5°, at texel frequency.
  //
  // Against the old 1.40-wide terminator that was a 4% wobble nobody could see.
  // Against this round's 1.30 terminator and its much larger lit-to-dark range
  // it is a visible fur crawling over every shaded flank — clearest on
  // `dome-h19`, where it ringed the shadowed core of the big mass.
  //
  // Half-float takes the sting out: measured round-trip error over 0..1 is
  // 2.44e-4 against 8-bit's 1.96e-3, so the same chain lands at a 0.0076 tilt —
  // 0.44°, an eighth of what it was, and under half a percent of brightness.
  // The cost is 2 MB instead of 1 MB for one texture built once at load. Linear
  // filtering of RGBA16F is core WebGL2, which this project already requires.
  const data = new Uint16Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4 + 0] = toHalf(r[i]);
    data[i * 4 + 1] = toHalf(g[i]);
    data[i * 4 + 2] = toHalf(b[i]);
    data[i * 4 + 3] = toHalf(a[i]);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // No mipmaps: the deck relies on fwidth for its level of detail, and a mip
  // chain on a 4-channel field whose channels are read at different scales
  // would blur the coverage long before it blurred the fray.
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { tex, r };
}

// ── the ground shadow's own map ──────────────────────────────────────────────
//
// Atmosphere owns the shadow tap and thresholds whatever map it is handed with
// a fixed `smoothstep(0.38, 0.90, cov)`. That used to line up with the sky by
// luck: the deck's threshold sat at 0.65, the field's median is 0.635, and both
// came out at roughly half the sky. Now that the deck only claims the top ~17%
// of the field, feeding Atmosphere the raw field would shade half the valley
// under a sky that is almost clear — the ground would be showing weather that
// is not there.
//
// Rather than reach into another author's shader, hand it a map that is already
// the silhouette: R is remapped so that Atmosphere's own 0.38…0.90 window lands
// exactly on the deck's lo…lo+RAMP window. One tap, same cost, and the patch on
// the meadow is the cloud you can see.
//
// Baked at one coverage, because a texture cannot vary with the hour. The
// shadow only exists in daylight (its strength fades out with the sun), where
// the keyframe cover runs 0.20–0.30, so the error at the extremes is a shadow
// silhouette a few per cent tighter or looser than the deck — invisible against
// a term this soft. Anything more would need the threshold to move, which is
// Atmosphere's to move.
function buildShadowTexture(r, size, lo, ramp) {
  const data = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const h = Math.max(0, Math.min(1, (r[i] - lo) / ramp));
    data[i] = Math.round((0.38 + 0.52 * h) * 255);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ── small colour helpers ─────────────────────────────────────────────────────
//
// Every SKY_STATE colour is in the renderer's working (linear) space, because
// three's ColorManagement converts on the way in from a hex literal. So these
// are linear-light operations and the Rec.709 luma weights below are the right
// ones — do not "fix" them to sRGB weights.
const WHITE = new THREE.Color(1, 1, 1);
const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const smooth = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a || 1e-6), 0), 1);
  return t * t * (3 - 2 * t);
};
/** Pull a colour toward its own luminance. 0 = untouched, 1 = neutral grey. */
function desatToward(c, k, tmp) {
  if (k <= 0) return c;
  const l = luma(c);
  return c.lerp(tmp.setRGB(l, l, l), k);
}
/**
 * Blue must not lead green while the sun is up.
 *
 * This is the `cloudAmbient` rule from Lighting.js turned into code. That bug
 * was a cloud colour whose linear blue sat above its green, which is literally
 * magenta-led, and it put a lavender veil over every daylight frame. It came
 * back at twilight: measured on the integrated tree, `cloudDark` at 19:00 is
 * linear [0.224, 0.228, 0.281] — B above G — and the deck rendered as violet
 * slabs across a cream sky.
 *
 * A cloud shadow is lit by the sky, so it is *allowed* to be cool. What it is
 * not allowed to be is a pigment. Pulling B down to G costs the coolness
 * nothing (the result is still the bluest of the three by ratio to a warm key)
 * and removes the magenta cast entirely. At night the rule inverts and is
 * switched off: `night2.jpg`'s moonlit cloud genuinely is blue-white over a
 * violet sky.
 */
function noViolet(c, w) {
  if (w <= 0 || c.b <= c.g) return c;
  c.b += (c.g - c.b) * w;
  return c;
}
/**
 * Scale a colour so its luminance becomes `target`, blended in by `w`.
 *
 * THIS FILE AUTHORS RATIOS, NOT LEVELS. The frame's absolute exposure is one
 * global decision and it belongs to the post author; the cloud's job is to sit
 * at the right *ratio* to the sky behind it. Everything the deck draws is
 * therefore anchored through here to a reference taken from SKY_STATE's own
 * zenith and horizon, which means the deck tracks whatever the light author
 * does to the keys and whatever the post author does to exposure without a
 * single number in this file needing to move.
 *
 * It is also the only thing that survived four authors editing at once. The
 * night keys were re-authored ten times brighter mid-round; the deck followed
 * them exactly and nobody had to notice.
 *
 * The ratio is clamped because a keyframe whose luma is near zero would
 * otherwise produce an arbitrarily large multiplier and a blown white cloud.
 */
function reanchor(c, target, w) {
  const l = luma(c);
  if (l < 1e-6) { c.setRGB(target, target, target); return c; }
  // The range has to reach 0.02: `moonColor` is a near-white unit colour with
  // luma 0.86 and the night sky it has to sit against is at luma 0.012, so the
  // honest ratio there is 0.04. A floor of 0.15 clamped it to ten times the
  // sky and put a bank of white cloud over the star field.
  const k = Math.min(Math.max(target / l, 0.02), 8);
  return c.multiplyScalar(1 + w * (k - 1));
}

// Slices trade silhouette accuracy for taps, not for noise: dropping to four
// still gives a lit crown and a shadowed base, it just resolves the shoulder
// between them more coarsely. The tile size cannot drop below 256 without the
// B channel aliasing (see the Nyquist note above).
const TIERS = {
  ultra:  { slices: 9, size: 512 },
  high:   { slices: 8, size: 512 },
  medium: { slices: 6, size: 384 },
  low:    { slices: 4, size: 256 },
};

export class Clouds extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Clouds';
    this.loadLabel = 'Building weather';
    // Wind, in metres/second of cloud drift. Slow on purpose: at this scale
    // anything faster than a brisk walk reads as a screensaver.
    // Raised from (4.4, 2.1) — 4.9 m/s, which at the 2.9 km the deck base sits
    // from a 20° view ray is 0.10°/s. That is under the threshold where drift
    // reads as weather rather than as a still image, and a cozy sky wants to be
    // legibly moving when you stop and look at it. 6.9 m/s is 0.14°/s: about
    // 8° of sky a minute, which reads as a breezy day and still takes three
    // minutes to cross the frame.
    this.wind = new THREE.Vector2(6.2, 3.0);
    this._uv = new THREE.Vector2();
    this._uv2 = new THREE.Vector2();
    this._uvC = new THREE.Vector2();
    this._key = new THREE.Vector3(0, 1, 0);
    this._lit = new THREE.Color();
    this._dark = new THREE.Color();
    this._amb = new THREE.Color();
    this._rim = new THREE.Color();
    this._tmp = new THREE.Color();
  }

  async init() {
    const { scene, quality, preset } = this.ctx;
    const tier = TIERS[quality] ?? TIERS.high;
    // `volumetric: false` tiers still get clouds — just fewer slices. A deck of
    // cumulus is load-bearing for the composition, not an effect.
    const slices = preset?.volumetric ? tier.slices : Math.max(4, tier.slices - 3);

    const built = buildNoiseTexture(tier.size, SEED ^ 0x51ed5);
    this.noise = built.tex;
    this.shadowMap = buildShadowTexture(
      built.r, tier.size, COVER_BIAS - COVER_SLOPE * SHADOW_COVER, RAMP);

    this.uniforms = {
      uNoise:    { value: this.noise },
      uCamPos:   { value: new THREE.Vector3() },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uKeyAz:    { value: new THREE.Vector2(1, 0) },
      uLit:      { value: new THREE.Color(0xffffff) },
      uDark:     { value: new THREE.Color(0x8888aa) },
      uAmbient:  { value: new THREE.Color(0x9aa8c8) },
      uRim:      { value: new THREE.Color(0xffffff) },
      uHorizon:  { value: new THREE.Color(0xf0d6b4) },
      uHorizonSun: { value: new THREE.Color(0xf0d6b4) },
      uWind:     { value: new THREE.Vector2() },
      uWind2:    { value: new THREE.Vector2() },
      uCirrusWind: { value: new THREE.Vector2() },
      uCover:    { value: 0.5 },
      uInvTile:  { value: 1 / TILE },
      uCirrus:   { value: 0.5 },
      uOpacity:  { value: 1.0 },
      uLowSun:   { value: 0 },
      uBelow:    { value: 0 },
      uRimAmt:   { value: 0.3 },
      uSilver:   { value: 0.6 },
      // Was a hand-tuned per-tier fudge for "fewer slices resolve the shoulder
      // more coarsely". That is now derived properly from SLICES inside the
      // shader (see `sw`), so this is left as a pure artistic knob at zero.
      uSoft:     { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines: { SLICES: slices },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
      // See the header: opaque queue (so renderOrder wins over the terrain)
      // but still alpha-blended over the sky dome.
      transparent: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,          // colour is pre-multiplied in the shader
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -999;
    this.mesh.name = 'Clouds';
    scene.add(this.mesh);

    // Hand the shared atmosphere the pre-thresholded silhouette of this same
    // coverage field, so the shadow on the meadow is the cloud that is actually
    // overhead rather than a wash of the underlying noise. See
    // buildShadowTexture for why it is a second map and not the raw one.
    this.ctx.atmosphere?.setCloudShadow({
      map: this.shadowMap,
      scale: 1 / TILE,
      altitude: BASE,
      strength: 0.42,
    });
  }

  update(dt, elapsed) {
    if (!this.mesh) return;
    const s = SKY_STATE;
    const u = this.uniforms;

    // uv drift = metres travelled / tile size. uWind is the *mass*, and it is
    // load-bearing: Atmosphere's ground-shadow map is scrolled by exactly this
    // vector below, so the patch on the meadow is the cloud overhead. uWind2
    // and uCirrusWind are free to shear against it — see the note by uvD.
    const w = -elapsed / TILE;
    this._uv.set(this.wind.x * w, this.wind.y * w);
    // 1.4x the speed and about 20° off the heading of the mass.
    this._uv2.set((this.wind.x * 0.94 - this.wind.y * 0.34) * 1.4 * w * 0.55,
                  (this.wind.x * 0.34 + this.wind.y * 0.94) * 1.4 * w * 0.55);
    // Cirrus is 6 km up and moves like it: faster, and backed round the other
    // way. Its tile is 30 km, so this is in units of that tile, not TILE.
    this._uvC.set((this.wind.x * 0.97 + this.wind.y * 0.24) * 2.2 * -elapsed / CIRRUS_TILE,
                  (this.wind.y * 0.97 - this.wind.x * 0.24) * 2.2 * -elapsed / CIRRUS_TILE);
    u.uWind.value.copy(this._uv);
    u.uWind2.value.copy(this._uv2);
    u.uCirrusWind.value.copy(this._uvC);
    u.uCamPos.value.copy(this.ctx.camera.position);

    // ── which light is lighting this deck ────────────────────────────────────
    // The sun by day, the moon at night, and the swing between them weighted by
    // `moonIntensity * starAmount` rather than by moonIntensity alone.
    //
    // That second factor is the whole trick. The moon is already at intensity
    // 0.53 at 19:00 while the sky is still salmon and the deck still has its
    // full sunset contrast, and the moon at that hour is 104° of azimuth away
    // from the sun — so weighting on moonIntensity alone rotates the key light
    // through a hundred degrees across the money frames and the deck's shading
    // visibly rolls over between 19:00 and 20:00. `starAmount` is Lighting's
    // own "is the sky genuinely dark yet" ramp, and multiplying by it defers
    // the whole swing into the hours where the deck has almost no contrast left
    // to roll: the weight is 0.08 at 19:00, 0.31 at 19:48, 0.79 at 21:00.
    const mw = s.moonIntensity * s.starAmount;
    this._key.copy(s.sunDir).lerp(s.moonDir, mw);
    // The lerp passes near zero only if the two are near-antipodal, which this
    // moon arc never is in the crossover window — but a guard costs nothing and
    // a NaN light direction costs the whole frame.
    if (this._key.lengthSq() < 0.02) this._key.copy(mw > 0.5 ? s.moonDir : s.sunDir);
    this._key.normalize();
    u.uLightDir.value.copy(this._key);
    const axz = Math.hypot(this._key.x, this._key.z) || 1e-4;
    u.uKeyAz.value.set(this._key.x / axz, this._key.z / axz);

    const ke = this._key.y;
    const lowSun = 1 - smooth(0.05, 0.35, ke);
    // "Under the deck base", which is what flips the crown lighting to belly
    // lighting. Keyed a touch above zero because the deck base is 1500 m up and
    // the ridge line the sun sets behind is not.
    const below = smooth(0.07, -0.04, ke);
    u.uLowSun.value = lowSun;
    u.uBelow.value = below;

    // ── body vs rim ──────────────────────────────────────────────────────────
    // The lead's baseline measurement: chromaMean ours 0.35 against
    // morning.jpg's 0.183, with ZERO near-neutral pixels against its 7.4%.
    // morning.jpg's cloud body is a near-neutral pale grey-cream and only the
    // rim facing the sun carries chroma. Tinting the whole mass warm — which is
    // what handing `cloudLit` straight to the shader does at 19:00, where it is
    // #ffb078 at chroma 0.53 — makes the standing "reads as monochrome orange"
    // complaint worse, not better. So the body is desaturated here and the
    // saturated colour goes to uRim, which the shader only spends on the limb,
    // the belly and the silver lining.
    //
    // `twilight` is "is there still a sun doing the lighting", on sun elevation
    // rather than dayFactor — dayFactor collapses to 0.03 by 19:00 and 0.00 by
    // 19:24, which is an hour before the sky stops being a sunset.
    const twilight = smooth(-0.22, -0.02, s.sunElev);

    // The reference the whole palette hangs off: the luminance of the sky this
    // deck is drawn against. Weighted toward the horizon in daylight, because
    // that is the part of the dome the cameras that matter actually see, and
    // onto the zenith alone at night, because at night the framing that matters
    // is the one pitched up at the star field and the horizon key is several
    // times brighter than the top of the dome.
    const ref = twilight * (0.42 * luma(s.zenith) + 0.58 * luma(s.horizon))
              + (1 - twilight) * luma(s.zenith);

    // The ratios. These are the entire art direction of this file.
    //
    //   lit   1.55  the cloud's lit face is the brightest non-sun thing in a
    //               daylight frame. Both plates are built on that.
    //   dark  0.38  and its core is genuinely darker than the sky. This is the
    //               number that protects lumaP05: a deck whose darkest pixel is
    //               still sky-value collapses the frame's range, which is what
    //               happened when the highlight was chased on its own.
    //   rim   3.2   only ever spent on a limb — see uRimAmt and `ev` below.
    //
    // At night every one of them drops under 1. `night2.jpg` puts the mass
    // DARKER than the sky with only its moonlit shoulder above it; a night
    // cloud brighter than the sky is a hole punched in the star field, and the
    // star field is what this round is for.
    const litR  = 0.88 + 0.67 * twilight;
    const darkR = 0.42 - 0.04 * twilight;
    const ambR  = 0.68 + 0.17 * twilight;
    const rimR  = 1.55 + 1.65 * twilight;

    // Desaturation, and the magenta clamp. A little of both even at night: the
    // authored keys carry more pigment than the plates do at every hour.
    const desat = 0.10 + 0.34 * twilight;

    this._lit.copy(s.cloudLit);
    desatToward(this._lit, desat, this._tmp);
    noViolet(this._lit, twilight);
    reanchor(this._lit, ref * litR, 1);

    this._dark.copy(s.cloudDark);
    desatToward(this._dark, 0.16 + 0.44 * twilight, this._tmp);
    noViolet(this._dark, twilight);
    reanchor(this._dark, ref * darkR, 1);

    this._amb.copy(s.cloudAmbient);
    desatToward(this._amb, 0.10 + 0.36 * twilight, this._tmp);
    noViolet(this._amb, twilight);
    reanchor(this._amb, ref * ambR, 1);

    // The rim, and the only saturated thing this file draws. Whitened on the
    // way up: `morning.jpg` puts #fefcf0 — chroma 0.055, essentially neutral —
    // immediately around the sun and only turns peach several degrees out. A
    // rim that just scales the glow colour up reads as a band of fire; one that
    // whitens as it brightens reads as a lit cloud edge.
    this._rim.copy(s.glow).lerp(s.cloudLit, 0.22);
    this._rim.lerp(WHITE, 0.20 * Math.min(s.glowIntensity, 1));
    // At night the key is the moon, so the rim is moonlight.
    this._tmp.copy(s.moonColor);
    this._rim.lerp(this._tmp, (1 - twilight) * Math.max(s.moonIntensity, 0.35));
    reanchor(this._rim, ref * rimR, 1);

    u.uLit.value.copy(this._lit);
    u.uDark.value.copy(this._dark);
    u.uAmbient.value.copy(this._amb);
    u.uRim.value.copy(this._rim);
    // How much of a limb the rim colour is allowed to take, and how hard the
    // forward-scatter lobe fires. Both were higher and both had to come down:
    // at 0.88 the rim was claiming most of the underlit half of every cloud,
    // which is a *body* tint wearing a limb's name, and it flattened the
    // frame's value range by moving everything to the top of the histogram
    // together. The highlight has to be a narrow edge or it is not a highlight.
    u.uRimAmt.value = 0.20 + 0.42 * lowSun;
    // Silver is a sun phenomenon. A moon lobe this strong put bright patches
    // over the star field.
    u.uSilver.value = (0.45 + 0.85 * lowSun) * (0.22 + 0.78 * twilight);

    u.uHorizon.value.copy(s.fogFar).lerp(s.horizon, 0.5);
    // What cloud dissolves into toward the light. `sunHorizon` is the horizon
    // colour in the sun's own azimuth and is already authored per hour, so this
    // costs nothing and tracks the arc for free.
    u.uHorizonSun.value.copy(s.sunHorizon).lerp(s.glow, 0.35 * lowSun);

    // ── cover ────────────────────────────────────────────────────────────────
    // Lighting's table runs cover 0.35–0.39 at night. That is a request for a
    // third of the sky under cloud at exactly the hour whose headline is a sky
    // full of stars and a moon, and both night reference plates are essentially
    // CLEAR. A deck that opaque over that much sky does not read as weather, it
    // reads as the star field having been deleted. See the request filed under
    // `## Author D requests` in docs/SKY_NIGHT_BRIEF.md — the curve is B's, so
    // this scales what it is handed rather than replacing it, and it is keyed
    // to `starAmount` so it is the same ramp the stars themselves fade in on.
    u.uCover.value = s.cloudCover * (1 - 0.78 * s.starAmount);
    u.uCirrus.value = 0.26 * (1 - 0.90 * s.starAmount);
    // Was `0.35 + 0.65 * dayFactor`, i.e. 35% opaque at night and — because
    // dayFactor is 0.03 by 19:00 — 37% opaque at the exact hour the brief calls
    // the money frame. That is the direct cause of "at 19 they are barely
    // distinguishable from the sky": the deck was being cross-faded out an hour
    // before sunset was over. It is also why cloud does not occlude stars; a
    // 35%-opaque layer over a star field is two unrelated pictures stacked.
    // Grace at night is now the job of `uCover` above, which is the honest
    // control: fewer clouds, not more transparent ones.
    u.uOpacity.value = 1.0;

    // Cosmetic only: the dome is drawn as a direction field (see VERT), so the
    // image no longer depends on this being exact — which matters, because the
    // camera pose is written in lateUpdate and this value is one frame old.
    // uCamPos is one frame old for the same reason, and that is harmless: at
    // 22 m/s a frame is 0.37 m against a 7000 m tile.
    this.mesh.position.copy(this.ctx.camera.position);

    // Scroll the ground shadow with the deck, and fade it out with the sun so
    // an overcast dusk does not stamp hard patches on an unlit valley.
    const a = this.ctx.atmosphere;
    if (a) {
      a.setCloudOffset(this._uv.x, this._uv.y);
      // Raised with the coverage cut. The old map shaded most of the valley at
      // partial strength, so the term had to stay weak to avoid reading as a
      // dimmer switch; the map is now a silhouette that covers a sixth of the
      // ground, and a shadow that rare has to be worth noticing when it passes.
      a.params.cloudShadow = 0.42 * Math.min(Math.max((s.sunElev - 0.02) / 0.18, 0), 1);
    }
    void dt;
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.noise?.dispose();
    this.shadowMap?.dispose();
    this.ctx.scene.remove(this.mesh);
    this.mesh = null;
  }
}
