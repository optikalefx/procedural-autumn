#!/usr/bin/env node
/**
 * The unit sim jumps at this lip every time and the game never does. One of
 * them is riding different ground. Ask both the same questions at the same
 * point: bake resolution, height, and the curvature the launch test fits.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { SEED } from '../../src/world/WorldConfig.js';

const PORT = process.argv[2] ?? '5272';
const X = 623.9, Z = -1.0, H = 2.7489;
const SPAN = 2.2, HALF = 0.55;

const probe = (getHeight) => {
  const fx = Math.sin(H), fz = Math.cos(H), hh = SPAN * 0.5;
  const cy = (x, z) => (getHeight(x + fx * HALF, z + fz * HALF) + getHeight(x - fx * HALF, z - fz * HALF)) * 0.5;
  const at = (k) => cy(X + fx * k * hh, Z + fz * k * hh);
  const ypp = (2 * at(-2) - at(-1) - 2 * at(0) - at(1) + 2 * at(2)) / (7 * hh * hh);
  return { y: +at(0).toFixed(3), ypp: +ypp.toFixed(4), launchV: +Math.sqrt(9.81 + 2.5 > 0 ? (9.81 + 2.5) / Math.max(-ypp, 1e-9) : 0).toFixed(1) };
};

const dir = new URL('../../public/bakes/', import.meta.url);
const buf = readFileSync(new URL(`world-${SEED}-1536-a2d45edb.pab`, dir));
const Wn = new WorldData(decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), SEED);
console.log(`node  res ${Wn.res}  size ${Wn.worldSize ?? Wn.size}  texel ${((Wn.worldSize ?? Wn.size) / Wn.res).toFixed(2)}`);
console.log('node ', JSON.stringify(probe((x, z) => Wn.getHeight(x, z))));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto(`http://127.0.0.1:${PORT}/?quality=high`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__bike, null, { timeout: 60000 });

const got = await page.evaluate(({ X, Z, H, SPAN, HALF }) => {
  const W = window.__bike.ctx.world;
  const fx = Math.sin(H), fz = Math.cos(H), hh = SPAN * 0.5;
  const cy = (x, z) => (W.getHeight(x + fx * HALF, z + fz * HALF) + W.getHeight(x - fx * HALF, z - fz * HALF)) * 0.5;
  const at = (k) => cy(X + fx * k * hh, Z + fz * k * hh);
  const ypp = (2 * at(-2) - at(-1) - 2 * at(0) - at(1) + 2 * at(2)) / (7 * hh * hh);
  return { res: W.res, size: W.worldSize ?? W.size, seed: window.__seed ?? null,
    y: +at(0).toFixed(3), ypp: +ypp.toFixed(4) };
}, { X, Z, H, SPAN, HALF });
console.log(`page  res ${got.res}  size ${got.size}  texel ${(got.size / got.res).toFixed(2)}`);
console.log('page ', JSON.stringify(got));
await browser.close();
