import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { RockScatter } from '../../src/rocks/RockScatter.js';
import { buildRockLibrary, archFootprints } from '../../src/rocks/RockForms.js';
import { SEED } from '../../src/world/WorldConfig.js';
const res = '1536';
const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
const buf = readFileSync(new URL(file, dir));
const data = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = new WorldData(data, SEED);
const sc = new RockScatter(world, SEED);
sc.setFootprints(archFootprints(buildRockLibrary(SEED)));
// Camera as in the peaks view.
const anchors = JSON.parse(readFileSync(new URL('../../review/anchors.json', import.meta.url), 'utf8'));
const a = anchors.peak;
const cam = { x: a.x, z: a.z };
const CELL = 64, STREAM = 1000;
const ccx = Math.floor(cam.x / CELL), ccz = Math.floor(cam.z / CELL);
const R = Math.ceil(STREAM / CELL);
// Count, per cell, how many crag course members would be dropped by minSize.
let tot = 0, kept = 0;
const orig = sc._place.bind(sc);
for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
  const mx = (ccx + dx + 0.5) * CELL, mz = (ccz + dz + 0.5) * CELL;
  const d = Math.hypot(mx - cam.x, mz - cam.z);
  if (d > STREAM) continue;
  const need = (2 * d) / 88;
  const minSize = need < 0.9 ? 0 : need < 2.2 ? 0.8 : need < 4.0 ? 2.0 : need < 6.5 ? 3.8
    : need < 10 ? 6.2 : need < 15 ? 9.6 : need < 22 ? 14.5 : need < 30 ? 21.0 : 29.0;
  const o0 = [], o1 = [];
  sc.generateCell(ccx + dx, ccz + dz, CELL, minSize, o0);
  sc.generateCell(ccx + dx, ccz + dz, CELL, 0, o1);
  const CRAG = new Set(['cliff', 'tower', 'prow', 'bench']);
  const k0 = o0.filter(i => CRAG.has(i.arch)).length;
  const k1 = o1.filter(i => CRAG.has(i.arch)).length;
  if (k1) { tot += k1; kept += k0; if (d > 600 && k1 > 3) console.log(`cell d${d|0} minSize ${minSize} crag ${k0}/${k1} sizes ${o1.filter(i=>CRAG.has(i.arch)).map(i=>i.size.toFixed(0)).join(',')}`); }
}
console.log(`crag blocks: kept ${kept} of ${tot} (${(100*kept/tot).toFixed(0)}%)`);
