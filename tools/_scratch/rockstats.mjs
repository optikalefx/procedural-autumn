// Headless placement audit — runs RockScatter against the baked world in node,
// no browser, no GPU, ~1 s. Used to tune density without burning a capture slot.
import { readFileSync, readdirSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { RockScatter } from '../../src/rocks/RockScatter.js';
import { SEED } from '../../src/world/WorldConfig.js';

const res = process.argv[2] || '768';
const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
const buf = readFileSync(new URL(file, dir));
const data = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = new WorldData(data, SEED);
const sc = new RockScatter(world, SEED);

const CELL = 64, R = 12;
const byKind = {}, byArch = {}, sizes = [];
let cells = 0, empty = 0;
const cx0 = Math.round(Number(process.argv[3] ?? 0) / CELL);
const cz0 = Math.round(Number(process.argv[4] ?? 0) / CELL);
for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
  const out = [];
  sc.generateCell(cx0 + dx, cz0 + dz, CELL, 0, out);
  cells++; if (!out.length) empty++;
  for (const i of out) {
    byKind[i.kind] = (byKind[i.kind] || 0) + 1;
    byArch[i.arch] = (byArch[i.arch] || 0) + 1;
    sizes.push(i.size);
  }
}
sizes.sort((a, b) => a - b);
const q = (p) => sizes.length ? sizes[Math.floor(sizes.length * p)].toFixed(2) : 'n/a';
console.log(JSON.stringify({
  cells, empty, total: sizes.length, perCell: (sizes.length / cells).toFixed(1),
  byKind, byArch, sizeQ: [q(0.1), q(0.5), q(0.9), q(0.99)],
}, null, 1));
