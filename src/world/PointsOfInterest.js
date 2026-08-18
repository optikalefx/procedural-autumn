// ─────────────────────────────────────────────────────────────────────────────
//  Landmark finder. Scans the baked world for the places worth looking at:
//  vistas, riverbanks, waterfall bases, forest interiors, peaks, meadows.
//  Used by photo mode, the compass HUD, wildlife spawning and the capture rig.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp01, smoothstep, mulberry32 } from '../core/MathUtils.js';

export class PointsOfInterest {
  constructor(world, seed = 20261018) {
    this.world = world;
    this.rng = mulberry32(seed ^ 0x1eaf);
    this.list = { vista: [], meadow: [], forest: [], river: [], waterfall: [], peak: [], road: [] };
    this._scan();
  }

  _scan() {
    const W = this.world;
    const half = W.half * 0.86;
    const STEP = 24;

    for (let z = -half; z <= half; z += STEP) {
      for (let x = -half; x <= half; x += STEP) {
        const h = W.getHeight(x, z);
        const slope = W.getSlope(x, z);
        const moist = W.getMoisture(x, z);
        const river = W.getRiver(x, z);
        const depth = W.getWaterDepth(x, z);

        // Vista: elevated, flat enough to stand on, with a big drop nearby.
        if (slope < 0.45 && h > 55) {
          let maxDrop = 0;
          for (let a = 0; a < 8; a++) {
            const ang = (a / 8) * Math.PI * 2;
            const d = h - W.getHeight(x + Math.cos(ang) * 130, z + Math.sin(ang) * 130);
            if (d > maxDrop) maxDrop = d;
          }
          if (maxDrop > 42) this.list.vista.push({ x, z, y: h, score: maxDrop + h * 0.3 });
        }

        // Peak: local maximum.
        if (h > 175) {
          let isPeak = true;
          for (let a = 0; a < 6 && isPeak; a++) {
            const ang = (a / 6) * Math.PI * 2;
            if (W.getHeight(x + Math.cos(ang) * 45, z + Math.sin(ang) * 45) > h) isPeak = false;
          }
          if (isPeak) this.list.peak.push({ x, z, y: h, score: h });
        }

        // Meadow: flat, dry-ish, open, low.
        if (slope < 0.20 && h > 4 && h < 95 && depth === 0) {
          this.list.meadow.push({ x, z, y: h, score: (0.25 - slope) * 100 + moist * 10 });
        }

        // Forest: damp, moderate slope, mid altitude.
        if (moist > 0.45 && slope < 0.55 && h > 10 && h < 165 && depth === 0) {
          this.list.forest.push({ x, z, y: h, score: moist * 100 });
        }

        // Riverbank: adjacent to flowing water but standing dry.
        if (depth === 0 && river < 0.02) {
          let nearRiver = 0;
          for (let a = 0; a < 6; a++) {
            const ang = (a / 6) * Math.PI * 2;
            nearRiver = Math.max(nearRiver, W.getRiver(x + Math.cos(ang) * 14, z + Math.sin(ang) * 14));
          }
          if (nearRiver > 0.22) this.list.river.push({ x, z, y: h, score: nearRiver * 100 });
        }
      }
    }

    for (const wf of W.waterfalls) {
      this.list.waterfall.push({
        x: wf.bottom[0], z: wf.bottom[2], y: wf.bottom[1],
        score: wf.height * 10 + wf.discharge * 40,
        meta: wf,
      });
    }

    for (const road of W.roads) {
      for (let i = 8; i < road.length - 8; i += 14) {
        const p = road[i];
        const next = road[Math.min(road.length - 1, i + 3)];
        this.list.road.push({
          x: p.x, z: p.z, y: p.y,
          yaw: Math.atan2(next.x - p.x, next.z - p.z),
          score: 1 + this.rng(),
        });
      }
    }

    for (const k of Object.keys(this.list)) {
      this.list[k].sort((a, b) => b.score - a.score);
      this.list[k] = this._thin(this.list[k], k === 'road' ? 60 : 140, 40);
    }
  }

  // Keep the best candidates but spread them out.
  _thin(arr, minDist, max) {
    const kept = [];
    const d2 = minDist * minDist;
    for (const c of arr) {
      let ok = true;
      for (const k of kept) {
        const dx = k.x - c.x, dz = k.z - c.z;
        if (dx * dx + dz * dz < d2) { ok = false; break; }
      }
      if (ok) kept.push(c);
      if (kept.length >= max) break;
    }
    return kept;
  }

  best(kind, index = 0) {
    const a = this.list[kind];
    if (!a || !a.length) return null;
    return a[Math.min(index, a.length - 1)];
  }

  /** Deterministic camera anchor for the capture harness. */
  anchor(kind, index = 0) {
    const p = this.best(kind, index);
    if (!p) return { x: 0, z: 0, yaw: 0 };
    // Face the most interesting direction: toward the biggest nearby drop or,
    // for water/forest, toward the feature itself.
    let yaw = p.yaw;
    if (yaw === undefined) {
      // A good vista looks *across* something: the near ground must fall away
      // (so we are not staring at a hillside) while the far ground rises (so
      // mountains fill the back of the frame). Scoring only "distant height"
      // reliably aims the camera straight into the nearest slope.
      let best = -Infinity;
      const W = this.world;
      const h0 = W.getHeight(p.x, p.z);
      for (let a = 0; a < 32; a++) {
        const ang = (a / 32) * Math.PI * 2;
        const sx = Math.sin(ang), sz = Math.cos(ang);
        let near = 0, far = 0, blocked = 0;
        for (let d = 12; d <= 90; d += 12) {
          const dh = W.getHeight(p.x + sx * d, p.z + sz * d) - h0;
          near += dh;
          if (dh > 6) blocked += dh;          // something in the way
        }
        for (let d = 180; d <= 620; d += 70) {
          far += W.getHeight(p.x + sx * d, p.z + sz * d) - h0;
        }
        const score = -near * 1.6 - blocked * 3.0 + far * 0.55;
        if (score > best) { best = score; yaw = ang; }
      }
    }
    return { x: p.x, z: p.z, y: p.y, yaw, lookY: 1.4, meta: p.meta };
  }
}
