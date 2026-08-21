#!/usr/bin/env node
/**
 * How far does each prop cut into a hillside?
 *
 * The player's report was visual — "these objects, like the tent and fire are
 * cutting into the side" — and the honest way to hold a fix to account is a
 * number per prop rather than another look at another screenshot.
 *
 * For each prop: take its world bounding box corners at the base, and for each
 * one ask how far the terrain there stands ABOVE the prop's own base plane.
 * The worst value is how deep the prop is buried on its uphill side.
 */
import { chromium } from 'playwright';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const LO = parseFloat(arg('lo', '0.22')), HI = parseFloat(arg('hi', '0.45'));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 850 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) return { readyState: 3, url: u, protocol: '', addEventListener() {}, removeEventListener() {}, send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    return new Real(u, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const out = await page.evaluate(({ LO, HI }) => {
  const S = window.__campSiteMod, W = window.__world, camp = window.__camp, v = window.__systems.vehicle;
  // A sloping site the game would actually offer.
  let site = null;
  for (let i = 0; i < 40000 && !site; i++) {
    const a = i * 2.39996, r = 6 * Math.sqrt(i);
    if (r > 260) break;
    const x = v.position.x + Math.cos(a) * r, z = v.position.z + Math.sin(a) * r;
    if (!W.isInBounds(x, z)) continue;
    const s = S.bestSite(W, x, z, { blocked: (bx, bz, br) => camp._blocked(bx, bz, br) });
    if (s.ok && s.grade >= LO && s.grade <= HI) site = { x, z, grade: s.grade };
  }
  if (!site) return null;
  camp.strike?.(camp.camps[0]);
  const c = camp.pitchAt(site.x, site.z, { instant: true });

  const T = window.__THREE;
  const box = new T.Box3(), corner = new T.Vector3();
  const rows = [];
  const measure = (obj, kind, ox, oz) => {
    box.setFromObject(obj);
    if (!isFinite(box.min.y)) return;
    // The prop's base plane, in world space, is its origin plus its own local
    // up — so a sample's depth is how far the ground is above that plane.
    const q = obj.quaternion, up = new T.Vector3(0, 1, 0).applyQuaternion(q);
    const o = obj.position;
    let worst = 0, worstAt = null;
    const R = obj.userData?.footprint ?? 0.6;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const px = ox + Math.cos(a) * R, pz = oz + Math.sin(a) * R;
      const h = W.getHeight(px, pz);
      // Signed distance from the base plane to the terrain point.
      corner.set(px - o.x, h - o.y, pz - o.z);
      const d = corner.dot(up);
      if (d > worst) { worst = d; worstAt = +(a * 57.3).toFixed(0); }
    }
    rows.push({ kind, buried: +worst.toFixed(3), at: worstAt, foot: +R.toFixed(2) });
  };
  for (const p of camp.props) measure(p.obj, p.item.kind, p.item.x, p.item.z);
  // The fire's solids carry their own rotation now.
  if (camp.fire?.solids) {
    const q = camp.fire.solids.quaternion, up = new T.Vector3(0, 1, 0).applyQuaternion(q);
    const o = camp.fire.group.position;
    let worst = 0;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2, R = 0.75;
      const px = c.x + Math.cos(a) * R, pz = c.z + Math.sin(a) * R;
      corner.set(px - o.x, W.getHeight(px, pz) - o.y, pz - o.z);
      const d = corner.dot(up);
      if (d > worst) worst = d;
    }
    rows.push({ kind: 'fire(ring)', buried: +worst.toFixed(3), at: null, foot: 0.75 });
  }
  return { site, rows };
}, { LO, HI });

if (!out) { console.error('no sloping site found'); await browser.close(); process.exit(2); }
console.log(`site grade ${out.site.grade.toFixed(3)} at ${out.site.x.toFixed(0)},${out.site.z.toFixed(0)}\n`);
console.log('prop         footprint   buried (m)');
for (const r of out.rows.sort((a, b) => b.buried - a.buried)) {
  const flag = r.buried > 0.10 ? '  <-- cutting in' : '';
  console.log(`  ${r.kind.padEnd(12)} ${String(r.foot).padStart(5)}      ${String(r.buried).padStart(6)}${flag}`);
}
if (errs.length) console.log('page-errors:', errs.slice(0, 3));
await browser.close();
