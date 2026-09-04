#!/usr/bin/env node
/**
 * Sweep the curvature span against the frame rate.
 *
 * The two failure modes pull opposite ways and one number has to satisfy both:
 *
 *   too SHORT — the span sees the bilinear seams of the 2 m bake, the bike
 *               chatters in and out of contact, and the answer depends on the
 *               frame rate because seam spikes are noise
 *   too LONG  — only whole hillsides register, and a bike can ride all day
 *               without leaving the ground
 *
 * The column that decides it is `spread`: the airborne fraction at 30 Hz over
 * the same at 120 Hz. A physical result is 1.0. Anything else is the frame rate
 * leaking into the game.
 *
 *   node tools/_scratch/bikesweep.mjs
 */
import { execFileSync } from 'node:child_process';

const SPANS = [0.55, 0.9, 1.3, 1.6, 2.2, 3.0, 4.0];
const HZS = [30, 60, 120];
const here = new URL('./bikefly.mjs', import.meta.url).pathname;

// Anchored on the label, because the bare word "max" appears on three lines and
// the first version of this silently reported the top SPEED as the longest
// flight — 15.3 m/s printed as "15.3s aloft", which is not a number this valley
// can produce and was believed for one round anyway.
const num = (out, label) => {
  const m = out.match(new RegExp(label + '\\s+([\\d.]+)'));
  return m ? Number(m[1]) : NaN;
};

console.log('span   ' + HZS.map(h => `${h}Hz air%`).join('  ') + '   spread   jumps>0.18s  longest');
for (const span of SPANS) {
  const air = [], jumps = [], long = [];
  for (const hz of HZS) {
    const out = execFileSync('node', [here], {
      env: { ...process.env, HZ: String(hz), CURVE_SPAN: String(span) },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    air.push(num(out, 'airborne fraction'));
    jumps.push(Number((out.match(/\((\d+) over the/) ?? [0, 0])[1]));
    long.push(num(out, 'flight duration.*max'));
  }
  const spread = air[0] / air[2];
  console.log(
    `${span.toFixed(2)}   ` +
    air.map(a => a.toFixed(2).padStart(7)).join('  ') +
    `   ${spread.toFixed(2).padStart(5)}   ` +
    jumps.map(j => String(j).padStart(4)).join(' ') +
    `   ${long[1].toFixed(2)}s`);
}
