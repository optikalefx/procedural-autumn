// ─────────────────────────────────────────────────────────────────────────────
//  RockForms — procedural faceted rock meshes.
//
//  Every rock is a convex polytope built by intersecting half-spaces: start
//  from a big cube and clip it with N planes tangent to a shaped ellipsoid.
//  That is the whole trick behind the reference art's look — a plane cut gives
//  a *genuinely* flat facet with a mathematically crisp edge, where sphere +
//  noise displacement can only ever give a lumpy blob with mushy silhouettes.
//
//  Rounding ("water-worn") is a second clipping pass at the protruding corners
//  and edges, i.e. real erosion truncation rather than a smoothing filter, so
//  a river boulder is still made of clean planes — just more of them.
//
//  Bigger forms (heroes, outcrops) are unions of 2-3 such polytopes, which is
//  what gives them a shouldered silhouette and, importantly, concave creases
//  where the baked AO has something to do.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32, clamp01 } from '../core/MathUtils.js';
import { NoiseField } from '../core/Noise.js';

const EPS = 1e-6;

// ── half-space clipping ──────────────────────────────────────────────────────

function boxFaces(B) {
  const P = (x, y, z) => new THREE.Vector3(x * B, y * B, z * B);
  // Wound CCW seen from outside; the winding is re-verified after clipping
  // anyway, so this only has to be approximately right.
  return [
    { n: new THREE.Vector3(-1, 0, 0), d: B, pts: [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)] },
    { n: new THREE.Vector3(1, 0, 0), d: B, pts: [P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1)] },
    { n: new THREE.Vector3(0, -1, 0), d: B, pts: [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)] },
    { n: new THREE.Vector3(0, 1, 0), d: B, pts: [P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1)] },
    { n: new THREE.Vector3(0, 0, -1), d: B, pts: [P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)] },
    { n: new THREE.Vector3(0, 0, 1), d: B, pts: [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)] },
  ];
}

/** Build the polygon that caps a fresh cut. Convexity makes angular sort valid. */
function buildCap(cutPts, plane) {
  if (cutPts.length < 3) return null;
  const pts = [];
  for (const p of cutPts) {
    let dup = false;
    for (let i = 0; i < pts.length; i++) if (pts[i].distanceToSquared(p) < 1e-8) { dup = true; break; }
    if (!dup) pts.push(p);
  }
  if (pts.length < 3) return null;

  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / pts.length);

  const n = plane.n;
  const u = Math.abs(n.y) < 0.9
    ? new THREE.Vector3(0, 1, 0).cross(n).normalize()
    : new THREE.Vector3(1, 0, 0).cross(n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);

  const tmp = new THREE.Vector3();
  pts.sort((a, b) => {
    const aa = Math.atan2(tmp.copy(a).sub(c).dot(v), tmp.copy(a).sub(c).dot(u));
    const bb = Math.atan2(tmp.copy(b).sub(c).dot(v), tmp.copy(b).sub(c).dot(u));
    return aa - bb;
  });
  return { n: n.clone(), d: plane.d, pts };
}

function clipPolytope(faces, plane) {
  const next = [];
  const cut = [];
  for (const f of faces) {
    const pts = f.pts, m = pts.length;
    const out = [];
    for (let i = 0; i < m; i++) {
      const a = pts[i], b = pts[(i + 1) % m];
      const da = plane.n.dot(a) - plane.d;
      const db = plane.n.dot(b) - plane.d;
      if (da <= EPS) {
        out.push(a);
        if (da >= -EPS) cut.push(a);          // vertex lies on the cut
      }
      if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
        const t = da / (da - db);
        const p = new THREE.Vector3().lerpVectors(a, b, t);
        out.push(p);
        cut.push(p);
      }
    }
    if (out.length >= 3) next.push({ n: f.n, d: f.d, pts: out });
  }
  const cap = buildCap(cut, plane);
  if (cap) next.push(cap);
  return next;
}

/** Drop slivers and collinear vertices — clipping accumulates both. */
function cleanFaces(faces, scale) {
  const minEdge = scale * 0.012;
  const minArea = scale * scale * 0.0006;
  const out = [];
  for (const f of faces) {
    const pts = [];
    for (let i = 0; i < f.pts.length; i++) {
      const p = f.pts[i];
      if (pts.length && pts[pts.length - 1].distanceTo(p) < minEdge) continue;
      pts.push(p);
    }
    while (pts.length > 2 && pts[0].distanceTo(pts[pts.length - 1]) < minEdge) pts.pop();
    if (pts.length < 3) continue;

    // Area via the fan; also fixes winding against the stored plane normal.
    let area = 0;
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cr = new THREE.Vector3();
    const acc = new THREE.Vector3();
    for (let i = 1; i < pts.length - 1; i++) {
      e1.subVectors(pts[i], pts[0]);
      e2.subVectors(pts[i + 1], pts[0]);
      cr.crossVectors(e1, e2);
      acc.add(cr);
      area += cr.length() * 0.5;
    }
    if (area < minArea) continue;
    if (acc.dot(f.n) < 0) pts.reverse();
    out.push({ n: f.n, d: f.d, pts });
  }
  return out;
}

// ── shaping ──────────────────────────────────────────────────────────────────

/** Support function of an ellipsoid: distance to the tangent plane along n. */
function support(n, a) {
  return Math.sqrt(a.x * a.x * n.x * n.x + a.y * a.y * n.y * n.y + a.z * a.z * n.z * n.z);
}

function fibDirs(count, rng, jitter) {
  const dirs = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * i + 1) / count;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    const d = new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r);
    d.x += (rng() * 2 - 1) * jitter;
    d.y += (rng() * 2 - 1) * jitter;
    d.z += (rng() * 2 - 1) * jitter;
    dirs.push(d.normalize());
  }
  return dirs;
}

/** A random orthonormal frame, optionally tipped off vertical (bedding dip). */
function randomFrame(rng, tiltMax) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng() * Math.PI * 2, 0));
  const a = rng() * Math.PI * 2;
  q.multiply(new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), (rng() * 2 - 1) * tiltMax));
  return [
    new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    new THREE.Vector3(0, 0, 1).applyQuaternion(q),
  ];
}

function planesFromDirs(dirs, axes, noise, lump, lumpFreq, offJit, rng) {
  const out = [];
  for (const n of dirs) {
    let d = support(n, axes);
    d *= 1 + lump * noise.n3d(n.x * lumpFreq + 3.1, n.y * lumpFreq + 7.7, n.z * lumpFreq + 1.9);
    d *= 1 + (rng() * 2 - 1) * offJit;
    out.push({ n, d: Math.max(d, 0.05) });
  }
  return out;
}

function uniqueVerts(faces, tol = 1e-4) {
  const list = [];
  const t2 = tol * tol;
  for (const f of faces) {
    for (const p of f.pts) {
      let dup = false;
      for (let i = 0; i < list.length; i++) if (list[i].distanceToSquared(p) < t2) { dup = true; break; }
      if (!dup) list.push(p.clone());
    }
  }
  return list;
}

/**
 * Erosion pass: clip the most protruding corners (and, for water-worn forms,
 * edge midpoints) back toward the body. This is what turns a sharp angular
 * chunk into a rounded river boulder without ever losing planar facets.
 */
function erosionPlanes(faces, axes, amount, maxCount, useEdges, rng) {
  const cand = [];
  const seen = [];
  const add = (p) => {
    const L = p.length();
    if (L < 1e-4) return;
    for (let i = 0; i < seen.length; i++) if (seen[i].distanceToSquared(p) < 1e-4) return;
    seen.push(p);
    const n = p.clone().multiplyScalar(1 / L);
    cand.push({ n, len: L, ratio: L / Math.max(support(n, axes), 1e-4) });
  };
  for (const f of faces) {
    for (let i = 0; i < f.pts.length; i++) {
      add(f.pts[i].clone());
      if (useEdges) {
        const b = f.pts[(i + 1) % f.pts.length];
        add(f.pts[i].clone().add(b).multiplyScalar(0.5));
      }
    }
  }
  cand.sort((a, b) => b.ratio - a.ratio);
  const out = [];
  for (let i = 0; i < Math.min(maxCount, cand.length); i++) {
    const c = cand[i];
    out.push({ n: c.n, d: c.len * (1 - amount * (0.65 + 0.7 * rng())) });
  }
  return out;
}

// ── archetype definitions ────────────────────────────────────────────────────
//  `chunks` returns one or more { planes, faces } convex bodies in local space.
//  Local space is normalised so the body is roughly 2 units across in X.

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

function makeBody(rng, noise, cfg) {
  const axes = cfg.axes;
  let dirs = [];

  // Structural planes first: a tipped box frame gives the few big, dominant
  // faces that make fractured rock read as fractured rather than as gravel.
  if (cfg.boxTilt !== undefined) {
    const [e1, e2, e3] = randomFrame(rng, cfg.boxTilt);
    for (const e of [e1, e2, e3]) { dirs.push(e.clone()); dirs.push(e.clone().negate()); }
  }
  if (cfg.columnar) {
    // A prismatic column: vertical joint planes + a tipped cap and base.
    const k = cfg.columnar;
    const off = rng() * Math.PI * 2;
    for (let i = 0; i < k; i++) {
      const a = off + (i / k) * Math.PI * 2 + (rng() - 0.5) * 0.35;
      dirs.push(V3(Math.cos(a), (rng() - 0.5) * 0.4, Math.sin(a)).normalize());
    }
    dirs.push(V3((rng() - 0.5) * 0.5, 1, (rng() - 0.5) * 0.5).normalize());
    dirs.push(V3((rng() - 0.5) * 0.4, -1, (rng() - 0.5) * 0.4).normalize());
  }
  if (cfg.fill) dirs = dirs.concat(fibDirs(cfg.fill, rng, cfg.dirJitter ?? 0.2));

  let planes = planesFromDirs(dirs, axes, noise, cfg.lump ?? 0.1, cfg.lumpFreq ?? 1.4,
    cfg.offJitter ?? 0.05, rng);

  const B = Math.max(axes.x, axes.y, axes.z) * 1.9;
  let faces = boxFaces(B);
  for (const p of planes) faces = clipPolytope(faces, p);
  faces = cleanFaces(faces, 1);

  if (cfg.erode > 0) {
    const ep = erosionPlanes(faces, axes, cfg.erode, cfg.erodeCount ?? 14, !!cfg.erodeEdges, rng);
    for (const p of ep) faces = clipPolytope(faces, p);
    faces = cleanFaces(faces, 1);
    planes = planes.concat(ep);
  }
  return { planes, faces };
}

function transformBody(body, q, offset, scale) {
  const m = new THREE.Matrix4().compose(offset, q, new THREE.Vector3(scale, scale, scale));
  const nm = new THREE.Matrix3().setFromMatrix4(m).invert().transpose();
  const faces = body.faces.map((f) => {
    const n = f.n.clone().applyMatrix3(nm).normalize();
    const pts = f.pts.map((p) => p.clone().applyMatrix4(m));
    return { n, d: n.dot(pts[0]), pts };
  });
  const planes = body.planes.map((p) => {
    const n = p.n.clone().applyMatrix3(nm).normalize();
    // A plane at distance d scales to d*s and then shifts by n·offset.
    return { n, d: p.d * scale + n.dot(offset) };
  });
  return { planes, faces };
}

export const ARCHETYPES = {
  // Water-worn boulder: many planes, heavy corner + edge truncation.
  boulder: {
    variants: 3, sink: 0.20,
    build: (rng, noise) => [makeBody(rng, noise, {
      axes: V3(1, 0.64 + rng() * 0.22, 0.78 + rng() * 0.20),
      // Few planes, big lumps, low-frequency: the support radius has to swing
      // a long way across the body or every facet comes out the same size and
      // the boulder reads as a geodesic dome instead of a rock.
      fill: 15, dirJitter: 0.32, lump: 0.20, lumpFreq: 0.85, offJitter: 0.10,
      erode: 0.22, erodeCount: 15, erodeEdges: true,
    })],
  },

  // Angular fractured slab — the big framing rocks by the river.
  slab: {
    variants: 3, sink: 0.24,
    build: (rng, noise) => [makeBody(rng, noise, {
      axes: V3(1, 0.32 + rng() * 0.16, 0.68 + rng() * 0.24),
      boxTilt: 0.40, fill: 5, dirJitter: 0.36, lump: 0.10, lumpFreq: 0.7, offJitter: 0.11,
      erode: 0.09, erodeCount: 4, erodeEdges: false,
    })],
  },

  // Standing stone / bedrock rib: prismatic, vertical joints.
  standing: {
    variants: 3, sink: 0.26,
    build: (rng, noise) => [makeBody(rng, noise, {
      axes: V3(0.52 + rng() * 0.14, 1.35 + rng() * 0.5, 0.56 + rng() * 0.16),
      columnar: 6 + ((rng() * 3) | 0), lump: 0.16, lumpFreq: 0.8, offJitter: 0.10,
      erode: 0.12, erodeCount: 6, erodeEdges: false,
    })],
  },

  // Small rubble / cobble.
  rubble: {
    variants: 4, sink: 0.30,
    build: (rng, noise) => [makeBody(rng, noise, {
      axes: V3(1, 0.56 + rng() * 0.28, 0.76 + rng() * 0.24),
      fill: 8, dirJitter: 0.36, lump: 0.24, lumpFreq: 1.1, offJitter: 0.12,
      erode: 0.20, erodeCount: 7, erodeEdges: true,
    })],
  },

  // Frost-shattered talus block: boxy, sharp, no rounding at all.
  talus: {
    variants: 3, sink: 0.28,
    build: (rng, noise) => [makeBody(rng, noise, {
      axes: V3(1, 0.58 + rng() * 0.30, 0.74 + rng() * 0.26),
      boxTilt: 0.55, fill: 3, dirJitter: 0.42, lump: 0.09, lumpFreq: 0.8, offJitter: 0.13,
      erode: 0.05, erodeCount: 2, erodeEdges: false,
    })],
  },

  // House-sized hero: a union of chunks, so the silhouette has shoulders.
  hero: {
    variants: 3, sink: 0.22,
    build: (rng, noise) => {
      const main = makeBody(rng, noise, {
        axes: V3(1, 0.66 + rng() * 0.26, 0.82 + rng() * 0.20),
        boxTilt: 0.34, fill: 13, dirJitter: 0.32, lump: 0.20, lumpFreq: 0.85, offJitter: 0.10,
        erode: 0.17, erodeCount: 13, erodeEdges: true,
      });
      const out = [main];
      const n = 1 + ((rng() * 2) | 0);
      for (let i = 0; i < n; i++) {
        const sub = makeBody(rng, noise, {
          axes: V3(1, 0.50 + rng() * 0.34, 0.76 + rng() * 0.24),
          boxTilt: 0.6, fill: 8, dirJitter: 0.36, lump: 0.18, lumpFreq: 1.0, offJitter: 0.11,
          erode: 0.13, erodeCount: 8, erodeEdges: true,
        });
        // Pushed far enough out that it actually breaks the main silhouette —
        // a shoulder you cannot see is just triangles.
        const a = rng() * Math.PI * 2;
        const r = 0.75 + rng() * 0.55;
        const q = new THREE.Quaternion().setFromEuler(
          new THREE.Euler((rng() - 0.5) * 0.9, rng() * 6.28, (rng() - 0.5) * 0.9));
        out.push(transformBody(sub, q,
          V3(Math.cos(a) * r, -0.12 - rng() * 0.34, Math.sin(a) * r), 0.50 + rng() * 0.30));
      }
      return out;
    },
  },

  // Cliff relief: a wide flat wedge that gets driven into a steep face so the
  // slope grows ledges and overhangs instead of reading as a painted ramp.
  ledge: {
    variants: 3, sink: 0.05,
    build: (rng, noise) => [makeBody(rng, noise, {
      axes: V3(1, 0.24 + rng() * 0.14, 0.52 + rng() * 0.24),
      boxTilt: 0.24, fill: 4, dirJitter: 0.32, lump: 0.10, lumpFreq: 0.7, offJitter: 0.11,
      erode: 0.07, erodeCount: 3, erodeEdges: false,
    })],
  },

  // Bench: the big blocky mass that makes a crag band. Deliberately near-
  // cuboid with only a handful of planes — at 200 m the thing that has to read
  // is one flat sunlit top, one dark vertical face and a hard horizontal edge
  // between them. Extra facets only mush that up.
  bench: {
    variants: 4, sink: 0.02,
    build: (rng, noise) => {
      const main = makeBody(rng, noise, {
        axes: V3(1, 0.66 + rng() * 0.34, 0.76 + rng() * 0.24),
        boxTilt: 0.26, fill: 3, dirJitter: 0.26, lump: 0.07, lumpFreq: 0.6, offJitter: 0.13,
        erode: 0.05, erodeCount: 3, erodeEdges: false,
      });
      const out = [main];
      // One or two stacked/offset blocks: a crag is a pile of beds, and the
      // step between them is the silhouette notch that reads from far away.
      const n = 1 + ((rng() * 2) | 0);
      for (let i = 0; i < n; i++) {
        const sub = makeBody(rng, noise, {
          axes: V3(1, 0.34 + rng() * 0.28, 0.60 + rng() * 0.28),
          boxTilt: 0.16, fill: 2, dirJitter: 0.3, lump: 0.07, lumpFreq: 0.6, offJitter: 0.14,
          erode: 0.04, erodeCount: 2, erodeEdges: false,
        });
        const a = rng() * Math.PI * 2;
        const q = new THREE.Quaternion().setFromEuler(
          new THREE.Euler((rng() - 0.5) * 0.30, rng() * 6.28, (rng() - 0.5) * 0.30));
        out.push(transformBody(sub, q,
          V3(Math.cos(a) * (0.45 + rng() * 0.5), 0.30 + rng() * 0.55, Math.sin(a) * (0.45 + rng() * 0.5)),
          0.52 + rng() * 0.34));
      }
      return out;
    },
  },

  // Tower / blade: the thing that actually punches a notch in the skyline.
  // Tall, prismatic, capped by an oblique fracture so the top is never a
  // horizontal cut — a flat-topped tower reads as a chimney, not a crag.
  tower: {
    variants: 4, sink: 0.10,
    build: (rng, noise) => {
      const main = makeBody(rng, noise, {
        axes: V3(0.66 + rng() * 0.20, 1.20 + rng() * 0.55, 0.58 + rng() * 0.20),
        columnar: 5 + ((rng() * 3) | 0), lump: 0.13, lumpFreq: 0.55, offJitter: 0.12,
        erode: 0.07, erodeCount: 4, erodeEdges: false,
      });
      const out = [main];
      // A buttress at the foot: towers taper, and a bare prism looks extruded.
      const a = rng() * Math.PI * 2;
      const sub = makeBody(rng, noise, {
        axes: V3(0.8, 0.7 + rng() * 0.5, 0.7),
        boxTilt: 0.4, fill: 3, dirJitter: 0.35, lump: 0.1, lumpFreq: 0.7, offJitter: 0.12,
        erode: 0.06, erodeCount: 3, erodeEdges: false,
      });
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler((rng() - 0.5) * 0.5, rng() * 6.28, (rng() - 0.5) * 0.5));
      out.push(transformBody(sub, q,
        V3(Math.cos(a) * 0.42, -1.05 - rng() * 0.4, Math.sin(a) * 0.42), 0.62 + rng() * 0.26));
      return out;
    },
  },
};

// ── AO bake ──────────────────────────────────────────────────────────────────

function insideAny(p, bodies) {
  for (const b of bodies) {
    let inside = true;
    const pl = b.planes;
    for (let i = 0; i < pl.length; i++) {
      if (pl[i].n.dot(p) - pl[i].d > 0) { inside = false; break; }
    }
    if (inside) return true;
  }
  return false;
}

const AO_DIRS = 13;
const AO_STEPS = [0.14, 0.34, 0.78];

/**
 * Ambient occlusion baked into the mesh. Occluders are the rock's own chunks
 * plus the ground plane it will be buried in, so a lone boulder still gets the
 * contact darkening at its base that makes stylised rock read as *heavy*.
 */
function bakeAO(pos, nrm, bodies, groundY, rng) {
  // Cosine-ish hemisphere around nrm, deterministic spiral with a random phase.
  const t0 = rng() * Math.PI * 2;
  const u = Math.abs(nrm.y) < 0.9
    ? new THREE.Vector3(0, 1, 0).cross(nrm).normalize()
    : new THREE.Vector3(1, 0, 0).cross(nrm).normalize();
  const v = new THREE.Vector3().crossVectors(nrm, u);
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  let occ = 0;
  for (let i = 0; i < AO_DIRS; i++) {
    const r = Math.sqrt((i + 0.5) / AO_DIRS);
    const a = t0 + i * 2.39996;
    const c = Math.sqrt(Math.max(0, 1 - r * r));
    d.copy(nrm).multiplyScalar(c)
      .addScaledVector(u, Math.cos(a) * r)
      .addScaledVector(v, Math.sin(a) * r).normalize();
    for (let s = 0; s < AO_STEPS.length; s++) {
      const t = AO_STEPS[s];
      p.copy(pos).addScaledVector(nrm, 0.004).addScaledVector(d, t);
      if (p.y < groundY || insideAny(p, bodies)) { occ += 1 - s * 0.30; break; }
    }
  }
  return clamp01(1 - occ / AO_DIRS);
}

// ── geometry assembly ────────────────────────────────────────────────────────

/**
 * Turn a set of convex bodies into a render-ready BufferGeometry.
 *  · vertices are duplicated per face so every facet keeps its exact plane
 *    normal — this is what preserves the crisp edges
 *  · aBake.x = AO, .y = upward exposure, .z = normalised height in the rock
 *  · geometry origin is placed at the intended ground line, so placement is a
 *    plain "put it at the terrain height" with no per-instance sink maths
 */
function assemble(bodies, sink, rng, noiseAmp, noise) {
  const faces = [];
  for (const b of bodies) for (const f of b.faces) faces.push(f);

  let minY = Infinity, maxY = -Infinity, maxR = 0;
  for (const f of faces) for (const p of f.pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    const r = Math.hypot(p.x, p.z);
    if (r > maxR) maxR = r;
  }
  const groundY = minY + (maxY - minY) * sink;

  // Weld: AO and the noise offset must agree across faces or the mesh cracks.
  const keys = new Map();
  const K = (p) => `${Math.round(p.x * 2048)},${Math.round(p.y * 2048)},${Math.round(p.z * 2048)}`;
  for (const f of faces) {
    for (const p of f.pts) {
      const k = K(p);
      let e = keys.get(k);
      if (!e) { e = { p: p.clone(), n: new THREE.Vector3(), ao: 1, off: null }; keys.set(k, e); }
      e.n.add(f.n);
    }
  }
  for (const e of keys.values()) {
    e.n.normalize();
    e.ao = bakeAO(e.p, e.n, bodies, groundY, rng);
    if (noiseAmp > 0) {
      // Displace the silhouette only — face normals stay exactly planar, so
      // the shading reads as clean planes while the outline gains grain.
      const s = 2.6;
      e.off = new THREE.Vector3(
        noise.n3d(e.p.x * s + 12.1, e.p.y * s + 3.3, e.p.z * s + 8.8),
        noise.n3d(e.p.x * s + 41.7, e.p.y * s + 9.2, e.p.z * s + 1.4),
        noise.n3d(e.p.x * s + 27.5, e.p.y * s + 6.6, e.p.z * s + 33.1)
      ).multiplyScalar(noiseAmp);
    }
  }

  let triCount = 0;
  for (const f of faces) triCount += f.pts.length - 2;
  const position = new Float32Array(triCount * 9);
  const normal = new Float32Array(triCount * 9);
  const bake = new Float32Array(triCount * 9);

  const invH = 1 / Math.max(maxY - minY, 1e-4);
  let o = 0;
  const emit = (p, f) => {
    const e = keys.get(K(p));
    const x = p.x + (e?.off ? e.off.x : 0);
    const y = p.y + (e?.off ? e.off.y : 0);
    const z = p.z + (e?.off ? e.off.z : 0);
    position[o] = x; position[o + 1] = y - groundY; position[o + 2] = z;
    normal[o] = f.n.x; normal[o + 1] = f.n.y; normal[o + 2] = f.n.z;
    bake[o] = e ? e.ao : 1;
    bake[o + 1] = clamp01(f.n.y * 0.5 + 0.5);
    bake[o + 2] = clamp01((p.y - minY) * invH);
    o += 3;
  };
  for (const f of faces) {
    for (let i = 1; i < f.pts.length - 1; i++) {
      emit(f.pts[0], f); emit(f.pts[i], f); emit(f.pts[i + 1], f);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('aBake', new THREE.BufferAttribute(bake, 3));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  g.userData.rockRadius = Math.max(maxR, (maxY - groundY));
  g.userData.rockTop = maxY - groundY;
  return g;
}

/**
 * Build every archetype variant. Returns
 *   { boulder: [geom, geom, …], slab: [...], … }
 * Deterministic for a given seed.
 */
export function buildRockLibrary(seed) {
  const noise = new NoiseField(seed ^ 0x1f0c5);
  const lib = {};
  let key = 0;
  for (const [name, spec] of Object.entries(ARCHETYPES)) {
    const geoms = [];
    for (let v = 0; v < spec.variants; v++) {
      const rng = mulberry32((seed ^ (key * 0x9e3779b9) ^ (v * 0x85ebca6b)) >>> 0);
      const bodies = spec.build(rng, noise);
      geoms.push(assemble(bodies, spec.sink, rng, spec.noise ?? 0.012, noise));
      key++;
    }
    lib[name] = geoms;
  }
  return lib;
}
