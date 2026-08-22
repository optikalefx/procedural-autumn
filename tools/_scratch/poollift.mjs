#!/usr/bin/env node
/**
 * How far does the plunge-apron mesh float above the ground it is draped on?
 *
 * The apron's vertices are placed at `drape + 0.55 m` by construction, so a
 * vertex-only measurement always answers 0.55 and says nothing. What matters is
 * the INTERIOR of each triangle: the mesh is flat between vertices and the rock
 * is not, so a triangle spanning a chute wall floats. Where it floats above the
 * rock it is visible; where it sinks below, the depth test cuts it — and the
 * cut is a straight line along the triangle, which is the hard-edged wedge.
 *
 * This samples every triangle on a barycentric grid and compares the mesh plane
 * against the game's own `getHeight`/`getWaterHeight`, on the CPU, so no part
 * of the render pipeline (fog, tone mapping, post) can colour the number.
 *
 *   node tools/_scratch/poollift.mjs
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/?seed=20261018';
await acquire('poollift');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(() => {
  let mesh = null;
  window.__engine.scene.traverse(o => { if (o.name === 'PlungePools') mesh = o; });
  if (!mesh) return { err: 'no PlungePools' };
  const world = window.__engine.ctx?.world || window.__world;
  if (!world) return { err: 'no world' };
  const surf = (x, z) => {
    const w = world.getWaterHeight(x, z), g = world.getHeight(x, z);
    return (w !== null && w > g) ? w : g;
  };
  const P = mesh.geometry.attributes.position.array;
  const I = mesh.geometry.index.array;
  const N = 4;                       // barycentric grid per triangle
  const lifts = [];
  let sunk = 0, tot = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    for (let i = 0; i <= N; i++) for (let j = 0; i + j <= N; j++) {
      const u = i / N, v = j / N, w = 1 - u - v;
      const x = P[a] * u + P[b] * v + P[c] * w;
      const y = P[a + 1] * u + P[b + 1] * v + P[c + 1] * w;
      const z = P[a + 2] * u + P[b + 2] * v + P[c + 2] * w;
      const l = y - surf(x, z) - 0.55;   // 0 == exactly on the drape
      lifts.push(l); tot++; if (l < -0.5) sunk++;
    }
  }
  lifts.sort((p, q) => p - q);
  const q = (f) => lifts[Math.min(lifts.length - 1, Math.round(f * (lifts.length - 1)))];
  return {
    samples: tot, sunkFrac: sunk / tot,
    p01: q(0.01), p10: q(0.10), p50: q(0.50), p90: q(0.90), p99: q(0.99), max: q(1),
    over1: lifts.filter(l => l > 1).length / tot,
    over2: lifts.filter(l => l > 2).length / tot,
    over4: lifts.filter(l => l > 4).length / tot,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
