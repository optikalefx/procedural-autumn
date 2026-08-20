#!/usr/bin/env node
/**
 * Coverage-versus-distance profile — the pop-in gradient, as a number.
 *
 * An image cannot show pop-in and a frame rate cannot either. What the player
 * actually perceives is the RATE at which ground dressing arrives as they drive
 * into it, so measure exactly that: for every drawn cover instance, its
 * distance from the camera and the shrink factor the shader will apply to it
 * (`coverFade`), binned into 4 m rings and normalised by ring area. A ladder
 * that pops has a cliff in this profile; one that does not is flat and then
 * tapers.
 *
 * Reported per bin: m² of prop footprint per m² of ground. Grass is reported
 * from its own fade ladder, analytically, in the same units.
 *
 *   node tools/_scratch/lodprofile.mjs
 *   node tools/_scratch/lodprofile.mjs --cover 0.55 --near 20,30 --mid 18,28
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const OV = {
  coverVis: arg('cover', null) === null ? null : parseFloat(arg('cover')),
  near: arg('near', null) ? arg('near').split(',').map(Number) : null,
  mid: arg('mid', null) ? arg('mid').split(',').map(Number) : null,
};

await acquire('lodprofile');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, q) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
               set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new R(u, q);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
await page.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

const out = await page.evaluate(async (ov) => {
  const S = window.__systems, T = window.__THREE, wd = window.__world;
  const gc = S.groundCover, gr = S.grass;

  // Stand where the chase camera stands, in open meadow.
  const a = window.__cameraAnchors.meadow();
  const e = window.__engine;
  e.camera.position.set(a.x, wd.getHeight(a.x, a.z) + 5.0, a.z);
  e.camera.lookAt(a.x + Math.sin(a.yaw ?? 0) * 40, e.camera.position.y - 5, a.z + Math.cos(a.yaw ?? 0) * 40);
  window.__forceCamera = true;
  if (ov.coverVis !== null) gc.visMul = ov.coverVis;
  if (ov.near) gr.rings[0].material.userData.uniforms.uFadeOut.value.set(ov.near[0], ov.near[1]);
  if (ov.mid) gr.rings[1].material.userData.uniforms.uFadeIn.value.set(ov.mid[0], ov.mid[1]);
  gc._dirty = true;
  await window.__settle(120);

  const cam = e.camera.position;
  const NB = 20, BW = 4;                       // 20 bins of 4 m -> 80 m
  const cover = new Float64Array(NB);
  const m = new T.Matrix4(), p = new T.Vector3(), q = new T.Quaternion(), sc = new T.Vector3();

  const SUBSTRATE = new Set(['pebble', 'leafScatter', 'deadTuft', 'moss', 'broadleaf']);
  for (const slot of gc.slots) {
    if (!SUBSTRATE.has(slot.arch.key)) continue;
    const n = slot.mesh.count;
    if (!n) continue;
    // Footprint of the prototype, from its own bounding sphere: a substrate
    // prop is wider than tall, so pi*r^2 is the right order for how much ground
    // it hides.
    const bs = slot.geo.boundingSphere;
    const base = Math.PI * bs.radius * bs.radius;
    const acov = slot.geo.getAttribute('aCov').array;
    for (let i = 0; i < n; i++) {
      slot.mesh.getMatrixAt(i, m);
      m.decompose(p, q, sc);
      const d = p.distanceTo(cam);
      const b = Math.floor(d / BW);
      if (b >= NB) continue;
      const vis = acov[i * 4 + 3];
      // The shader's own fade, verbatim.
      const t = Math.min(1, Math.max(0, (d - vis * 0.76) / (vis - vis * 0.76)));
      const f = 1 - (t * t * (3 - 2 * t));
      const s = (sc.x + sc.z) * 0.5 * f;
      cover[b] += base * s * s;
    }
  }

  const rows = [];
  for (let b = 0; b < NB; b++) {
    const r0 = b * BW, r1 = r0 + BW;
    const area = Math.PI * (r1 * r1 - r0 * r0);
    // Grass, from the fade ladder rather than by counting half a million
    // blades: density x blade area x the ring's own cover() at this radius.
    let g = 0;
    for (const ring of gr.rings) {
      const u = ring.material.userData.uniforms;
      const fi = u.uFadeIn.value, fo = u.uFadeOut.value;
      const ss = (x, e0, e1) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
      const d = (r0 + r1) * 0.5;
      const c = Math.min(ss(d, fi.x, fi.y), 1 - ss(d, fo.x, fo.y));
      const dens = ring.maxBlades * 16 / ((4 * ring.tileSize) ** 2);
      g += dens * c * ring.width * ring.height;
    }
    rows.push({ d: (r0 + r1) / 2, cover: +(cover[b] / area).toFixed(4), grass: +g.toFixed(3) });
  }
  return { rows, instances: gc.stats.instances };
}, OV);

await browser.close();
const bump = (k) => out.rows.map((r) => r[k]);
console.log(`instances ${out.instances}`);
console.log('  d(m)  substrate  grass   total');
for (const r of out.rows) {
  const t = r.cover + r.grass;
  console.log(`  ${String(r.d).padStart(4)}  ${r.cover.toFixed(4).padStart(8)}  ${r.grass.toFixed(3).padStart(6)}  ${t.toFixed(3).padStart(6)}  ${'#'.repeat(Math.round(t * 18))}`);
}
// Steepest fall per metre of the combined profile — the number that decides
// whether a player sees detail arriving.
let worst = 0, at = 0;
const tot = out.rows.map((r) => r.cover + r.grass);
for (let i = 1; i < tot.length; i++) {
  const g = (tot[i - 1] - tot[i]) / 4;
  if (g > worst) { worst = g; at = out.rows[i].d - 2; }
}
console.log(`steepest fall ${worst.toFixed(4)} /m at ${at} m from camera (${(at - 12).toFixed(0)} m ahead of the bumper, ${((at - 12) / 13).toFixed(2)} s)`);
void bump;
