#!/usr/bin/env node
/**
 * The marshmallow's END FACE, measured two ways.
 *
 * The critic's D3-5 is that the near end is a countersunk crater about 40% of
 * the diameter across, so the object reads as a doughnut. That claim has a
 * geometry half and a shading half and they are NOT the same number — the dish
 * is 3 mm of pull-in, the AO ramp in `mallowColourFn` is a separate 14% over a
 * separate radius, and the thing the eye reads is the second one. So:
 *
 *   node tools/_scratch/mallowdish.mjs
 *       the built profile: pull-in vs radius off a real `buildHeldStick`
 *       mallow, with the depression width at three thresholds.
 *
 *   node tools/_scratch/mallowdish.mjs <png> <x0> <x1> <y>
 *       a horizontal scanline through a macro frame in LINEAR luma, with the
 *       trough depth and width the critic quoted (0.406 -> 0.338, ~100 px).
 */
import { buildHeldStick, buildRoastStick } from '../../src/camp/camp_marshmallow.js';

const mk = (s) => () => {
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  return ((s >>> 0) % 1e6) / 1e6;
};

if (process.argv.length > 3) {
  const { readPNG } = await import('../_pngread.mjs');
  const [file, X0, X1, Y] = process.argv.slice(2);
  const img = readPNG(file);
  const { w: W, px } = img;
  const lin = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
  const at = (x) => {
    const i = (+Y) * W + x;
    return 0.2126 * lin(px[i * 3] / 255) + 0.7152 * lin(px[i * 3 + 1] / 255)
         + 0.0722 * lin(px[i * 3 + 2] / 255);
  };
  const a = +X0, b = +X1;
  const row = [];
  for (let x = a; x <= b; x++) row.push([x, at(x)]);
  const hi = Math.max(...row.map((r) => r[1]));
  const lo = Math.min(...row.map((r) => r[1]));
  console.log(`scanline y=${Y}  x ${a}..${b} (${b - a} px)  linear luma ${lo.toFixed(3)} .. ${hi.toFixed(3)}`);
  for (let x = a; x <= b; x += Math.max(1, Math.round((b - a) / 48))) {
    const v = at(x);
    const n = Math.round(((v - lo) / (hi - lo || 1)) * 60);
    console.log(`  ${String(x).padStart(4)}  ${v.toFixed(4)}  ${'#'.repeat(n)}`);
  }
  process.exit(0);
}

// ── the built profile ────────────────────────────────────────────────────────
for (const [what, build] of [['held', buildHeldStick], ['prop', buildRoastStick]]) {
  const g = build(mk(0x12345 ^ 0x9e3779b1), { restH: 0.447, leanYaw: 0 });
  let mesh = null;
  g.traverse((o) => { if (o.isMesh && /mallow/.test(o.name)) mesh = o; });
  const p = mesh.geometry.attributes.position;
  const half = g.userData.held?.half ?? 0.0130;
  // One meridian: every vertex with |x - r| tiny on the j = 0 column is hard to
  // pick out of a flat array, so bucket by radius instead and keep the extreme
  // z in each bucket — the cap is the surface nearest the axis at max |z|.
  const rows = new Map();
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
    if (z > 0) continue;                       // the grip cap only
    const r = Math.hypot(x, y);
    const key = r.toFixed(5);
    const cur = rows.get(key);
    if (!cur || z < cur) rows.set(key, z);
  }
  const prof = [...rows.entries()].map(([r, z]) => [+r, z + half])
    .sort((a, b) => a[0] - b[0])
    .filter(([r]) => r <= 0.0161);            // the flat cap, inside the rim
  const peak = prof[0][1];
  const width = (thr) => {
    let last = 0;
    for (const [r, d] of prof) if (d >= thr) last = r;
    return last;
  };
  console.log(`\n${what}: cap pull-in, peak ${(peak * 1e3).toFixed(2)} mm`);
  // The tilt column is the one that maps to the rendered value trough: a face
  // reads as flat when its normal does, and it is the SLOPE of the cap, not its
  // depth, that draws the dark ring the critic measured.
  for (let i = 0; i < prof.length; i++) {
    const [r, d] = prof[i];
    if (r > 0.0161) break;
    const nx = prof[Math.min(prof.length - 1, i + 1)];
    const tilt = nx[0] > r ? Math.atan2(d - nx[1], nx[0] - r) * 180 / Math.PI : 0;
    console.log(`   r ${(r * 1e3).toFixed(2).padStart(6)} mm   drop ${(d * 1e3).toFixed(3).padStart(6)} mm` +
                `   tilt to next ${tilt.toFixed(1).padStart(5)}°` +
                `   ${'#'.repeat(Math.round(d * 1e4))}`);
  }
  for (const thr of [0.0020, 0.0010, 0.0005, 0.00025]) {
    const r = width(thr);
    console.log(`   depression at >=${(thr * 1e3).toFixed(2)} mm deep: r ${(r * 1e3).toFixed(1)} mm` +
                `  = ${(2 * r / 0.042 * 100).toFixed(0)}% of diameter`);
  }
}
