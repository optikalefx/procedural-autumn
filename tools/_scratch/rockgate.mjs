#!/usr/bin/env node
// Dump size / camera distance / the bigNear gate for the rock instances the
// 'river' camera is actually looking at, so a term that measures as inert can
// be told apart from a term that is switched off.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const frozen = JSON.parse(readFileSync(new URL('../../review/anchors.json', import.meta.url), 'utf8'));
const V = { anchor: 'river', height: 6.0, dist: 30, pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42 };
await acquire('rock-gate');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('console', (m) => { const t = m.text(); if (t.startsWith('G ')) console.log(t.slice(2)); });
await page.goto('http://localhost:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.evaluate(async ({ v, frozen }) => {
  const THREE = window.__THREE, e = window.__engine, wd = window.__world;
  window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
  const a = frozen[v.anchor]; const yaw = (a.yaw ?? 0) + (v.yawOffset ?? 0);
  const gy = wd.getHeight(a.x, a.z) + v.height;
  const pos = new THREE.Vector3(a.x, gy, a.z);
  e.camera.fov = v.fov; e.camera.updateProjectionMatrix(); e.camera.position.copy(pos);
  e.camera.lookAt(a.x + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, a.z + Math.cos(yaw) * v.dist);
  window.__forceCamera = true; if (window.__settle) await window.__settle(90);
  const rk = window.__systems.rocks;
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const rows = [];
  const m = new THREE.Matrix4(), p = new THREE.Vector3();
  for (const mesh of rk.meshes) {
    const sz = mesh.geometry.attributes.aRockA;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m); p.setFromMatrixPosition(m);
      const d = p.distanceTo(e.camera.position);
      if (d > 140) continue;
      const size = sz.array[i * 4 + 3];
      const gate = ss(1.0, 2.0, size) * ss(0.010, 0.030, size / Math.max(d, 1));
      rows.push({ arch: mesh.userData.arch, size, d, gate });
    }
  }
  rows.sort((x, y) => y.size - x.size);
  console.log('G near-camera rocks (d<140 m), largest first:');
  for (const r of rows.slice(0, 14))
    console.log(`G   ${r.arch.padEnd(9)} size ${r.size.toFixed(2).padStart(6)}  d ${r.d.toFixed(0).padStart(4)} m  size/d ${(r.size / r.d).toFixed(4)}  bigNear ${r.gate.toFixed(3)}`);
  console.log(`G total near rocks: ${rows.length}   with bigNear>0.5: ${rows.filter((r) => r.gate > 0.5).length}`);
}, { v: V, frozen });
await browser.close();
