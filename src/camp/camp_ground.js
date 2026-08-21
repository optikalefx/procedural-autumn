// ─────────────────────────────────────────────────────────────────────────────
//  camp_ground — the scuffed dirt the camp stands on.
//
//  API contract (Camp.js depends on exactly this):
//    new CampGround(scene, world) -> { build(x, z, radius, rnd), setReveal(k),
//                                      dispose() }
//
//  ── three decisions, and the argument for each ──────────────────────────────
//
//  1. THE MESH IS POLAR, AND ITS RINGS ARE THE CLEARING'S OWN CONTOURS.
//
//     The first pass was a square PlaneGeometry with a soft alpha ramp, which
//     spends most of its vertices on ground that is never drawn and puts its
//     *fewest* vertices exactly where all the interest is — the fringe. A polar
//     grid whose outer ring is placed on the clearing boundary itself puts a
//     ring every 9 cm through the transition band and every 45 cm across the
//     dead centre, for a third of the triangles.
//
//     The boundary is not re-derived. `campCoverAt()` is a smoothstep over
//     [R(a) - feather, R(a)], so it passes through 0.5 at exactly R - w/2;
//     bisecting it for that crossing recovers R(a) to five decimal places
//     without this file knowing a single one of the wobble constants. If the
//     clearing's shape function is ever changed the dirt follows it for free —
//     which is the only version of "keep these two in step" that actually stays
//     in step.
//
//  2. THE MESH REPRODUCES THE RENDERED TERRAIN SURFACE, NOT THE HEIGHTFIELD.
//
//     These are not the same thing and the difference is what made the first
//     pass float. `world.getHeight()` is the analytic field; the terrain you
//     can see is that field sampled on a 1.5 m lattice and linearly
//     interpolated across two triangles per cell. On any convex ground the
//     drawn surface sits *below* the field by up to a few centimetres, so a
//     decal that conforms to the field pokes through it in places and sinks
//     into it in others — which the first pass paid for with a blanket +3.5 cm
//     lift, i.e. a visible lip all the way round at grazing angles.
//
//     `_surfaceY()` below reconstructs the drawn surface exactly: the same
//     lattice, the same alternating diagonal, the same barycentric
//     interpolation Terrain.js's index template produces. That buys the lift
//     down from 35 mm to 13 mm, and 13 mm does not read as a lip from anywhere.
//
//  3. THE COLOUR IS FRAGMENT WORK, NOT VERTEX COLOUR.
//
//     TerrainMaterial's central claim is that this game reads as broad flat
//     colour masses with definite edges. A vertex colour on a mesh this size is
//     structurally incapable of a definite edge — Gouraud interpolation turns
//     every boundary into a ramp as wide as a cell. The masses here are
//     thresholded per fragment with a width taken from the field's own
//     derivative, which is the same trick `massEdge()` uses over there: crisp
//     at any distance, antialiased for free, and it degrades to a flat mass
//     rather than to noise as the pixel footprint grows.
//
//     Five masses, not one fBm: a pale compacted centre where people walk, the
//     general dry earth, a darker damp band where the roots start again, small
//     patches of exposed grit, and a fringe of crushed straw-coloured stubble.
//     Noise appears only as the *outline* of those masses and as a warp on it,
//     never as a wash of value.
//
//  A note on the hash. The value noise here is the cheap fract-dot hash rather
//  than TerrainMaterial's `fract(sin(...))` one. That is a cost decision and
//  not a taste one: this surface can cover a third of the frame at 3 m and the
//  sin version is eight transcendentals per lattice corner. The grain is
//  indistinguishable; the frame time is not.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { campCoverAt, getCampSite } from './camp_clearing.js';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';
import { C, sanitizeNormals } from './camp_materials.js';

// Terrain.js: chunkSize 96 m, LOD-0 resolution 64 → a 1.5 m lattice, and
// `world.half` is 1536 m, an exact multiple of it. So the drawn surface's
// vertices sit on world coordinates that are exact multiples of 1.5 m and the
// reconstruction below needs no per-chunk bookkeeping.
const LOD0_STEP = 96 / 64;

// Rings. Coarse across the middle, dense through the feather where the whole
// transition happens, then a short skirt past the boundary for the scuff.
const RINGS_IN = 9;      // centre → inner edge of the feather
const RINGS_MID = 17;    // through the feather
const RINGS_OUT = 5;     // past the boundary, for scuff patches under grass
const SECTORS = 180;     // 25 samples per period of the wobble's 7th harmonic
const SKIRT = 1.05;      // metres of mesh past the boundary

// How far the dirt sits above the drawn terrain. See decision 2: this is a
// safety margin against float error and the LOD-1 switch at 180 m, not a
// clearance, so it is as small as it can be.
const LIFT = 0.013;
// The matted berm just inside the boundary — trodden grass has thickness, and
// a 2 cm rise there is what stops the fringe reading as a printed edge.
const BERM = 0.022;

// ── palette ──────────────────────────────────────────────────────────────────
// Authored as sRGB hex and converted, because vertex/fragment albedo multiplies
// in LINEAR space: a hex that looks like "brown" fed in raw lands about two
// stops darker than intended and reads as a burn scar. That is exactly the trap
// the first pass fell into.
//
// Values are keyed off TerrainMaterial's own `dirtPath` (#b99a72), which is
// what the terrain paints its worn ground with — so the camp's dirt is the same
// substance as the valley's dirt rather than a new material sitting on it.
// EARTH is a touch cooler and lower in chroma than the meadow gold; PACK is
// nearly a stop lighter, which is what puts it clearly above shadowed grass.
//
// Lighter and flatter than the first pass, on the evidence of the plates. The
// bare trail through the meadow in reference-art/…10.29.36 is barely a stop
// under the gold beside it, and all of its interest is small hard-edged dark
// rock, not large swings of value. The first pass ran EARTH to DAMP as a
// two-stop drop across the disc and the capture read as a mud crater.
//
// The fourth pass lifted these to put the dirt above the sunlit grass, on a
// literal reading of "lighter than the shadowed grass". That was wrong, and
// the whole-camp frame said so in three ways at once: the disc became the
// brightest thing in the frame and pulled the eye off the fire, it read as
// beach sand rather than as earth, and — the tell that named the cause — the
// tree shadow crossing it turned MAUVE. That last one is arithmetic. This
// scene's shade is tinted violet on purpose (grassShadow #4a4f86 is the
// palette's complementary anchor), and a violet shade multiplied into a
// near-neutral pale albedo has nothing warm left to fight it. Give the albedo
// real chroma and the same shadow lands as a warm brown.
//
// So: a warm mid brown, one step BELOW the sunlit meadow, with chroma in it.
// The squint test is the specification — a dark fire and a few dark props on a
// mid ground, inside a lighter gold field.
const EARTH = C(0xb19075);   // general dry trodden earth
const PACK  = C(0xc6ad92);   // compacted, walked flat, dusty and pale
const DAMP  = C(0x866d58);   // damp unwalked earth — patches, never a ring
// Grit is the one mass that may lean cool, and it must lean only a *little*.
// At #bdb5a8 it came back as puddles of wet cement in the plan frame. The
// palette's note about the rock says the plates are bimodal — near-neutral
// stone beside strongly coloured ground — and that licence belongs to stone,
// not to a patch of dust on a warm valley floor.
const GRIT  = C(0xafa590);   // exposed grit — half a step cooler, no more
const STUB  = C(0xc8b585);   // crushed, yellowed grass stubble at the fringe
// Fallen leaves. This valley is deciduous and it is autumn; a clearing in it
// collects leaves at its downwind fringe within a day. It is also the one
// warm, chromatic note the dirt is allowed — it ties the ground to the canopy
// overhead, and it is the reason the disc is not four shades of one colour.
const LEAF  = C(0xa96b3c);
// Uncrushed growth at the fringe, seen from above.
//
// This was #ada05f, and it rendered as an unbroken green ribbon a metre wide
// around the whole disc that read as moss. Two things were wrong with it. It
// was twenty degrees greener than the meadow's own ground beside it, and dry
// autumn grass crushed flat is not green at all — it is a pale straw-grey. And
// it was the mix BASE, so every fragment the threshold did not claim came out
// as a hundred percent of it.
const MAT   = C(0xc4b48c);

// Small props lying on the dirt.
const STONE_A = C(0xa9a49c);
const STONE_B = C(0x8e8478);
const STONE_C = C(0xb5a998);
const TWIG_A  = C(0x8d7454);
const TWIG_B  = C(0xa48d69);

const TAU = Math.PI * 2;

// ── a tiny deterministic value noise, for the CPU-side hummocks ──────────────
function h2(x, y) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function vnoise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = h2(ix, iy), b = h2(ix + 1, iy), c = h2(ix, iy + 1), d = h2(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

// ── shared GLSL: the noise stack and the mass-edge threshold ─────────────────
const NOISE_GLSL = /* glsl */`
float h21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float vn( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( h21( i ),               h21( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float fbm2( vec2 p ) { return vn( p ) * 0.62 + vn( p * 2.13 + 7.7 ) * 0.38; }

// TerrainMaterial's massEdge, with an explicit width floor. The floor is a real
// width in the field rather than a token one, for the reason spelled out over
// there: on a field whose gradient is small a derivative-only width resolves to
// a one-pixel contour whose shape is dictated by whatever is quantised
// underneath, and that is how you get a straight-edged polygon across a
// hillside instead of an edge.
float massEdgeW( float field, float threshold, float floorW ) {
  float w = max( fwidth( field ) * 1.35, floorW );
  return smoothstep( threshold - w, threshold + w, field );
}

// World metres per pixel at this fragment. Written once at the top of the
// albedo block; hardEdge below is useless without it.
float gPx = 1.0;

// The same threshold, with the edge width expressed as a WIDTH ON THE GROUND
// instead of a width in the field.
//
// This is the fix for the defect that survived four rounds. massEdgeW's floor
// is in field units, and on an fBm at 0.3–1.0 cycles per metre the field's
// gradient is shallow — 0.03 of field range is thirty to sixty centimetres of
// ground. So the floor, which exists only to stop a one-pixel contour, became
// the dominant term and quietly turned every "definite edge" in this shader
// into a half-metre ramp. Four captures of an airbrush, from code whose
// comments claimed flat masses with definite edges.
//
// The gradient is recoverable: fwidth(f) is the field's change across a pixel
// and gPx is that pixel's size in metres, so fwidth(f)/gPx is |∇f| in field
// units per metre. Divide the width you actually want — five centimetres of
// ground — by that, and the edge is five centimetres wide wherever it lands.
// fwidth(f) itself remains the floor, which is exactly one pixel: antialiased,
// never wider.
float hardEdge( float field, float threshold, float wMetres ) {
  float fw = fwidth( field );
  float w = max( fw, ( fw / max( gPx, 1e-5 ) ) * wMetres );
  return smoothstep( threshold - w, threshold + w, field );
}
`;


// ── the material set, built once for the session ─────────────────────────────
//
//  Not once per build, and that is a measured perf fix rather than tidiness.
//  Three folds `onBeforeCompile` into the program cache key, so a material
//  constructed inside `build()` is a brand new program every time a camp is
//  pitched — 36 link events and two frames near 900 ms on the first camp, which
//  the player felt as a freeze. Worse, Camp.js pre-warms the whole feature at
//  boot by building one of everything under the loading screen and throwing it
//  away, and a program belonging to a discarded material is discarded with it,
//  so the pre-warm was warming nothing here at all.
//
//  Module scope, the way `campMaterials()` does it in camp_materials.js. Every
//  per-site value that used to be a constructor argument is a uniform now.
//  There is exactly one camp in the world at a time — see the note at the top
//  of Camp.js — so one shared uniform block is not a restriction, and a uniform
//  can be animated, which is what lets the build-in be a radial wipe rather
//  than a fade.
let _gm = null;

function groundMaterials() {
  if (_gm) return _gm;

  // One object, referenced by both materials, so `setReveal` is a single write.
  const uReveal = { value: 1 };

  const dirt = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.95, metalness: 0.0,
      transparent: true, depthWrite: false, dithering: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
  const u = {
    uCentre: { value: new THREE.Vector2(0, 0) },
    uReveal,
    uEarth: { value: EARTH }, uPack: { value: PACK }, uDamp: { value: DAMP },
    uGrit: { value: GRIT }, uStub: { value: STUB },
    uMat: { value: MAT }, uLeaf: { value: LEAF },
  };
  dirt.userData.uniforms = u;
  dirt.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = /* glsl */`
        attribute float aB;
        attribute float aU;
        varying vec3 vWPos;
        varying float vB;
        varying float vU;
        varying float vCam;
      ` + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        vB = aB;
        vU = aU;
        vCam = length( cameraPosition - vWPos );
      `);

      sh.fragmentShader = /* glsl */`
        uniform vec2 uCentre;
        uniform float uReveal;
        uniform vec3 uEarth, uPack, uDamp, uGrit, uStub, uMat, uLeaf;
        varying vec3 vWPos;
        varying float vB;
        varying float vU;
        varying float vCam;

        ${NOISE_GLSL}

        // Carried from the albedo block to the normal block. Three's chunk
        // order puts <color_fragment> well before <normal_fragment_maps>, and
        // re-deriving four noise fields there would be pure waste.
        float gTrod = 0.0;
        float gGrit = 0.0;
        float gBump = 0.0;
        float gAlpha = 1.0;
        vec2  gP = vec2( 0.0 );

        // The bump field. Two things only: a broad hummock octave that the
        // vertex relief is too coarse to carry, and the scuff arcs.
        //
        // The arcs are concentric rings phase-warped by a metre of noise, which
        // is what turns "a target" into "somebody has been walking round this
        // fire". A polar noise would be the obvious way to draw them and it is
        // the wrong one — atan() has a seam at the antimeridian and it would
        // draw a hairline crack from the fire to the edge of the clearing.
        // Fine and shallow. The first pass gave the broad octave 15 cm of
        // amplitude at a 1.7 m wavelength, which is a nineteen degree slope —
        // enough to shade the whole disc into soft swells and read as an
        // airbrush. Grain, not swells: 4 cm of relief at 30 cm.
        float bumpF( vec2 p ) {
          float b = vn( p * 3.40 ) * 0.030 + vn( p * 1.10 ) * 0.055;
          float r = length( p - uCentre );
          b += sin( r * 7.4 + fbm2( p * 0.52 ) * 12.0 ) * 0.022 * gTrod;
          return b;
        }
      ` + sh.fragmentShader.replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        {
          vec2 P = vWPos.xz;
          gP = P;
          gPx = max( fwidth( P.x ), fwidth( P.y ) );
          float rr = length( P - uCentre );

          // ── the fields the masses are cut from ────────────────────────────
          // A domain warp, so a mass boundary is a lobed organic outline rather
          // than the smooth blob a raw fbm threshold gives.
          vec2 wq = P * 0.33;
          vec2 warp = vec2( fbm2( wq + vec2( 19.3, 4.1 ) ),
                            fbm2( wq + vec2( -7.7, 23.9 ) ) ) - 0.5;
          vec2 Q = P + warp * 2.6;
          float blot = fbm2( Q * 0.30 );           // ~3.5 m
          float meso = fbm2( P * 0.95 + 12.4 );    // ~1 m

          // A WEAK radial bias, and only on one mass. The first pass made every
          // mass a function of radius and the result was a lit sphere: a pale
          // middle inside a dark ring is what a shaded ball looks like, whatever
          // it happens to be painted on.
          // Weaker still after the whole-camp frame called the disc a raised
          // dome. The geometry is a shallow BOWL — 13 mm of lift at the centre
          // against 35 mm at the berm — so the bulge was never in the mesh; it
          // was a pale middle inside a darker rim, which is what a lit sphere
          // looks like whatever it is painted on.
          float inner = 1.0 - smoothstep( 0.06, 0.98, vU );

          // ── mass 1: the scuffed paths ────────────────────────────────────
          // Ridged, not blobby. Inverting |n - ½| turns islands into connected
          // snaking bands, and connected bands are what ground that people walk
          // over and over actually looks like. Radius only decides how much of
          // the disc they cover — see docs/CAMP_REQUESTS.md for why this is a
          // statistical stand-in for the real prop footprints.
          float ridge = 1.0 - abs( blot * 2.0 - 1.0 );
          float trodF = ridge * ( 0.76 + 0.30 * inner ) + meso * 0.26;
          float trod  = hardEdge( trodF, 0.60, 0.060 );

          // ── mass 2: damp unwalked earth. Patches, deliberately not a ring ─
          float dampF = fbm2( Q * 0.52 + 61.7 ) + 0.07 * ( 1.0 - inner ) - 0.28 * trod;
          float damp  = hardEdge( dampF, 0.58, 0.060 );

          // ── mass 3: exposed grit where the scuffing has cut through ──────
          float gritF = fbm2( Q * 1.05 + 31.1 ) + meso * 0.20;
          float grit  = hardEdge( gritF, 0.78, 0.045 ) * ( 0.22 + 0.78 * trod );

          // ── mass 4: crushed stubble, on the vegetation gradient ──────────
          // Keyed on the cover field itself, not on radius, so it follows the
          // wobble of the boundary exactly instead of running beside it.
          float stubF = ( 1.0 - abs( vB - 0.40 ) / 0.38 )
                      + ( meso - 0.5 ) * 0.70 + ( blot - 0.5 ) * 0.40;
          float stub  = hardEdge( stubF, 0.50, 0.090 );

          vec3 c = uEarth;
          c = mix( c, uDamp, damp * 0.90 );
          c = mix( c, uPack, trod * 0.92 );
          c = mix( c, uGrit, grit );
          c = mix( c, uStub, stub * 0.92 );

          // -- the fringe, and why the interlock is opaque -------------------
          // Two passes were spent making this transition by cutting ragged
          // holes in the alpha, and both produced the same defect: an olive
          // lobe reaching two metres into the disc. What shows through a hole
          // is bare TERRAIN, and the terrain's meadow albedo is a strong
          // yellow-green that belongs to neither surface — so each hole read as
          // a puddle of the wrong colour rather than as a tuft of grass.
          //
          // So the interlock is a COLOUR boundary on an opaque surface: fingers
          // of crushed stubble reaching out, tongues of uncrushed growth
          // reaching in, thresholded against the clearing's own cover field so
          // they thin exactly as the real blades above them do. Alpha is left
          // to do only the last handspan, where the grass is back to 95% and
          // there is nothing left to hide.
          //
          // It happens HERE, above the three fine scales rather than below
          // them, and that ordering is the whole difference between a fringe
          // and a flat khaki ring. Mixed in last it overwrote every scale of
          // detail the fringe had, which is why the r4 capture had a metre of
          // dead colour all round the disc while the middle of it was textured.
          float tongN = fbm2( P * 2.30 + 5.5 ) * 0.78 + fbm2( P * 5.10 - 22.0 ) * 0.30;
          float tong  = hardEdge( vB * 2.3 + tongN, 0.72, 0.050 );
          c = mix( uMat, c, tong );

          // ── leaves, blown to the fringe and out of the walked lines ──────
          float leafF = fbm2( P * 1.75 + 91.0 ) + ( 1.0 - vB ) * 0.11 - trod * 0.34;
          float leaf  = hardEdge( leafF, 0.84, 0.035 );
          c = mix( c, uLeaf, leaf * 0.85 );


          // ── the two fine scales, and why they are albedo ─────────────────
          // This is where the first pass failed hardest. All of its surface
          // detail was carried in the shading normal — and Stylize.js quantises
          // diffuse into bands, so a six degree normal perturbation moves
          // nothing at all unless it happens to land on a band edge. The
          // capture at three metres came back completely, glassily smooth.
          //
          // In a cel-shaded pipeline surface texture has to be ALBEDO, and it
          // has to have edges. Both scales fade to their own mean over a range
          // chosen for their wavelength, which is the distance budget every
          // octave in TerrainMaterial is given for the same reason: albedo
          // finer than a couple of pixels crawls when the camera moves.
          // Three of them, an octave and a bit apart, each with the distance
          // budget its own wavelength earns. Scale matters as much as amplitude:
          // a 32 cm blotch is eleven pixels in the plan framing, and massEdgeW's
          // derivative width across eleven pixels is wider than the whole useful
          // range of the field — so the first attempt at this resolved to mush.
          // Anything meant to survive to fifteen metres has to be most of a
          // metre across.
          float mac  = fbm2( P * 1.30 + 77.0 );         // ~0.8 m scuff blotches
          float macF = 1.0 - smoothstep( 20.0, 46.0, vCam );
          c *= 1.0 + ( hardEdge( mac, 0.60, 0.050 ) * 0.098
                     - hardEdge( 1.0 - mac, 0.62, 0.050 ) * 0.086 ) * macF;

          float mic  = fbm2( P * 4.10 + 19.0 );         // ~24 cm
          float micF = 1.0 - smoothstep( 7.0, 19.0, vCam );
          c *= 1.0 + ( hardEdge( mic, 0.60, 0.032 ) * 0.080
                     - hardEdge( 1.0 - mic, 0.62, 0.032 ) * 0.072 ) * micF;

          float spk  = vn( P * 18.0 + 3.3 );            // ~5.5 cm grit
          float spkF = 1.0 - smoothstep( 3.5, 9.5, vCam );
          c = mix( c, c * vec3( 0.70, 0.685, 0.665 ),
                   hardEdge( spk, 0.76, 0.012 ) * spkF * 0.60 * ( 0.35 + 0.65 * grit ) );
          c = mix( c, uGrit * 1.10,
                   hardEdge( 1.0 - spk, 0.80, 0.012 ) * spkF * 0.35 );

          // Scuff arcs as a whisper of value on the walked ground. Deliberately
          // small — painted bands on ground are how TerrainMaterial drew a
          // contour map twice, and the arcs are mostly carried by the bump.
          float arc = sin( rr * 7.4 + fbm2( P * 0.52 ) * 12.0 );
          c *= 1.0 + arc * 0.055 * trod;

          // Ash and scorch around the hearth. The fire pit itself covers the
          // middle of this; what shows is the halo beyond its stones.
          float ash = 1.0 - smoothstep( 0.95, 2.40, rr );
          c = mix( c, c * vec3( 0.78, 0.765, 0.775 ), ash * 0.32 );

          diffuseColor.rgb *= c;

          gTrod = trod;
          gGrit = grit;
          gBump = ( 0.90 + 0.75 * grit - 0.30 * trod )
                * ( 1.0 - smoothstep( 14.0, 38.0, vCam ) );

          // ── the edge ─────────────────────────────────────────────────────
          // Not an alpha ramp, and deliberately not much of an alpha at all.
          // vB is the clearing's own bare-ground field, baked per vertex from
          // campCoverAt at full radius, so the dirt and the grass can never
          // disagree about where the boundary is. The transition the eye reads
          // is the opaque stubble interlock above; all this does is take the
          // surface out inside a quarter of a metre, at a bare-ground value of
          // 0.04 where the meadow is back to 95% of its blades and the last
          // centimetre is under standing grass either way.
          float rag  = fbm2( P * 1.90 + 41.5 ) - 0.5;
          float ragW = smoothstep( 0.005, 0.06, vB ) * ( 1.0 - smoothstep( 0.10, 0.30, vB ) );
          float alpha = hardEdge( vB * 6.0 + rag * 0.42 * ragW, 0.22, 0.055 );

          // Scuff past the boundary: a few flattened patches under grass that
          // is still standing, which is what the last stride into a camp
          // actually leaves. Capped well under opaque so the blades read over
          // the top of it.
          float outM = ( 1.0 - smoothstep( 0.96, 1.15, vU ) )
                     * hardEdge( fbm2( P * 0.85 + 17.0 ), 0.62, 0.050 );
          alpha = max( alpha, outM * 0.42 );

          // ── build-in ─────────────────────────────────────────────────────
          // A radial wipe, not a global fade. Camp.js eases the clearing's own
          // radius open ahead of the props; the dirt sweeping outward at the
          // same rate is what makes the sequence read as "the ground was
          // cleared" rather than as a group of objects fading in.
          float wipe = smoothstep( 0.0, 0.11,
              uReveal * 1.45 - 0.12 - vU + ( fbm2( P * 1.2 ) - 0.5 ) * 0.16 );
          gAlpha = alpha * wipe;
          // Deliberately no discard here. The normal block below takes
          // screen-space derivatives, and derivatives inside non-uniform
          // control flow are undefined — killing the transparent lanes at the
          // fringe would corrupt the bump on the lanes beside them, which is
          // exactly the band where the ground is most closely looked at.
        }
      `).replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        // Compacted ground is smoother than loose grit. Small, but it is the
        // only thing separating the two masses when the sun is behind cloud.
        roughnessFactor = clamp( 0.99 - 0.10 * gTrod + 0.04 * gGrit, 0.55, 1.0 );
      `).replace('#include <normal_fragment_maps>', /* glsl */`
        #include <normal_fragment_maps>
        if ( gBump > 0.02 ) {
          // Finite differences with a step tied to the pixel footprint, which
          // band-limits the field for free: at 3 m it resolves the grain, at
          // 30 m it has already smoothed it into the mass it belongs to.
          float px = max( fwidth( gP.x ), fwidth( gP.y ) );
          float e  = max( 0.055, px * 1.7 );
          float b0 = bumpF( gP );
          float bx = bumpF( gP + vec2( e, 0.0 ) );
          float bz = bumpF( gP + vec2( 0.0, e ) );
          vec3 wn = vec3( -( bx - b0 ) / e, 0.0, -( bz - b0 ) / e ) * gBump * 0.75;
          normal = normalize( normal + ( viewMatrix * vec4( wn, 0.0 ) ).xyz );
        }
      `).replace('#include <lights_fragment_end>', /* glsl */`
        #include <lights_fragment_end>
        {
          // ── shade: the dirt keeps its own hue ──────────────────────────
          // The plum diagonal that two reviews called the loudest defect in
          // the feature. It is not a noise octave and it is not a bad lerp —
          // it is the stylised cast-shadow mass, and it was found by painting
          // one uniform magenta at a time and re-shooting the plan framing:
          // every mask came back innocent and the stain stayed exactly where
          // the birch's shadow was.
          //
          // Stylize.js appends SHADOW_COOL to lights_fragment_end, which
          // rotates a shadowed pixel's total diffuse toward a violet-blue at
          // constant luminance. On gold grass that lands as shade. On a warm
          // brown it lands on the straight line from brown to violet-blue, and
          // the middle of that line is WINE. Stylize's own comment names the
          // dead zone — "the straight line between those two colours passes
          // through neutral" — and quotes the player asking for exactly this
          // surface to be "a soft yellow or a light brown" instead of grey.
          //
          // So this pulls the shaded total back toward the fragment's OWN hue
          // at the SAME luminance. Not a warm triple invented here, and not a
          // veto of the art direction: value structure stays entirely the
          // shadow's business, the cool mass still cools the disc, and what it
          // can no longer do is change what the ground is made of. Gated on
          // how much direct light the fragment actually received, so lit
          // ground is untouched.
          const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );
          vec3  ind = reflectedLight.indirectDiffuse;
          float il  = dot( ind, LUMA );
          float dl  = dot( reflectedLight.directDiffuse, LUMA );
          float shade = 1.0 - smoothstep( 0.10, 0.80, dl / max( il, 1e-4 ) );
          vec3  d   = reflectedLight.directDiffuse + ind;
          float ld  = dot( d, LUMA );
          vec3  own = diffuseColor.rgb / max( dot( diffuseColor.rgb, LUMA ), 1e-4 );
          // Two corrections beyond the hue, both measured off the probe frame.
          // Shade is lit by the whole sky rather than by one small sun, so it
          // is LESS saturated than the lit surface, not equally saturated in a
          // different hue — without the pull toward white the recovered shadow
          // came back as wet red clay. And it was landing at 0.45 of the lit
          // dirt beside it while the shaded meadow two metres away sat at 0.87
          // of its own lit value; a lift of a fifth puts the disc's shadow in
          // the same key as the meadow's, which is what stops it reading as a
          // hole cut in the ground.
          vec3  tgt = mix( own, vec3( 1.0 ), 0.26 ) * ld * 1.20;
          reflectedLight.indirectDiffuse += mix( d, tgt, 0.85 * shade ) - d;
        }
      `).replace('#include <dithering_fragment>', /* glsl */`
        #include <dithering_fragment>
        gl_FragColor.a *= gAlpha;
      `);
    };


  const lu = { uReveal };
  const patchVert = (sh) => {
      Object.assign(sh.uniforms, lu);
      sh.vertexShader = /* glsl */`
        attribute vec3 aBase;
        attribute float aU;
        uniform float uReveal;
      ` + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        // The same radial wipe the dirt uses, so a stone appears on the frame
        // the dirt reaches it rather than at some unrelated moment.
        float wk = clamp( ( uReveal * 1.45 - 0.12 - aU ) / 0.10, 0.0, 1.0 );
        wk = wk * wk * ( 3.0 - 2.0 * wk );
        transformed = mix( aBase, transformed, wk );
      `);
    };

  const litter = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0.0, flatShading: true,
  });
  litter.userData.uniforms = lu;
  litter.onBeforeCompile = patchVert;

  const litterDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  litterDepth.onBeforeCompile = patchVert;


  _gm = { dirt, litter, litterDepth, u, lu };
  return _gm;
}

export class CampGround {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.mesh = null;
    this.props = null;
    const M = groundMaterials();
    this.u = M.u;
    this.mat = M.dirt;
    this.propMat = M.litter;
    this.propDepth = M.litterDepth;
    this.reveal = 1;
    this._lat = new Map();     // memoised lattice heights
    this._n = new THREE.Vector3();
  }

  // ── the drawn terrain surface, reconstructed exactly ───────────────────────

  /** `world.getHeight` at a LOD-0 lattice node, memoised for the build. */
  _node(I, J) {
    const key = I * 8192 + J;
    let h = this._lat.get(key);
    if (h === undefined) {
      h = this.world.getHeight(I * LOD0_STEP - this.world.half, J * LOD0_STEP - this.world.half);
      this._lat.set(key, h);
    }
    return h;
  }

  /**
   * The height of the terrain *as drawn*: the LOD-0 lattice, triangulated with
   * the same alternating diagonal `Terrain._indexTemplate` uses, interpolated
   * across whichever of the two triangles the point falls in.
   *
   * The parity test is `(I + J) & 1` because a chunk's lattice origin is at
   * lattice index cx*64, and 64 is even — so a chunk-local parity and a world
   * parity are the same parity, and the reconstruction does not need to know
   * where the chunk boundaries are.
   */
  _surfaceY(x, z) {
    const fx = (x + this.world.half) / LOD0_STEP;
    const fz = (z + this.world.half) / LOD0_STEP;
    const I = Math.floor(fx), J = Math.floor(fz);
    const u = fx - I, v = fz - J;
    const h00 = this._node(I, J),     h10 = this._node(I + 1, J);
    const h01 = this._node(I, J + 1), h11 = this._node(I + 1, J + 1);
    if (((I + J) & 1) === 0) {
      // Diagonal runs from (1,0) to (0,1).
      return (u + v <= 1)
        ? h00 + u * (h10 - h00) + v * (h01 - h00)
        : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
    }
    // Diagonal runs from (0,0) to (1,1).
    return (v >= u)
      ? h00 + u * (h11 - h01) + v * (h01 - h00)
      : h00 + u * (h10 - h00) + v * (h11 - h10);
  }

  /**
   * The clearing's boundary radius at angle `a`, recovered from `campCoverAt`
   * rather than re-derived. See decision 1: cover is a smoothstep over
   * [R - w, R], so its 0.5 crossing is at R - w/2 exactly.
   */
  _boundary(cx, cz, a, radius, feather) {
    const ca = Math.cos(a), sa = Math.sin(a);
    // `uCampFloor` (the aiming ghost) lifts the whole field and would make the
    // 0.5 crossing meaningless. It is 0 whenever a camp is actually pitched, so
    // this only ever fires if someone builds the dirt from the aiming state.
    if (campCoverAt(cx, cz) >= 0.5) return radius;
    let lo = radius * 0.35, hi = radius * 1.45;
    for (let i = 0; i < 26; i++) {
      const m = (lo + hi) * 0.5;
      if (campCoverAt(cx + ca * m, cz + sa * m) < 0.5) lo = m; else hi = m;
    }
    return (lo + hi) * 0.5 + feather * 0.5;
  }

  // ── build ──────────────────────────────────────────────────────────────────

  build(x, z, radius, rnd = Math.random) {
    this.dispose();
    this._lat.clear();

    const site = getCampSite();
    const feather = Math.max(0.35, site.w);

    // Draw a fixed, small number of values from the shared stream and seed a
    // local generator from them. The shared `rnd` is consumed by the layout
    // solver immediately after this call, so a module that draws a
    // *variable* number of values from it silently re-rolls where the tent
    // goes every time its own scatter loop is retuned — which makes an A/B of
    // two ground builds an A/B of two different camps.
    let s = 0;
    for (let i = 0; i < 4; i++) s = (s * 65537 + Math.floor(rnd() * 0xffffff) + 1) >>> 0;
    const rng = () => {
      s = (Math.imul(s ^ (s >>> 15), 2246822507) ^ 0x9e3779b9) >>> 0;
      return ((s ^ (s >>> 13)) >>> 0) / 4294967296;
    };

    // Boundary radius per sector, once.
    const R = new Float32Array(SECTORS);
    for (let j = 0; j < SECTORS; j++) {
      R[j] = this._boundary(x, z, (j / SECTORS) * TAU, radius, feather);
    }

    this._buildDisc(x, z, R, feather, rng);
    this._buildLitter(x, z, R, feather, rng);
    this.setReveal(this.reveal);
  }

  _buildDisc(x, z, R, feather, rng) {
    const RINGS = RINGS_IN + RINGS_MID + RINGS_OUT;
    const nVerts = 1 + SECTORS * RINGS;
    const pos = new Float32Array(nVerts * 3);
    const nrm = new Float32Array(nVerts * 3);
    const aB = new Float32Array(nVerts);
    const aU = new Float32Array(nVerts);

    const n = this._n;
    // Hummock phase, so two camps 4 m apart do not share a relief pattern.
    const hx = x * 0.83, hz = z * 0.83;

    const write = (vi, lx, lz, u, uSkirt) => {
      const wx = x + lx, wz = z + lz;
      // Relief: 1–2 cm of hummock at ~1.4 m, faded out at the skirt so the mesh
      // arrives at the terrain rather than at an offset from it.
      const skirt = 1 - smoothstep(1.0, 1.0 + uSkirt, u);
      const hum = (vnoise2(hx + lx * 0.72, hz + lz * 0.72) - 0.5) * 0.026
                + (vnoise2(hx + lx * 1.9 + 31.7, hz + lz * 1.9 - 12.1) - 0.5) * 0.011;
      // Lift profile: flat across the middle, a matted berm just inside the
      // boundary, then down to nothing at the skirt.
      const berm = Math.exp(-Math.pow((u - 0.90) / 0.10, 2));
      const lift = LIFT * (0.35 + 0.65 * skirt) + BERM * berm * skirt + hum * skirt;

      pos[vi * 3] = lx;
      pos[vi * 3 + 1] = this._surfaceY(wx, wz) + lift;
      pos[vi * 3 + 2] = lz;
      // The analytic ground normal, so the dirt shades exactly like the terrain
      // it is lying on. The hummocks are carried in the fragment normal, not
      // here — a 1.4 m bump across a 45 cm cell is not a shape a vertex normal
      // can describe honestly.
      this.world.getNormal(wx, wz, n, 0.9);
      nrm[vi * 3] = n.x; nrm[vi * 3 + 1] = n.y; nrm[vi * 3 + 2] = n.z;
      aB[vi] = 1 - campCoverAt(wx, wz);
      aU[vi] = u;
    };

    // Centre.
    write(0, 0, 0, 0, SKIRT / Math.max(1, R[0]));

    for (let j = 0; j < SECTORS; j++) {
      const a = (j / SECTORS) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const Ra = R[j];
      const uSkirt = SKIRT / Ra;
      const inner = Math.max(0.25, Ra - feather);
      for (let i = 0; i < RINGS; i++) {
        let r;
        if (i < RINGS_IN) {
          // Slightly biased outward so the sliver triangles at the centre — the
          // ground the fire pit stands on anyway — cost the fewest rings.
          const t = (i + 1) / RINGS_IN;
          r = inner * 0.94 * (t * t * 0.45 + t * 0.55);
        } else if (i < RINGS_IN + RINGS_MID) {
          const t = (i - RINGS_IN + 1) / RINGS_MID;
          r = lerp(inner * 0.94, Ra, t);
        } else {
          const t = (i - RINGS_IN - RINGS_MID + 1) / RINGS_OUT;
          r = Ra + SKIRT * t;
        }
        write(1 + j * RINGS + i, ca * r, sa * r, r / Ra, uSkirt);
      }
    }

    // Indices. Winding checked by hand and by tools/winding.mjs: for a fan in
    // +Y, (ring i, sector j) → (ring i, sector j+1) → (ring i+1, sector j) is
    // counter-clockwise seen from above.
    const idx = new Uint32Array(SECTORS * 3 + SECTORS * (RINGS - 1) * 6);
    let p = 0;
    for (let j = 0; j < SECTORS; j++) {
      const j1 = (j + 1) % SECTORS;
      idx[p++] = 0; idx[p++] = 1 + j1 * RINGS; idx[p++] = 1 + j * RINGS;
      for (let i = 0; i < RINGS - 1; i++) {
        const a0 = 1 + j * RINGS + i, b0 = 1 + j1 * RINGS + i;
        idx[p++] = a0; idx[p++] = b0; idx[p++] = a0 + 1;
        idx[p++] = b0; idx[p++] = b0 + 1; idx[p++] = a0 + 1;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aB', new THREE.BufferAttribute(aB, 1));
    g.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    sanitizeNormals(g);
    g.computeBoundingSphere();

    this.u.uCentre.value.set(x, z);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'camp_ground';
    this.mesh.position.set(x, 0, z);
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);
  }

  // ── litter: stones and sticks ────────────────────────────────────────────
  //
  //  The disc reads as flat until something on it casts a shadow. These are the
  //  cheapest possible thing that does: fifty small solids, one draw call, and
  //  they are most of what makes the ground look like ground.
  //
  //  Scattered in clumps rather than uniformly, for the same reason the grass
  //  is: a Poisson-disc scatter of stones reads as a texture, and a handful of
  //  loose groups with bare ground between them reads as stones. Cluster seeds
  //  are placed by golden-angle so the groups themselves never collide.

  _buildLitter(x, z, R, feather, rng) {
    const parts = [];   // { geo }
    const bases = [];   // Vector3 per part, for the wipe
    const us = [];

    const stoneT = [
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.DodecahedronGeometry(1, 0),
    ];
    const twigT = new THREE.CylinderGeometry(1, 0.72, 1, 5, 1, false);
    twigT.rotateZ(Math.PI / 2);      // lie along +X

    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    const boundaryAt = (a) => R[((Math.floor((a / TAU) * SECTORS) % SECTORS) + SECTORS) % SECTORS];

    // Where litter is allowed: on ground the dirt actually covers, outside the
    // fire ring, and out to a little past the boundary where the stubble is.
    const place = (a, r) => {
      const Ra = boundaryAt(a);
      const u = r / Ra;
      if (u > 1.06 || r < 1.25) return null;
      const lx = Math.cos(a) * r, lz = Math.sin(a) * r;
      const bare = 1 - campCoverAt(x + lx, z + lz);
      if (bare < 0.10) return null;
      return { lx, lz, u, bare };
    };

    const addPart = (geo, m, base, u) => {
      const g = geo.clone();
      g.applyMatrix4(m);
      parts.push(g); bases.push(base); us.push(u);
    };

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const tr = new THREE.Vector3();
    const col = new THREE.Color();

    const stone = (lx, lz, u, size) => {
      const wx = x + lx, wz = z + lz;
      const h = size * lerp(0.52, 0.86, rng());
      // Sunk. A stone resting exactly on a surface reads as a stone dropped on
      // to it; a stone with a third of itself below the dirt reads as a stone
      // that has been there.
      const y = this._surfaceY(wx, wz) + LIFT - h * lerp(0.28, 0.46, rng());
      q.setFromEuler(new THREE.Euler(
        (rng() - 0.5) * 0.7, rng() * TAU, (rng() - 0.5) * 0.7));
      sc.set(size * lerp(0.8, 1.25, rng()), h, size * lerp(0.8, 1.25, rng()));
      tr.set(lx, y, lz);
      m4.compose(tr, q, sc);
      const t = rng();
      col.copy(t < 0.42 ? STONE_A : t < 0.74 ? STONE_B : STONE_C);
      // A stone that is a different colour from the one beside it is gravel;
      // a group that shares a cast and varies in value is a rock type.
      const v = lerp(0.80, 1.14, rng());
      col.multiplyScalar(v);
      const geo = stoneT[rng() < 0.6 ? 0 : 1];
      addPart(geo, m4, tr.clone(), u);
      return col.clone();
    };

    const twig = (lx, lz, u, len) => {
      const wx = x + lx, wz = z + lz;
      const rad = lerp(0.011, 0.023, rng());
      const y = this._surfaceY(wx, wz) + LIFT + rad * 0.55;
      q.setFromEuler(new THREE.Euler(
        (rng() - 0.5) * 0.35, rng() * TAU, (rng() - 0.5) * 0.16));
      sc.set(len, rad, rad);
      tr.set(lx, y, lz);
      m4.compose(tr, q, sc);
      addPart(twigT, m4, tr.clone(), u);
      return (rng() < 0.5 ? TWIG_A : TWIG_B).clone().multiplyScalar(lerp(0.85, 1.15, rng()));
    };

    const colours = [];

    // Clumps, and they have to be tight. The version before this one scattered
    // fifty stones of one size across the whole disc at a roughly even spacing,
    // and a critic reading the plan frame called it "an even Poisson spread of
    // same-size grey lumps" — which is exactly the failure the grass system
    // documents: a uniform scatter reads as a texture, and only groups with
    // bare ground between them read as objects. So: one anchor stone per group,
    // clearly larger than everything near it, with small satellites drawn tight
    // around it, and fewer groups than there used to be stones.
    const clumps = 6 + Math.floor(rng() * 4);
    for (let k = 0; k < clumps; k++) {
      const a0 = k * GOLDEN + rng() * 0.4;
      const Ra = boundaryAt(a0);
      // Biased outward. Ground people cross gets swept clear by feet; the stuff
      // they kick out of the way ends up at the edges, which is also where a
      // scatter does the most for the fringe.
      const r0 = lerp(1.7, Ra * 1.02, Math.pow(rng(), 0.55));
      const spread = lerp(0.16, 0.38, rng());
      const anchor = place(a0, r0);
      if (anchor) colours.push(stone(anchor.lx, anchor.lz, anchor.u, lerp(0.155, 0.30, rng())));
      const count = 4 + Math.floor(rng() * 6);
      for (let i = 0; i < count; i++) {
        const a = a0 + (rng() - 0.5) * (spread / Math.max(0.8, r0)) * 2.6;
        const r = r0 + (rng() - 0.5) * spread * 2.2;
        const pt = place(a, r);
        if (!pt) continue;
        if (rng() < 0.80) colours.push(stone(pt.lx, pt.lz, pt.u, lerp(0.040, 0.125, Math.pow(rng(), 1.5))));
        else colours.push(twig(pt.lx, pt.lz, pt.u, lerp(0.16, 0.40, rng())));
      }
    }

    // Loners, so the clumps are not the only thing on the ground. Small — a
    // lone stone the size of an anchor would read as a group of one.
    for (let i = 0; i < 14; i++) {
      const a = rng() * TAU;
      const Ra = boundaryAt(a);
      const pt = place(a, lerp(1.5, Ra * 1.04, Math.sqrt(rng())));
      if (!pt) continue;
      if (rng() < 0.55) colours.push(stone(pt.lx, pt.lz, pt.u, lerp(0.040, 0.095, rng())));
      else colours.push(twig(pt.lx, pt.lz, pt.u, lerp(0.18, 0.46, rng())));
    }

    // A handful of longer sticks. Reads as things dragged in and dropped rather
    // than as gravel, and a 70 cm stick is the one piece of litter with a
    // silhouette you can read at fifteen metres.
    for (let i = 0; i < 8; i++) {
      const a = rng() * TAU;
      const Ra = boundaryAt(a);
      const pt = place(a, lerp(2.0, Ra * 0.94, rng()));
      if (!pt) continue;
      colours.push(twig(pt.lx, pt.lz, pt.u, lerp(0.40, 0.78, rng())));
    }

    if (!parts.length) return;

    let vTotal = 0, iTotal = 0;
    for (const g of parts) {
      vTotal += g.attributes.position.count;
      iTotal += g.index ? g.index.count : g.attributes.position.count;
    }
    const pos = new Float32Array(vTotal * 3);
    const nrm = new Float32Array(vTotal * 3);
    const col3 = new Float32Array(vTotal * 3);
    const base = new Float32Array(vTotal * 3);
    const au = new Float32Array(vTotal);
    const idx = new Uint32Array(iTotal);

    let vo = 0, io = 0;
    for (let k = 0; k < parts.length; k++) {
      const g = parts[k];
      const gp = g.attributes.position, gn = g.attributes.normal;
      const c = colours[k] ?? STONE_A;
      const b = bases[k];
      // Lowest and highest point of this part, for the contact darkening.
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < gp.count; i++) {
        const y = gp.getY(i);
        if (y < lo) lo = y; if (y > hi) hi = y;
      }
      const span = Math.max(1e-4, hi - lo);
      for (let i = 0; i < gp.count; i++) {
        const o = (vo + i) * 3;
        pos[o] = gp.getX(i); pos[o + 1] = gp.getY(i); pos[o + 2] = gp.getZ(i);
        nrm[o] = gn.getX(i); nrm[o + 1] = gn.getY(i); nrm[o + 2] = gn.getZ(i);
        // Occlusion where the solid meets the dirt. This is what a contact
        // shadow does at a scale the shadow map cannot resolve — a 6 cm stone
        // is under a texel in every cascade, so if its footing is not painted
        // in it does not get one.
        const t = (gp.getY(i) - lo) / span;
        const k2 = lerp(0.46, 1.0, smoothstep(0.0, 0.55, t));
        col3[o] = c.r * k2; col3[o + 1] = c.g * k2; col3[o + 2] = c.b * k2;
        base[o] = b.x; base[o + 1] = b.y; base[o + 2] = b.z;
        au[vo + i] = us[k];
      }
      if (g.index) {
        for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
        io += g.index.count;
      } else {
        for (let i = 0; i < gp.count; i++) idx[io + i] = vo + i;
        io += gp.count;
      }
      vo += gp.count;
      g.dispose();
    }
    for (const g of stoneT) g.dispose();
    twigT.dispose();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col3, 3));
    geo.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
    geo.setAttribute('aU', new THREE.BufferAttribute(au, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    sanitizeNormals(geo);
    geo.computeBoundingSphere();

    this.props = new THREE.Mesh(geo, this.propMat);
    this.props.name = 'camp_ground_litter';
    this.props.customDepthMaterial = this.propDepth;
    this.props.castShadow = true;
    this.props.receiveShadow = true;
    this.props.position.set(x, 0, z);
    this.scene.add(this.props);
  }

  setReveal(k) {
    this.reveal = clamp01(k);
    this.u.uReveal.value = this.reveal;
    if (this.mesh) this.mesh.visible = this.reveal > 0.004;
    if (this.props) this.props.visible = this.reveal > 0.02;
  }

  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (this.props) {
      this.scene.remove(this.props);
      this.props.geometry.dispose();
      this.props = null;
    }
    // The materials are NOT disposed. They belong to the module, not to this
    // instance — see `groundMaterials()`. Camp.js's boot pre-warm constructs a
    // CampGround, builds it and disposes it under the loading screen, and if
    // that call took the programs with it the first real camp would pay the
    // compile again.
    this._lat.clear();
  }
}
