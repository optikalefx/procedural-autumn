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
//     4 m quads   259 871 cells   0.52 M triangles
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
const SURF_QUAD = 4;
const SURF_CHUNK = 512;      // metres per draw call, for frustum culling
// Depth, in metres, at which the mesh is cut. Negative: the boundary sits on the
// DRY side of the waterline, far enough out that the shoreline fade and the damp
// band both finish inside geometry and neither can ever end on a cell edge.
const SURF_ISO = -1.4;
// ...and how far out, in metres of ground, the mesh may grow looking for that
// contour. The walk stops early wherever the terrain has already climbed past
// SURF_ISO, which on any bank steeper than about 1:6 is the first ring, so this
// only costs anything on a genuinely flat apron — and a flat apron is exactly
// where a mesh that stops short leaves the shoreline fade unfinished on a
// straight cell edge. Measured over the whole map, taking it from 8 m to 16 m
// moves the cell count by 8%.
const SURF_DILATE_M = 12;
// Metres a single quad's four corners may disagree about the surface height
// before the quad is thrown away. Standing water is level and a channel drops a
// few percent per metre; anything steeper is the mesh bridging two bodies across
// a lip, and it draws as a vertical wall of water down the rock between them.
// Scaled to the quad, because the old fixed 2.5 m was calibrated for 8 m quads:
// at 4 m it would let a 60% chute through, which is a waterfall.
// RAISED, from a value calibrated for a surface that was only ever standing
// water. A lake is level; a channel is not, and the unified surface is both. At
// 2 m per quad a reach dropping 50% — which the carve makes wherever a river
// runs off a bench — trips a test written to catch a mesh bridging two pools
// sixty metres apart in height, and every quad it throws away is a hole in the
// middle of a river with the bed showing through. The case it was written for
// is caught per-pixel now, and better: the shader's 'perched' guard reads the
// baked water grid, so a surface hanging down a cliff between two bodies has no
// baked water under it and goes to zero alpha whatever the mesh does. This
// stays only as a backstop against the sixty-metre case, which no channel can
// reach.
const SURF_LEVEL_STEP = 8.0;
// Signed shore distance is capped here, in metres. Past this the shader only
// wants to know "open water", and a u8-sized number keeps the attribute small.
const SHORE_CAP = 32;

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
    const reflectSteps = preset?.reflections ? 24 : 0;
    this.shared = {
      uTime:         { value: 0 },
      uDataTex:      { value: world.dataTexture },
      // The flow field. This is what replaces the ribbon's per-vertex distance
      // downstream, tangent, discharge and turbulence.
      uFlowTex:      { value: world.flowTexture },
      uWorldSize:    { value: world.worldSize },
      uDataTexel:    { value: 1 / world.res },
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
    });
    this._materials.push(this.material);

    this._buildSurface();

    scene.add(this.group);
  }

  /**
   * The water surface: a mesh over the baked water grid, cut on a contour of
   * (water - bed).
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
  _buildSurface() {
    const world = this.ctx.world;
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

    // ── distance to the nearest dry cell, in metres (two-pass chamfer) ───────
    // Computed on the undilated wet mask, so it is a real distance to the
    // waterline. Signed: the second sweep runs the same chamfer outward over the
    // dry side, which is what gives the damp band a horizontal reach it cannot
    // derive from depth.
    const FAR = 1e6;
    const din = new Float32Array(G * G);
    const dout = new Float32Array(G * G);
    for (let k = 0; k < G * G; k++) {
      din[k] = wet[k] ? FAR : 0;
      dout[k] = wet[k] ? 0 : FAR;
    }
    const chamfer = (d) => {
      for (let cz = 0; cz < G; cz++) {
        for (let cx = 0; cx < G; cx++) {
          const k = cz * G + cx;
          let v = d[k];
          if (cx > 0) v = Math.min(v, d[k - 1] + 1);
          if (cz > 0) v = Math.min(v, d[k - G] + 1);
          if (cx > 0 && cz > 0) v = Math.min(v, d[k - G - 1] + 1.41);
          if (cx < G - 1 && cz > 0) v = Math.min(v, d[k - G + 1] + 1.41);
          d[k] = v;
        }
      }
      for (let cz = G - 1; cz >= 0; cz--) {
        for (let cx = G - 1; cx >= 0; cx--) {
          const k = cz * G + cx;
          let v = d[k];
          if (cx < G - 1) v = Math.min(v, d[k + 1] + 1);
          if (cz < G - 1) v = Math.min(v, d[k + G] + 1);
          if (cx < G - 1 && cz < G - 1) v = Math.min(v, d[k + G + 1] + 1.41);
          if (cx > 0 && cz < G - 1) v = Math.min(v, d[k + G - 1] + 1.41);
          d[k] = v;
        }
      }
    };
    chamfer(din);
    chamfer(dout);
    const cap = SHORE_CAP / quadM;
    const shore = new Float32Array(G * G);
    for (let k = 0; k < G * G; k++) {
      const v = wet[k] ? Math.min(din[k], cap) : -Math.min(dout[k], cap);
      shore[k] = v * quadM;
    }

    // ── how open the water is: a local maximum of the inside chamfer ─────────
    // Sampled on a coarse grid and read back bilinearly. A running max over a
    // wide neighbourhood at full resolution is two million cells times fifty
    // taps at load time; a block maximum plus its eight neighbours is O(N) and
    // is more than smooth enough for a quantity that only ever scales a band
    // width by a factor of two.
    const CB = Math.max(1, Math.round(16 / quadM));         // block, in cells
    const SG = Math.ceil(G / CB);
    const blockMax = new Float32Array(SG * SG);
    for (let k = 0; k < G * G; k++) {
      if (!wet[k]) continue;
      const cx = (k % G) / CB | 0, cz = ((k / G) | 0) / CB | 0;
      const bi = cz * SG + cx;
      const v = Math.min(din[k], cap) * quadM;
      if (v > blockMax[bi]) blockMax[bi] = v;
    }
    const span = new Float32Array(SG * SG);
    for (let bz = 0; bz < SG; bz++) {
      for (let bx = 0; bx < SG; bx++) {
        let m = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const z = bz + dz; if (z < 0 || z >= SG) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x = bx + dx; if (x < 0 || x >= SG) continue;
            const v = blockMax[z * SG + x];
            if (v > m) m = v;
          }
        }
        span[bz * SG + bx] = m;
      }
    }
    const spanAt = (cx, cz) => {
      const fx = Math.min(SG - 1.001, Math.max(0, cx / CB - 0.5));
      const fz = Math.min(SG - 1.001, Math.max(0, cz / CB - 0.5));
      const x0 = fx | 0, z0 = fz | 0, tx = fx - x0, tz = fz - z0;
      const a = span[z0 * SG + x0], b = span[z0 * SG + x0 + 1];
      const c = span[(z0 + 1) * SG + x0], d = span[(z0 + 1) * SG + x0 + 1];
      return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
    };

    // ── dilate outward, carrying the water level with it ────────────────────
    // These cells are never SEEN as water unless the ground genuinely lies below
    // the surface there; they exist so neither the shoreline fade nor the damp
    // band on the dry side of it ever coincides with the edge of the mesh. The
    // walk stops growing where the ground has already climbed past SURF_ISO, so
    // a steep bank costs one ring and a flat apron gets what it needs.
    const mask = Uint8Array.from(hasW);
    {
      const rings = Math.max(1, Math.round(SURF_DILATE_M / quadM));
      // ...of which the first SURF_MIN_RINGS are UNCONDITIONAL, and that is not
      // a detail. Two things eat into the ring before it becomes geometry: the
      // emit loop refuses any cell one of whose four corners touches no mask
      // cell, which erodes the mask by one; and the contour then cuts inside
      // what is left. So a ring that stops as soon as the ground has climbed
      // past the iso value — which on a steep bank is after ONE ring — leaves
      // the mesh boundary sitting on the cell edges of the water itself, and
      // the shoreline fade never gets to run: the visible edge of the water is
      // then the polygon, at a full quad of resolution, complete with its
      // 45-degree corners. Measured by rendering coverage with the discards
      // removed: the last mesh pixel on the far bank in 'river' still had two
      // metres of water under it. That is the sawtooth along every incised
      // channel in the frame.
      const minRings = Math.max(2, Math.round(8 / quadM));
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
              if (ring < minRings || level[k] - bedLo[nk] > SURF_ISO) next.push(nk);
            }
          }
        }
        frontier = next;
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
        let n = 0, lv = 0, sh = 0, wn = 0, wlv = 0;
        for (let dz = -1; dz <= 0; dz++) {
          const cz = vz + dz; if (cz < 0 || cz >= G) continue;
          for (let dx = -1; dx <= 0; dx++) {
            const cx = vx + dx; if (cx < 0 || cx >= G) continue;
            const k = cz * G + cx;
            if (!mask[k]) continue;
            n++; lv += level[k]; sh += shore[k];
            if (wet[k]) { wn++; wlv += level[k]; }
          }
        }
        if (!n) continue;
        const vi = vz * VG + vx;
        vOk[vi] = 1;
        vLevel[vi] = wn ? wlv / wn : lv / n;
        vShore[vi] = sh / n;
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
            if (!vOk[ci[0]] || !vOk[ci[1]] || !vOk[ci[2]] || !vOk[ci[3]]) continue;

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
            if (hi - lo > SURF_LEVEL_STEP) continue;

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
            if (np < 3) continue;
            for (let q = 1; q < np - 1; q++) idx.push(poly[0], poly[q], poly[q + 1]);
            drawn[kc] = 1;
            quadCount++;
          }
        }
        if (!idx.length) continue;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('aShore', new THREE.Float32BufferAttribute(shoreA, 1));
        geo.setAttribute('aSpan', new THREE.Float32BufferAttribute(spanA, 1));
        geo.setIndex(idx);
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
        tris += idx.length / 3;
      }
    }
    this.surfaceQuads = quadCount;
    this.surfaceTriangles = tris;

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
    this.waterField = field;
    if (typeof world.setWaterField === 'function') world.setWaterField(field);
    void clamp01;
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
      const h = rend.getDrawingBufferSize(this._tmpSize ??= new THREE.Vector2()).y;
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

void WORLD;
