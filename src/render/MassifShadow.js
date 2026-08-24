// ─────────────────────────────────────────────────────────────────────────────
//  MassifShadow — the valley-crossing terrain shadow the sun's shadow map
//  cannot reach.
//
//  X2 asks for a large soft warm value event on the ground at eye level. Two
//  instruments have been eliminated for it by measurement:
//
//    · the cloud shadow (L6): even at cloudScaleMul 5.5, 64% of camera
//      positions see no shadow EDGE at all, because a silhouette with
//      hundreds-of-metres features cannot reliably put an edge inside a 200 m
//      ground fan viewed from a 4 m camera.
//    · the sun's own shadow map (W1): at eye level its half-extent is 150-200 m,
//      and growing it deletes every contact shadow in the frame because both
//      biases are derived from the extent.
//
//  So the shadow that is the right size by construction — a massif throwing
//  across the valley floor — is exactly the one nothing in the pipeline can
//  draw. Measured on the shipped heightfield (tools/_scratch/massif.mjs), for
//  the ground fan the `drive` camera actually sees:
//
//              sun elev   fan shadowed   median occluder   beyond shadowExtent
//    07:24        6.8°        0.3%            12 m               100%
//    09:00       26.6°        0.0%             -                   -
//    12:00       67.1°        0.0%             -                   -
//    15:30       35.4°        0.0%             -                   -
//    16:40       18.4°        4.6%           537 m               100%
//    17:30        8.8°       22.8%           705 m               100%
//    18:18        1.7°       13.3%           473 m                84%
//
//  `reachablePct` — the share of the fan whose occluder is inside the shadow
//  camera at all — is 0.0% at `drive` and `meadow` and 0.2-2.2% at the other
//  eye-level views. The feature the terrain author built at round 018 (chunks
//  cast to LOD 2, ~720 m) is real, its casters are real, and at eye level not
//  one of them is inside the frustum that would record them. The structure is
//  in the heightfield and has never once been on screen.
//
//  It is drawn here instead, on the CPU, as a world-space sun-visibility field
//  sampled by the fog chunk — the one hook that reaches every material after it
//  has finished shading, which is the same reason the cloud shadow lives there.
//
//  ── why this does not double up with the sun's shadow map ──
//
//  Every cell carries how far its occluder is (`SRC_*` below), and the mask is
//  gated to occluders BEYOND the shadow camera's own reach. Local terrain
//  self-shadowing — a near ridge, the terminator on the mountainside under the
//  `vehicle` anchor, whose occluders measure 6-15 m — is left entirely to the
//  shadow map, which draws it correctly and sharply. This term only fills in
//  what that map structurally cannot contain. The two are complementary by
//  construction rather than by tuning.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

// 256 over a 3072 m world is a 12 m texel. A massif shadow's features are
// hundreds of metres, so this is generous; the cost of the sweep is quadratic
// in it and the whole point of the term is that it is coarse. Powers of two
// only — the row pitch has to stay a multiple of the texture unpack alignment.
const GRID = 256;

// Metres of horizontal ground the penumbra takes to close. Converted to a depth
// threshold with the sun's own tangent, so the softness stays roughly constant
// on the ground rather than collapsing to a hard line as the sun drops.
//
// 90 m is a deliberately enormous penumbra — far wider than the physical one.
// The player's note on this exact mass was that it created "too much contrast",
// and X2 is explicit that restoring it must not raise contrast. A shadow whose
// edge takes 90 m to close cannot produce a hard value step anywhere in an
// eye-level frame; what it produces is the broad gradient across the meadow
// that rounds 035-040 had.
const PENUMBRA_GROUND_M = 90.0;

// The occluder-distance gate, in metres. Below SRC_NEAR the sun's shadow map
// owns the shadow and this term contributes nothing; above SRC_FAR it owns it
// alone. The window brackets the 150-200 m eye-level shadow extent that W1
// pins, with enough margin that the handover is a crossfade rather than a seam
// — the extent itself moves with camera height and this field does not know
// where the camera is.
const SRC_NEAR = 170.0;
const SRC_FAR = 300.0;

// A sun this low is below its own horizon for most of the valley and the whole
// frame is shadow; multiplying an already dark ground by this term as well is
// how an evening frame arrives crushed. Ramp in over the first few degrees.
const ELEV_FADE_LO = 0.015;   // ~0.9°
const ELEV_FADE_HI = 0.075;   // ~4.3°

/** A 4x4 all-zero red map: "nothing is shadowed", for before the world exists. */
export function neutralMassifMap() {
  const t = new THREE.DataTexture(new Uint8Array(4 * 4), 4, 4, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

export class MassifShadow {
  constructor() {
    this.texture = neutralMassifMap();
    this.ready = false;
    this.worldSize = 1;
    this.strength = 0;
    this._h = null;
    this._ray = new Float32Array(GRID * GRID);
    this._src = new Float32Array(GRID * GRID);
    this._depth = new Float32Array(GRID * GRID);
    this._gate = new Float32Array(GRID * GRID);
    this._tmp = new Float32Array(GRID * GRID);
    this._bytes = new Uint8Array(GRID * GRID);
    this._lastDir = new THREE.Vector3(0, -1, 0);
    this._lastBuild = -1e9;
    this.rebuilds = 0;
    this.lastCostMs = 0;
  }

  /**
   * Downsample the baked heightfield once. Deliberately a mean and not a max:
   * a max filter grows every ridge by half a texel in all four directions,
   * which at a 12 m texel throws shadows off ridgelines that are not there.
   */
  bind(world) {
    if (this.ready || !world?.height?.length) return false;
    const R = world.res;
    const h = new Float32Array(GRID * GRID);
    const step = R / GRID;
    for (let j = 0; j < GRID; j++) {
      const z0 = Math.floor(j * step), z1 = Math.max(z0 + 1, Math.floor((j + 1) * step));
      for (let i = 0; i < GRID; i++) {
        const x0 = Math.floor(i * step), x1 = Math.max(x0 + 1, Math.floor((i + 1) * step));
        let s = 0, n = 0;
        for (let z = z0; z < z1; z++) {
          const row = z * R;
          for (let x = x0; x < x1; x++) { s += world.height[row + x]; n++; }
        }
        h[i + j * GRID] = n ? s / n : 0;
      }
    }
    this._h = h;
    this.worldSize = world.worldSize;
    this.texelM = world.worldSize / GRID;

    const tex = new THREE.DataTexture(this._bytes, GRID, GRID, THREE.RedFormat);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.texture = tex;
    this.ready = true;
    this._lastDir.set(0, -1, 0);
    return true;
  }

  /**
   * Rebuild if the sun has moved enough to matter. The rate limit keeps slow
   * sun motion and HUD time-of-day scrubbing from rebuilding this field every
   * frame.
   */
  update(sunDir, nowMs) {
    if (!this.ready) return;
    const moved = 1 - Math.abs(this._lastDir.dot(sunDir));
    if (moved < 3e-5 && this._lastBuild > -1e8) return;
    if (nowMs - this._lastBuild < 220) return;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    this._build(sunDir);
    this.lastCostMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
    this._lastDir.copy(sunDir);
    this._lastBuild = nowMs;
    this.rebuilds++;
  }

  /**
   * One sweep of the heightfield along the light's own direction.
   *
   * Propagate a "shadow ray height" downwind one cell at a time. A cell is lit
   * when its own terrain stands above the incoming ray, and it then becomes the
   * ray's new source; otherwise it is shadowed by (ray - terrain) metres and
   * inherits the distance back to whatever is casting on it. Because the step
   * is always one full cell along the dominant axis, the whole upwind column
   * (or row) is finished before the current one starts, so this is exactly one
   * pass over the grid — O(n²), not a per-cell march.
   */
  _build(sunDir) {
    const N = GRID, h = this._h, ray = this._ray, src = this._src;
    const depth = this._depth, gate = this._gate;
    const horiz = Math.hypot(sunDir.x, sunDir.z);
    depth.fill(0); gate.fill(0);

    // Sun at the zenith, or below the horizon: nothing this term can say.
    if (horiz > 1e-3 && sunDir.y > 0.004) {
      const tanElev = sunDir.y / horiz;
      // Direction the light travels across the ground.
      const lx = -sunDir.x / horiz, lz = -sunDir.z / horiz;
      const majorX = Math.abs(lx) >= Math.abs(lz);
      const m = majorX ? Math.abs(lx) : Math.abs(lz);
      const ax = lx / m, az = lz / m;            // one of these is exactly ±1
      const minor = majorX ? az : ax;
      const stepM = this.texelM * Math.sqrt(1 + minor * minor);
      const drop = stepM * tanElev;

      // Iterate along the major axis starting from the upwind edge.
      const sMaj = majorX ? Math.sign(ax) : Math.sign(az);
      const start = sMaj > 0 ? 0 : N - 1;
      const end = sMaj > 0 ? N : -1;

      for (let a = start; a !== end; a += sMaj) {
        const first = (a === start);
        for (let b = 0; b < N; b++) {
          const idx = majorX ? (a + b * N) : (b + a * N);
          const hh = h[idx];
          if (first) { ray[idx] = hh; src[idx] = 0; continue; }
          // Upwind sample sits between two cells of the finished column/row.
          const bu = b - minor;
          let b0 = Math.floor(bu);
          const f = bu - b0;
          if (b0 < 0) b0 = 0; else if (b0 > N - 1) b0 = N - 1;
          let b1 = b0 + 1; if (b1 > N - 1) b1 = N - 1;
          const au = a - sMaj;
          const i0 = majorX ? (au + b0 * N) : (b0 + au * N);
          const i1 = majorX ? (au + b1 * N) : (b1 + au * N);
          const rIn = (ray[i0] * (1 - f) + ray[i1] * f) - drop;
          const dIn = (src[i0] * (1 - f) + src[i1] * f) + stepM;
          if (rIn > hh) {
            ray[idx] = rIn; src[idx] = dIn;
            depth[idx] = rIn - hh;
            gate[idx] = dIn;
          } else {
            ray[idx] = hh; src[idx] = 0;
          }
        }
      }
    }

    // Depth and occluder distance -> a soft mask. The penumbra is expressed on
    // the ground and converted here, so it does not narrow as the sun drops.
    const softDepth = Math.max(PENUMBRA_GROUND_M * (sunDir.y / Math.max(horiz, 1e-3)), 1.5);
    const elevFade = smooth01((sunDir.y - ELEV_FADE_LO) / (ELEV_FADE_HI - ELEV_FADE_LO));
    const tmp = this._tmp;
    for (let i = 0; i < N * N; i++) {
      const d = smooth01(depth[i] / softDepth);
      const g = smooth01((gate[i] - SRC_NEAR) / (SRC_FAR - SRC_NEAR));
      tmp[i] = d * g * elevFade;
    }
    // One separable 1-2-1, twice. The sweep writes along grid lines and leaves
    // a faint stair-step on diagonal sun angles; at a 12 m texel two passes
    // cost nothing against a penumbra tens of metres wide and remove it.
    this._blur(tmp, depth);
    this._blur(depth, tmp);
    const out = this._bytes;
    for (let i = 0; i < N * N; i++) out[i] = Math.max(0, Math.min(255, Math.round(tmp[i] * 255)));
    this.texture.needsUpdate = true;
  }

  _blur(srcArr, dstArr) {
    const N = GRID, mid = this._ray;   // _ray is free by now; reuse as scratch
    for (let j = 0; j < N; j++) {
      const row = j * N;
      for (let i = 0; i < N; i++) {
        const i0 = i > 0 ? i - 1 : 0, i1 = i < N - 1 ? i + 1 : N - 1;
        mid[row + i] = (srcArr[row + i0] + srcArr[row + i] * 2 + srcArr[row + i1]) * 0.25;
      }
    }
    for (let j = 0; j < N; j++) {
      const j0 = (j > 0 ? j - 1 : 0) * N, j1 = (j < N - 1 ? j + 1 : N - 1) * N, row = j * N;
      for (let i = 0; i < N; i++) {
        dstArr[row + i] = (mid[j0 + i] + mid[row + i] * 2 + mid[j1 + i]) * 0.25;
      }
    }
  }
}

function smooth01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
