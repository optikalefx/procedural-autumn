#!/usr/bin/env node
/**
 * Scratch: write intermediate water-shader terms straight to the frame.
 *
 *   node tools/_scratch/wdebug.mjs mouth "vec3(wetT, shoreFade, foam)"
 *
 * Six wrong hypotheses were spent on the pale slab in the 'mouth' framing
 * before somebody rendered the terms as RGB and looked. This is that, as a
 * tool: it patches the material's fragment shader in the live page, forcing
 * gl_FragColor to the expression given and alpha to 1, and captures.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { readFileSync, mkdirSync } from 'node:fs';

const VIEWS = {
  mouth:     { anchor: 'mouth',     height: 5.0, dist: 26, pitch: -0.16, fov: 54, hour: 16.9 },
  river:     { anchor: 'river',     height: 6.0, dist: 30, pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  waterfall: { anchor: 'waterfall', height: 11,  dist: 58, pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
  hero:      { anchor: 'vista',     height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
};
const name = process.argv[2] || 'mouth';
const expr = process.argv[3] || 'vec3(alpha)';
const out = process.argv[4] || `shots/wdebug/${name}.png`;
const argvW = process.argv.slice(2);
const argOfW = (n) => { const i = argvW.indexOf('--' + n); return i === -1 ? null : argvW[i + 1]; };
const POS = argOfW('pos'), LOOK = argOfW('look');
if (POS && LOOK) VIEWS[name] = { free: true, pos: POS.split(',').map(Number), look: LOOK.split(',').map(Number), fov: 54, hour: 16.7 };
const V = VIEWS[name];
if (!V) { console.error('unknown view'); process.exit(1); }

let frozen = {};
try { frozen = JSON.parse(readFileSync('review/anchors.json', 'utf8')); } catch {}

await acquire('shot');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.error('ERR', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
await p.goto('http://localhost:5178', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

const noDiscard = process.argv.includes('--solid');
const msg = await p.evaluate(async ({ v, cached, expr, noDiscard }) => {
  window.__wdebugNoDiscard = noDiscard;
  const THREE = window.__THREE, wd = window.__world;
  window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
  const c0 = window.__engine.camera;
  if (v.free) {
    window.__forceCamera = true;
    c0.fov = v.fov; c0.updateProjectionMatrix();
    c0.position.set(v.pos[0], v.pos[1], v.pos[2]);
    c0.lookAt(v.look[0], v.look[1], v.look[2]);
  }
  const api = window.__cameraAnchors || {};
  const anchor = v.free ? { x: 0, z: 0, yaw: 0 } : (cached ?? ((v.index && window.__anchorAt)
    ? window.__anchorAt(v.anchor, v.index)
    : (api[v.anchor] || api.vista || (() => ({ x: 0, z: 0, yaw: 0 })))()));
  if (!v.free) {
    const yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
    const gx = anchor.x, gz = anchor.z;
    const gy = wd.getHeight(gx, gz) + v.height;
    window.__forceCamera = true;
    c0.fov = v.fov; c0.updateProjectionMatrix();
    c0.position.set(gx, gy, gz);
    c0.lookAt(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
  }

  const mat = window.__systems.water.material;
  const marker = 'gl_FragColor = vec4(col, alpha);';
  if (!mat.fragmentShader.includes(marker)) return 'marker not found';
  mat.fragmentShader = mat.fragmentShader.replace(
    marker, 'gl_FragColor = vec4(' + expr + ', 1.0); if (false) { }');
  // and cut the fog/tonemap includes so the term is what is written
  mat.fragmentShader = mat.fragmentShader
    .replace('#include <fog_fragment>', '')
    .replace('#include <tonemapping_fragment>', '');
  if (window.__wdebugNoDiscard) {
    mat.fragmentShader = mat.fragmentShader.split('discard;').join(';');
    mat.transparent = false; mat.depthWrite = true;
  }
  mat.needsUpdate = true;
  await window.__settleStable(1500, 30);
  return 'ok';
}, { v: V, cached: frozen[V.anchor] ?? null, expr, noDiscard });
console.log(msg);
mkdirSync('shots/wdebug', { recursive: true });
await p.screenshot({ path: out });
await b.close();
console.log(out);
