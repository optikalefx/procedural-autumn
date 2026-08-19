#!/usr/bin/env node
// Lay every ground-cover archetype out in a row on flat ground and photograph
// it. Silhouette bugs that are invisible at 60 m in a meadow are obvious here.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const out = resolve(arg('out', 'shots/cover/gallery.png'));
mkdirSync(dirname(out), { recursive: true });

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 620 } });
page.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 300)));
await page.goto('http://localhost:5178?res=' + arg('res', '512'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

console.log(await page.evaluate(async ({hour, from, to, span}) => {
  const T = window.__THREE, e = window.__engine, W = window.__world;
  const g = window.__systems.groundCover;
  window.__lighting.hour = parseFloat(hour);
  from = parseInt(from, 10); to = parseInt(to, 10); span = parseFloat(span);
  window.__lighting.cycleSpeed = 0;
  window.__systems.grass.group.visible = false;
  for (const k of ['trees', 'rocks', 'wildlife', 'birds']) {
    const sys = window.__systems[k];
    if (sys && sys.group) sys.group.visible = false;
  }
  g.enabled = false;

  // A flat, dry patch to stand them on.
  let bx = 0, bz = 0, best = 1e9;
  for (let i = 0; i < 4000; i++) {
    const x = (Math.random() - 0.5) * 1800, z = (Math.random() - 0.5) * 1800;
    if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0) continue;
    const s = W.getSlope(x, z);
    if (s < best) { best = s; bx = x; bz = z; }
    if (best < 0.02) break;
  }

  const M = new T.Matrix4(), p = new T.Vector3(), q = new T.Quaternion(), sc = new T.Vector3(1, 1, 1);
  const names = [];
  const sel = g.slots.slice(from, to);
  const n = sel.length;
  for (const s of g.slots) { s.mesh.count = 0; s.mesh.visible = false; }
  sel.forEach((s, i) => {
    const x = bx + (i - (n - 1) / 2) * span;
    const z = bz;
    p.set(x, W.getHeight(x, z), z);
    q.identity();
    M.compose(p, q, sc);
    s.mesh.setMatrixAt(0, M);
    const cov = s.geo.getAttribute('aCov').array;
    cov[0] = 0; cov[1] = 0; cov[2] = 1; cov[3] = 9999;   // no wind, no fade
    const wd = s.geo.getAttribute('aWindDir').array;
    wd[0] = 1; wd[1] = 0;
    s.mesh.instanceMatrix.needsUpdate = true;
    s.geo.getAttribute('aCov').needsUpdate = true;
    s.geo.getAttribute('aWindDir').needsUpdate = true;
    s.mesh.count = 1;
    s.mesh.visible = true;
    names.push(s.mesh.name.replace('cover_', ''));
  });

  const cy = W.getHeight(bx, bz);
  const dist = Math.max(6, (n * span) / 1.38 + 3);
  e.camera.fov = 30; e.camera.updateProjectionMatrix();
  e.camera.position.set(bx, cy + dist * 0.10 + 0.5, bz + dist);
  e.camera.lookAt(bx, cy + dist * 0.045, bz);
  window.__forceCamera = true;
  if (window.__settle) await window.__settle(40);
  return JSON.stringify(names);
}, { hour: arg('hour', '16.7'), from: arg('from', '0'), to: arg('to', '99'), span: arg('span', '2.6') }));

await page.waitForTimeout(1200);
await page.screenshot({ path: out });
console.log('shot:', out);
await browser.close();
