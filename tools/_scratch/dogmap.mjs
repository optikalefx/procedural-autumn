#!/usr/bin/env node
// dogmap — draw one seed's camp raster + dog trajectory as SVG.
import * as THREE from 'three';
import { CampDog } from '../../src/camp/camp_dog.js';
import { layoutCamp } from '../../src/camp/camp_site.js';
import { writeFileSync } from 'fs';

const SEED = parseInt(process.argv[2] ?? '1', 10);
const MIN = parseFloat(process.argv[3] ?? '8');
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const world = {
  getHeight: (x, z) => 0.06 * Math.sin(x * 0.9) * Math.cos(z * 0.7),
  getSlope: () => 0, getWaterDepth: () => 0, isInBounds: () => true,
};
const KIND_R = { tent: 1.85, telescope: 0.77, chair: 0.55, cooler: 0.60, table: 0.80, woodpile: 0.70 };
const rnd = mulberry32(SEED * 7919);
const items = layoutCamp(rnd, world, 0, 0, {});
const obstacles = items.map((it) => ({ x: it.x, z: it.z, r: KIND_R[it.kind] ?? 0.6, kind: it.kind }));
const dog = new CampDog(new THREE.Group(), { x: 0, y: 0, z: 0 }, rnd, world, { obstacles });

const S = 80, W = 12 * S; // 12m view, 80px/m
const w2s = (x, z) => [ (x + 6) * S, (6 - z) * S ];
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}"><rect width="${W}" height="${W}" fill="#222"/>`;
// yard cells
const n = dog.navN;
for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
  if (!dog.navFree[iz * n + ix]) continue;
  const x = dog.navMinX + ix * 0.16, z = dog.navMinZ + (iz + 1) * 0.16;
  const [sx, sy] = w2s(x, z);
  svg += `<rect x="${sx.toFixed(0)}" y="${sy.toFixed(0)}" width="${(0.16*S).toFixed(0)}" height="${(0.16*S).toFixed(0)}" fill="#2e4632"/>`;
}
// obstacles: mesh radius (solid) + inflated (stroke)
for (const o of dog.obstacles) {
  const [cx, cy] = w2s(o.x, o.z);
  svg += `<circle cx="${cx}" cy="${cy}" r="${o.r * S}" fill="#734d4d" fill-opacity="0.75"/>`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${(o.r + 0.25) * S}" fill="none" stroke="#a06060" stroke-dasharray="4 4"/>`;
  if (o.kind) svg += `<text x="${cx}" y="${cy}" fill="#eee" font-size="14" text-anchor="middle">${o.kind}</text>`;
}
// trajectory
const dt = 1 / 60;
let pts = [], marks = '', simT = 0, lastR = 0;
for (let i = 0; i < MIN * 3600; i++) {
  dog.update(dt, null);
  simT += dt;
  if (i % 6 === 0) {
    const [sx, sy] = w2s(dog.pos.x, dog.pos.z);
    pts.push(`${sx.toFixed(0)},${sy.toFixed(0)}`);
  }
  if (dog.respawns !== lastR) {
    lastR = dog.respawns;
    const [sx, sy] = w2s(dog.pos.x, dog.pos.z);
    marks += `<circle cx="${sx}" cy="${sy}" r="8" fill="none" stroke="#ff0" stroke-width="2"/>`;
    svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="#7ec8ff" stroke-width="1.5" stroke-opacity="0.8"/>`;
    pts = [];
  }
  if (dog.stateName === 'rest' && dog.timer > 1 && dog.blend === 1) {
    // skip most of the rest so the walk dominates the picture
    dog.timer = Math.min(dog.timer, 0.5);
  }
}
svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="#7ec8ff" stroke-width="1.5" stroke-opacity="0.8"/>` + marks + '</svg>';
writeFileSync(`tools/_scratch/dogmap_${SEED}.svg`, svg);
console.log(`respawns: ${dog.respawns}  -> tools/_scratch/dogmap_${SEED}.svg`);
