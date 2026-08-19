// ─────────────────────────────────────────────────────────────────────────────
//  NearTrees — a small, slowly-refreshed index of the trees around the camera.
//
//  Both the leaf drift and the light shafts need the same question answered:
//  "which trees are close enough to matter, and which of those are deciduous".
//  Trees already buckets its placement into a 64 m grid, so this is a walk over
//  a handful of buckets — but it is pointless to do that twice, and pointless
//  to do it every frame, so it lives here and runs a couple of times a second.
//
//  Deciduous trees are sorted to the front of the list, which lets a caller
//  that only sheds leaves ignore the conifer tail without a second pass.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { SPECIES } from '../vegetation/tree_species.js';

export class NearTrees {
  constructor(ctx, radius = 70, cap = 384) {
    this.ctx = ctx;
    this.radius = radius;
    this.idx = new Int32Array(cap);
    this.n = 0;            // total in range
    this.decidN = 0;       // how many of the first entries are deciduous
    this._timer = 0;
    this._pos = new THREE.Vector3(1e9, 0, 1e9);
    this._tail = new Int32Array(cap);
  }

  update(dt, cam) {
    this._timer -= dt;
    // Rebuild on a timer, or immediately if the camera has jumped — a capture
    // tool teleporting the camera must not leave a stale index behind.
    if (this._timer > 0 && this._pos.distanceToSquared(cam) < 225) return;
    this._timer = 0.45;
    this._pos.copy(cam);
    this._scan(cam);
  }

  _scan(cam) {
    this.n = 0; this.decidN = 0;
    const T = this.ctx.systems?.trees?.trees;
    this.data = T;
    if (!T) return;
    const { px, pz, pspec, order, bucketStart, BW, BS, half } = T;
    const R = this.radius, cap = this.idx.length;
    const b0x = Math.max(0, Math.floor((cam.x - R + half) / BS));
    const b1x = Math.min(BW - 1, Math.floor((cam.x + R + half) / BS));
    const b0z = Math.max(0, Math.floor((cam.z - R + half) / BS));
    const b1z = Math.min(BW - 1, Math.floor((cam.z + R + half) / BS));
    const r2 = R * R;
    let d = 0, c = 0;
    for (let bz = b0z; bz <= b1z; bz++) {
      for (let bx = b0x; bx <= b1x; bx++) {
        const b = bz * BW + bx;
        const s = bucketStart[b], e = bucketStart[b + 1];
        for (let k = s; k < e; k++) {
          const t = order[k];
          const dx = px[t] - cam.x, dz = pz[t] - cam.z;
          if (dx * dx + dz * dz > r2) continue;
          if (SPECIES[pspec[t]]?.conifer) {
            if (c < cap) this._tail[c++] = t;
          } else if (d < cap) {
            this.idx[d++] = t;
          }
        }
      }
    }
    this.decidN = d;
    // Conifers after the deciduous block, up to the cap.
    const room = Math.min(c, cap - d);
    for (let i = 0; i < room; i++) this.idx[d + i] = this._tail[i];
    this.n = d + room;
  }
}
