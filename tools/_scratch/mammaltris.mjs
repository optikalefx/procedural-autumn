// Triangle counts + circumferential/axial facet arithmetic for every mammal.
// Run from the worktree root:  node <this> [--facets]
import { readFileSync } from 'node:fs';
import { SPECIES, DOG_SPECIES, buildSpecies, buildCampDog, isGlb } from '../../src/wildlife/animal_species.js';

// Blueprint species only. The fox is hand-authored and has no profile arrays to
// do facet arithmetic on — its cost is read straight out of the GLB below,
// which is the comparison anyone runs this tool for.
// 'bear' left out with 'fox': both are hand-authored now and carry no blueprint.
const KEYS = ['deer', 'rabbit', 'squirrel', 'raccoon'];
const SEED = 20261018;

/**
 * Triangles and primitives in a GLB, decoded from the container.
 *
 * Primitive count matters as much as the triangle count here: each one is its
 * own draw call, and each is drawn twice while the animal is close enough to
 * cast a shadow. That is the number that makes a hand-authored animal expensive
 * next to a procedural one, which is a single skinned mesh.
 */
function glbCost(url) {
  const b = readFileSync(`public${url}`);
  const j = JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  const prims = [];
  for (const m of j.meshes) {
    for (const p of m.primitives) {
      prims.push({ mat: j.materials[p.material].name, tris: j.accessors[p.indices].count / 3 });
    }
  }
  return { prims: prims.length, tris: prims.reduce((a, p) => a + p.tris, 0), parts: prims };
}

// ── triangle counts ──────────────────────────────────────────────────────────
const rows = [];
for (const k of KEYS) {
  const protos = buildSpecies(k, SEED);
  for (const p of protos) {
    rows.push({ species: k, variant: p.variant.name, weight: p.variant.weight,
      lod0: p.geoms[0].index.count / 3, lod1: p.geoms[1].index.count / 3 });
  }
}
for (const p of buildCampDog(SEED)) {
  rows.push({ species: 'dog', variant: p.variant.name, weight: p.variant.weight,
    lod0: p.geoms[0].index.count / 3, lod1: p.geoms[1].index.count / 3 });
}
console.log(JSON.stringify(rows));

// ── the hand-authored cast ───────────────────────────────────────────────────
// One mesh, no LOD twin, and as many draw calls as it has materials. Reported
// separately because none of the columns above mean the same thing here.
for (const [k, sp] of Object.entries(SPECIES)) {
  if (!isGlb(k)) continue;
  const c = glbCost(sp.glb.url);
  console.log(`GLB ${k}: ${c.tris} tris across ${c.prims} primitives `
    + `(${c.prims} draw calls, ${c.prims * 2} with the shadow pass) — `
    + c.parts.map((p) => `${p.mat} ${p.tris}`).join(', '));
}

// ── facet arithmetic ─────────────────────────────────────────────────────────
if (!process.argv.includes('--facets')) process.exit(0);

// Mirror of DETAIL[0] — keep in sync by hand when editing the source.
const D0 = JSON.parse(process.env.D0 || '{"radialBody":14,"radialLimb":10,"radialTrim":8,"smooth":3,"neckRings":14,"legRings":5}');

// Ramanujan ellipse perimeter.
const perim = (a, b) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
const dist2 = (a, b) => Math.hypot((a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0));

function analyse(key, P, scale) {
  const out = [];
  const mm = (v) => +(v * scale * 1000).toFixed(1);

  // barrel: smoothStations(prof, smooth) => (n-1)*smooth + 1 rings
  const bp = P.barrel;
  const nRings = (bp.length - 1) * D0.smooth + 1;
  let len = 0;
  for (let i = 0; i < bp.length - 1; i++) len += dist2(bp[i], bp[i + 1]);
  const axial = len / (nRings - 1);
  const rad = bp.reduce((s, x) => s + perim(x.rx, x.ry), 0) / bp.length / D0.radialBody;
  out.push({ part: 'barrel', rings: nRings, R: D0.radialBody, axial_mm: mm(axial), radial_mm: mm(rad), ratio: +(rad / axial).toFixed(2) });

  // head
  const hp = P.headProfile;
  const hR = (hp.length - 1) * D0.smooth + 1;
  let hl = 0;
  for (let i = 0; i < hp.length - 1; i++) hl += Math.hypot(hp[i].dy - hp[i + 1].dy, hp[i].dz - hp[i + 1].dz);
  const hax = hl / (hR - 1);
  const hrad = hp.reduce((s, x) => s + perim(x.rx, x.ry), 0) / hp.length / D0.radialBody;
  out.push({ part: 'head', rings: hR, R: D0.radialBody, axial_mm: mm(hax), radial_mm: mm(hrad), ratio: +(hrad / hax).toFixed(2) });

  // neck: neckRings over the chest->head polyline. Skel.add takes ABSOLUTE
  // model-space coords (only addRel is relative), so these are points.
  const nPts = [P.chest, ...P.neck, P.head];
  let nl = 0;
  for (let i = 0; i < nPts.length - 1; i++) nl += Math.hypot(nPts[i][1] - nPts[i + 1][1], nPts[i][2] - nPts[i + 1][2]);
  const nax = nl / (D0.neckRings - 1);
  const nrad = P.neckProfile.reduce((s, x) => s + perim(x.rx, x.ry), 0) / P.neckProfile.length / D0.radialBody;
  out.push({ part: 'neck', rings: D0.neckRings, R: D0.radialBody, axial_mm: mm(nax), radial_mm: mm(nrad), ratio: +(nrad / nax).toFixed(2) });

  // tail
  const bands = P.tailBands;
  const tN = bands ? Math.max(bands.length + 1, Math.round(P.tailRings ?? 24)) : P.tail.length + 1;
  const tPts = [P.pelvis, ...P.tail];
  let tl = 0;
  for (let i = 0; i < tPts.length - 1; i++) tl += Math.hypot(tPts[i][1] - tPts[i + 1][1], tPts[i][2] - tPts[i + 1][2]);
  const tax = tl / (tN - 1);
  const trad = (perim(P.tailR[0], P.tailR[0] * (P.tailFlat ?? 1)) + perim(P.tailR[1], P.tailR[1] * (P.tailFlat ?? 1))) / 2 / D0.radialTrim;
  out.push({ part: 'tail', rings: tN, R: D0.radialTrim, axial_mm: mm(tax), radial_mm: mm(trad), ratio: +(trad / tax).toFixed(2) });

  // legs: 5 rings per segment (t = .02 .22 .55 .86 .98) over each segment length
  for (const [tag, spec] of [['hind', P.hind], ['fore', P.fore]]) {
    const segs = [
      ['upper', Math.hypot(spec.knee[0], spec.knee[1], spec.knee[2]), spec.rTop, spec.rMid],
      ['lower', Math.hypot(spec.hock[0], spec.hock[1], spec.hock[2]), spec.rMid, spec.rLow],
      ['cannon', Math.hypot(spec.foot[0], spec.foot[1], spec.foot[2]), spec.rLow, spec.rFoot],
    ];
    for (const [nm, L, r0, r1] of segs) {
      // ring params span 0.02..0.98 → covered length = 0.96 L over legRings-1 gaps
      const ax = (L * 0.96) / (D0.legRings - 1);
      const rmean = (r0 + r1) / 2;
      const rd = perim(rmean * (spec.flat ?? 1), rmean) / D0.radialLimb;
      out.push({ part: `${tag}.${nm}`, rings: D0.legRings, R: D0.radialLimb,
        axial_mm: mm(ax), radial_mm: mm(rd), ratio: +(rd / ax).toFixed(2), segLen_mm: mm(L), rMean_mm: mm(rmean) });
    }
  }
  return { key, scale, parts: out };
}

const facets = [];
for (const k of KEYS) {
  const sp = SPECIES[k];
  const v = sp.variants.reduce((a, b) => (b.weight > a.weight ? b : a));
  facets.push(analyse(k, sp.blueprint(), v.scale));
}
{
  const v = DOG_SPECIES.variants.reduce((a, b) => (b.weight > a.weight ? b : a));
  facets.push(analyse('dog', DOG_SPECIES.blueprint(), v.scale));
}
console.log('FACETS', JSON.stringify(facets));
