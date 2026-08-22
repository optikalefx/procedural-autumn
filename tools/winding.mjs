#!/usr/bin/env node
/**
 * Whole-scene winding audit.
 *
 * Three separate authors have now shipped geometry whose triangle winding
 * disagreed with the vertex normals it wrote — `frond()`, `tube()` and
 * `buildBarkGeometry()`. Each time the symptom was a surface that stayed dark
 * from every angle, each time it was misdiagnosed first (as a shadow-receive
 * problem, as a grade clamp, as a palette that needed lifting), and each time
 * the "fix" was a compensating brightness multiplier somewhere else.
 *
 * The failure is invisible in a still and cheap to detect: for each triangle,
 * the geometric normal from the winding should point the same way as the
 * average of its three stored vertex normals.
 *
 *   node tools/winding.mjs
 *   node tools/winding.mjs --threshold 0.5 --json shots/winding.json
 *
 * Exit code 0 = every mesh agrees. Non-zero = at least one is inverted.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

// Fraction of triangles that must agree before a mesh is considered correct.
// Legitimately double-sided foliage cards can disagree on a minority of faces;
// an inverted mesh disagrees on essentially all of them.
const THRESHOLD = parseFloat(arg('threshold', '0.5'));
const RES = arg('res', '768');

await acquire('winding');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
// Neuter Vite's HMR client before any page script runs. A dozen authors edit
  // this tree concurrently, and a peer saving a file mid-run reloads the page
  // and kills the run with "Execution context was destroyed".
  await page.addInitScript(() => {
    const RealWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
        return {
          readyState: 3, url, close() {}, send() {},
          addEventListener() {}, removeEventListener() {},
          set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {},
        };
      }
      return new RealWS(url, protocols);
    };
    window.WebSocket.prototype = RealWS.prototype;
    Object.assign(window.WebSocket, RealWS);
  });

page.on('pageerror', (e) => console.error('page error:', e.message));

await page.goto(`${process.env.AUTUMN_URL || 'http://localhost:5178'}/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
// Let streaming systems build their geometry before auditing it.
await page.evaluate(() => window.__settle?.(120));

const report = await page.evaluate((threshold) => {
  const out = [];
  const seen = new Set();

  window.__engine.scene.traverse((o) => {
    const g = o.geometry;
    if (!g || !g.attributes?.position || !g.attributes?.normal) return;
    if (seen.has(g.uuid)) return;
    seen.add(g.uuid);

    const pos = g.attributes.position, nor = g.attributes.normal;
    const idx = g.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    if (!triCount) return;

    // Sample rather than test every triangle — 400 is plenty to separate
    // "inverted" from "a few disagreeing cards".
    const step = Math.max(1, Math.floor(triCount / 400));
    let agree = 0, tested = 0;

    for (let t = 0; t < triCount; t += step) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;

      const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
      const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
      const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);

      // Geometric normal from the winding order.
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const gx = uy * vz - uz * vy;
      const gy = uz * vx - ux * vz;
      const gz = ux * vy - uy * vx;
      const gl = Math.hypot(gx, gy, gz);
      if (gl < 1e-12) continue;              // degenerate triangle

      // Average of the three stored vertex normals.
      const sx = nor.getX(i0) + nor.getX(i1) + nor.getX(i2);
      const sy = nor.getY(i0) + nor.getY(i1) + nor.getY(i2);
      const sz = nor.getZ(i0) + nor.getZ(i1) + nor.getZ(i2);
      const sl = Math.hypot(sx, sy, sz);
      if (sl < 1e-9) continue;               // opposed normals, nothing to say

      if ((gx * sx + gy * sy + gz * sz) / (gl * sl) > 0) agree++;
      tested++;
    }

    if (!tested) return;
    const ratio = agree / tested;
    if (ratio >= threshold) return;

    let path = [], p = o;
    while (p && path.length < 5) { if (p.name) path.unshift(p.name); p = p.parent; }
    out.push({
      object: o.name || o.type,
      path: path.join('/'),
      material: o.material?.name || o.material?.type,
      side: o.material?.side,
      agreeRatio: +ratio.toFixed(3),
      tested,
      triangles: triCount,
    });
  });
  return out;
}, THRESHOLD);

await browser.close();

if (arg('json')) {
  mkdirSync(dirname(resolve(arg('json'))), { recursive: true });
  writeFileSync(resolve(arg('json')), JSON.stringify(report, null, 1));
}

if (!report.length) {
  console.log('✓ every audited geometry winds in agreement with its normals');
  process.exit(0);
}

console.log(`\n✗ ${report.length} geometry(ies) wound against their own normals:\n`);
for (const r of report) {
  console.log(`  ${r.path || r.object}`);
  console.log(`     ${(r.agreeRatio * 100).toFixed(1)}% of ${r.tested} sampled triangles agree ` +
              `(${r.triangles} tris, material ${r.material}, side ${r.side})`);
}
console.log('\nA surface wound against its normals renders dark from every angle.');
console.log('It is usually mistaken for a shadow, grade or palette problem — check this first.\n');
process.exit(1);
