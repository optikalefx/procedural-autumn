// ─────────────────────────────────────────────────────────────────────────────
//  Water — ONE surface, everywhere.
//
//  There used to be two: a swept ribbon along the baked centrelines for rivers,
//  and a mesh contoured from the baked water grid for lakes. Two meshes, two
//  materials, two noise fields, two foam models, two shoreline rules — and so
//  they could never agree where they met. Every jagged transition this project
//  has logged was at that seam, and a long list of machinery existed only to
//  paper over it: a RIVER_LIFT constant so the two surfaces would not z-fight
//  where they overlapped, an aLake attribute that flared the ribbon and dived it
//  under the lake mesh so the depth test would hide the join, an 'airborne'
//  guard on one and a perched-lake guard on the other. All of that is gone with
//  the second surface.
//
//  A river is not a different kind of thing from a lake. It is the same water,
//  in a narrower channel, moving faster. So this file builds one mesh, contoured
//  from (water - bed) over the baked grid, and the thing that used to be the
//  difference between the two — flow — is a FIELD the shader samples from a
//  texture rather than a set of vertex attributes on a special mesh. Standing
//  water is velocity zero. See TerrainGen._flowField and shaders/water_surface.js.
//
//  What this file still owns: the geometry, the two distances it carries, and
//  the uniforms. src/shaders/water_surface.js owns the pixels.
//
//  The centreline polylines are NOT built into anything here any more. They stay
//  in the bake because audio emitters, wildlife patrol walks and
//  tools/riverplan.mjs read them (docs/WATER_CONTRACT.md).
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { PALETTE, WORLD } from './WorldConfig.js';
import { fogUniforms } from '../render/Atmosphere.js';
import { clamp01 } from '../core/MathUtils.js';

// ── the lattice ──────────────────────────────────────────────────────────────
// Metres per quad. MEASURED, because the choice is a triangle budget and not a
// taste. The water grid is 2 m per texel and channels in this map run 5-20 m
// wide, so the ideal is to contour at the native grid resolution — but water is
// not the small fraction of the map that assumption needs. It is 22.9% of it:
// 539 321 texels of the 1536 grid have positive depth, mostly in a handful of
// very large basins. Counting the cells a contour would actually emit, with the
// dilation ring included:
//
//     2 m quads   901 888 cells   1.80 M triangles
//     4 m quads   259 871 cells   0.52 M triangles   (0.53 M as it now stands)
//     8 m quads    74 827 cells   0.15 M triangles   (what this replaces)
//
// The scene is 5.36 M triangles, so native resolution is a 34% increase on the
// whole frame for a transparent, double-sided, ray-marching surface. 4 m is four
// times finer than the lattice it replaces, resolves the narrowest channel the
// bake can produce (the water splat has a floor of 1.2 texels of radius, so no
// channel is under about 5 m across), and costs 0.37 M triangles more than the
// lake mesh alone did — which is roughly what the river ribbons cost.
//
// Merging flat interior blocks into coarse quads was measured too: it takes the
// 2 m case to 0.89 M triangles, which is still worse than 4 m and buys a class
// of T-junction crack that only stays invisible while every merged body is
// exactly level. Not worth it.
//
// RE-MEASURED, because the round asked whether the lattice should be refined
// near the waterline and left coarse over open water. It should not, and the
// reason is the same fact stated from the other side: this map's water is
// mostly narrow channels and shallow rims, so the shore band is not a band, it
// is most of the surface. Counted over the drawn quads with the exact shore
// distance below:
//
//   within 4 m of a waterline   51% of drawn quads   +804 k triangles at 2 m
//   within 6 m                  64%                  +1.01 M
//   within 8 m                  72%                  +1.13 M
//
// A 151% increase on the water for the tightest band that is any use, before
// the T-junction stitching a mixed lattice needs. The mesh is not what makes
// the waterline jagged in any case — the waterline is the zero set of
// (surface - bed) evaluated PER PIXEL, and the surface term's contribution to
// its position is measured at the vertex field below: p90 0.63 m.
const SURF_QUAD = 4;
const SURF_CHUNK = 512;      // metres per draw call, for frustum culling
// Depth, in metres, at which the mesh is cut. Negative: the boundary sits on the
// DRY side of the waterline, far enough out that the shoreline fade and the damp
// band both finish inside geometry and neither can ever end on a cell edge.
//
// It is set by uWetBand, and not by taste: the damp margin is a window that
// closes at a depth of -uWetBand, so a contour cut shallower than that ends the
// polygon while the band is still being drawn on it. uWetBand is 1.0 m, and
// this is 0.4 m outside it. Swept anyway, since the round asked — metres of
// mesh boundary the fragment shader draws at alpha > 0.05, map border excluded,
// against the triangle count:
//
//   -0.8   112 m   511 968 tris        -1.4    59 m   531 748 tris
//   -1.1    70 m   522 968 tris        -2.0    37 m   544 370 tris
//
// Nothing here is worth 20 000 triangles either way, and -0.8 would put the cut
// inside the damp band. Unchanged.
const SURF_ISO = -1.4;
// SURF_DILATE_M is gone. It was how far out, in metres of ground, the mesh
// could grow looking for the contour, with the walk stopping wherever the
// terrain had already climbed past SURF_ISO. That criterion is a statement
// about an imported, fictional water level, and it stops in the wrong place on
// both kinds of ground: on a steep bank after one ring, leaving the polygon as
// the visible edge, and on a flat apron never, which is why it needed a cap at
// all. The dilation is now bounded by SURF_DEAD_M, a real distance to the real
// waterline — see the note at the dilation itself.

// Metres a single quad's four corners may disagree about the surface height
// before the quad is considered for the chop. Standing water is level and a
// channel drops a few percent per metre; anything steeper is, allegedly, the
// mesh bridging two bodies across a lip, drawn as a vertical wall of water down
// the rock between them — the floating pale-blue X a critic pass logged in the
// waterfall view.
//
// IT WAS NOT. MEASURED, with tools/_scratch/meshlab.mjs, which walks the welded
// mesh boundary and evaluates the fragment shader's own alpha chain along it.
// This test on its own — corner disagreement, nothing else — threw away 4 551
// quads and left 5 464 metres of mesh boundary drawn at alpha above 0.05, 98%
// of it cell-aligned, 910 m of it at alpha above 0.9. Those are not rims. They
// are HOLES, punched through the middle of running water: 669 of the culled
// quads had two or more wet four-neighbours, 213 held standing water
// themselves, and a sample at (-1024, -1452) sat in 1.56 m of water with the
// bed showing through. That row of straight segments and tan wedges in
// shots/w0-base/river.png is this constant.
//
// What the test was catching was cascades. Removing it entirely leaves 3 686
// quads steeper than 8 m per quad drawn, and the part of them the shader
// actually draws stands p50 1.7 m, p95 3.2 m, max 7.1 m above its own bed. A
// bridging wall stands TENS of metres above the rock; nothing near that
// survives, because the shader's perched guard reads the baked water grid and
// kills it per-pixel. The mesh test was removing steep water lying on steep
// rock, which is what a rapid is.
//
// So the step is now only the first of three conditions, and the other two are
// the shader's own guard restated on the lattice: the cell must be pure
// dilation ring with no baked water within the reach of the texture's linear
// filter, and its lowest corner must stand clear of the lowest ground beneath
// it by more than the 3.5 m at which that guard has fully closed. 246 quads
// meet all three. None of them has a wet neighbour, and none holds water.
const SURF_LEVEL_STEP = 8.0;
// Metres a pure dilation-ring cell may stand above the lowest ground under it
// before it is dropped. Two, because the ring's whole job is to give the
// shoreline fade and the damp band ground to finish on, and both are drawn
// within a metre of the waterline; a ring cell standing higher than a bank is
// not carrying a fade, it is a sheet in the air. See the cull site.
const SURF_RING_HANG = 2.0;
// Signed shore distance is capped here, in metres. Past this the shader only
// wants to know "open water", and a u8-sized number keeps the attribute small.
const SHORE_CAP = 32;
// aSpan is a local maximum of the inside distance over a window this wide, in
// metres, then smoothed by two box blurs of this radius. MEASURED against the
// 16 m block-max field these replace, which every shoreline constant in
// water_surface.js was calibrated on: the pair below reproduces its percentile
// curve to within 0.6 m at every quartile while removing its seams. See the
// table at the field itself.
// Radius, in metres, of the box blur that takes the corner off the exact shore
// field's medial axis. See the sweep at the field itself.
const SHORE_SMOOTH_M = 0;
// Metres of dry-side shore distance past which the fragment shader cannot draw
// anything at all: its outer guard is `alpha *= 1 - smoothstep(2, 9, -aShore)`
// and its damp band is gated at `shoreOut > 3.1`, so at 9 m out both are
// identically zero. Quads entirely beyond this are not emitted. Two metres of
// margin over the shader's 9, because that number lives in
// src/shaders/water_surface.js and belongs to another author — if it grows,
// this has to grow with it, and the note is in docs/INTEGRATION_REQUESTS.md.
const SURF_DEAD_M = 11;
const SPAN_WIN_M = 40;
const SPAN_BLUR_M = 12;

import { SURFACE_VERT, SURFACE_FRAG } from '../shaders/water_surface.js';

export class Water extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Water';
    this.loadLabel = 'Filling the rivers';
    this.group = new THREE.Group();
    this.group.name = 'Water';
    this._meshes = [];
    this._materials = [];
  }

  async init() {
    const { world, scene, preset } = this.ctx;
    if (!world) return;

    // Uniforms — one object, updated once per frame. There is one material now,
    // so there is nothing left for two of them to disagree about.
    // 16, because wEnvReflect's loop bound is 16. It said 24 for a round while
    // the loop capped at 16, so the only dial a preset has over that march
    // overstated its work by half and a sweep of it read as "flat above 8".
    // See the schedule note in src/shaders/water_common.js.
    const reflectSteps = preset?.reflections ? 16 : 0;
    this.shared = {
      uTime:         { value: 0 },
      uDataTex:      { value: world.dataTexture },
      // The flow field. This is what replaces the ribbon's per-vertex distance
      // downstream, tangent, discharge and turbulence.
      uFlowTex:      { value: world.flowTexture },
      uWorldSize:    { value: world.worldSize },
      uDataTexel:    { value: 1 / world.res },
      // ── the hydro field ─────────────────────────────────────────────────
      // src/world/hydroField.js. ONE statement about where the water's edge
      // is, that everything which draws an edge reads — this shader, and
      // TerrainMaterial, which used to derive its own from a different field at
      // a different resolution and drew a second shoreline a metre from this
      // one.
      //
      //   R  depth to test against. Within 18 m of the waterline this is
      //      reconstructed as 0.60 x the signed distance, so its zero set is a
      //      smooth curve by construction and its gradient is a known 0.60
      //      rather than whatever the eroded bed left. Away from the line it is
      //      the real bathymetry, so a lake still deepens toward the middle.
      //   G  signed metres to the waterline, positive inside, capped +/-48. An
      //      exact Euclidean distance transform, so its gradient is 1 and a band
      //      rationed by it has a constant width in metres.
      //   B  wet coverage 0..1. Replaces the -9999 sentinel, which between a wet
      //      texel and a dry one crossed its threshold 1 cm past the texel
      //      centre and so was a binary mask with no antialiasing at all.
      //   A  how OPEN the water is here, in metres: the mean inside distance
      //      over a 12 m neighbourhood. This is what the aSpan vertex attribute
      //      is, derived from the same distance field as everything else here,
      //      so it has no lattice seams and it agrees with the shoreline by
      //      construction rather than by coincidence.
      //
      // RGBA16F at half the bake's resolution with a CPU-built mip chain, so
      // unlike uDataTex it is not a point sample of a 2 m field at every range.
      // Keep uDataTex.r for the reflection march and the sun march: those want
      // real geometry, not a conditioned one.
      uHydroTex:     { value: world.hydroTexture },
      uHydroTexel:   { value: world.hydroTexel },
      uSunDir:       { value: new THREE.Vector3(0.4, 0.5, 0.3) },
      uSunColor:     { value: new THREE.Color(1, 1, 1) },
      uSunLight:     { value: new THREE.Color(1, 1, 1) },
      uAmbient:      { value: new THREE.Color(0.4, 0.45, 0.55) },
      uSkyZenith:    { value: PALETTE.skyZenith.clone() },
      uSkyHorizon:   { value: PALETTE.skyHorizon.clone() },
      uRefGround:    { value: PALETTE.grassGoldDeep.clone().multiplyScalar(0.62) },
      uRefRock:      { value: PALETTE.rockMid.clone().multiplyScalar(0.72) },
      uSnowLine:     { value: 262.0 },
      uReflectSteps: { value: reflectSteps },
      uShallow:      { value: PALETTE.waterShallow.clone() },
      // The palette's deep blue is the colour of a *sample* of deep water, not
      // of a body seen under a bright sky. Taken literally it makes every basin
      // in the map a dark hole, which fails the brief's lifted-blacks target;
      // lifting it a quarter of the way to the shallow tone keeps the hue and
      // gets the value back.
      uDeep:         { value: PALETTE.waterDeep.clone().lerp(PALETTE.waterShallow, 0.26) },
      uFoam:         { value: PALETTE.waterFoam.clone() },
      uSubsurface:   { value: PALETTE.waterSubsurface.clone() },
      uBodyGain:     { value: 1.30 },
      // How much of the water's own hue is imposed on the light coming back out
      // of it. 1.0 is a literal multiply by the body colour; below that the
      // illuminant shows through, which is the whole point.
      uAbsorb:       { value: 1.0 },
      // Chroma of the absorption tint. 1.0 is literal, above that the water
      // holds its blue against a hard amber key the way the plates do.
      uAbsorbPow:    { value: 1.60 },
      // How far the surface reflection is rotated toward the water's hue. The
      // reflection is physically neutral, so this is pure art direction: enough
      // that water stays the cool note in a hot frame, little enough that a dawn
      // sky still lands on it.
      uEnvTint:      { value: 0.25 },
      // How much of the sky a *rough* surface hands back regardless of angle.
      // Physical Fresnel at anything but a grazing angle is 5-8%, which measured
      // two and a half stops under the plates; this is the floor under it, and
      // it is the single dial that decides whether a basin reads as water or as
      // a dark hole. Measured, same framing, back to back, lake patch only:
      //
      //   uSheen 0.88  srgb(117,123,125)  1:1.05:1.07
      //   uSheen 0.66  srgb(110,115,116)  1:1.05:1.05
      //   uSheen 0.00  srgb( 91, 93, 91)  1:1.02:1.00
      //
      // The sheen is what SUPPLIES the blue. Take it away and water goes three
      // stops down and dead neutral. A critic pass recorded distant lakes going
      // slate in the round this was raised in and the obvious move is to put it
      // back: do not. At 420 m the landscape reflection has already faded out
      // and aerial perspective owns most of the pixel, so that measurement
      // belongs to Atmosphere and the grade, not to this dial.
      uSheen:        { value: 0.88 },
      // Metres of damp margin on the dry side of the waterline, measured in
      // NEGATIVE DEPTH. The reference never shows water meeting dry ground on a
      // line; there is always a band of wet substrate between the two, and its
      // absence is what makes a shoreline read as a cut-out however well
      // antialiased the alpha edge is.
      //
      // MEASURED DOWN from 3.1. docs/WATER_ART_SPEC.md 3.5 puts the plates' damp
      // band at 0.7-1.1 m on an ordinary bank and reaches 3.1 m only on the very
      // shallowest, and the banks author reached the same number from the other
      // direction by rasterising how far inland of its own waterline the surface
      // was drawing. It is a DEPTH and it reads as an AREA, which is why the
      // shader also caps it in metres of ground.
      uWetBand:      { value: 1.0 },
      // How dark the damp band lands, as a fraction of the lit gold the bank is
      // made of. docs/WATER_ART_SPEC.md 3.5: against blue water the band is
      // 0.8-1.9 stops below the meadow with the meadow's hue held. MEASURED
      // rather than derived: uRefGround is the palette gold multiplied by the
      // key and the sun's intensity and comes out about 2.8x the luminance of
      // the ground actually rendered under it, so the arithmetic has to be run
      // backwards from a capture. At 0.80 alpha, 0.15 of it composites to 0.55
      // of the ground, which is 0.86 stops down — the middle of the plate's
      // range. The previous shader drew this band PALE, on the strength
      // of plate 5 where the water beside it is white; every frame in this map
      // except the foot of a fall has blue water beside it, and a pale fringe
      // there is one of the two sources of the flat pale slab in 'mouth'.
      uDampDark:     { value: 0.20 },
      uCoolTint:     { value: new THREE.Vector3(0.96, 1.00, 1.03) },
      // Strength of the cool governor (see wCoolGovern). 0 disables it and water
      // goes the colour of the light; 1 holds it hard against any warm key at
      // all. Half is enough to keep a river blue-violet through a golden hour
      // without it looking painted on at noon.
      uCoolGain:     { value: 0.55 },
      // Radians of view angle per output pixel. Everything band-limited — ripple
      // scales, the specular lobe, the reflection march — is measured against the
      // footprint this implies.
      uPixelScale:   { value: 0.0016 },
      // Shared with the falls: the one dial for every aerated surface. See
      // wFoamLight in water_common.js for why foam gets its own illuminant.
      uFoamGain:     { value: 1.55 },
      uFoamCut:      { value: 0.74 },
      uWind:         { value: new THREE.Vector2(0.62, 0.36) },
    };

    this.material = new THREE.ShaderMaterial({
      lights: true,
      uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
                              fogUniforms(), this.shared),
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      fog: true,
      // Resolve depth ties with the bed in DEPTH, not in world space. The
      // surface shader used to lift its geometry by up to 2.2 m to clear the
      // ill-conditioned plane-meets-facet intersection; that kept coverage
      // exactly right and drew it up to two metres too high, so at a grazing
      // angle the sheet stood off its own bank and read as a floating river.
      // See the long note at the lift in shaders/water_surface.js. A polygon
      // offset does the same job in the only space where it cannot move a
      // silhouette. Slope-scaled, because the tie is worst where the bed is
      // nearly parallel to the sheet, which is exactly where the depth slope
      // is largest.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this._materials.push(this.material);

    this._buildSurface();

    scene.add(this.group);
  }

  // The geometry itself is built by buildWaterSurface below, which is a plain
  // function over plain arrays and knows nothing about three.js or about this
  // class. That is deliberate: it is what lets tools/_scratch/meshlab.mjs
  // measure THIS code rather than a reimplementation of it, headless, in a
  // third of a second, over the real bake.
  _buildSurface() {
    const built = buildWaterSurface(this.ctx.world);
    for (const c of built.chunks) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(c.pos, 3));
      geo.setAttribute('aShore', new THREE.BufferAttribute(c.shore, 1));
      geo.setAttribute('aSpan', new THREE.BufferAttribute(c.span, 1));
      geo.setIndex(new THREE.BufferAttribute(c.index, 1));
      geo.computeBoundingSphere();
      geo.boundingSphere.radius *= 1.05;
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.receiveShadow = true;
      mesh.renderOrder = 4;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = 'WaterChunk';
      this.group.add(mesh);
      this._meshes.push(mesh);
    }
    this.surfaceQuads = built.quads;
    this.surfaceTriangles = built.triangles;
    this.waterField = built.field;
    const world = this.ctx.world;
    if (typeof world.setWaterField === 'function') world.setWaterField(built.field);
  }


  // ── per frame ──────────────────────────────────────────────────────────────
  update(dt, elapsed) {
    const u = this.shared;
    if (!u) return;
    const { lighting, sky } = this.ctx;
    u.uTime.value = elapsed;

    // Angular pixel size, for the band limits. Recomputed every frame because
    // both the field of view and the drawing buffer can change under us.
    const cam = this.ctx.camera, rend = this.ctx.renderer;
    if (cam && rend) {
      // Scaled by internalScale: the scene rasterises at PostFX's internal
      // resolution, not the drawing buffer's (see UpscalePass.js).
      const h = rend.getDrawingBufferSize(this._tmpSize ??= new THREE.Vector2()).y
                * (this.ctx.engine?.internalScale ?? 1);
      if (h > 0) {
        u.uPixelScale.value = 2 * Math.tan(cam.fov * Math.PI / 360) / h;
      }
    }

    const sun = lighting?.sun;
    if (sun) {
      u.uSunColor.value.copy(sun.color);
      u.uSunLight.value.copy(sun.color).multiplyScalar(sun.intensity);
    }
    if (lighting?.sunDir) u.uSunDir.value.copy(lighting.sunDir);

    const hemi = lighting?.hemi;
    if (hemi) {
      // Match three's hemisphere irradiance for an up-facing surface: mostly
      // sky, a little bounce. Water lit any other way drifts out of step with
      // the terrain it sits in.
      u.uAmbient.value.copy(hemi.groundColor).lerp(hemi.color, 0.78)
        .multiplyScalar(hemi.intensity);
    }

    // Sky gradient for the reflection. Read defensively — Sky is another
    // author's module and its uniform names are not a contract.
    const su = sky?.uniforms;
    const zen = su?.uZenith?.value ?? su?.uSkyZenith?.value;
    const hor = su?.uHorizon?.value ?? su?.uSkyHorizon?.value;
    if (zen?.isColor) u.uSkyZenith.value.copy(zen);
    if (hor?.isColor) u.uSkyHorizon.value.copy(hor);
    else if (lighting?.fogNear) u.uSkyHorizon.value.copy(lighting.fogNear);

    // Reflected land is lit by the same sun; tie it to the key so a dawn lake
    // does not reflect a golden-hour hillside. This is also the colour the damp
    // band is drawn from, so the band warms and cools with the bank beside it.
    if (sun) {
      const k = Math.min(1.6, 0.35 + sun.intensity * 0.22);
      u.uRefGround.value.copy(PALETTE.grassGoldDeep).multiply(sun.color).multiplyScalar(k * 0.9);
      u.uRefRock.value.copy(PALETTE.rockMid).multiply(sun.color).multiplyScalar(k * 0.95);
    }
    void dt;
  }

  dispose() {
    for (const m of this._meshes) m.geometry.dispose();
    for (const m of this._materials) m.dispose();
    this.ctx.scene?.remove(this.group);
    this._meshes.length = 0;
  }
}

/**
 * The water surface: a mesh over the baked water grid, cut on a contour of
 * (water - bed).
 *
 * Pure: takes the world's fields, returns chunk arrays, a triangle count and
 * the surface field WorldData is handed. `debug`, if given, is filled with
 * every intermediate the build decided on, for the offline instrument.
 *
 * Everything here is a statement about ONE field. The cells that get geometry,
 * the height each vertex sits at, the two distances the vertices carry and the
 * field handed to WorldData at the end are all derived from the same depth
 * raster, so nothing downstream can disagree about where the water is.
 *
 * ── the boundary is a contour, not a cell edge ──────────────────────────────
 * Cells wholly inside emit a plain quad; the rim is cut by marching squares on
 * the depth field at SURF_ISO with the crossing point interpolated along each
 * lattice edge, so the boundary polyline follows a terrain contour and its
 * vertices land anywhere on an edge rather than only on lattice points. The
 * visible waterline is not this boundary in any case — it is a per-pixel depth
 * fade against the terrain, and the boundary sits metres outside it on the dry
 * side so the fade always finishes inside geometry.
 *
 * ── the two distances ───────────────────────────────────────────────────────
 * aShore is a SIGNED chamfer, in metres, positive inside the water. It is what
 * lets the shader ration a shoreline term by a real horizontal distance
 * instead of by depth-over-gradient, which is exact on a bank and explodes on
 * a flat apron — and this map is mostly flat apron. Two of the shipped pale
 * slabs were terms rationed by that quantity running unrationed.
 *
 * aSpan is how open the water is here: the local maximum of the inside
 * chamfer, so it is the half-width of a channel and the cap on a lake. It is
 * what the ribbon's aWidth attribute was, derived from the grid instead of
 * from a polyline, and it is why a 1.5 m brook and a 60 m river can share one
 * set of shoreline constants.
 */
export function buildWaterSurface(world, debug = null) {
  const R = world.res;
  const half = world.half;
  const texel = world.texel ?? (world.worldSize / R);

  const S = Math.max(1, Math.round(SURF_QUAD / texel));   // grid texels per quad
  const quadM = S * texel;
  const G = Math.floor(R / S);                            // quads per side
  const DRY = -9999;

  // ── coarse pass: is there water in this quad, and at what level? ─────────
  //
  // TWO masks, and the difference between them is a defect that has now been
  // shipped twice in two different colours.
  //
  //   hasW  the baked grid says something about the water surface here. It is
  //         what the mesh is built over, because a cell whose surface is a
  //         few centimetres under its own bed still has to carry the right
  //         level for its neighbours to interpolate against.
  //   wet   there is actually water standing here: surface above bed. This is
  //         the one the shore chamfer is measured from, so that a distance to
  //         the waterline is a distance to where the water visibly ENDS.
  //
  // 19 121 texels of this bake are the first and not the second — the shallow
  // aprons the fill leaves round every basin. Measuring the chamfer off hasW
  // hands those a POSITIVE shore distance while their depth is negative,
  // which is a contradiction, and every shoreline term that rations itself by
  // "how far out on the dry side am I" then reads zero and runs unrationed
  // across the whole apron. That is a slab in the foreground of 'mouth',
  // whatever colour the band happens to be painted.
  const level = new Float32Array(G * G).fill(DRY);
  const hasW = new Uint8Array(G * G);
  const wet = new Uint8Array(G * G);
  // The deepest texel under each quad. Used only to decide how far the
  // dilation may grow — see the note at the vertex field for why the CONTOUR
  // may not be cut on a quantity gathered this widely.
  const bedLo = new Float32Array(G * G).fill(Infinity);
  for (let cz = 0; cz < G; cz++) {
    for (let cx = 0; cx < G; cx++) {
      let n = 0, sum = 0, lo = Infinity, standing = 0;
      for (let j = 0; j < S; j++) {
        const row = (cz * S + j) * R;
        for (let i = 0; i < S; i++) {
          const gi = row + cx * S + i;
          const h = world.height[gi];
          if (h < lo) lo = h;
          const v = world.water[gi];
          if (v < -9000) continue;
          n++; sum += v;
          if (v > h) standing = 1;
        }
      }
      const k = cz * G + cx;
      bedLo[k] = lo;
      if (!n) continue;
      hasW[k] = 1;
      wet[k] = standing;
      level[k] = sum / n;
    }
  }

  // ── drop stray specks ───────────────────────────────────────────────────
  // The baked water grid leaves isolated cells wherever the fill caught a
  // local pit. Each one becomes a slab of water sitting in dry meadow, and a
  // critic pass logged three in one frame as evidence of a broken mask. A body
  // that small has no shoreline, no depth and no reflection — it is a
  // puddle-shaped bug.
  //
  // On area ALONE it would also delete channels, which is new: at 8 m quads a
  // 5 m channel was never resolved in the first place, and at 4 m a 30 m reach
  // of one is 8 cells. So the test is area AND compactness — a puddle is small
  // in both axes, a channel fragment is long in one. Anything elongated
  // survives whatever its area.
  {
    const MIN_CELLS = Math.max(3, Math.round(120 / (quadM * quadM)));
    const MIN_EXTENT = Math.round(24 / quadM);
    const seen = new Uint8Array(G * G);
    const stack = new Int32Array(G * G);
    const comp = new Int32Array(G * G);
    // Walked over hasW, judged on wet. A component is thrown away if it holds
    // no standing water at all — an apron the fill flagged and then left dry,
    // which would otherwise draw a ring of damp band in the middle of a
    // meadow — or if it is a puddle.
    for (let k0 = 0; k0 < G * G; k0++) {
      if (!hasW[k0] || seen[k0]) continue;
      let sp = 0, n = 0, standing = 0;
      let xlo = G, xhi = -1, zlo = G, zhi = -1;
      stack[sp++] = k0; seen[k0] = 1;
      while (sp > 0) {
        const k = stack[--sp];
        comp[n++] = k;
        if (wet[k]) standing++;
        const cx = k % G, cz = (k / G) | 0;
        if (cx < xlo) xlo = cx; if (cx > xhi) xhi = cx;
        if (cz < zlo) zlo = cz; if (cz > zhi) zhi = cz;
        if (cx > 0 && hasW[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack[sp++] = k - 1; }
        if (cx < G - 1 && hasW[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack[sp++] = k + 1; }
        if (cz > 0 && hasW[k - G] && !seen[k - G]) { seen[k - G] = 1; stack[sp++] = k - G; }
        if (cz < G - 1 && hasW[k + G] && !seen[k + G]) { seen[k + G] = 1; stack[sp++] = k + G; }
      }
      const extent = Math.max(xhi - xlo, zhi - zlo) + 1;
      if (!standing || (n < MIN_CELLS && extent < MIN_EXTENT)) {
        for (let i = 0; i < n; i++) {
          wet[comp[i]] = 0; hasW[comp[i]] = 0; level[comp[i]] = DRY;
        }
      }
    }
  }

  // ── the shore distance: an EXACT Euclidean transform, at the NATIVE grid ─
  // aShore is a signed horizontal distance to the waterline, and the shader
  // rations five separate terms by it — a band width, an interior exemption,
  // a fetch, a ceiling on the per-pixel estimate, and the outer alpha guard
  // that decides where the mesh stops being water at all. So its errors are
  // not softened anywhere; they are the shape of what gets drawn.
  //
  // It used to be a 3-4-5 chamfer over the QUAD grid, and it was wrong in
  // three ways at once, all measured with tools/_scratch/meshlab.mjs against
  // an exact transform of the same waterline:
  //
  //   quantised   a quad counted as wet if ANY of its four texels was, so the
  //               zero of aShore sat up to 5.7 m OUT on the dry side, handing
  //               a positive shore distance to ground whose depth is negative
  //               — the same contradiction the note at `wet` above describes,
  //               arriving again by a different route.
  //   anisotropic 3-4-5 overstates a pure diagonal by 8%, and the quad-level
  //               chamfer quantises to 4 m steps on top of that.
  //   blurred     the vertex took the MEAN over the four quads touching it,
  //               a one-cell box blur of a field whose gradient is supposed
  //               to be exactly 1.
  //
  //   RMS error against exact, inside the 8 m band where it is used:  3.00 m
  //   mean angle between the field gradient either side of a lattice line:
  //   23.3 deg, on a distance field whose gradient should not turn at all.
  //
  // That last number IS the faceting the round was called for. The shader's
  // own comment says the trouble with aShore is that it is "a lattice
  // quantity interpolated linearly across triangles, so its level sets are
  // straight segments with a kink at every triangle edge" — but linear
  // interpolation of a TRUE distance field on a 4 m lattice is second-order
  // accurate and its kink is (h^2/8)/r, which on a 10 m radius bend is 20 cm.
  // Almost none of the 23 degrees was the interpolation. It was the field.
  //
  // Felzenszwalb-Huttenlocher: exact squared Euclidean distance, O(N), two
  // separable passes of a lower-parabola envelope. Run at the 2 m grid, not
  // the 4 m one, because the waterline it has to be a distance TO is the
  // shader's per-pixel depth test on the 2 m bake and nothing coarser can
  // agree with that. Measured at 1536^2: 138 ms for both signs.
  //
  // ── AND IT IS NO LONGER RUN WHEN THE WORLD ALREADY HAS ONE ──────────────
  //
  // src/world/hydroField.js computes the same transform, of the same waterline,
  // 40 ms earlier in the same constructor, and publishes it as its `sdf`
  // channel. Two exact Euclidean transforms of one curve, in two files that did
  // not know about each other, were 138 of Water.js's 350 ms and 163 of
  // hydroField's 329.
  //
  // MEASURED, tools/_scratch/meshbench.mjs, 15 reps of each path interleaved on
  // the shipped 1536 bake:
  //
  //                                 min      median
  //   buildWaterSurface exact      501 ms    586 ms
  //   buildWaterSurface hydro      208 ms    266 ms
  //   ratio                         0.42      0.45
  //
  // Read the RATIO, not the milliseconds. This machine had another author's
  // ablation, a bake and a bake-watch on it for the whole session and never
  // went quiet, so both columns carry that load; the ratio is stable across
  // four runs at three different load levels (0.41, 0.43, 0.44, 0.49) and the
  // absolute numbers are not. Against the 350 ms this file's own header records
  // on a quiet machine that is about 155 ms, and the 138 ms attributed to the
  // transform does not account for all of it: the exact path also allocates
  // three Float32Array(2.36 M) and a Float64 scratch pair per build, and the
  // collection of those is the rest.
  //
  // docs/WATER_SMOOTH_STATE.md flagged the pair and asked
  // somebody to measure how far apart they are before merging them. Here is
  // that measurement, from tools/_scratch/sdfdiverge.mjs, taken at the 4 m
  // lattice points this file actually evaluates on and restricted to vertices a
  // drawn quad touches, with both fields clamped to SHORE_CAP:
  //
  //                        |hydro - exact|
  //   band  |sdf| <= 8 m    p50 0.39   p90 2.02   p99 8.96 m
  //   ring   -15..-8 m      p50 0.14   p90 0.70   p99 5.71 m
  //
  // The p99 is not noise and it is not the blur: it is the two CLEANINGS. This
  // file's transform is seeded from the RAW texel mask — every 6 m puddle in
  // the bake is in it, so it hands a positive shore distance to the middle of a
  // pond whose quads the speck rule above has already thrown away — while
  // hydroField's is seeded from the cleaned mask, which fills pinholes, deletes
  // bodies under 40 m2 and fills dry islands under 40 m2. Every disagreement
  // over 6 m is one of those, and they are all on water this mesh does not
  // draw: the worst, 33 m at (516, 60), is a dry island in a lake that
  // hydroField fills and this transform did not.
  //
  // The decision that had to be checked before swapping is the DEAD-QUAD CULL,
  // because it is the one place where being wrong deletes visible water: the
  // fragment shader's outer guard is on hydro (`1 - smoothstep(2, 9, -HY.g)`)
  // and this file culls on its own field at SURF_DEAD_M = 11, so a
  // disagreement bigger than that 2 m of margin is a pixel the shader wants to
  // draw with no triangle under it. Measured over all 293 083 mesh vertices:
  //
  //   shader wants to draw (hydro > -9 m)        250 155
  //   ...and the exact field would cull it             0
  //   geometry kept where the shader draws nothing 15 227
  //
  // Zero in the direction that costs water, and 15 227 vertices of dead ring in
  // the direction that costs nothing but memory — so the exact field was never
  // buying safety here, it was buying slack. Reading hydro instead makes the
  // cull and the guard the same number by construction, which is the thing
  // docs/WATER_SMOOTH_STATE.md said a future round would otherwise "discover
  // the hard way".
  //
  // What the attribute is still used for is worth knowing before worrying about
  // the 4 m storage: water_surface.js has moved every shoreline term onto HY.g
  // and HY.a, so aShore now feeds exactly one line of the vertex shader
  // (`smoothstep(3.0, 25.0, aShore)`, the swell fade) plus this file's own
  // dilation and cull. Nothing left reads it at a precision a 4 m sample of a
  // distance field cannot carry: the interpolation error of a true distance
  // field on a 4 m lattice is (h^2/8)/r, 20 cm on a 10 m bend, which is the
  // argument fourteen lines above and it applies to the source grid too.
  //
  // The exact path below is KEPT, not deleted, and runs whenever the caller
  // hands over a world with no hydro field — tools/_scratch/meshlab.mjs and
  // meshtime.mjs both build a `world` literal straight off the bake. A tool
  // that silently measured a different field from the shipped one would be the
  // instrument failure docs/CRITIC_PROTOCOL.md lists most of.
  const FAR = 1e9;
  const exactSdf = () => {
    const N = R * R;
    const D = Math.max(R, R);
    const f = new Float64Array(D), dd = new Float64Array(D);
    const vpar = new Int32Array(D), zpar = new Float64Array(D + 1);
    // 1-D squared EDT of the sampled function f, into dd.
    const pass1d = (n) => {
      let k = 0; vpar[0] = 0; zpar[0] = -Infinity; zpar[1] = Infinity;
      for (let q = 1; q < n; q++) {
        let sIt = ((f[q] + q * q) - (f[vpar[k]] + vpar[k] * vpar[k])) / (2 * q - 2 * vpar[k]);
        while (sIt <= zpar[k]) {
          k--;
          sIt = ((f[q] + q * q) - (f[vpar[k]] + vpar[k] * vpar[k])) / (2 * q - 2 * vpar[k]);
        }
        k++; vpar[k] = q; zpar[k] = sIt; zpar[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (zpar[k + 1] < q) k++;
        const dq = q - vpar[k];
        dd[q] = dq * dq + f[vpar[k]];
      }
    };
    const edt = (seed) => {
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = seed[i] ? 0 : FAR;
      for (let x = 0; x < R; x++) {
        for (let y = 0; y < R; y++) f[y] = out[y * R + x];
        pass1d(R);
        for (let y = 0; y < R; y++) out[y * R + x] = dd[y];
      }
      for (let y = 0; y < R; y++) {
        const row = y * R;
        for (let x = 0; x < R; x++) f[x] = out[row + x];
        pass1d(R);
        for (let x = 0; x < R; x++) out[row + x] = dd[x];
      }
      return out;
    };
    // The SAME definition of wet the mesh uses, one level down: surface above
    // bed. Measured at the texel, so the zero of this field is the curve the
    // fragment shader draws and not a 4 m staircase around it.
    const wetT = new Uint8Array(N);
    const dryT = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const v = world.water[i];
      const w = (v > -9000 && v > world.height[i]) ? 1 : 0;
      wetT[i] = w; dryT[i] = 1 - w;
    }
    const dIn = edt(dryT);    // inside water: distance to the nearest dry texel
    const dOut = edt(wetT);   // outside: distance to the nearest wet texel
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // Half a texel off each side, because the boundary between a wet texel
      // and a dry one lies BETWEEN their centres, not on either. Without it
      // the field reads a full texel too large on both sides and its zero set
      // is not the waterline but a pair of curves a metre either side of it.
      // src/world/hydroField.js does the same subtraction and says the same
      // thing; the two fields have to agree about where zero is.
      const din = Math.sqrt(dIn[i]) * texel - texel * 0.5;
      const dout = Math.sqrt(dOut[i]) * texel - texel * 0.5;
      out[i] = wetT[i] ? Math.min(din, SHORE_CAP) : -Math.min(dout, SHORE_CAP);
    }
    // ── the one thing exactness costs, and the sweep that priced it ─────
    // Being right about the distance made the field TURN FASTER. Measured
    // across every interior lattice line of the drawn surface, as the angle
    // between the field gradient in the two cells either side:
    //
    //                     1-8 m inside     1-8 m outside    |grad| jump, in band
    //   quad chamfer        31.0 deg          22.1 deg           0.279
    //   exact, 2 m          35.1 deg          31.1 deg           0.249
    //
    // Two things are in that. One is the medial axis, where a distance field is
    // genuinely not differentiable — on a 6 m brook the skeleton is 3 m from
    // the bank, inside the band. The other is not a defect of this field at
    // all: an exact distance to a JAGGED waterline has a jagged gradient, and
    // this map's waterline is jagged (waterlab reports `fine` at 26-60%). The
    // chamfer's smoother gradient was a 4 m box blur of a shoreline it could
    // not resolve, and the smoothness was borrowed from not knowing where the
    // shoreline was — a 3.00 m RMS, 34.0 m worst-case not-knowing. Smoothing
    // the DISTANCE to a rough shore is drawing a smooth band around a rough
    // edge; the edge stays rough and the band stops lining up with it.
    //
    // A separable box blur rounds the ridge. It also moves the ZERO SET,
    // which is the one thing that must not move, by O(r^2 * curvature) — nil
    // against a straight bank and largest on a tight headland. Swept, at the
    // 2 m grid, over the 8 m band where the field is used:
    //
    //   radius   band RMS err   band kink   zero-set shift, p50 / p99
    //     0 m        0.81 m        34.0 deg      0.51 / 2.27 m   <- shipped
    //     2 m        0.99 m        30.8 deg      0.67 / 2.55 m
    //     4 m        1.35 m        26.8 deg      1.00 / 3.23 m
    //     6 m        1.78 m        23.3 deg      1.42 / 4.12 m
    //
    // (the shift at radius 0 is the 4 m lattice's own linear interpolation;
    // the blur adds to it about one for one.)
    //
    // SET TO ZERO, and the sweep is kept because the trade is not obvious.
    // The ridge is on the MEDIAL AXIS, and every term the shader rations by
    // aShore is already saturated there: at the skeleton of a channel of
    // half-width w the ceiling `max(vShore,0) + 6` stands at w + 6, `bankT`
    // has clamped to zero, `bodyCore` is a hundredth. The ZERO SET is not
    // saturated anywhere — it is where the damp-band gate and the outer alpha
    // guard live — and a metre of it costs a metre of shoreline. Trading an
    // exact waterline for a smoother skeleton is trading the part that is
    // read for the part that is not.
    //
    // SHORE_SMOOTH_M is that radius in metres. Left in place, not deleted,
    // because the sweep is the argument.
    if (SHORE_SMOOTH_M > 0) {
      const r = Math.max(1, Math.round(SHORE_SMOOTH_M / texel));
      const acc = new Float32Array(R);
      const inv = 1 / (2 * r + 1);
      for (let y = 0; y < R; y++) {
        const row = y * R;
        let sm = 0;
        for (let i = -r; i <= r; i++) sm += out[row + (i < 0 ? 0 : i > R - 1 ? R - 1 : i)];
        for (let i = 0; i < R; i++) {
          acc[i] = sm * inv;
          sm += out[row + Math.min(R - 1, i + r + 1)] - out[row + Math.max(0, i - r)];
        }
        out.set(acc, row);
      }
      for (let x = 0; x < R; x++) {
        let sm = 0;
        for (let i = -r; i <= r; i++) sm += out[(i < 0 ? 0 : i > R - 1 ? R - 1 : i) * R + x];
        for (let i = 0; i < R; i++) {
          acc[i] = sm * inv;
          sm += out[Math.min(R - 1, i + r + 1) * R + x] - out[Math.max(0, i - r) * R + x];
        }
        for (let i = 0; i < R; i++) out[i * R + x] = acc[i];
      }
    }
    return out;
  };
  // hydroField's sdf if the world carries one, this file's own exact transform
  // if it does not. `off` is the sample offset in texels, and it is NOT the
  // same for the two: see the note at sdfAt.
  const HY = world.hydro && world.hydro.sdf ? world.hydro : null;
  const sdf = HY ? HY.sdf : exactSdf();
  const SR = HY ? HY.res : R;
  const ST = HY ? HY.texel : texel;
  const SOFF = HY ? 0.25 : 0;
  // Bilinear read of the signed field at a world position, in texel space.
  //
  // NO half-texel offset, and the comment that used to be here got that exactly
  // backwards. Half a texel is the correction a GPU *sampler* needs, because a
  // sampler addresses texel CENTRES in a 0..1 UV space. There is no such
  // convention in a JS array: `sdf[i]` is the value at world `i*texel - half`,
  // full stop, which is the same indexing `TerrainGen` writes with and the same
  // one `TerrainMaterial`'s uvw correction exists to reproduce.
  //
  // MEASURED by running this block verbatim over a synthetic half-plane at 2 m
  // texels. With the -0.5 in place the whole field is shifted (+1, +1) m in
  // world space, and because the error is a shift rather than a scale it
  // REVERSES around a headland:
  //
  //     bank            wet-side err   dry-side err   zero set
  //     wet x <= X0        +2.00 m         0.00 m      +1.00 m
  //     wet x >= X1         0.00 m        -2.00 m      -1.00 m
  //
  // So at the true waterline the shader's vShore read +2 m on a north- or
  // west-facing bank and -2 m on a south- or east-facing one. The two terms
  // this file's own comments say live at the zero set — the damp-band gate
  // `smoothstep(1.1, 3.1, shoreOut)` and the outer guard
  // `1 - smoothstep(2, 9, -vShore)` — were opening and closing on ground one to
  // two metres from where they were meant to, with the sign of the error
  // flipping around every point of land.
  //
  // ── ...and it is -0.25 for the HYDRO field, which is not a contradiction ──
  //
  // The paragraph above is about a JS array indexed at its own resolution, and
  // it is still right for that. hydroField.js stores at HALF the bake's
  // resolution by AREA-AVERAGING pairs, so its sample k is the mean of full-res
  // texels 2k and 2k+1 and therefore represents the point (k + 0.25) hydro
  // texels from the corner, not k and not (k + 0.5). WorldData.microDetail
  // reads the same field with the same -0.25 and records the measurement that
  // set it — a synthetic half-plane whose true waterline is at x = -55.000
  // lands at -54.000 with -0.5 and at -55.000 exactly with -0.25 — and
  // TerrainMaterial's `uvh` carries the GPU form of the same quarter texel.
  // Three readers of one field, one offset; getting this wrong here would have
  // slid every mesh decision a metre against every pixel decision.
  const sdfAt = (wx, wz) => {
    let gx = (wx + half) / ST - SOFF, gz = (wz + half) / ST - SOFF;
    gx = gx < 0 ? 0 : gx > SR - 1.001 ? SR - 1.001 : gx;
    gz = gz < 0 ? 0 : gz > SR - 1.001 ? SR - 1.001 : gz;
    const x0 = gx | 0, z0 = gz | 0, tx = gx - x0, tz = gz - z0;
    const i0 = z0 * SR + x0, i1 = i0 + SR;
    const v = (sdf[i0] * (1 - tx) + sdf[i0 + 1] * tx) * (1 - tz)
            + (sdf[i1] * (1 - tx) + sdf[i1 + 1] * tx) * tz;
    // hydroField caps at 48 m and this file at SHORE_CAP; clamp on read so the
    // attribute, the dilation reach and the span seed keep the range every
    // constant downstream was calibrated against whichever field fed them.
    return v > SHORE_CAP ? SHORE_CAP : v < -SHORE_CAP ? -SHORE_CAP : v;
  };

  // ── how open the water is: a SMOOTH local maximum of the inside distance ─
  // aSpan is the half-width of the body — what the swept ribbon's aWidth
  // attribute was — and the shader turns it straight into a band width
  // (`shoreBand = clamp(vSpan * 0.30, 0.30, 1.6)`) and a bank fraction
  // (`bankT`). It was a maximum over 16 m blocks, taken again over the eight
  // neighbouring blocks, read back bilinearly. Bilinear interpolation of a
  // block-constant field is C0 and nothing more: measured over the drawn
  // surface, the second difference of aSpan across one cell averaged 0.199 m
  // and reached 17.19 m — a seam that moves shoreBand by 5.1 m in one step,
  // on a 16 m grid that has nothing to do with the water.
  //
  // Same quantity, no blocks: a true running maximum over a square window
  // (van Herk / Gil-Werman, three comparisons per cell per axis, O(N)), then
  // two separable box blurs. The max is exact and seamless; the blur is what
  // makes it differentiable. Window and blur chosen to REPRODUCE the old
  // field's distribution rather than to change it, because every shoreline
  // constant in water_surface.js was calibrated against those numbers:
  //
  //             p05   p25   p50   p75   p95      2nd difference across a
  //                                               cell: mean / max, metres
  //   blocks    4.0   6.8  12.8  25.6  32.0          0.199 / 17.19
  //   this      1.6   3.2   7.3  17.9  32.0          0.095 /  8.13
  //
  // The seam halved, and so did the field — and the SECOND of those is not a
  // side effect, it is the block field being wrong. `din` was a chamfer of
  // the QUAD-level wet mask, and a quad counted as wet if any one of its four
  // texels was, so a 6 m channel came out three quads across and its
  // half-width read 8 m instead of 3. Every brook in the map was therefore
  // handed a lake's `shoreBand` — the 1.6 m cap — which is precisely the
  // failure water_surface.js says the attribute exists to prevent: "A fixed
  // one metre band is the whole surface of a two-metre brook, which is how a
  // quiet creek ends up rendered as solid whitewater". This field is measured
  // at 2 m against the real waterline, so a brook now reads as a brook.
  // FLAGGED to the shader author in docs/INTEGRATION_REQUESTS.md, because it
  // moves a number five of their terms are calibrated against.
  //
  // Checked the way it is used: aSpan must be an UPPER estimate of the local
  // half-width or bankT goes negative in open water. 0.54% of wet cells come
  // out below their own exact inside distance, by at most 0.9 m.
  const SPAN_WIN = Math.max(1, Math.round(SPAN_WIN_M / quadM));
  const SPAN_BLUR = Math.max(1, Math.round(SPAN_BLUR_M / quadM));
  const span = new Float32Array(G * G);
  {
    // Inside distance at the quad centres. Zero outside the water, so the max
    // below can never import a span from across a bank.
    for (let cz = 0; cz < G; cz++) {
      for (let cx = 0; cx < G; cx++) {
        const v = sdfAt(-half + (cx + 0.5) * quadM, -half + (cz + 0.5) * quadM);
        span[cz * G + cx] = v > 0 ? v : 0;
      }
    }
    // van Herk running max along a line: forward-cumulative and
    // backward-cumulative maxima over blocks of W, combined.
    const line = new Float32Array(G), pre = new Float32Array(G), suf = new Float32Array(G);
    const tmp = new Float32Array(G);
    const W = SPAN_WIN, rW = W >> 1;
    const runMax = () => {
      for (let i = 0; i < G; i++) pre[i] = (i % W === 0) ? line[i] : Math.max(pre[i - 1], line[i]);
      for (let i = G - 1; i >= 0; i--) suf[i] = (i === G - 1 || (i + 1) % W === 0) ? line[i] : Math.max(suf[i + 1], line[i]);
      for (let i = 0; i < G; i++) {
        const a = i - rW, b = i - rW + W - 1 < G - 1 ? i - rW + W - 1 : G - 1;
        tmp[i] = a < 0 ? pre[b] : Math.max(suf[a], pre[b]);
      }
    };
    for (let cz = 0; cz < G; cz++) {
      const row = cz * G;
      for (let i = 0; i < G; i++) line[i] = span[row + i];
      runMax();
      span.set(tmp, row);
    }
    for (let cx = 0; cx < G; cx++) {
      for (let i = 0; i < G; i++) line[i] = span[i * G + cx];
      runMax();
      for (let i = 0; i < G; i++) span[i * G + cx] = tmp[i];
    }
    // ...and a separable box blur, twice, which is a quadratic B-spline: C1,
    // which a maximum is not, and that is the whole point of it being here.
    const blur = (r) => {
      const acc = new Float32Array(G);
      for (let cz = 0; cz < G; cz++) {
        const row = cz * G;
        let s2 = 0;
        for (let i = -r; i <= r; i++) s2 += span[row + Math.min(G - 1, Math.max(0, i))];
        for (let i = 0; i < G; i++) {
          acc[i] = s2 / (2 * r + 1);
          s2 += span[row + Math.min(G - 1, i + r + 1)] - span[row + Math.max(0, i - r)];
        }
        span.set(acc, row);
      }
      for (let cx = 0; cx < G; cx++) {
        let s2 = 0;
        for (let i = -r; i <= r; i++) s2 += span[Math.min(G - 1, Math.max(0, i)) * G + cx];
        for (let i = 0; i < G; i++) {
          acc[i] = s2 / (2 * r + 1);
          s2 += span[Math.min(G - 1, i + r + 1) * G + cx] - span[Math.max(0, i - r) * G + cx];
        }
        for (let i = 0; i < G; i++) span[i * G + cx] = acc[i];
      }
    };
    blur(SPAN_BLUR); blur(SPAN_BLUR);
  }
  const spanAt = (vx, vz) => {
    // Vertex-centred read of a cell-centred field: the four cells touching
    // the vertex, equally weighted, which is the bilinear sample at the
    // corner and is continuous by construction.
    const cx0 = Math.max(0, Math.min(G - 1, vx - 1)), cx1 = Math.max(0, Math.min(G - 1, vx));
    const cz0 = Math.max(0, Math.min(G - 1, vz - 1)), cz1 = Math.max(0, Math.min(G - 1, vz));
    return (span[cz0 * G + cx0] + span[cz0 * G + cx1]
          + span[cz1 * G + cx0] + span[cz1 * G + cx1]) * 0.25;
  };

  // ── dilate outward, carrying the water level with it ────────────────────
  // These cells are never SEEN as water unless the ground genuinely lies below
  // the surface there; they exist so neither the shoreline fade nor the damp
  // band on the dry side of it ever coincides with the edge of the mesh.
  //
  // REWRITTEN AROUND THE ONE FACT THAT DECIDES IT. The ring used to grow a
  // fixed number of steps, unconditionally for the first two and then only
  // while an imported, fictional water level still stood above the ground —
  // and water_surface.js measured what that costs: "27% of the cells where
  // the ring runs out still have depth above the iso value at the boundary;
  // growing the ring from 4 rings to 32 only takes that to 7.6%, and costs a
  // third of the surface's triangles doing it".
  //
  // But the shader does not need the ring to reach the end of the fiction. It
  // needs it to reach the point where the shader itself stops drawing, which
  // is SURF_DEAD_M out on the dry side and is a DISTANCE — the exact one this
  // file now computes. So grow on that, and the question of where the ring
  // runs out stops existing: the mesh covers the drawable set and one cell of
  // margin, everywhere, on a steep bank and on a flat apron alike.
  //
  // MEASURED with tools/_scratch/meshlab.mjs, which walks the welded mesh
  // boundary and evaluates the fragment shader's own alpha along it. Metres
  // of boundary drawn at alpha > 0.05, excluding the map border, which is the
  // end of the world and not a defect of this file:
  //
  //   rings, level-fiction stop, min 2      5 487 m   546 711 triangles
  //   distance stop at SURF_DEAD_M             37 m   531 748 triangles
  //
  // ...and 100% of wet cells now carry geometry, against 99.86% before: 213
  // cells of standing water, 3 408 m2, had no triangle over them at all.
  const mask = Uint8Array.from(hasW);
  {
    // One cell of margin past the dead line, so the emit loop's own erosion —
    // it refuses any cell one of whose four corners touches no mask cell —
    // cannot eat into the drawable set.
    const reach = SURF_DEAD_M + quadM;
    const rings = Math.max(2, Math.ceil(reach / quadM) + 1);
    let frontier = [];
    for (let k = 0; k < G * G; k++) if (hasW[k]) frontier.push(k);
    for (let ring = 0; ring < rings && frontier.length; ring++) {
      const next = [];
      for (const k of frontier) {
        const cx = k % G, cz = (k / G) | 0;
        for (let dz = -1; dz <= 1; dz++) {
          const z = cz + dz; if (z < 0 || z >= G) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx; if (x < 0 || x >= G) continue;
            const nk = z * G + x;
            if (mask[nk]) continue;
            mask[nk] = 1;
            level[nk] = level[k];
            // Grow while this cell is still inside the set the shader can put
            // a pixel in. Chebyshev rings are square and the criterion is
            // round, so the corners cost nothing.
            if (sdfAt(-half + (x + 0.5) * quadM, -half + (z + 0.5) * quadM) > -reach) next.push(nk);
          }
        }
      }
      frontier = next;
    }
  }

  // hasW, grown by one cell. The shader's perched guard reads the baked water
  // grid through a LINEAR filter, so a cell one texel from baked water still
  // sees baked > -40 and the guard does not fire there. Anything the mesh
  // decides on the strength of that guard has to use the same reach.
  const hasWD = new Uint8Array(G * G);
  for (let cz = 0; cz < G; cz++) {
    for (let cx = 0; cx < G; cx++) {
      const k = cz * G + cx;
      if (!hasW[k]) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const z = cz + dz; if (z < 0 || z >= G) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx; if (x < 0 || x >= G) continue;
          hasWD[z * G + x] = 1;
        }
      }
    }
  }

  // ── the vertex field, computed once for the whole lattice ───────────────
  // Vertex value = mean over the (up to four) mesh cells touching it, so the
  // surface is continuous across chunk borders. Hoisted out of the chunk loop
  // because it is not only the mesh's own business: this grid, plus `drawn`
  // below, IS the water surface. Handing exactly these arrays to WorldData at
  // the end is what stops getWaterHeight deriving a second, different surface
  // from the same bake.
  const VG = G + 1;
  const vLevel = new Float32Array(VG * VG);
  const vShore = new Float32Array(VG * VG);
  const vSpan = new Float32Array(VG * VG);
  const vDepth = new Float32Array(VG * VG).fill(-1e9);
  const vOk = new Uint8Array(VG * VG);
  for (let vz = 0; vz < VG; vz++) {
    for (let vx = 0; vx < VG; vx++) {
      // REAL WATER WINS. A vertex takes its level from the wet cells touching
      // it if there are any, and only falls back to the dilation ring when
      // there are none.
      //
      // This is the whole of the missing-quad defect. A ring cell's level is a
      // fiction: the flood that grew the ring copied it from whichever wet
      // cell the walk reached it from. That is fine in open country and wrong
      // wherever two limbs of a meander pass within a couple of ring widths of
      // each other, which on a sinuous river is constantly — the two rings
      // overlap, and a vertex that averages a ring cell fed by the upstream
      // limb with the real water of the downstream one lands metres between
      // them. Averaged in, that fiction drags the surface DOWN below the bed
      // in mid-channel, so the terrain covers the quad and a flat wedge of
      // riverbed appears lying across the water with water on both sides of
      // it; and where it drags two corners apart by more than the level-step
      // cull allows, the quad is thrown away and the wedge is a hole instead.
      // Both were visible in the same frame from a chase camera over a
      // meandering reach, and neither is terrain: hiding the water in one page
      // load leaves a smooth, continuous, unbroken channel behind.
      let n = 0, lv = 0, wn = 0, wlv = 0;
      for (let dz = -1; dz <= 0; dz++) {
        const cz = vz + dz; if (cz < 0 || cz >= G) continue;
        for (let dx = -1; dx <= 0; dx++) {
          const cx = vx + dx; if (cx < 0 || cx >= G) continue;
          const k = cz * G + cx;
          if (!mask[k]) continue;
          n++; lv += level[k];
          if (wet[k]) { wn++; wlv += level[k]; }
        }
      }
      if (!n) continue;
      const vi = vz * VG + vx;
      vOk[vi] = 1;
      vLevel[vi] = wn ? wlv / wn : lv / n;
      // ...and where there is real water AT THE VERTEX, at the native grid,
      // take it from there instead of from the cell means. Both statements
      // are 'real water wins'; this one is made at 2 m rather than 4 m, and
      // the difference is a 4 m box filter that was being applied to the one
      // term the waterline is the zero set of.
      //
      // It matters more than its size suggests. The visible waterline is
      // (surface - bed) = 0 with the bed sampled per pixel, so an error e in
      // the surface moves the line by e/g, and g on this map's aprons is 1:30.
      // MEASURED against the bake's own water surface, sampled within 3 m of
      // the waterline, over 161 476 points:
      //
      //                          |level error|         implied waterline move
      //                        p50    p90    p99        p50    p90    p99
      //   cell means          0.01   0.42   1.63       0.03   0.88   4.98 m
      //   native, this        0.00   0.32   1.40       0.01   0.63   4.12 m
      //
      // Four texel reads per vertex, inside a loop that is already here.
      if (wn) {
        let ws = 0, wv = 0;
        const gx = vx * S, gz = vz * S;
        for (let dz = -1; dz <= 0; dz++) {
          const tz = gz + dz; if (tz < 0 || tz >= R) continue;
          for (let dx = -1; dx <= 0; dx++) {
            const tx = gx + dx; if (tx < 0 || tx >= R) continue;
            const gi = tz * R + tx;
            const v = world.water[gi];
            if (v > -9000 && v > world.height[gi]) { ws++; wv += v; }
          }
        }
        if (ws) vLevel[vi] = wv / ws;
      }
      // Read where the vertex IS, not averaged over the quads around it. The
      // averaging was a one-cell box blur on a field whose gradient is one by
      // construction, and it cost 0.9 m of the 3.00 m RMS error on its own.
      vShore[vi] = sdfAt(-half + vx * quadM, -half + vz * quadM);
      vSpan[vi] = spanAt(vx, vz);
      // Depth at the vertex, against the LOWEST GROUND WITHIN ONE QUAD of it.
      // The contour is cut on this field and the shader's per-pixel shoreline
      // fade is cut on the same difference sampled per pixel, so the two have
      // to be statements about the same surface — and the window this is
      // gathered over is exactly how far they are allowed to disagree.
      //
      // A little generosity is right and free: the visible waterline is the
      // per-pixel fade, so a mesh a metre too big costs nothing while a mesh a
      // metre too small cuts the water off inside its own edge, and on a 5 m
      // channel crossing a 4 m lattice a point sample can land on the bank and
      // delete the channel.
      //
      // MEASURED, and this is where the generosity has to stop: taken over the
      // four QUADS touching a vertex — an 8 m box, each quad already a minimum
      // over its own texels — a vertex on a bank beside a 3 m channel reports
      // three metres of depth. The contour then never crosses the iso value
      // anywhere near the bank, every cell in the dilation ring emits a full
      // quad, and the mesh ends on a straight cell edge with the shoreline
      // fade still saturated. That is the row of hard pale wedges along the
      // far bank in the 'river' framing: not a foam term, not a colour — the
      // polygon itself, uncut. One quad, centred on the vertex, is 4 m of
      // slack and holds the disagreement inside the fade.
      const tx0 = Math.max(0, vx * S - (S >> 1)), tx1 = Math.min(R - 1, vx * S + (S >> 1));
      const tz0 = Math.max(0, vz * S - (S >> 1)), tz1 = Math.min(R - 1, vz * S + (S >> 1));
      let lo = Infinity;
      for (let tz = tz0; tz <= tz1; tz++) {
        const row = tz * R;
        for (let tx = tx0; tx <= tx1; tx++) {
          const h = world.height[row + tx];
          if (h < lo) lo = h;
        }
      }
      vDepth[vi] = vLevel[vi] - lo;
    }
  }

  // Which quads actually became triangles. Set in the emit loop rather than
  // predicted here, so it can never claim surface the mesh does not have.
  const drawn = new Uint8Array(G * G);

  // ── emit, chunked for frustum culling ───────────────────────────────────
  const perChunk = Math.max(8, Math.round(SURF_CHUNK / quadM));
  const chunks = Math.ceil(G / perChunk);
  const vmap = new Int32Array((perChunk + 1) * (perChunk + 1));
  let quadCount = 0, tris = 0;
  const outChunks = [];
  let cullVOk = 0, cullStep = 0, cullNp = 0, cullDead = 0, cullHang = 0;

  // Corners are walked 00 -> 01 -> 11 -> 10, which is the reverse of the
  // natural order and is what the quad emission always used; keep it, or every
  // triangle faces down. Inside corners contribute themselves, and every edge
  // whose two ends disagree contributes the point where the depth field
  // crosses SURF_ISO. Fanned from the first vertex, so a wholly-inside cell is
  // exactly the two triangles it would have been.
  const CX = [0, 0, 1, 1], CZ = [0, 1, 1, 0];
  const edgeMap = new Map();
  const poly = new Int32Array(8);

  for (let bz = 0; bz < chunks; bz++) {
    for (let bx = 0; bx < chunks; bx++) {
      const cz0 = bz * perChunk, cx0 = bx * perChunk;
      const cz1 = Math.min(G, cz0 + perChunk), cx1 = Math.min(G, cx0 + perChunk);
      vmap.fill(-1);
      edgeMap.clear();
      const pos = [], shoreA = [], spanA = [], idx = [];

      const vert = (vx, vz) => {
        const li = (vz - cz0) * (perChunk + 1) + (vx - cx0);
        const hit = vmap[li];
        if (hit >= 0) return hit;
        const vi = vz * VG + vx;
        if (!vOk[vi]) return -1;
        const id = pos.length / 3;
        pos.push(-half + vx * quadM, vLevel[vi], -half + vz * quadM);
        shoreA.push(vShore[vi]);
        spanA.push(vSpan[vi]);
        vmap[li] = id;
        return id;
      };

      // The point on the lattice edge where depth crosses the iso value, with
      // everything the vertex carries interpolated to it. Canonicalised, so
      // the two cells sharing an edge produce one vertex from one arithmetic
      // rather than two that nearly agree and split the surface along it.
      const cross = (ax0, az0, bx0, bz0) => {
        const swap = bz0 < az0 || (bz0 === az0 && bx0 < ax0);
        const ax = swap ? bx0 : ax0, az = swap ? bz0 : az0;
        const bx2 = swap ? ax0 : bx0, bz2 = swap ? az0 : bz0;
        const ai = az * VG + ax, bi = bz2 * VG + bx2;
        const key = ai * 2 + (az === bz2 ? 1 : 0);
        const hit = edgeMap.get(key);
        if (hit !== undefined) return hit;
        const fa = vDepth[ai], fb = vDepth[bi];
        let t = (SURF_ISO - fa) / (fb - fa);
        t = t < 0.03 ? 0.03 : t > 0.97 ? 0.97 : t;
        const id = pos.length / 3;
        pos.push(-half + (ax + (bx2 - ax) * t) * quadM,
                 vLevel[ai] + (vLevel[bi] - vLevel[ai]) * t,
                 -half + (az + (bz2 - az) * t) * quadM);
        shoreA.push(vShore[ai] + (vShore[bi] - vShore[ai]) * t);
        spanA.push(vSpan[ai] + (vSpan[bi] - vSpan[ai]) * t);
        edgeMap.set(key, id);
        return id;
      };

      for (let cz = cz0; cz < cz1; cz++) {
        for (let cx = cx0; cx < cx1; cx++) {
          const kc = cz * G + cx;
          if (!mask[kc]) continue;
          const ci = [cz * VG + cx, (cz + 1) * VG + cx,
                      (cz + 1) * VG + cx + 1, cz * VG + cx + 1];
          if (!vOk[ci[0]] || !vOk[ci[1]] || !vOk[ci[2]] || !vOk[ci[3]]) { cullVOk++; continue; }

          // A water surface does not stand on end. Reject any cell whose
          // corners disagree about where the surface is by more than a step:
          // the baked grid marks the pool above a lip and the pool below it as
          // water, sixty metres apart in height, and one quad joining them is
          // a near-vertical wall of water hanging down a cliff face. Two of
          // them across one gorge is the floating pale-blue X a critic pass
          // logged in the waterfall view.
          let lo = Infinity, hi = -Infinity;
          for (let q = 0; q < 4; q++) {
            const L = vLevel[ci[q]];
            if (L < lo) lo = L;
            if (L > hi) hi = L;
          }
          if (hi - lo > SURF_LEVEL_STEP && !hasWD[kc]
              && lo - bedLo[kc] > 3.5) { cullStep++; continue; }

          // ── and the ring may not hang ────────────────────────────────────
          //
          // The test above catches a quad that stands ON END. This one catches
          // the far commoner thing, which stands perfectly level and is just as
          // wrong: a ring cell lying flat, several metres up in the air, over
          // ground that has fallen away underneath it.
          //
          // The contour is cut at SURF_ISO = -1.4 m, which is a bound on how
          // far the surface may go UNDER the ground. There has never been a
          // bound the other way, and downhill of a channel there needs to be
          // one, because the ring carries the water's level outward while the
          // hill drops away from it: the depth field the contour tests grows
          // instead of crossing the iso, so the polygon never closes and the
          // mesh runs the full SURF_DEAD_M of ring. MEASURED on the bank of the
          // reach at (615, -765), sampling straight down the fall line from the
          // last baked-wet texel: the mesh carries a level of 49.9 over ground
          // at 46.6, and four metres further down, 50.3 over 43.4 — a sheet of
          // water geometry standing seven metres in the air.
          //
          // It is not a small defect and it is invisible from above, which is
          // why it survived: in plan it is a band a few metres wide beside the
          // river, and the alpha ramps that are supposed to withdraw it are all
          // functions of PLAN distance. Seen along the hill it is the whole
          // hillside — a metre of ground costs a metre of screen when you are
          // looking down the slope, and Fresnel at that angle hands back the
          // sky at almost full strength however low the alpha is. It is the
          // slab of water lying on the mountainside in every eye-level frame of
          // this map.
          //
          // Bounded on `hasWD`, so this only ever removes cells the bake itself
          // does not call water: over a real body, however deep, hasWD is set
          // and nothing here fires.
          // On `hasW`, the cell's OWN baked water, and not on the one-cell
          // growth `hasWD` used above. hasWD exists because the shader reads
          // the baked grid through a linear filter and a cell one texel out
          // still sees water in it; that is the right reach for a per-pixel
          // guard and the wrong one here, where the question is whether the
          // BAKE put water in this cell. It did not, and the bake already
          // refuses to write channel water more than three metres above its own
          // bed — so a cell it declined, standing higher than a bank above the
          // ground, is exactly the geometry that has no business existing.
          if (!hasW[kc] && lo - bedLo[kc] > SURF_RING_HANG) { cullHang++; continue; }

          // A quad whose four corners are ALL further out on the dry side
          // than the shader's outer alpha guard reaches is multiplied by
          // exactly zero over its whole area — bilinear interpolation of four
          // values below the threshold cannot rise above it — and the damp
          // band is gated by the same distance, so nothing else can draw
          // there either. MEASURED over the map: 23 370 quads, 46 740
          // triangles, 8.5% of the surface, rendering nothing.
          if (vShore[ci[0]] < -SURF_DEAD_M && vShore[ci[1]] < -SURF_DEAD_M
           && vShore[ci[2]] < -SURF_DEAD_M && vShore[ci[3]] < -SURF_DEAD_M) { cullDead++; continue; }

          let np = 0;
          for (let q = 0; q < 4; q++) {
            const qn = (q + 1) & 3;
            const inA = vDepth[ci[q]] > SURF_ISO;
            const inB = vDepth[ci[qn]] > SURF_ISO;
            if (inA) poly[np++] = vert(cx + CX[q], cz + CZ[q]);
            if (inA !== inB) {
              poly[np++] = cross(cx + CX[q], cz + CZ[q], cx + CX[qn], cz + CZ[qn]);
            }
          }
          if (np < 3) { cullNp++; continue; }
          for (let q = 1; q < np - 1; q++) idx.push(poly[0], poly[q], poly[q + 1]);
          drawn[kc] = 1;
          quadCount++;
        }
      }
      if (!idx.length) continue;

      outChunks.push({
        pos: new Float32Array(pos),
        shore: new Float32Array(shoreA),
        span: new Float32Array(spanA),
        index: (pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx)),
      });
      tris += idx.length / 3;
    }
  }

  // ── publish the surface, so nothing has to guess at it ──────────────────
  // Every gameplay query about water — the chase boom floor, wildlife spawn
  // rejection, grass and cover scatter, the camper's fording drag and its
  // audio — goes through WorldData.getWaterHeight, which was a nearest-texel
  // point sample of the raw bake. This mesh is not a point sample of the raw
  // bake: it coarsens the grid into quads, dilates outward so the shoreline
  // fade has geometry to finish inside, cuts its rim on a depth contour, and
  // averages each vertex over the quads that touch it. Two derivations of one
  // field disagreed under 91% of drawn water shallower than 15 cm and under
  // 41 m of it at (-768, 832).
  //
  // So hand over the field the mesh was actually built from. levelAt evaluates
  // the same triangles the renderer draws, from the same numbers, so it cannot
  // drift.
  const origin = -half;
  const iso = SURF_ISO;
  const field = {
    level: vLevel,
    depth: vDepth,
    drawn,
    G, quadM, origin, iso,
    /**
     * Height of the drawn water surface at world (x, z), or null where the
     * mesh does not cover the point. Two tests, matching the two things the
     * emit loop does: the cell has to have emitted geometry at all, and the
     * point has to be on the inside of the contour.
     */
    levelAt(x, z) {
      const fx = (x - origin) / quadM, fz = (z - origin) / quadM;
      if (!(fx >= 0 && fz >= 0 && fx <= G && fz <= G)) return null;
      const cx0 = Math.min(G - 1, Math.floor(fx)), cz0 = Math.min(G - 1, Math.floor(fz));
      // On a lattice line up to four quads share the point; they share the
      // vertices that decide it too, so this is a lookup, not a search.
      const bx = fx - cx0 < 1e-6 ? -1 : 0, bz = fz - cz0 < 1e-6 ? -1 : 0;
      let best = null;
      for (let ix = bx; ix <= 0; ix++) {
        const cx = cx0 + ix; if (cx < 0) continue;
        for (let iz = bz; iz <= 0; iz++) {
          const cz = cz0 + iz; if (cz < 0) continue;
          if (!drawn[cz * G + cx]) continue;
          const u = fx - cx, v = fz - cz;
          const i00 = cz * VG + cx, i10 = i00 + 1;
          const i01 = (cz + 1) * VG + cx, i11 = i01 + 1;
          const dp = (vDepth[i00] * (1 - u) + vDepth[i10] * u) * (1 - v)
                   + (vDepth[i01] * (1 - u) + vDepth[i11] * u) * v;
          if (dp <= iso) continue;
          const y = (vLevel[i00] * (1 - u) + vLevel[i10] * u) * (1 - v)
                  + (vLevel[i01] * (1 - u) + vLevel[i11] * u) * v;
          if (best === null || y > best) best = y;
        }
      }
      return best;
    },
  };
  // Everything the mesh decided, for tools/_scratch/meshlab.mjs. Handed out
  // rather than recomputed, so the instrument measures this code and not a
  // model of it — the one habit in docs/CRITIC_PROTOCOL.md that would have
  // caught four of the five confidently-wrong measurements it lists.
  if (debug) Object.assign(debug, {
    G, VG, quadM, origin, S, R,
    mask, wet, hasW, drawn, level,
    vLevel, vShore, vSpan, vDepth, vOk,
    // sdf is whichever field fed this build, so SR/ST come with it: it is the
    // bake's resolution on the exact path and HALF that on the hydro path, and
    // an instrument that indexed it at R either way would be reading a
    // quarter of the map at four times the scale and reporting it as a result.
    sdf, sdfAt, span, sdfRes: SR, sdfTexel: ST, sdfFromHydro: !!HY,
    cullVOk, cullStep, cullNp, cullDead, cullHang,
  });

  void clamp01;
  return { chunks: outChunks, quads: quadCount, triangles: tris, field };
}

void WORLD;
