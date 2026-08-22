#!/usr/bin/env node
// Build time for buildWaterSurface, base vs live, 7 runs, median. The one-shot
// number in meshlab swings 200 ms run to run on a warm laptop, which is more
// than the whole change costs.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { decodeBake } from '../../src/world/bakeFormat.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/bakes/manifest.json'), 'utf8'));
const e = man.entries.find((x) => x.res === 1536 && x.hash === man.current);
const buf = fs.readFileSync(path.join(ROOT, 'public/bakes', e.file));
const b = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = { res: b.res, worldSize: b.worldSize, half: b.worldSize / 2, texel: b.worldSize / b.res, height: b.height, water: b.water };
for (const impl of ['base', 'live']) {
  const { buildWaterSurface } = await import(impl === 'base' ? './Water.base.js' : '../../src/world/Water.js');
  const ts = [];
  for (let i = 0; i < 7; i++) {
    const t = process.hrtime.bigint();
    const r = buildWaterSurface(world);
    ts.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (i === 0) console.log(`${impl}  tris ${r.triangles}  chunks ${r.chunks.length}`);
  }
  ts.sort((a, c) => a - c);
  console.log(`${impl}  median ${ts[3].toFixed(0)} ms   min ${ts[0].toFixed(0)}  max ${ts[6].toFixed(0)}`);
}
