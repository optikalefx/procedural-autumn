#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { buildHydroField } from '../../src/world/hydroField.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/bakes/manifest.json'), 'utf8'));
const e = man.entries.find((x) => x.res === 1536 && x.hash === man.current);
const b = fs.readFileSync(path.join(ROOT, 'public/bakes', e.file));
const bake = decodeBake(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const R = bake.res, WS = bake.worldSize, HALF = WS / 2, T = WS / R;
const CX = +process.argv[2], CZ = +process.argv[3], W = +(process.argv[4] || 14);
const ix = Math.round((CX + HALF) / T), iz = Math.round((CZ + HALF) / T);
console.log(`patch centred (${CX},${CZ}) = texel (${ix},${iz}), texel ${T} m`);
const show = (name, f) => {
  console.log(`\n${name}`);
  for (let z = iz - W; z <= iz + W; z++) {
    let s = '';
    for (let x = ix - W; x <= ix + W; x++) s += f(z * R + x, x, z);
    console.log(s);
  }
};
show('wet mask (# = water>height, . = dry, o = water present but <= height)', (i) => {
  const v = bake.water[i];
  return v < -9000 ? '. ' : (v > bake.height[i] ? '# ' : 'o ');
});
show('bed height (m, mod 100)', (i) => String(Math.round(bake.height[i])).padStart(4));
show('water level (m)', (i) => (bake.water[i] < -9000 ? '   .' : String(Math.round(bake.water[i])).padStart(4)));
show('depth = water-bed (cm, capped)', (i) => (bake.water[i] < -9000 ? '    .' : String(Math.max(-999, Math.min(999, Math.round((bake.water[i] - bake.height[i]) * 100)))).padStart(5)));
