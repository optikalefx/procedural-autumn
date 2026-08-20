#!/usr/bin/env node
/**
 * How much rock is standing in the road?
 *
 * Headless, no browser, no GPU, ~5 s, and deterministic — which is the point.
 * `poi.anchor()` is not stable across page loads (P3) and two captures of this
 * tree 34 minutes apart differed in half their pixels, so the browser sweep
 * (`wedgeroad.mjs`) can say *whether* a given anchor still shows the wedge but
 * it is a poor instrument for *how much* rock is in the road. This measures the
 * placement directly: it builds the baked world (which rebuilds `world.roads`
 * from the same heightfield the game drives on), runs RockScatter over every
 * cell in the world, and compares each instance's own horizontal reach against
 * its distance to the road centreline.
 *
 * Two numbers matter, and they are different questions:
 *
 *   inside      road centreline points that lie inside some rock's footprint.
 *               This is P2 in its bluntest form: the road goes through a rock.
 *   sub         the largest angular size (reach / distance) any rock presents
 *               from a road point. The D3 wedge is `sub` above 1 — a rock whose
 *               own radius exceeds its distance cannot be anything but a flat
 *               plane across the lens with no scale in it.
 *
 *   node tools/_scratch/rockroad.mjs              # audit, current rule
 *   node tools/_scratch/rockroad.mjs --off        # same world, rule disabled
 *   node tools/_scratch/rockroad.mjs --sweep      # A/B plus a parameter sweep
 */
import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { RockScatter } from '../../src/rocks/RockScatter.js';
import { buildRockLibrary, archFootprints } from '../../src/rocks/RockForms.js';
import { SEED } from '../../src/world/WorldConfig.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const OFF = argv.includes('--off');
const SWEEP = argv.includes('--sweep');
const res = arg('res', '768');

const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
const buf = readFileSync(new URL(file, dir));
const data = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = new WorldData(data, SEED);
const foot = archFootprints(buildRockLibrary(SEED));

const CELL = 64;
const NC = Math.ceil(world.half / CELL);
const pts = [];
for (const line of world.roads) for (const p of line) pts.push(p);

function scatter(clearance) {
  const sc = new RockScatter(world, SEED);
  sc.setFootprints(foot);
  if ('roadClearance' in sc) sc.roadClearance = clearance;
  return sc;
}

/** Every instance in the world, with its reach and its distance to the road. */
function census(sc) {
  const out = [];
  let total = 0;
  for (let cz = -NC; cz <= NC; cz++) for (let cx = -NC; cx <= NC; cx++) {
    const cell = [];
    sc.generateCell(cx, cz, CELL, 0, cell);
    total += cell.length;
    for (const inst of cell) {
      const fp = foot[inst.arch]?.[inst.variant] ?? { rx: 1.3, rz: 1.3 };
      const reach = Math.max(fp.rx, fp.rz) * inst.size * 1.18;
      out.push({ x: inst.x, z: inst.z, reach, arch: inst.arch, kind: inst.kind, size: inst.size });
    }
  }
  return { all: out, total };
}

/** The two road-side numbers, plus the worst offenders. */
function score(all) {
  let inside = 0, sub10 = 0, sub05 = 0, worst = 0;
  const offenders = [];
  const near = all.filter((r) => Math.abs(r.x) < world.half + 200);
  for (const p of pts) {
    let m = 0, ins = null;
    for (const r of near) {
      const dd = Math.hypot(r.x - p.x, r.z - p.z);
      if (dd > 300) continue;
      const s = r.reach / Math.max(1, dd);
      if (s > m) { m = s; if (s > 1) ins = r; }
      if (dd < r.reach && !ins) ins = r;
    }
    if (ins) { inside++; offenders.push({ ...ins, at: [Math.round(p.x), Math.round(p.z)], sub: +m.toFixed(2) }); }
    if (m > 1.0) sub10++;
    if (m > 0.5) sub05++;
    if (m > worst) worst = m;
  }
  return { inside, sub10, sub05, worst: +worst.toFixed(2), offenders };
}

if (!SWEEP) {
  const sc = scatter(!OFF);
  const { all, total } = census(sc);
  const s = score(all);
  console.log(`bake ${file}  roadClearance=${OFF ? 'OFF' : (sc.roadClearance ?? 'n/a')}`);
  console.log(`instances ${total}   road centreline points ${pts.length}`);
  console.log(`road points inside a rock : ${s.inside} / ${pts.length}`);
  console.log(`road points with reach/dist > 1.0 : ${s.sub10}   > 0.5 : ${s.sub05}   worst ${s.worst}`);
  s.offenders.sort((a, b) => b.sub - a.sub);
  console.log('\nworst offenders (rock, where the road meets it):');
  for (const o of s.offenders.slice(0, 12)) {
    console.log(`  ${o.arch}/${o.kind} size ${o.size.toFixed(1)} reach ${o.reach.toFixed(1)} m at (${Math.round(o.x)}, ${Math.round(o.z)})  road (${o.at[0]}, ${o.at[1]})  sub ${o.sub}`);
  }
} else {
  const off = census(scatter(false));
  const on = census(scatter(true));
  const a = score(off.all), b = score(on.all);
  const row = (tag, t, s) => console.log(`${tag.padEnd(18)} instances ${String(t).padStart(6)}   inside ${String(s.inside).padStart(4)}/${pts.length}   sub>1.0 ${String(s.sub10).padStart(4)}   sub>0.5 ${String(s.sub05).padStart(4)}   worst ${s.worst}`);
  row('clearance OFF', off.total, a);
  row('clearance ON', on.total, b);
  console.log(`removed ${off.total - on.total} instances (${(100 * (off.total - on.total) / off.total).toFixed(1)}% of the world's rock)`);

  // What the two constants buy, measured on the same census.
  console.log('\nrule sweep (need = ROAD_TRACK + reach * ROAD_STANDOFF), applied post-hoc:');
  const dist = (r) => { let best = Infinity; for (const p of pts) { const d = (p.x - r.x) ** 2 + (p.z - r.z) ** 2; if (d < best) best = d; } return Math.sqrt(best); };
  for (const r of off.all) r.d = dist(r);
  for (const [T, S] of [[3.2, 1.0], [3.2, 1.3], [3.2, 1.6], [3.2, 2.0], [3.2, 2.5], [6.0, 2.0]]) {
    const keep = off.all.filter((r) => r.d >= T + r.reach * S);
    const s = score(keep);
    console.log(`  TRACK ${T} STANDOFF ${S}  cull ${String(off.total - keep.length).padStart(4)} (${(100 * (off.total - keep.length) / off.total).toFixed(1)}%)  inside ${s.inside}  sub>1.0 ${s.sub10}  sub>0.5 ${s.sub05}  worst ${s.worst}`);
  }
}
