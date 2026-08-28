#!/usr/bin/env node
/**
 * What the roasting shaft's pixels are DOING at held range.
 *
 * `dusk-held-clean` shows the stick as the brightest object in the frame after
 * the flame, pale pink, with no bark, no char and no taper — while `prop-side`
 * shows the same stick as dark brown wood. Round 2 proved a marshmallow's value
 * was lighting-bound rather than albedo-bound by rendering it white; this is the
 * same play for the shaft, and it needs three things a screenshot cannot give:
 *
 *   1. WHICH PART of the stick is on screen. The grip is behind the lens, so
 *      the visible run is some interval of `s`, and every claim about "no bark"
 *      or "no taper" is a claim about that interval.
 *   2. The irradiance the fire's point light puts on it, AFTER the view's
 *      `_dampHearth` has run — intensity / d^decay at the shaft, against the
 *      same quantity at the near stones and at the marshmallow.
 *   3. The albedo actually in the buffers there: material colour x the baked
 *      vertex colour, which is where bark, whittle and char live.
 *
 *   AUTUMN_URL=http://127.0.0.1:5251 node tools/_scratch/shaftlight.mjs
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5178';
const HOUR = Number(process.env.HOUR ?? 20.4);

await acquire('shaftlight');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await p.goto(`${URL}?res=768&car=camper`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });

await p.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);

// Park and pitch exactly as roastshot does, because `enter()` needs a camp with
// a roaststick in it and there is not one until `pitchNear` has run.
const parkAt = await p.evaluate(() => {
  const q = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(q.x, q.z, q.yaw ?? 0.9);
  return { x: q.x, z: q.z };
});
await p.waitForTimeout(1600);
await p.keyboard.down('Space');
await p.waitForTimeout(1000);
await p.keyboard.up('Space');
await p.waitForTimeout(2400);
await p.waitForFunction(() => !!window.__camp?.pitchNear, null, { timeout: 60000, polling: 300 });
const site = await p.evaluate((at) => {
  const s = window.__camp.pitchNear(at.x, at.z, { instant: true, radius: 14 });
  return s ? { x: s.x, z: s.z } : null;
}, parkAt);
if (!site) { console.log('!! no camp pitched'); await b.close(); process.exit(1); }
await p.waitForTimeout(1200);

// Enter, then let the view run REAL frames: `_dampHearth` is written from
// `lateUpdate`, so a probe that enters and reads in the same tick reads the
// fire's authored falloff and not the view's.
const ent = await p.evaluate(() => {
  const R = window.__roast;
  let err = null;
  try { R.enter(); } catch (e) { err = String(e.message); }
  return { err, active: !!R.state?.().active };
});
console.log('enter:', JSON.stringify(ent));
// Long enough for one `lateUpdate` (which is where `_dampHearth` is written)
// and short enough that the view has not dropped out again — it does, on this
// harness, about a second after `enter()`.
await p.waitForTimeout(250);

const r = await p.evaluate(() => {
  const THREE = window.THREE || window.__THREE;
  const R = window.__roast;
  let st = R.state();
  if (!st?.active) { R.enter(); st = R.state(); }
  if (!st?.active) return { error: 'the view did not enter' };
  R.setHeight(0.24); R.setSpin(0); R.setDoneness(0.55);
  R.step?.(0);
  window.__roastDraw?.();

  const cam = window.__engine?.camera || window.__camera;
  const held = R._view?.held || (() => {
    let f = null;
    cam.traverse((o) => { if (o.name === 'camp_roast_held') f = o; });
    return f;
  })();
  if (!held) return { error: 'no camp_roast_held under the camera' };

  // ── the shaft mesh, and the interval of it that is on screen ─────────────
  let shaft = null;
  held.traverse((o) => { if (o.isMesh && o.name !== 'held_mallow' && !shaft) shaft = o; });
  const pos = shaft.geometry.attributes.position;
  const col = shaft.geometry.attributes.color;
  held.updateMatrixWorld(true);
  const mw = shaft.matrixWorld;
  const grip = held.getWorldPosition(new THREE.Vector3());
  const mallowW = held.userData.held.mallow.getWorldPosition(new THREE.Vector3());
  const axis = mallowW.clone().sub(grip);
  const stickLen = axis.length();
  axis.normalize();
  const eye = cam.getWorldPosition(new THREE.Vector3());

  // Bucket every shaft vertex by its arc parameter, and record for each bucket
  // the radius (max distance off the axis), the distance to the lens, the
  // albedo, and whether it projects inside the frame.
  // Two passes. The radius has to be measured from the LOCAL centreline, not
  // from the grip->mallow chord: the S and the droop carry the centreline up to
  // 25 mm off that chord over 1.3 m, which is three times the shaft's own
  // radius, so a distance-to-chord reads a 15 mm stick as an 80 mm one. Pass
  // one finds each bucket's centroid; pass two measures against it.
  const NB = 60;
  const bk = Array.from({ length: NB }, () => ({
    n: 0, r: 0, d: 0, on: 0, cr: 0, cg: 0, cb: 0, ndcx: 0, ndcy: 0,
    c: new THREE.Vector3(),
  }));
  const v = new THREE.Vector3();
  const W = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mw);
    const q = v.clone().sub(grip);
    const s = q.dot(axis) / stickLen;
    const j = Math.max(0, Math.min(NB - 1, Math.floor(s * NB)));
    W.push({ w: v.clone(), j, i });
    bk[j].c.add(v);
    bk[j].n++;
  }
  for (const B of bk) if (B.n) B.c.divideScalar(B.n);
  for (const { w, j, i } of W) {
    const B = bk[j];
    const off = w.distanceTo(B.c);
    B.r += off;
    B.d += w.distanceTo(eye);
    const n = w.clone().project(cam);
    if (Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1 && n.z < 1) B.on++;
    B.ndcx += n.x; B.ndcy += n.y;
    if (col) { B.cr += col.getX(i); B.cg += col.getY(i); B.cb += col.getZ(i); }
  }

  // ── the fire's light, as the view leaves it ──────────────────────────────
  // The point light NEAREST the eye. Naming it by traversal order picks up the
  // headlights, which are a kilometre away when the camp is pitched at a POI —
  // the 1714 m the first revision of this tool printed.
  // The point light NEAREST the eye, over every root three knows about. The
  // fire's light comes out of a pool built at boot (`camp_fire.js`), so it is
  // not under the camp group and naming it by traversal order picks up a
  // headlight a kilometre away — the 1714 m an earlier revision printed.
  let light = null, lightD = Infinity;
  const roots = [window.__engine?.scene, window.__world?.scene, cam.parent];
  const seen = new Set();
  for (const R0 of roots) {
    let top = R0;
    while (top?.parent) top = top.parent;
    if (!top || seen.has(top)) continue;
    seen.add(top);
    top.traverse((o) => {
      if (!o.isPointLight || !o.visible || o.intensity <= 0) return;
      const d = o.getWorldPosition(new THREE.Vector3()).distanceTo(eye);
      if (d < lightD) { lightD = d; light = o; }
    });
  }
  const L = light ? {
    decay: light.decay, distance: light.distance, intensity: light.intensity,
    colour: light.color.getHexString(),
    pos: light.getWorldPosition(new THREE.Vector3()).toArray().map((x) => +x.toFixed(3)),
  } : null;

  const mat = shaft.material;
  const rows = [];
  for (let j = 0; j < NB; j++) {
    const B = bk[j];
    if (!B.n) continue;
    const s = (j + 0.5) / NB;
    const d = B.d / B.n;
    const wp = grip.clone().addScaledVector(axis, s * stickLen);
    const dl = light ? wp.distanceTo(light.getWorldPosition(new THREE.Vector3())) : 0;
    rows.push({
      s: +s.toFixed(3),
      mm: +((B.r / B.n) * 2000).toFixed(2),
      dLens: +d.toFixed(3),
      dFire: +dl.toFixed(3),
      onFrac: +(B.on / B.n).toFixed(2),
      // A cylinder of diameter `mm` at `dLens` on a 34-degree, 900-px frame.
      px: +(((B.r / B.n) * 2 / d) / (2 * Math.tan(34 * Math.PI / 360)) * 900).toFixed(1),
      ndc: [+(B.ndcx / B.n).toFixed(3), +(B.ndcy / B.n).toFixed(3)],
      vc: [+(B.cr / B.n).toFixed(3), +(B.cg / B.n).toFixed(3), +(B.cb / B.n).toFixed(3)],
    });
  }

  return {
    hour: window.__lighting.hour,
    stickLen: +stickLen.toFixed(3),
    dMallow: +eye.distanceTo(mallowW).toFixed(3),
    matColour: mat.color.getHexString(),
    matRough: mat.roughness, matMetal: mat.metalness,
    light: L,
    rows,
  };
});

if (r.error) { console.log('!!', r.error); await b.close(); process.exit(1); }

console.log(`hour ${r.hour}   stick ${r.stickLen} m grip->mallow   marshmallow ${r.dMallow} m from the lens`);
console.log(`shaft material  colour #${r.matColour}  roughness ${r.matRough}  metalness ${r.matMetal}`);
if (r.light) {
  const L = r.light;
  console.log(`fire light      #${L.colour}  intensity ${L.intensity.toFixed(2)}  ` +
              `decay ${L.decay.toFixed(2)}  cutoff ${L.distance.toFixed(2)} m`);
}
console.log('\n   s      dia mm   d lens   d fire   on-screen   px wide   irradiance   vertex colour');
for (const row of r.rows) {
  const L = r.light;
  const E = L ? L.intensity / Math.pow(Math.max(1e-3, row.dFire), L.decay) : 0;
  const mark = row.onFrac > 0.5 ? ' <=' : '';
  console.log(`  ${row.s.toFixed(3)}  ${row.mm.toFixed(2).padStart(7)}  ` +
    `${row.dLens.toFixed(3).padStart(7)}  ${row.dFire.toFixed(3).padStart(7)}  ` +
    `${row.onFrac.toFixed(2).padStart(9)}  ${row.px.toFixed(1).padStart(8)}  ` +
    `${E.toFixed(2).padStart(10)}   ${row.vc.map((x) => x.toFixed(2)).join(' ')}` +
    `  px(${((row.ndc[0] + 1) * 800).toFixed(0)},${((1 - row.ndc[1]) * 450).toFixed(0)})${mark}`);
}
await b.close();
