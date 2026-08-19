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

        // Peak: a *vantage on* a summit group, not the summit itself.
        //
        // Standing on the highest thing in sight and looking out at the given
        // pitch fills the frame with sky, which is what the "peaks" capture
        // used to be. What reads as mountains is a shoulder a few hundred
        // metres out and well below the crest, aimed back at the massif.
        if (h > 175) {
          let isPeak = true;
          for (let a = 0; a < 6 && isPeak; a++) {
            const ang = (a / 6) * Math.PI * 2;
            if (W.getHeight(x + Math.cos(ang) * 45, z + Math.sin(ang) * 45) > h) isPeak = false;
          }
          if (isPeak) {
            // Search the ring around the summit for the best stand-off: low
            // enough to look up from, and with clear air between it and the
            // peak so we are not staring at an intervening spur.
            let bestScore = -Infinity, best = null;
            for (let a = 0; a < 16; a++) {
              const ang = (a / 16) * Math.PI * 2;
              const ca = Math.cos(ang), sa = Math.sin(ang);
              // Stand well back. At 340 m from a 340 m peak the massif subtends
              // more than the whole frame and the shot becomes a close-up of one
              // face — you cannot read a mountain you are pressed against. These
              // ranges put the summit around a third of the frame height and
              // leave room for the middle distance the reference plates all have.
              for (const d of [620, 780, 950]) {
                const vx = x + ca * d, vz = z + sa * d;
                if (!W.isInBounds(vx, vz)) continue;
                const vh = W.getHeight(vx, vz);
                if (W.getWaterDepth(vx, vz) > 0.2) continue;
                // Nothing may poke above the sight line to the summit.
                let blocked = 0;
                for (let t = 0.25; t < 0.95; t += 0.15) {
                  const sx = vx + (x - vx) * t, sz = vz + (z - vz) * t;
                  const sightY = vh + (h - vh) * t;
                  blocked = Math.max(blocked, W.getHeight(sx, sz) - sightY);
                }
                const score = (h - vh) * 1.0 - blocked * 4.0 - W.getSlope(vx, vz) * 60;
                if (score > bestScore) {
                  bestScore = score;
                  best = { x: vx, z: vz, y: vh, yaw: Math.atan2(x - vx, z - vz), score: h + bestScore * 0.2 };
                }
              }
            }
            if (best && h - best.y > 90) this.list.peak.push(best);
          }
        }

        // Meadow: flat, dry-ish, open, low.
        // Open ground, and DRY open ground at that. Scoring meadows *up* for
        // moisture aimed the camera at the dampest spot in the valley, which is
        // precisely where the tree scatter is densest — several captures came
        // back from inside a trunk. A meadow is the clearing, not the wood.
        if (slope < 0.20 && h > 4 && h < 95 && depth === 0) {
          this.list.meadow.push({ x, z, y: h, score: (0.25 - slope) * 100 + (0.5 - moist) * 40 });
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
          if (nearRiver > 0.22) {
            // Face the water. Scoring for a distant view instead reliably aims
            // a "river" shot at the hillside behind the photographer.
            let byaw = 0, bestR = -1;
            for (let a = 0; a < 16; a++) {
              const ang = (a / 16) * Math.PI * 2;
              let acc = 0;
              for (const d of [12, 24, 40, 60]) {
                acc += W.getRiver(x + Math.sin(ang) * d, z + Math.cos(ang) * d) * (80 - d);
              }
              if (acc > bestR) { bestR = acc; byaw = ang; }
            }
            // Dry, open, level bank. Scoring on proximity to water alone put
            // the camera in the wettest spot on the bank, which is exactly
            // where the conifer scatter is densest — the capture came back
            // looking at the inside of a tree.
            this.list.river.push({
              x, z, y: h, yaw: byaw,
              score: nearRiver * 100 - moist * 35 - slope * 45,
            });
          }
        }
      }
    }

    for (const wf of W.waterfalls) {
      // Stand off downstream of the plunge pool and look back up the fall —
      // standing in it and picking a yaw by terrain score points at a wall.
      const dx = wf.bottom[0] - wf.top[0], dz = wf.bottom[2] - wf.top[2];
      const len = Math.hypot(dx, dz) || 1;
      // Try several stand-offs and keep the one with a clear line of sight to
      // the lip. One fixed distance is a coin toss: on some bakes it lands on
      // open bank, on others behind a spur or inside the treeline, and a
      // capture from inside a conifer is not a shot of a waterfall.
      let px = wf.bottom[0], pz = wf.bottom[2], bestScore = -Infinity;
      for (const off of [30, 46, 64, 84]) {
        const cx = wf.bottom[0] + (dx / len) * off;
        const cz = wf.bottom[2] + (dz / len) * off;
        if (!W.isInBounds(cx, cz)) continue;
        if (W.getWaterDepth(cx, cz) > 0.4) continue;      // not standing in it
        const cy = W.getHeight(cx, cz) + 1.4;
        // Nothing may poke above the sight line from here up to the lip.
        let blocked = 0;
        for (let t = 0.15; t < 0.95; t += 0.12) {
          const sx = cx + (wf.top[0] - cx) * t, sz = cz + (wf.top[2] - cz) * t;
          blocked = Math.max(blocked, W.getHeight(sx, sz) - (cy + (wf.top[1] - cy) * t));
        }
        // Prefer open, gently sloping bank; damp ground is where the trees are.
        const score = -blocked * 6.0 - W.getSlope(cx, cz) * 40 - W.getMoisture(cx, cz) * 25;
        if (score > bestScore) { bestScore = score; px = cx; pz = cz; }
      }
      this.list.waterfall.push({
        x: px, z: pz, y: W.getHeight(px, pz),
        yaw: Math.atan2(wf.top[0] - px, wf.top[2] - pz),
        score: wf.height * 10 + wf.discharge * 40,
        meta: wf,
      });
    }

    for (const road of W.roads) {
      for (let i = 8; i < road.length - 8; i += 14) {
        const p = road[i];
        const next = road[Math.min(road.length - 1, i + 3)];
        const yaw = Math.atan2(next.x - p.x, next.z - p.z);
        // Scored, not drawn at random. `drive` is the frame the player stares
        // at for hours and the one the critic used to judge the largest terrain
        // mass in the set, and a road point picked by coin toss lands inside
        // the densest thicket on the map as readily as anywhere else — this
        // capture came back as a close-up of fern fronds with no ground and no
        // horizon in it at all, which is a frame nobody can judge anything from.
        //
        // Three terms, all read off fields we already have. Tree and scrub
        // scatter follows moisture, so dry ground ahead is open ground. Nothing
        // should stand across the near view. And there should be something in
        // the distance worth driving toward — which in this valley means the
        // ground rising to a massif rather than falling away to more meadow.
        const sx = Math.sin(yaw), sz = Math.cos(yaw);
        let damp = 0, blocked = 0, ahead = 0;
        for (let d = 10; d <= 90; d += 16) damp += W.getMoisture(p.x + sx * d, p.z + sz * d);
        for (let d = 25; d <= 140; d += 23) {
          const dh = W.getHeight(p.x + sx * d, p.z + sz * d) - p.y;
          if (dh > 6) blocked += dh;
        }
        for (let d = 220; d <= 820; d += 120) {
          ahead += Math.max(0, W.getHeight(p.x + sx * d, p.z + sz * d) - p.y);
        }
        this.list.road.push({
          x: p.x, z: p.z, y: p.y, yaw,
          // The jitter is kept so that road[1], road[2] … are not all the same
          // stretch of the same track, but it is now small enough that it only
          // ever breaks ties.
          score: ahead * 0.06 - blocked * 0.40 - damp * 16 - W.getSlope(p.x, p.z) * 30
                 + this.rng() * 3,
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
        // The occlusion test has to reach past the near ground. Checking only
        // the first 90 m happily picks a direction where a whole massif starts
        // at 120 m and fills two thirds of the frame, which is not a vista —
        // it is a wall. 260 m of clearance is what buys the open middle
        // distance the reference plates all have.
        let near = 0, far = 0, blocked = 0;
        for (let d = 12; d <= 90; d += 13) {
          const dh = W.getHeight(p.x + sx * d, p.z + sz * d) - h0;
          near += dh;
        }
        for (let d = 20; d <= 260; d += 20) {
          const dh = W.getHeight(p.x + sx * d, p.z + sz * d) - h0;
          if (dh > 4) blocked += dh;
        }
        for (let d = 320; d <= 900; d += 80) {
          far += W.getHeight(p.x + sx * d, p.z + sz * d) - h0;
        }
        const score = -near * 1.4 - blocked * 2.4 + far * 0.42;
        if (score > best) { best = score; yaw = ang; }
      }
    }
    return { x: p.x, z: p.z, y: p.y, yaw, lookY: 1.4, meta: p.meta };
  }
}
