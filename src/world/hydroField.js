// ─────────────────────────────────────────────────────────────────────────────
//  The hydro field — ONE statement about where the water's edge is, that
//  everything which draws an edge reads.
//
//  Before this file there were four different answers to "where does the water
//  end", and every one of them was cut on a different curve:
//
//    1. the water shader        depth = P.y - texture(uDataTex).r, i.e. the zero
//                               set of a SMOOTH surface minus the RAW 2 m
//                               eroded bed. A level curve of a rough field.
//    2. the terrain shader      the same subtraction, but against the TERRAIN
//                               MESH's height, which is the baked field plus up
//                               to 0.44 m of per-vertex micro-detail the water
//                               shader knows nothing about. Measured: the two
//                               waterlines are 0.44 m apart at the median and
//                               2.16 m apart at p90. That is two visible
//                               shorelines a metre apart, and it is a large part
//                               of why a bank reads as a stain rather than an
//                               edge.
//    3. the perched guard       a -9999 sentinel in a linearly filtered channel.
//                               Between a wet texel at 12 m and a dry one at
//                               -9999, the -40 threshold is crossed 1 cm past
//                               the wet texel's centre — so it is a BINARY mask
//                               on the 2 m lattice with no antialiasing at all,
//                               biting on 23% of the mask boundary.
//    4. Water.js's aShore       an octagonal chamfer of a 4 m binary raster,
//                               linearly interpolated across triangles, so its
//                               level sets are straight segments with a kink
//                               every four metres.
//
//  Four curves, four resolutions, four quantisations. The jagged shoreline is
//  not one bug; it is those four disagreeing, and no amount of tuning inside any
//  one of them can fix it.
//
//  ── what this computes ──────────────────────────────────────────────────────
//
//  A single band-limited field, derived once from the baked height and water
//  grids, carrying everything an edge needs:
//
//    depth     the water depth to TEST AGAINST — the continuous water level
//              minus a shore-conditioned bed. Positive is wet.
//    sdf       signed metres to the waterline, positive inside. A real
//              Euclidean distance transform of the smoothed mask, not a
//              chamfer, so it is smooth, its gradient is unit length, and a
//              shoreline band rationed by it has a constant width in metres
//              wherever it is drawn.
//    wet       0..1 coverage. Replaces the sentinel test, and being a fraction
//              rather than a flag it antialiases.
//    span      how OPEN the water is here: the mean inside distance over 12 m,
//              in metres. A thread reads under a metre, a lake reads at the cap.
//
//  ── why it lives at half resolution ─────────────────────────────────────────
//
//  Because it is band-limited by construction. Every channel is the output of a
//  low-pass at 6-10 m or a distance transform, and neither carries information
//  above about a tenth of a cycle per metre. Sampling a 6 m-smoothed field at
//  2 m stores three copies of every number. At 4 m texels the field is stored
//  at the rate it actually varies, the texture is a quarter of the memory
//  (1536² RGBA half-float is 18.9 MB; 768² is 4.7 MB), and every fetch of it
//  covers four times the area of cache.
//
//  Half-float, and that is a measurement rather than a default: the channels
//  are DIFFERENCES, not absolute elevations. Depth spans about -48..+60 m, so
//  the half-float step is 0.03 m at the deep end and 0.004 m in the 8 m band
//  where every shoreline decision is made. An absolute height would have been
//  the wrong thing to store — at 365 m the step is 0.25 m, which is three times
//  the micro-detail this file exists to reconcile.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Separable box blur, radius in texels, edge-clamped. Two passes of it
 * approximate a Gaussian closely enough for a field whose only job is to be
 * smooth, and it is O(N) in the radius rather than O(N·r).
 */
function boxBlur(src, dst, R, radius, tmp) {
  const r = Math.max(1, radius | 0);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < R; y++) {
    const row = y * R;
    let acc = src[row] * (r + 1);
    for (let i = 1; i <= r; i++) acc += src[row + Math.min(R - 1, i)];
    for (let x = 0; x < R; x++) {
      tmp[row + x] = acc * norm;
      acc += src[row + Math.min(R - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < R; x++) {
    let acc = tmp[x] * (r + 1);
    for (let i = 1; i <= r; i++) acc += tmp[Math.min(R - 1, i) * R + x];
    for (let y = 0; y < R; y++) {
      dst[y * R + x] = acc * norm;
      acc += tmp[Math.min(R - 1, y + r + 1) * R + x] - tmp[Math.max(0, y - r) * R + x];
    }
  }
}

/**
 * Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher).
 * O(N) and exact, where the 3-4-5 chamfer this replaces is neither: a chamfer's
 * level sets are octagons, so a band rationed by one is up to 8% wider on the
 * diagonal than on the axis — visible as a shoreline band that thickens and
 * thins with the compass bearing of the bank.
 *
 * `f` is the seed cost: 0 on a seed texel, Infinity elsewhere.
 */
function edt(f, R, out, scratch) {
  const { v, z, line, src } = scratch;
  // Columns.
  for (let x = 0; x < R; x++) {
    for (let y = 0; y < R; y++) line[y] = f[y * R + x];
    edt1d(line, R, v, z, src);
    for (let y = 0; y < R; y++) out[y * R + x] = line[y];
  }
  // Rows.
  for (let y = 0; y < R; y++) {
    const row = y * R;
    for (let x = 0; x < R; x++) line[x] = out[row + x];
    edt1d(line, R, v, z, src);
    for (let x = 0; x < R; x++) out[row + x] = line[x];
  }
}

/** Scratch buffers for `edt`, allocated once per field rather than per scanline. */
function edtScratch(R) {
  return {
    v: new Int32Array(R + 1),
    z: new Float64Array(R + 2),
    line: new Float64Array(R),
    // The second pass of the 1-D transform reads the ORIGINAL values at the
    // parabola vertices while writing the transformed ones, so it needs a copy.
    // Allocating that copy inside the scanline loop meant 3 072 allocations of
    // 12 kB per transform and three transforms per field — measured at 90 ms of
    // the build, all of it garbage.
    src: new Float64Array(R),
  };
}

function edt1d(f, n, v, z, src) {
  const INF = 1e20;
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) src[q] = f[q];
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    f[q] = d * d + src[v[k]];
  }
}

/**
 * @param {Float32Array} height   baked bed elevation, res²
 * @param {Float32Array} water    baked water surface, res², -9999 where dry
 * @param {number} res            texels per side of the baked grid
 * @param {number} worldSize      metres per side
 * @returns {{res:number, texel:number, depth:Float32Array, sdf:Float32Array,
 *            wet:Float32Array, span:Float32Array, ms:number}}
 */
export function buildHydroField(height, water, res, worldSize, opts = {}) {
  const {
    // Every one of these is swept in tools/hydrosweep.mjs and the numbers that
    // set the defaults are in the comments beside their use below. They are
    // parameters rather than constants only so that the sweep can exist: a
    // conditioning field whose dials nobody ever varied is a set of dials
    // nobody ever measured.
    //
    // Anything removed from the code must be removed from here in the same
    // edit. `bedRadiusM`, `maxLift`, `nearRadiusM` and `allowM` all outlived
    // their code paths for a while, and a dial that is still accepted and no
    // longer read is worse than one that never existed: a sweep of it comes
    // back a flat line, which reads as "this parameter does not matter".
    sdfBlurM = 10,
    levelBlurM = 6,
    clean = true,
    gradeK = 0.60,
    gradeBandM = 18.0,
  } = opts;
  const clk = (typeof performance !== 'undefined' ? performance : Date);
  const t0 = clk.now();
  const stages = [];
  let tPrev = t0;
  const mark = (n) => { const t = clk.now(); stages.push([n, +(t - tPrev).toFixed(1)]); tPrev = t; };
  const texel = worldSize / res;
  const N = res * res;

  // ── everything is DERIVED at the bake's own resolution ────────────────────
  //
  // and only STORED at half. Deriving at half rate looks like it should be
  // free, because the field is band-limited — but the MASK is not band-limited,
  // it is a threshold, and a threshold taken at 4 m rounds every channel up to
  // the cell that holds it. Measured on the shipped bake: deriving at 4 m took
  // the wet share from 21.8% to 26.9%, a quarter more water than the bake made,
  // all of it narrow tributaries inflated from two metres to four. Deriving at
  // 2 m and area-averaging the RESULT keeps the area, because a mean of the
  // depth field is the honest downsample of it and its zero set reproduces the
  // true coverage to first order.
  const level = new Float32Array(N).fill(NaN);
  // The bake's own wet mask, captured BEFORE anything below touches the level.
  //
  // Taking it afterwards was a real bug and it cost an afternoon: the extension
  // defines a level everywhere within 40 m of water, so a test written after it
  // reports every extended texel above its own bed as wet, and the mask the cap
  // and the level-smoothing exemption were supposed to be anchored to was the
  // inflated one they existed to bound. Both were then no-ops, and the field
  // quietly added a third more water to the world while reporting that it had
  // not.
  const bakedWet = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (water[i] > -9000) {
      level[i] = water[i];
      if (water[i] > height[i]) bakedWet[i] = 1;
    }
  }

  // ── extend the level off the wet mask ─────────────────────────────────────
  // A sentinel in a filtered channel is defect 3 in the header. The level has
  // to be defined, and smooth, for a band of ground OUTSIDE the water, because
  // that is precisely where a shoreline fade does its work. Propagated outward
  // from the nearest cell that knows one, which is what the mesh's dilation
  // ring does and for the same reason.
  //
  // 40 m of Chebyshev reach, unconditionally. The widest damp band the art spec
  // asks for is 3.1 m and the mesh is drawn out to about 15 m, so this only has
  // to be comfortably past both.
  //
  // It is worth being plain that this is an UNCONDITIONAL flood: there is no
  // height or slope test in it, so it runs its full twenty rings over a cliff
  // exactly as it does over a meadow, and the level it carries there is a
  // fiction. That is safe only because the mask below comes from the bake and
  // not from this — the extension may draw an edge, it may not invent a body,
  // and an earlier version of this file that let it decide the mask added a
  // third more water to the world.
  const RINGS = Math.max(4, Math.round(40 / texel));
  {
    // One Int32 ring buffer for the whole flood rather than an Array per ring.
    // The two-array form allocated and grew a JS Array of boxed indices per
    // ring, twenty rings deep over a 2.36 M-texel grid — measured at 90 ms of
    // pure allocation on a walk whose real work is a copy.
    const queue = new Int32Array(N);
    let head = 0, tail = 0, ringEnd = 0;
    for (let i = 0; i < N; i++) if (!Number.isNaN(level[i])) queue[tail++] = i;
    ringEnd = tail;
    for (let r = 0; r < RINGS && head < tail; r++) {
      while (head < ringEnd) {
        const k = queue[head++];
        const cx = k % res, cz = (k / res) | 0;
        const z0 = cz > 0 ? cz - 1 : 0, z1 = cz < res - 1 ? cz + 1 : res - 1;
        const x0 = cx > 0 ? cx - 1 : 0, x1 = cx < res - 1 ? cx + 1 : res - 1;
        const lv = level[k];
        for (let z = z0; z <= z1; z++) {
          const row = z * res;
          for (let x = x0; x <= x1; x++) {
            const nk = row + x;
            if (!Number.isNaN(level[nk])) continue;
            level[nk] = lv;
            queue[tail++] = nk;
          }
        }
      }
      ringEnd = tail;
    }
  }
  // Somewhere far from any water the level is still undefined. Park it well
  // under the bed so the depth is decisively negative and no consumer has to
  // carry a special case. -400 rather than -9999: this is stored as a
  // half-float, and it is a number the mip chain will average with real ones.
  for (let i = 0; i < N; i++) if (Number.isNaN(level[i])) level[i] = height[i] - 400;
  const wetSeed = bakedWet;
  // Smooth the propagated level, which is a nearest-neighbour field and so has
  // Voronoi creases in it. Only the EXTENSION is smoothed: a wet cell keeps its
  // own level exactly, because a lake being level is the one thing standing
  // water is never allowed to lose.
  {
    const tmp = new Float32Array(N), sm = new Float32Array(N);
    boxBlur(level, sm, res, Math.max(1, Math.round(levelBlurM / texel)), tmp);
    for (let i = 0; i < N; i++) if (!wetSeed[i]) level[i] = sm[i];
  }

  mark('extend+levelblur');
  // ── depth, from the bed as the bake left it ──────────────────────────────
  //
  // There was a shore-weighted low-pass of the bed here, with the departure
  // clamped, and it is gone. It was the round's opening hypothesis — "smooth
  // the terrain under the water placement" — and it is measurably the wrong
  // instrument, twice over:
  //
  //   * On its own it made the waterline BOTH rougher and worse conditioned
  //     than doing nothing: over the real bake, `fine` 13.2% -> 15.1% and the
  //     10th-percentile depth gradient 0.113 -> 0.079. A low-pass takes the
  //     fizz out of the bed and it also flattens the crossing, and a flatter
  //     crossing is a longer, wanderier contour that moves further when
  //     anything moves.
  //   * And it silently drains narrow water. Blurring an incised channel with
  //     its own banks RAISES its bed — a blurred cut is a shallower cut. Driven
  //     through the nine lab terrains it took `braid` from 11.01% wet to 7.79%
  //     and `meander` from 9.37% to 7.04%: a third of every thread in the map,
  //     gone, to smooth an edge that the distance field below smooths for free.
  //
  // The cure is to smooth the CURVE and steepen the CROSSING. That is what a
  // distance field does and what a blur cannot, and it is all done below.
  const depthF = new Float32Array(N);
  for (let i = 0; i < N; i++) depthF[i] = level[i] - height[i];

  // ── the mask is the BAKE's, not this file's ──────────────────────────────
  //
  // It used to be `depthF > 0`, i.e. the extended level minus the conditioned
  // bed, and that re-decides where water IS rather than where its edge is.
  // Wherever the 40 m extension ran downhill into a hollow the bake left dry,
  // the test passed and a pond appeared: measured over the nine lab terrains,
  // `gorge` gained HALF AGAIN as much water as the bake made (10.88% -> 16.15%)
  // because its floor is a dense braid and every thread's extension reached
  // every other thread's bank.
  //
  // A cap on distance-from-the-baked-mask was tried first and it works, but it
  // is the wrong shape: the cap becomes the mask boundary, so the mask is a
  // dilation of the jagged baked one and the curve is only as smooth as the
  // dilation radius — which is the same trade, paid in area, that the bed blur
  // was paid in. Measured: allowance 4 m gave `fine` 7.4% at +1.12 area,
  // allowance 2 m gave 14.6% at +0.21.
  //
  // Seed from the bake instead. The bake is the authority on extent, this file
  // is the authority on the edge, and the smoothing that makes the edge clean
  // is then a SYMMETRIC blur of a distance field — which moves the curve
  // inwards and outwards equally and so preserves area to first order, instead
  // of a dilation, which only ever adds.
  const cleaned = Uint8Array.from(bakedWet);
  const doClean = clean;

  // 1. Pinholes. A dry texel with three or four of its four orthogonal
  //    neighbours wet is a hole in a body, not a gap between two — a diagonal
  //    gap has at most two. Measured on the shipped bake, 6 726 texels inside a
  //    water splat never receive a write at all because of the per-texel
  //    rejections in `_waterSurface`, and 2.8% of channel water is adjacent to
  //    one. Two passes: filling a hole can expose the next one.
  for (let pass = 0; doClean && pass < 2; pass++) {
    const add = [];
    for (let z = 1; z < res - 1; z++) {
      for (let x = 1; x < res - 1; x++) {
        const k = z * res + x;
        if (cleaned[k]) continue;
        const n4 = cleaned[k - 1] + cleaned[k + 1] + cleaned[k - res] + cleaned[k + res];
        if (n4 >= 3) add.push(k);
      }
    }
    if (!add.length) break;
    for (const k of add) cleaned[k] = 1;
  }

  // 2. Crumbs — on area AND compactness, never on area alone. A body is thrown
  //    away only if it is under 40 m^2 AND its longer axis is under 12 m. A 6 m
  //    puddle goes; a 4 m x 30 m fragment of a braided thread stays, whatever
  //    its area. Dry islands inside water get the same test from the other side.
  if (doClean) {
    const CELL_AREA = texel * texel;
    const MIN_CELLS = Math.max(2, Math.round(40 / CELL_AREA));
    const MIN_EXTENT = Math.max(3, Math.round(12 / texel));
    const seen = new Uint8Array(N);
    const stack = new Int32Array(N);
    const comp = new Int32Array(N);
    for (const want of [1, 0]) {
      seen.fill(0);
      for (let s0 = 0; s0 < N; s0++) {
        if (seen[s0] || cleaned[s0] !== want) continue;
        let sp = 0, n = 0, xlo = res, xhi = -1, zlo = res, zhi = -1;
        stack[sp++] = s0; seen[s0] = 1;
        while (sp > 0) {
          const k = stack[--sp];
          comp[n++] = k;
          const cx = k % res, cz = (k / res) | 0;
          if (cx < xlo) xlo = cx; if (cx > xhi) xhi = cx;
          if (cz < zlo) zlo = cz; if (cz > zhi) zhi = cz;
          if (cx > 0 && !seen[k - 1] && cleaned[k - 1] === want) { seen[k - 1] = 1; stack[sp++] = k - 1; }
          if (cx < res - 1 && !seen[k + 1] && cleaned[k + 1] === want) { seen[k + 1] = 1; stack[sp++] = k + 1; }
          if (cz > 0 && !seen[k - res] && cleaned[k - res] === want) { seen[k - res] = 1; stack[sp++] = k - res; }
          if (cz < res - 1 && !seen[k + res] && cleaned[k + res] === want) { seen[k + res] = 1; stack[sp++] = k + res; }
        }
        const extent = Math.max(xhi - xlo, zhi - zlo) + 1;
        if (n < MIN_CELLS && extent < MIN_EXTENT) {
          const to = want ? 0 : 1;
          for (let i = 0; i < n; i++) cleaned[comp[i]] = to;
        }
      }
    }
  }

  // ── the signed distance field ─────────────────────────────────────────────
  const INF = 1e20;
  const scratch = edtScratch(res);
  const fIn = new Float64Array(N), fOut = new Float64Array(N);
  const dIn = new Float64Array(N), dOut = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    fIn[i] = cleaned[i] ? INF : 0;      // distance from dry, measured inside
    fOut[i] = cleaned[i] ? 0 : INF;     // distance from wet, measured outside
  }
  edt(fIn, res, dIn, scratch);
  edt(fOut, res, dOut, scratch);
  const CAP = 48;
  const sdfF = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // Half a texel off each side so the zero of the field lands on the boundary
    // between a wet and a dry texel rather than on a texel centre — otherwise
    // the whole field is biased outward by a texel and every band drawn from it
    // sits a metre inland.
    const din = Math.sqrt(dIn[i]) * texel - texel * 0.5;
    const dout = Math.sqrt(dOut[i]) * texel - texel * 0.5;
    sdfF[i] = Math.max(-CAP, Math.min(CAP, cleaned[i] ? din : -dout));
  }
  // ── smooth the CURVE, by as much as the body can afford ──────────────────
  //
  // Blurring a distance field is a well-behaved operation and it is not the
  // same as blurring a mask: near the zero set a distance field is LINEAR, so a
  // local mean of it is the mean surface, and the zero set moves only where the
  // curve was bending. It smooths the curve, symmetrically — inwards and
  // outwards equally — which is why it costs no area where a dilation would.
  //
  // But it is isotropic, and an isotropic smoothing at radius R destroys every
  // feature smaller than R — including the WIDTH of a channel narrower than R.
  // Measured: at a 10 m radius a 4 m thread's inside distance never exceeds
  // 2 m, the kernel flattens it to nearly constant, and the thread loses its
  // gradient and then itself.
  //
  // It does not need to touch them. Narrow water in this map is CARVED, along a
  // centreline that `_traceRivers` has already smoothed twelve times — those
  // boundaries are smooth by construction. The jagged edges are all on wide,
  // shallow water, where the bed is nearly flat and the waterline is a level
  // curve of whatever roughness erosion left. So the radius is rationed by how
  // wide the body is: a mean of the inside distance over 12 m, which is small
  // in a thread and large in a lake.
  const spanF = new Float32Array(N);
  {
    const tmp = new Float32Array(N), sm = new Float32Array(N);
    const inside = new Float32Array(N);
    for (let i = 0; i < N; i++) inside[i] = sdfF[i] > 0 ? sdfF[i] : 0;
    boxBlur(inside, spanF, res, Math.max(1, Math.round(12 / texel)), tmp);
    boxBlur(sdfF, sm, res, Math.max(1, Math.round(sdfBlurM / texel)), tmp);
    for (let i = 0; i < N; i++) {
      // 1.0 m of mean inside-distance is a thread; 4.0 m is a body that can
      // take the full radius.
      const t = Math.min(1, Math.max(0, (spanF[i] - 1.0) / 3.0));
      const w = t * t * (3 - 2 * t);
      sdfF[i] = sdfF[i] + (sm[i] - sdfF[i]) * w;
    }
  }

  // ── grade the crossing, do not merely smooth it ──────────────────────────
  //
  // A low-pass of the bed makes the waterline SMOOTHER and makes it CRAWL.
  // Measured over the shipped bake: blurring the bed at 8 m took `fine` from
  // 15.3% to 13.3% and took the 10th-percentile depth gradient at the waterline
  // from 0.106 to 0.068 — a third worse. That gradient is what decides how far
  // the line moves when anything about the bed moves, so halving it doubles
  // every shimmer, and a shoreline that is smooth in a still frame and crawling
  // in motion is not an improvement.
  //
  // The distance field already knows the answer. Near the waterline, replace
  // the depth with `k * sdf`: a field whose zero set is the SMOOTHED curve by
  // construction, and whose gradient is exactly k because the gradient of a
  // distance field is one. Blended out over a band so the interior keeps its
  // real bathymetry — a lake still gets deeper towards the middle, and the
  // shelf and sandbar terms downstream still have a bed to read.
  //
  // ── the numbers, from tools/hydrosweep.mjs over the real bake ────────────
  //
  //   variant            dArea    fine   grad10
  //   off                +1.53   13.2%    0.113
  //   morph only         +1.01   10.9%    0.129
  //   bed blur alone     -0.24   15.1%    0.079   <- WORSE on both
  //   grade .30 band 6   -0.24   11.2%    0.103
  //   grade .45 band 18  +0.24    6.3%    0.233
  //   grade .60 band 18  +0.01    5.7%    0.293   <- shipped
  //   grade .80 band 18  +0.01    5.8%    0.374
  //
  // Read the third row. An eight-metre low-pass of the bed, ON ITS OWN, made
  // the waterline both rougher and less well conditioned than doing nothing —
  // it takes the fizz out of the bed but it also flattens the crossing, and a
  // flatter crossing means a longer, wanderier contour. The intuition the round
  // started from ("smooth the terrain under the water") is right about the
  // cause and wrong about the cure: the cure is to smooth the CURVE and steepen
  // the CROSSING, which is what a distance field does and what a blur cannot.
  //
  // k = 0.60 m/m, floored rather than imposed: where the bank is genuinely
  // steeper than that the real depth is used, because a gorge wall should not
  // be handed a 1:1.7 beach. It only ever STEEPENS a crossing that was flatter,
  // which is where all of the trouble is — the median bed gradient in the
  // shallow band is 0.288 and 6.4% of water-bearing texels are under 0.05.
  // Past 0.80 the shallows stop existing: depth reaches a metre inside 1.2 m of
  // shore and the whole translucent margin the plates show goes with it.
  const K = gradeK;
  const BAND = gradeBandM;
  for (let i = 0; i < N; i++) {
    const a = Math.abs(sdfF[i]);
    if (a > BAND) {
      // Outside the band, only reconcile the sign with the cleaned mask, so a
      // consumer testing `depth > 0` and one testing `sdf > 0` cannot disagree.
      if (cleaned[i] && depthF[i] <= 0) depthF[i] = 0.05;
      else if (!cleaned[i] && depthF[i] > 0) depthF[i] = -0.05;
      continue;
    }
    const graded = sdfF[i] * K;
    // Full weight at the line, none at the edge of the band.
    const t = 1 - a / BAND;
    const wq = t * t * (3 - 2 * t);
    // Floored: keep whichever of the two is FURTHER from zero, so a steep bank
    // is never flattened into a beach, and then blend that toward the real
    // depth away from the line.
    const steep = Math.abs(graded) > Math.abs(depthF[i]) || (graded > 0) !== (depthF[i] > 0)
      ? graded : depthF[i];
    depthF[i] = depthF[i] + (steep - depthF[i]) * wq;
  }

  mark('grade');
  // ── store at half rate ────────────────────────────────────────────────────
  const HR = res >> 1;
  const HN = HR * HR;
  const depth = new Float32Array(HN), sdf = new Float32Array(HN);
  const wet = new Float32Array(HN), span = new Float32Array(HN);
  for (let z = 0; z < HR; z++) {
    for (let x = 0; x < HR; x++) {
      const k = z * HR + x;
      const a = (z * 2) * res + x * 2, b = a + 1, c = a + res, d = c + 1;
      depth[k] = (depthF[a] + depthF[b] + depthF[c] + depthF[d]) * 0.25;
      sdf[k] = (sdfF[a] + sdfF[b] + sdfF[c] + sdfF[d]) * 0.25;
      span[k] = (spanF[a] + spanF[b] + spanF[c] + spanF[d]) * 0.25;
      // Coverage is the true fraction of the four texels that are wet, not a
      // function of the averaged depth. That is what makes it an ANTIALIASED
      // mask: a cell straddling the waterline stores 0.25 or 0.5, and the
      // perched guard that reads it fades instead of stepping.
      wet[k] = (cleaned[a] + cleaned[b] + cleaned[c] + cleaned[d]) * 0.25;
      // ...and the two channels that carry a SIGN must agree about it.
      //
      // They agree exactly at full resolution — the grading sets depth to
      // 0.60 x sdf near the line — and the downsample breaks it: a cell with
      // two wet texels and two dry can average a positive depth and a negative
      // distance, because the two are averages of different quantities. Left
      // alone it is 1.35% of the field, all of it on the waterline itself, and
      // it means a consumer testing `depth > 0` and one testing `sdf > 0` draw
      // two different curves — which is the exact defect this whole file exists
      // to remove, reintroduced in its last ten lines.
      //
      // Only the disagreeing cells are touched, and they take the distance
      // field's answer, because that is the smooth one. A cell where the two
      // already agree keeps its real depth, so a steep bank is still steep.
      if ((depth[k] > 0) !== (sdf[k] > 0)) depth[k] = gradeK * sdf[k];
    }
  }

  mark('downsample');
  const ms = clk.now() - t0;
  return { res: HR, texel: texel * 2, depth, sdf, wet, span, ms, stages };
}
