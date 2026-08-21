#!/usr/bin/env node
/**
 * How close does tent FABRIC actually come to the fire?
 *
 * `firegap.mjs` measures centre to centre, which is the number the layout
 * controls. This measures the one that decides whether the picture is wrong:
 * the closest point of the built tent's geometry, in world XZ, to the middle
 * of the fire ring — guy lines, pegs, vestibule and all.
 *
 * Pitched through `pitchNear` so it is the real camp, not a reconstruction.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const r = await page.evaluate(async () => {
  const C = window.__camp, THREE = window.__THREE;
  const rows = { full: [], small: [] };
  for (const small of [false, true]) {
    for (let i = 0; i < 26; i++) {
      C.strike();
      const a = i * 2.39996, rr = 40 + i * 41;
      const camp = C.pitchNear(Math.cos(a) * rr, Math.sin(a) * rr, { instant: true, small });
      if (!camp) continue;
      // Drain the one-prop-per-frame queue without waiting on frames.
      for (let k = 0; k < 40 && camp.queue.length; k++) C._buildNext(camp);
      const tent = camp.props.find((p) => p.item.kind === 'tent');
      if (!tent) continue;
      // Closest vertex, in world space, projected to XZ. The fire sits at the
      // camp centre, so that is what we measure to.
      let near = Infinity, far = 0;
      // The fly on its own. `Parts.flush` names every mesh `${label}_${key}`,
      // so the cords and the pegs — which reach further than the fabric and
      // which nobody minds seeing in the fringe grass — can be left out. This
      // is the extent that decides whether the tent is standing on the dirt it
      // was pitched on, and it is the number the comment on TENT_FIRE_CLEAR
      // spends its compact-camp budget against.
      let flyFar = 0, flyNear = Infinity;
      const v = new THREE.Vector3();
      tent.obj.updateWorldMatrix(true, true);
      tent.obj.traverse((o) => {
        const g = o.geometry; if (!g?.attributes?.position) return;
        const isCord = /_(cord|tube|alu|peg)$/.test(o.name);
        const p = g.attributes.position;
        // Instanced merges keep everything in one buffer already baked to the
        // group's local frame, so the object's world matrix is the whole
        // transform.
        for (let j = 0; j < p.count; j++) {
          v.fromBufferAttribute(p, j).applyMatrix4(o.matrixWorld);
          const d = Math.hypot(v.x - camp.x, v.z - camp.z);
          if (d < near) near = d;
          if (d > far) far = d;
          if (!isCord) { if (d < flyNear) flyNear = d; if (d > flyFar) flyFar = d; }
        }
      });
      rows[camp.small ? 'small' : 'full'].push({
        centre: +Math.hypot(tent.item.x - camp.x, tent.item.z - camp.z).toFixed(2),
        near: +near.toFixed(2),
        far: +far.toFixed(2),
        flyNear: +flyNear.toFixed(2),
        flyFar: +flyFar.toFixed(2),
        style: tent.item.opts?.style,
        R: camp.radius,
        feather: +camp.feather.toFixed(2),
      });
    }
  }
  C.strike();
  const fireR = C.camps[0]?.fire?.radius ?? C._pool?.[0]?.fire?.radius ?? null;
  return { rows, fireR: C._pool?.[0]?.fire?.radius ?? fireR };
});
console.log(`fire ring radius: ${r.fireR}`);
for (const [k, rows] of Object.entries(r.rows)) {
  if (!rows.length) { console.log(`${k}: none`); continue; }
  const near = rows.map((x) => x.near).sort((a, b) => a - b);
  const ctr  = rows.map((x) => x.centre).sort((a, b) => a - b);
  const q = (a, p) => a[Math.floor(a.length * p)];
  // Reach is what the layout actually needs to know: how far the built tent
  // extends past the point the layout placed, toward the fire and away from it.
  const reachIn  = rows.map((x) => +(x.centre - x.near).toFixed(2)).sort((a, b) => a - b);
  const reachOut = rows.map((x) => +(x.far - x.centre).toFixed(2)).sort((a, b) => a - b);
  console.log(`${k.padEnd(6)} n=${rows.length}  R=${rows[0].R} feather=${rows[0].feather}`);
  console.log(`       centre  min ${q(ctr,0)}  med ${q(ctr,0.5)}`);
  console.log(`       fabric→fire  min ${q(near,0)}  med ${q(near,0.5)}   inside ring (<${r.fireR}): ${near.filter((v) => v < r.fireR).length}/${rows.length}`);
  console.log(`       reach toward fire  med ${q(reachIn,0.5)}  max ${q(reachIn,0.99)}`);
  console.log(`       reach away (back)  med ${q(reachOut,0.5)}  max ${q(reachOut,0.99)}`);
  const flyFar = rows.map((x) => x.flyFar).sort((a, b) => a - b);
  const flyIn  = rows.map((x) => x.flyNear).sort((a, b) => a - b);
  const rim = rows[0].R, cover = +(rows[0].R - rows[0].feather).toFixed(2);
  console.log(`       fly→fire   min ${q(flyIn,0)}   fly back edge  med ${q(flyFar,0.5)}  max ${q(flyFar,0.99)}   (full cover ${cover}, rim ${rim})`);
  console.log(`       fly past rim: ${flyFar.filter((v) => v > rim).length}/${rows.length}   fly past full cover: ${flyFar.filter((v) => v > cover).length}/${rows.length}`);
}
await browser.close();
