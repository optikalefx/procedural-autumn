// ─────────────────────────────────────────────────────────────────────────────
//  Water — river ribbons and lake surfaces.
//
//  Two very different characters share one shader library:
//
//    RIVERS  swept ribbons along the baked polylines. Everything the shader
//            needs to make water look like it is *going somewhere* lives in
//            vertex attributes: distance downstream drives the flow scroll, the
//            channel tangent rotates the ripple basis, discharge and surface
//            gradient drive foam. Nothing is a global scroll.
//
//    LAKES   a mesh built cell-by-cell from the baked water grid, one vertex
//            every ~8 m, each carrying the *local* baked surface height. Calm,
//            near-mirror at grazing angles, gentle wind ripple. The polygon
//            only ever has to be roughly right: the visible edge is a per-pixel
//            depth fade against the terrain, so the shoreline comes from the
//            ground, not from where the mesh happens to stop.
//
//  The shoreline in both cases is a depth fade computed from the data texture,
//  so the water edge is soft and follows the carved bank rather than reading as
//  a cut polygon against the ground.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { PALETTE, WORLD } from './WorldConfig.js';
import { fogUniforms } from '../render/Atmosphere.js';
import { clamp01, smoothstep } from '../core/MathUtils.js';

// Cross-channel profile, in half-widths. Denser near the banks where the foam
// and the shoreline fade need the resolution; the outer ±1.5 columns run up the
// bank and are hidden by the terrain, which is what makes the edge crisp.
const COLS = [-1.5, -1.05, -0.72, -0.36, 0, 0.36, 0.72, 1.05, 1.5];
const RIVER_BUCKET = 1024;   // metres; coarse spatial split so culling can work
const LAKE_QUAD = 8;         // metres per lake quad — fine enough that the surface
                             // follows the baked water instead of averaging it
const LAKE_CHUNK = 768;      // metres per lake draw call
// Metres a single lake quad's four corners may disagree about the surface
// height before the quad is thrown away. Standing water is level; anything
// steeper than this is the mesh bridging two different bodies across a lip,
// and it draws as a vertical wall of water down the rock between them.
const LAKE_LEVEL_STEP = 2.5;
// A ribbon and a lake covering the same flooded reach are coplanar and would
// z-fight. Six centimetres is far more than depth precision at these ranges and
// far less than anything the eye can read as a step.
const RIVER_LIFT = 0.06;

// ── surface shaders ──────────────────────────────────────────────────────────
// The two surface shaders live in src/shaders/. This file owns the *geometry*
// they run on and the attributes it feeds them; those files own the pixels.
import { RIVER_VERT, RIVER_FRAG } from '../shaders/water_river.js';
import { LAKE_VERT,  LAKE_FRAG  } from '../shaders/water_lake.js';

export class Water extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Water';
    this.loadLabel = 'Filling the rivers';
    this.group = new THREE.Group();
    this.group.name = 'Water';
    this._meshes = [];
    this._materials = [];
    this._tmpC = new THREE.Color();
  }

  async init() {
    const { world, scene, preset } = this.ctx;
    if (!world) return;

    // Uniforms shared by every water material — one object, updated once.
    const reflectSteps = preset?.reflections ? 24 : 0;
    this.shared = {
      uTime:         { value: 0 },
      uDataTex:      { value: world.dataTexture },
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
      // of a lake seen under a bright sky. Taken literally it makes every basin
      // in the map a dark hole, which fails the brief's lifted-blacks target;
      // lifting it a quarter of the way to the shallow tone keeps the hue and
      // gets the value back.
      uDeep:         { value: PALETTE.waterDeep.clone().lerp(PALETTE.waterShallow, 0.26) },
      uFoam:         { value: PALETTE.waterFoam.clone() },
      uSubsurface:   { value: PALETTE.waterSubsurface.clone() },
      // Shallow water at 3.1 clipped every channel past 1.0 — the surface then
      // has no structure left to see, which is how a pond two metres from the
      // camera ends up reading as flat turquoise vinyl.
      //
      // Re-measured against the current grade (the flat-shadow clamp is gone,
      // AMBIENT_SCALE is 0.72) and against the new tint model, which no longer
      // multiplies the light by the body colour and so no longer needs a gain
      // to put back the value that the double filter took out.
      uBodyGain:     { value: 1.30 },
      // How much of the water's own hue is imposed on the light coming back out
      // of it. 1.0 is a literal multiply by the body colour; below that the
      // illuminant shows through, which is the whole point.
      uAbsorb:       { value: 1.0 },
      // Chroma of the absorption tint. See the shader: 1.0 is literal, above
      // that the water holds its blue against a hard amber key the way the
      // reference plates do.
      uAbsorbPow:    { value: 1.60 },
      // How far the surface reflection is rotated toward the water's hue. The
      // reflection is physically neutral, so this is pure art direction: enough
      // that a lake stays the cool note in a hot frame, little enough that a
      // dawn sky still lands on it.
      uEnvTint:      { value: 0.25 },
      // How much of the sky a *rough* surface hands back regardless of angle.
      // See the sheen block in LAKE_FRAG: physical Fresnel at anything but a
      // grazing angle is 5-8%, which measured two and a half stops under the
      // reference plates. This is the floor under it, and it is the single
      // dial that decides whether a basin reads as water or as a dark hole.
      // Raised with the widening of sheenMass: the mass now averages 0.57 of
      // full rather than 0.76, and this is the whole *value* of the water at
      // anything but a grazing angle, so the mean has to be held where it was
      // measured or the widening reads as a darker lake rather than as a lake
      // with structure in it.
      // 0.88, not 0.80: the mass averages 0.57 of full where it used to average
      // 0.76, so holding the *mean* reflectance where it was measured takes
      // 0.50/0.57. Measured on the river anchor the 0.80 arm came back 8% dark
      // against the arm it replaced, which is the widening reading as a dimmer
      // river rather than as a river with structure in it.
      //
      // CHECKED AGAINST CRITIC PASS 4, WHICH RECORDS THE OPPOSITE OF WHAT THIS
      // DIAL DOES. Pass 4 has `peaks` losing its lake colour between 045 and
      // 048 — cyan 4.7% -> 0.1%, "045's read as water; this reads as slate" —
      // and 048 is the round this raise landed in, so the obvious next move is
      // to put it back. Do not. Measured, same framing, back to back, lake
      // patch only:
      //
      //   uSheen 0.88  srgb(117,123,125)  1:1.05:1.07
      //   uSheen 0.66  srgb(110,115,116)  1:1.05:1.05
      //   uSheen 0.00  srgb( 91, 93, 91)  1:1.02:1.00
      //
      // The sheen is what *supplies* the blue. Take it away and the lake goes
      // three stops down and dead neutral — a dark hole, which is the failure
      // this dial exists to prevent. Turning it back down to chase the slate
      // measurement would make the slate worse.
      //
      // Which means the greying is somewhere else, and at this range the
      // candidate is not in this file: `peaks` frames its lake at 420 m, where
      // marchOn has already faded the landscape reflection out and aerial
      // perspective owns most of the pixel. Whoever holds Atmosphere and the
      // grade should have this measurement before anyone reaches for a water
      // dial to fix it.
      uSheen:        { value: 0.88 },
      // Metres of damp margin drawn on the dry side of the waterline. The
      // reference never shows water meeting dry ground on a line; there is
      // always a band of wet substrate between the two, and its absence is
      // what makes a shoreline read as a cut-out however well antialiased the
      // alpha edge is.
      uWetBand:      { value: 3.1 },
      uCoolTint:     { value: new THREE.Vector3(0.96, 1.00, 1.03) },
      // Strength of the cool governor (see wCoolGovern). 0 disables it and
      // water goes the colour of the light; 1 holds it hard against any warm
      // key at all. Half is enough to keep a river blue-violet through a
      // golden hour without it looking painted on at noon.
      uCoolGain:     { value: 0.55 },
      // Radians of view angle per output pixel. Everything that has to be
      // band-limited — ripple scales, the specular lobe, the reflection march —
      // is measured against the footprint this implies.
      uPixelScale:   { value: 0.0016 },
      // Shared with the falls: the one dial for every aerated surface. See
      // wFoamLight in water_common.js for why foam gets its own illuminant.
      uFoamGain:     { value: 1.55 },
    };

    this.riverMaterial = new THREE.ShaderMaterial({
      lights: true,
      uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
                              fogUniforms(), this.shared, {
        uFoamCut: { value: 0.74 },
      }),
      vertexShader: RIVER_VERT,
      fragmentShader: RIVER_FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      fog: true,
    });

    this.lakeMaterial = new THREE.ShaderMaterial({
      lights: true,
      uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
                              fogUniforms(), this.shared, {
        uWind: { value: new THREE.Vector2(0.62, 0.36) },
      }),
      vertexShader: LAKE_VERT,
      fragmentShader: LAKE_FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      fog: true,
    });
    this._materials.push(this.riverMaterial, this.lakeMaterial);

    this._buildLakes();
    this._buildRivers();

    scene.add(this.group);
  }

  // ── rivers ─────────────────────────────────────────────────────────────────
  _buildRivers() {
    const world = this.ctx.world;
    const polys = world.riverPolylines ?? [];
    const buckets = new Map();

    const bucketOf = (x, z) =>
      (Math.floor((x + world.half) / RIVER_BUCKET) << 4) | Math.floor((z + world.half) / RIVER_BUCKET);

    const getBucket = (k) => {
      let b = buckets.get(k);
      if (!b) {
        b = { pos: [], side: [], dist: [], flow: [], turb: [], wid: [], tan: [], idx: [], n: 0 };
        buckets.set(k, b);
      }
      return b;
    };

    for (const poly of polys) {
      if (!poly || poly.length < 6) continue;

      // ── repair the channel profile ────────────────────────────────────────
      // The baked polylines carry per-point width and discharge sampled off the
      // flow-accumulation grid, and roughly one point in eight drops out to the
      // headwater minimum where the trace strays a texel off the channel. Swept
      // straight, that turns a 12 m trunk into a row of paper darts. A windowed
      // maximum repairs the dropouts (discharge only ever grows downstream),
      // then a box blur takes the stairstep out of the confluences.
      const n0 = poly.length;
      const wRep = new Float32Array(n0), fRep = new Float32Array(n0);
      const RAD = 5;
      for (let i = 0; i < n0; i++) {
        let mw = 0, mf = 0;
        for (let k = Math.max(0, i - RAD); k <= Math.min(n0 - 1, i + RAD); k++) {
          if (poly[k].w > mw) mw = poly[k].w;
          if (poly[k].flow > mf) mf = poly[k].flow;
        }
        wRep[i] = mw; fRep[i] = mf;
      }
      const wSm = new Float32Array(n0), fSm = new Float32Array(n0);
      const BLUR = 8;
      for (let i = 0; i < n0; i++) {
        let sw = 0, sf = 0, c = 0;
        for (let k = Math.max(0, i - BLUR); k <= Math.min(n0 - 1, i + BLUR); k++) {
          sw += wRep[k]; sf += fRep[k]; c++;
        }
        wSm[i] = sw / c; fSm[i] = sf / c;
      }

      // ── resample: station spacing scales with the channel, so a 12 m trunk
      // is not tessellated at the same density as a 1.5 m brook.
      const stations = [];
      let maxW = 0;
      const push = (i, d) => {
        stations.push({ x: poly[i].x, y: poly[i].y, z: poly[i].z, w: wSm[i], flow: fSm[i], d });
        if (wSm[i] > maxW) maxW = wSm[i];
      };
      let travelled = 0, sinceStation = 0;
      push(0, 0);
      for (let i = 1; i < poly.length; i++) {
        const seg = Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
        travelled += seg;
        sinceStation += seg;
        const stepM = Math.min(12, Math.max(4, wSm[i] * 0.9));
        if (sinceStation >= stepM || i === poly.length - 1) {
          push(i, travelled);
          sinceStation = 0;
        }
      }
      if (stations.length < 3 || maxW < 1.5) continue;

      // Tangents + turbulence. Surface gradient is the honest signal for
      // whitewater: a reach that drops fast is a rapid, one that does not is a
      // pool, regardless of how much water is in it.
      const n = stations.length;
      for (let k = 0; k < n; k++) {
        const a = stations[Math.max(0, k - 1)];
        const b = stations[Math.min(n - 1, k + 1)];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        stations[k].tx = dx / len;
        stations[k].tz = dz / len;
        const ds = Math.max(b.d - a.d, 1e-3);
        const grad = Math.max(0, (a.y - b.y) / ds);
        // Calibration matters more than the formula here. A 2 % surface
        // gradient is a lazy meander and a 20 % one is a genuine rapid; a
        // linear ramp saturates every mountain creek in the map at "full
        // whitewater" and renders the whole river network as white paint.
        const steep = smoothstep(0.015, 0.20, grad);
        // Discharge squeezed through a narrow channel is fast, and fast water
        // over a rough bed aerates even where it is not steep.
        const pinch = clamp01(stations[k].flow * 5 / Math.max(stations[k].w, 1.5));
        stations[k].turb = clamp01(steep * 0.85 + pinch * 0.25);
      }
      // Smooth turbulence along the reach — foam does not switch on per-vertex.
      const sm = stations.map((s) => s.turb);
      for (let k = 0; k < n; k++) {
        const a = sm[Math.max(0, k - 2)], b = sm[Math.max(0, k - 1)];
        const c = sm[k], d = sm[Math.min(n - 1, k + 1)], e = sm[Math.min(n - 1, k + 2)];
        stations[k].turb = (a + b * 2 + c * 3 + d * 2 + e) / 9;
      }

      // ── emit into spatial buckets. A station that straddles two buckets is
      // duplicated into both; a few thousand extra vertices is a cheaper price
      // than losing frustum culling on a 3 km river network.
      const placed = new Map();   // `${bucket}:${station}` -> first vertex index
      const put = (bk, si) => {
        const key = bk * 100000 + si;
        const hit = placed.get(key);
        if (hit !== undefined) return hit;
        const b = getBucket(bk);
        const s = stations[si];
        const base = b.n;
        const hw = s.w * 0.5;
        for (let c = 0; c < COLS.length; c++) {
          const off = COLS[c] * hw;
          b.pos.push(s.x - s.tz * off, s.y + RIVER_LIFT, s.z + s.tx * off);
          b.side.push(COLS[c]);
          b.dist.push(s.d);
          b.flow.push(s.flow);
          b.turb.push(s.turb);
          b.wid.push(s.w);
          b.tan.push(s.tx, s.tz);
        }
        b.n += COLS.length;
        placed.set(key, base);
        return base;
      };

      for (let k = 0; k < n - 1; k++) {
        const s = stations[k];
        const bk = bucketOf(s.x, s.z);
        const a = put(bk, k);
        const c = put(bk, k + 1);
        const b = getBucket(bk);
        for (let q = 0; q < COLS.length - 1; q++) {
          b.idx.push(a + q, c + q, a + q + 1);
          b.idx.push(a + q + 1, c + q, c + q + 1);
        }
      }
    }

    let tris = 0;
    for (const [, b] of buckets) {
      if (!b.idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('aSide', new THREE.Float32BufferAttribute(b.side, 1));
      geo.setAttribute('aDist', new THREE.Float32BufferAttribute(b.dist, 1));
      geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(b.flow, 1));
      geo.setAttribute('aTurb', new THREE.Float32BufferAttribute(b.turb, 1));
      geo.setAttribute('aWidth', new THREE.Float32BufferAttribute(b.wid, 1));
      geo.setAttribute('aTan', new THREE.Float32BufferAttribute(b.tan, 2));
      geo.setIndex(b.idx);
      geo.computeBoundingSphere();
      geo.boundingSphere.radius *= 1.1;
      const mesh = new THREE.Mesh(geo, this.riverMaterial);
      mesh.receiveShadow = true;
      mesh.renderOrder = 6;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = 'RiverChunk';
      this.group.add(mesh);
      this._meshes.push(mesh);
      tris += b.idx.length / 3;
    }
    this.riverTriangles = tris;
  }

  // ── lakes ──────────────────────────────────────────────────────────────────
  /**
   * The lake surface is a mesh over the baked water grid, not a set of flat
   * tiles laid on top of it.
   *
   * The previous build averaged the water height over a 48 m tile and drew one
   * quad at that level. Over the near-flat valley floors this map is full of,
   * a neighbouring tile averaging 0.4 m differently moves the waterline by tens
   * of metres — which is precisely why the lakes read as hard-edged slabs
   * floating over the ground, with dead-straight tile seams through the middle
   * of a single body of water.
   *
   * Instead: one vertex every ~8 m carrying the *local* baked surface height,
   * cells emitted only where there is water, the whole thing dilated one ring
   * so the per-pixel depth fade has geometry to finish inside. The polygon
   * boundary is then always well outside the visible waterline, and the
   * waterline itself is decided by the terrain.
   */
  _buildLakes() {
    const world = this.ctx.world;
    const R = world.res;
    const half = world.half;
    const texel = world.texel ?? (world.worldSize / R);

    const S = Math.max(1, Math.round(LAKE_QUAD / texel));  // grid cells per quad
    const quadM = S * texel;
    const G = Math.floor(R / S);                           // quads per side
    const DRY = -9999;

    // ── coarse pass: is there water in this quad, and at what level? ─────────
    const level = new Float32Array(G * G).fill(DRY);
    const wet = new Uint8Array(G * G);
    for (let cz = 0; cz < G; cz++) {
      for (let cx = 0; cx < G; cx++) {
        let n = 0, sum = 0;
        for (let j = 0; j < S; j++) {
          const row = (cz * S + j) * R;
          for (let i = 0; i < S; i++) {
            const v = world.water[row + cx * S + i];
            if (v < -9000) continue;
            n++; sum += v;
          }
        }
        if (!n) continue;
        wet[cz * G + cx] = 1;
        level[cz * G + cx] = sum / n;
      }
    }

    // ── drop stray specks ───────────────────────────────────────────────────
    // The baked water grid leaves isolated single cells scattered across the
    // valley wherever the fill algorithm caught a local pit. Each one becomes
    // an 8 m slab of water sitting in the middle of dry meadow, and a critic
    // pass logged three of them in one frame as evidence of a broken mask.
    // A body of water this small has no shoreline, no depth and no reflection
    // to speak of — it is a puddle-shaped bug. Flood-fill and discard anything
    // under three quads.
    {
      const MIN_CELLS = 3;
      const seen = new Uint8Array(G * G);
      const stack = new Int32Array(G * G);
      const comp = new Int32Array(G * G);
      for (let k0 = 0; k0 < G * G; k0++) {
        if (!wet[k0] || seen[k0]) continue;
        let sp = 0, n = 0;
        stack[sp++] = k0; seen[k0] = 1;
        while (sp > 0) {
          const k = stack[--sp];
          comp[n++] = k;
          const cx = k % G, cz = (k / G) | 0;
          if (cx > 0 && wet[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack[sp++] = k - 1; }
          if (cx < G - 1 && wet[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack[sp++] = k + 1; }
          if (cz > 0 && wet[k - G] && !seen[k - G]) { seen[k - G] = 1; stack[sp++] = k - G; }
          if (cz < G - 1 && wet[k + G] && !seen[k + G]) { seen[k + G] = 1; stack[sp++] = k + G; }
        }
        if (n < MIN_CELLS) {
          for (let i = 0; i < n; i++) { wet[comp[i]] = 0; level[comp[i]] = DRY; }
        }
      }
    }

    // ── dilate one ring, carrying the neighbouring level outward ────────────
    // These cells are never *seen* as water unless the ground genuinely lies
    // below the lake there; they exist so the shoreline fade never coincides
    // with the edge of the mesh.
    const mask = Uint8Array.from(wet);
    for (let cz = 0; cz < G; cz++) {
      for (let cx = 0; cx < G; cx++) {
        const k = cz * G + cx;
        if (wet[k]) continue;
        let n = 0, sum = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const z = cz + dz; if (z < 0 || z >= G) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx; if (x < 0 || x >= G) continue;
            if (!wet[z * G + x]) continue;
            n++; sum += level[z * G + x];
          }
        }
        if (!n) continue;
        mask[k] = 1;
        level[k] = sum / n;
      }
    }

    // ── distance to the nearest dry cell, in metres (two-pass chamfer) ───────
    // Fetch, not depth, is what decides whether water is glassy or textured.
    const FAR = 1e6;
    const dist = new Float32Array(G * G);
    for (let k = 0; k < G * G; k++) dist[k] = wet[k] ? FAR : 0;
    for (let cz = 0; cz < G; cz++) {
      for (let cx = 0; cx < G; cx++) {
        const k = cz * G + cx;
        let d = dist[k];
        if (cx > 0) d = Math.min(d, dist[k - 1] + 1);
        if (cz > 0) d = Math.min(d, dist[k - G] + 1);
        if (cx > 0 && cz > 0) d = Math.min(d, dist[k - G - 1] + 1.41);
        if (cx < G - 1 && cz > 0) d = Math.min(d, dist[k - G + 1] + 1.41);
        dist[k] = d;
      }
    }
    for (let cz = G - 1; cz >= 0; cz--) {
      for (let cx = G - 1; cx >= 0; cx--) {
        const k = cz * G + cx;
        let d = dist[k];
        if (cx < G - 1) d = Math.min(d, dist[k + 1] + 1);
        if (cz < G - 1) d = Math.min(d, dist[k + G] + 1);
        if (cx < G - 1 && cz < G - 1) d = Math.min(d, dist[k + G + 1] + 1.41);
        if (cx > 0 && cz < G - 1) d = Math.min(d, dist[k + G - 1] + 1.41);
        dist[k] = d;
      }
    }

    // ── emit, chunked for frustum culling ───────────────────────────────────
    const perChunk = Math.max(8, Math.round(LAKE_CHUNK / quadM));
    const chunks = Math.ceil(G / perChunk);
    const vmap = new Int32Array((perChunk + 1) * (perChunk + 1));
    let quadCount = 0, tris = 0;

    // ── the vertex field, computed once for the whole lattice ───────────────
    // Vertex value = mean over the (up to four) mesh cells touching it, so the
    // surface is continuous across chunk borders.
    //
    // This used to be recomputed inside the chunk loop, up to four times per
    // vertex. It is hoisted out because it is no longer only the mesh's own
    // business: this grid, plus `drawn` below, IS the lake surface — nothing
    // else about the geometry decides where the water is or how high it sits.
    // Handing exactly these two arrays to WorldData at the end of the build is
    // what stops `getWaterHeight` from deriving a second, different water
    // surface from the same bake (docs/INTEGRATION_REQUESTS.md, P1). Anything
    // computed here a second time somewhere else can drift; this cannot.
    const VG = G + 1;
    const vLevel = new Float32Array(VG * VG);
    const vWet = new Float32Array(VG * VG);
    const vShore = new Float32Array(VG * VG);
    const vOk = new Uint8Array(VG * VG);
    for (let vz = 0; vz < VG; vz++) {
      for (let vx = 0; vx < VG; vx++) {
        let n = 0, lv = 0, w = 0, sh = 0;
        for (let dz = -1; dz <= 0; dz++) {
          const cz = vz + dz; if (cz < 0 || cz >= G) continue;
          for (let dx = -1; dx <= 0; dx++) {
            const cx = vx + dx; if (cx < 0 || cx >= G) continue;
            const k = cz * G + cx;
            if (!mask[k]) continue;
            n++; lv += level[k]; w += wet[k]; sh += Math.min(dist[k], 12) * quadM;
          }
        }
        if (!n) continue;
        const vi = vz * VG + vx;
        vOk[vi] = 1; vLevel[vi] = lv / n; vWet[vi] = w / n; vShore[vi] = sh / n;
      }
    }

    // Which quads actually became triangles. Set in the emit loop below rather
    // than predicted here, so it can never claim surface the mesh does not have.
    const drawn = new Uint8Array(G * G);

    const vertexAt = (vx, vz, out) => {
      const vi = vz * VG + vx;
      if (!vOk[vi]) return false;
      out[0] = vLevel[vi]; out[1] = vWet[vi]; out[2] = vShore[vi];
      return true;
    };

    const vv = [0, 0, 0];
    for (let bz = 0; bz < chunks; bz++) {
      for (let bx = 0; bx < chunks; bx++) {
        const cz0 = bz * perChunk, cx0 = bx * perChunk;
        const cz1 = Math.min(G, cz0 + perChunk), cx1 = Math.min(G, cx0 + perChunk);
        vmap.fill(-1);
        const pos = [], wetA = [], shoreA = [], idx = [];

        const vert = (vx, vz) => {
          const li = (vz - cz0) * (perChunk + 1) + (vx - cx0);
          const hit = vmap[li];
          if (hit >= 0) return hit;
          if (!vertexAt(vx, vz, vv)) return -1;
          const id = pos.length / 3;
          pos.push(-half + vx * quadM, vv[0], -half + vz * quadM);
          wetA.push(vv[1]);
          shoreA.push(vv[2]);
          vmap[li] = id;
          return id;
        };

        for (let cz = cz0; cz < cz1; cz++) {
          for (let cx = cx0; cx < cx1; cx++) {
            if (!mask[cz * G + cx]) continue;
            const a = vert(cx, cz), b = vert(cx + 1, cz);
            const c = vert(cx + 1, cz + 1), d = vert(cx, cz + 1);
            if (a < 0 || b < 0 || c < 0 || d < 0) continue;
            // A lake surface is level. Reject any quad whose corners disagree
            // about where the surface is by more than a step.
            //
            // This is the bug behind everything a critic pass logged against
            // the waterfall view. The baked water grid marks the pool above a
            // lip and the pool below it as water, sixty metres apart in
            // height; the mesh then joins them with one 8 m quad, which is a
            // near-vertical wall of "lake" hanging down the cliff face. Two of
            // them across one gorge is the floating pale-blue X with no source
            // and no ground contact. One of them in front of a fall is the
            // "flat pale rectangle with horizontal pencil streaking" — the
            // pencil streaking is the *lake's* wind ripple seen edge on, and
            // an isolation capture (lake chunks hidden, everything else on)
            // shows the falls system's curtain behind it, correctly white and
            // fully streaked, having been covered up the whole time.
            const ya = pos[a * 3 + 1], yb = pos[b * 3 + 1];
            const yc = pos[c * 3 + 1], yd = pos[d * 3 + 1];
            const span = Math.max(ya, yb, yc, yd) - Math.min(ya, yb, yc, yd);
            if (span > LAKE_LEVEL_STEP) continue;
            idx.push(a, c, b, a, d, c);
            drawn[cz * G + cx] = 1;
            quadCount++;
          }
        }
        if (!idx.length) continue;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('aWet', new THREE.Float32BufferAttribute(wetA, 1));
        geo.setAttribute('aShore', new THREE.Float32BufferAttribute(shoreA, 1));
        geo.setIndex(idx);
        geo.computeBoundingSphere();
        geo.boundingSphere.radius *= 1.05;
        const mesh = new THREE.Mesh(geo, this.lakeMaterial);
        mesh.receiveShadow = true;
        mesh.renderOrder = 4;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.name = 'LakeChunk';
        this.group.add(mesh);
        this._meshes.push(mesh);
        tris += idx.length / 3;
      }
    }
    this.lakeQuads = quadCount;
    this.lakeTriangles = tris;

    // ── publish the surface, so nothing has to guess at it ──────────────────
    // Every gameplay query about water — the chase boom floor, wildlife spawn
    // rejection, grass and cover scatter, the camper's fording drag and its
    // audio — goes through `WorldData.getWaterHeight`, which was a nearest-texel
    // point sample of the raw bake. This mesh is not a point sample of the raw
    // bake: it coarsens sixteen 2 m texels into an 8 m quad, dilates one ring so
    // the shoreline fade has geometry to finish inside, and averages each vertex
    // over the quads that touch it. Two derivations of one field, and they
    // disagreed under 91% of drawn water shallower than 15 cm and under 41 m of
    // it at (-768, 832) — measured in P1.
    //
    // So hand over the field the mesh was actually built from. `levelAt` below
    // evaluates the same triangles the renderer draws, from the same numbers, so
    // it cannot drift: there is now one water surface, not two.
    //
    // ~740 KB at res 1536 (385² floats + 384² bytes).
    const origin = -half;
    const field = {
      level: vLevel,          // (G+1)² lattice, metres
      drawn,                  // G², 1 where the mesh emitted this quad
      G, quadM, origin,
      /**
       * Height of the drawn lake surface at world (x, z), or null where no
       * lake quad is drawn. Evaluates the emitted triangles exactly: the quad
       * is split a-c-b / a-d-c, and a downward ray takes the highest surface it
       * meets, so on a quad boundary any drawn quad touching the point answers.
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
            const ya = vLevel[cz * VG + cx], yb = vLevel[cz * VG + cx + 1];
            const yc = vLevel[(cz + 1) * VG + cx + 1], yd = vLevel[(cz + 1) * VG + cx];
            const y = u >= v ? ya * (1 - u) + yb * (u - v) + yc * v
                             : ya * (1 - v) + yd * (v - u) + yc * u;
            if (best === null || y > best) best = y;
          }
        }
        return best;
      },
    };
    this.lakeField = field;
    // WorldData is another author's file and does not implement the receiving
    // side yet — the exact patch is filed as P1-reply in
    // docs/INTEGRATION_REQUESTS.md. Until it lands this is a no-op and the mesh
    // is identical either way; `this.lakeField` is readable from tools meanwhile.
    if (typeof world.setLakeField === 'function') world.setLakeField(field);
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
    // does not reflect a golden-hour hillside.
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
