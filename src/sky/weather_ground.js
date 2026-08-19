// ─────────────────────────────────────────────────────────────────────────────
//  GroundCache — a cheap, allocation-free ground height around the camera.
//
//  Why this exists: `WorldData.getHeight` returns a freshly allocated pair from
//  `toGrid` and then runs five fbm octaves of micro-detail. That is the right
//  call for placing a rock once; it is the wrong call a thousand times a frame
//  from a particle integrator, where it both allocates and dominates the cost.
//
//  Leaves only need to know "have I landed yet", and mist only needs "how deep
//  is this hollow" — both are answered fine by a 6 m lattice. So: a toroidal
//  grid of heights that follows the camera, refreshed by a rolling cursor a
//  slice at a time so no single frame pays for a full rebuild.
//
//  A cell is addressed by its absolute world cell index wrapped into the grid,
//  which means moving the camera invalidates only the cells that actually left
//  the box — the rest keep their values with no copying at all.
// ─────────────────────────────────────────────────────────────────────────────

const CELL = 6;          // metres per cell
const N = 32;            // cells per side -> 192 m box
const REFRESH = 128;     // cells re-sampled per frame (whole grid in 8 frames)

export class GroundCache {
  constructor(world) {
    this.world = world;
    this.h = new Float32Array(N * N);
    // Which absolute cell each slot currently holds. A sentinel that no real
    // cell index can take forces a fill on the first pass.
    this.ix = new Int32Array(N * N).fill(0x7fffffff);
    this.iz = new Int32Array(N * N).fill(0x7fffffff);
    this.cursor = 0;
    this.centreX = 0;
    this.centreZ = 0;
    this.fallback = 0;
  }

  /** Fill every slot immediately. Called once, from init. */
  prime(camX, camZ) {
    this.centreX = camX; this.centreZ = camZ;
    this.fallback = this.world.getHeight(camX, camZ);
    this._refresh(N * N);
  }

  update(camX, camZ) {
    this.centreX = camX; this.centreZ = camZ;
    this._refresh(REFRESH);
  }

  _refresh(count) {
    const { h, ix, iz, world } = this;
    // Cell index of the box's lower corner, snapped so the wrap is stable.
    const c0x = Math.floor(this.centreX / CELL) - (N >> 1);
    const c0z = Math.floor(this.centreZ / CELL) - (N >> 1);
    for (let k = 0; k < count; k++) {
      const c = this.cursor;
      this.cursor = (this.cursor + 1) % (N * N);
      // Slot -> the one absolute cell inside the current box that wraps onto it.
      const sx = c % N, sz = (c / N) | 0;
      const ax = c0x + ((sx - ((c0x % N) + N) % N + N) % N);
      const az = c0z + ((sz - ((c0z % N) + N) % N + N) % N);
      if (ix[c] === ax && iz[c] === az) continue;
      ix[c] = ax; iz[c] = az;
      h[c] = world.getHeight(ax * CELL, az * CELL);
    }
  }

  /** Bilinear ground height. Returns the cached fallback outside the box. */
  at(x, z) {
    const fx = x / CELL, fz = z / CELL;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const tx = fx - x0, tz = fz - z0;
    const h = this.h, ix = this.ix, iz = this.iz;
    const a0 = ((x0 % N) + N) % N, b0 = ((z0 % N) + N) % N;
    const a1 = (a0 + 1) % N, b1 = (b0 + 1) % N;
    const i00 = b0 * N + a0;
    // One validity probe is enough: if the primary cell is stale the query is
    // outside the box and the fallback is a better answer than a wrapped one.
    if (ix[i00] !== x0 || iz[i00] !== z0) return this.fallback;
    const i10 = b0 * N + a1, i01 = b1 * N + a0, i11 = b1 * N + a1;
    const h0 = h[i00] + (h[i10] - h[i00]) * tx;
    const h1 = h[i01] + (h[i11] - h[i01]) * tx;
    return h0 + (h1 - h0) * tz;
  }
}
