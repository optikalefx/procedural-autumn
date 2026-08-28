#!/usr/bin/env node
/**
 * The shaft's ALBEDO, offline — the half of `shaftlight.mjs` that does not need
 * a browser.
 *
 * The critic's diagnosis is that the stick "has no mid anchor": near-black in
 * the daylight prop frames, pale in the firelit held ones, i.e. carried
 * entirely by the light. That is a claim about what is in the buffers before
 * any light touches them, and it is decidable here: material colour x the baked
 * vertex colour, per band of `s`, printed as the sRGB the eye would call it.
 *
 *   node tools/_scratch/shaftalb.mjs
 */
import * as THREE from 'three';
import { buildRoastStick, buildHeldStick } from '../../src/camp/camp_marshmallow.js';
import { campMaterials } from '../../src/camp/camp_materials.js';

const mk = (s) => () => {
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  return ((s >>> 0) % 1e6) / 1e6;
};
const srgb = (u) => Math.round(255 * (u <= 0.0031308 ? u * 12.92
  : 1.055 * Math.pow(u, 1 / 2.4) - 0.055));

const wood = campMaterials().wood.color;   // linear, three's own working space
console.log(`shaft material 'wood'  linear ${wood.r.toFixed(3)} ${wood.g.toFixed(3)} ${wood.b.toFixed(3)}` +
            `  = sRGB ${srgb(wood.r)},${srgb(wood.g)},${srgb(wood.b)}\n`);

const NB = 20;
for (const [what, build, seeds] of [['prop', buildRoastStick, 12], ['held', buildHeldStick, 12]]) {
  const acc = Array.from({ length: NB }, () => ({ n: 0, r: 0, g: 0, b: 0, lo: 9, hi: 0 }));
  for (let i = 0; i < seeds; i++) {
    const g = build(mk(0x9e3779b1 ^ (i * 2654435761)), { restH: 0.447, leanYaw: 0, wear: (i % 5) / 5 });
    let butt = null, len = 0;
    if (g.userData.roast) { butt = g.userData.roast.butt; len = g.userData.roast.len; }
    g.traverse((o) => {
      if (!o.isMesh || /mallow/.test(o.name)) return;
      const p = o.geometry.attributes.position, c = o.geometry.attributes.color;
      if (!c) return;
      for (let k = 0; k < p.count; k++) {
        const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
        // Arc position: distance from the butt for the prop, +z for the held
        // stick (whose origin is the grip, 0.10 m along).
        const s = butt ? Math.hypot(x - butt.x, y - butt.y, z - butt.z) / len
          : (z + 0.100) / 1.38;
        const j = Math.max(0, Math.min(NB - 1, Math.floor(s * NB)));
        const A = acc[j];
        const lr = c.getX(k) * wood.r, lg = c.getY(k) * wood.g, lb = c.getZ(k) * wood.b;
        const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
        A.n++; A.r += lr; A.g += lg; A.b += lb;
        if (lum < A.lo) A.lo = lum;
        if (lum > A.hi) A.hi = lum;
      }
    });
    g.traverse((o) => o.isMesh && o.geometry.dispose());
  }
  console.log(`${what}:   s      albedo sRGB      linear luma   band lo..hi`);
  for (let j = 0; j < NB; j++) {
    const A = acc[j];
    if (!A.n) continue;
    const r = A.r / A.n, gg = A.g / A.n, b = A.b / A.n;
    const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    console.log(`   ${((j + 0.5) / NB).toFixed(3)}   ` +
      `${String(srgb(r)).padStart(3)},${String(srgb(gg)).padStart(3)},${String(srgb(b)).padStart(3)}   ` +
      `${lum.toFixed(3)}   ${A.lo.toFixed(3)}..${A.hi.toFixed(3)}   ` +
      `${'#'.repeat(Math.round(lum * 120))}`);
  }
  console.log('');
}
