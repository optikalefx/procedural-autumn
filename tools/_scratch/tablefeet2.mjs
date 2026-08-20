#!/usr/bin/env node
// Throwaway: how far above (or below) the *drawn* dirt does each of the table's
// four feet sit? Samples the camp ground mesh directly — the terrain and the
// dirt both override raycast for their BVH, so a raycast miss reads as "no
// ground" rather than as an error.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const release = await acquire('tablefeet');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (String(p).includes('vite')) return { readyState: 3, addEventListener() {}, removeEventListener() {}, send() {}, close() {} };
    return new Real(u, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1600);

const out = await page.evaluate(() => {
  const THREE = window.__THREE;
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  if (!s) return { error: 'no site' };
  const rec = window.__camp.props.find((q) => q.item.kind === 'table');
  if (!rec) return { error: 'no table placed' };
  const obj = rec.obj;
  obj.updateMatrixWorld(true);

  const quad = [{}, {}, {}, {}];
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const p = m.geometry.getAttribute('position');
    const w = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      const lx = p.getX(i), ly = p.getY(i), lz = p.getZ(i);
      if (Math.abs(lx) < 0.20 || Math.abs(lz) < 0.12) continue;
      w.set(lx, ly, lz).applyMatrix4(m.matrixWorld);
      const q = (lx > 0 ? 1 : 0) + (lz > 0 ? 2 : 0);
      if (quad[q].y === undefined || w.y < quad[q].y) quad[q] = { x: w.x, y: w.y, z: w.z, lx, ly, lz };
    }
  });

  const names = [], cand = [];
  window.__engine.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || obj.getObjectById(o.id)) return;
    const n = (o.name || o.type).toLowerCase();
    if (/camp|dirt|ground|terrain|chunk|tile/.test(n)) { names.push(o.name || o.type); cand.push(o); }
  });

  const nearestOn = (m, wx, wz) => {
    const p = m.geometry.getAttribute('position');
    const w = new THREE.Vector3();
    let best = null, bd = Infinity;
    for (let i = 0; i < p.count; i++) {
      w.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(m.matrixWorld);
      const d = (w.x - wx) ** 2 + (w.z - wz) ** 2;
      if (d < bd) { bd = d; best = w.y; }
    }
    return { y: best, d: Math.sqrt(bd) };
  };

  const rows = quad.map((f, i) => {
    if (f.y === undefined) return { i, err: 'none' };
    let gy = null, gname = null, gd = Infinity;
    for (const m of cand) {
      const r = nearestOn(m, f.x, f.z);
      if (r.y !== null && r.d < gd) { gd = r.d; gy = r.y; gname = m.name || m.type; }
    }
    return {
      i, local: [+f.lx.toFixed(3), +f.ly.toFixed(3), +f.lz.toFixed(3)],
      footY: +f.y.toFixed(4),
      groundY: gy === null ? null : +gy.toFixed(4),
      sampleDist: +gd.toFixed(3),
      on: gname,
      clearance: gy === null ? null : +(f.y - gy).toFixed(4),
    };
  });

  return { originY: +obj.position.y.toFixed(4), rows, meshes: [...new Set(names)].slice(0, 14) };
});

console.log(JSON.stringify(out, null, 1));
await browser.close();
release();
