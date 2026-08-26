#!/usr/bin/env node
/**
 * Why the journal went dark on the camp table, and what `HIDE_LIFT` is worth.
 *
 *   node tools/_scratch/_jlum.mjs
 *
 * The book was authored for the journal overlay — four lights and an
 * environment map — and on the table it has a sun, a hemisphere and no fill.
 * This pitches a camp with a table in the real game, poses the lens on the
 * book, and sweeps the leather's albedo gain at runtime (`HIDE_LIFT` is exactly
 * a gain on `material.color`, so it can be swept without a rebuild).
 *
 * Two things it prints and one it settled on the way:
 *
 *  · the cover map's own average, straight off the decoded bitmap;
 *  · per lift: the cover's mean RGB, its luma, and its **grain sd** — which is
 *    the column that matters. The atmosphere lays a pedestal over the prop that
 *    no albedo gain touches, so the mean barely moves; what moves is whether
 *    the pebble and the blind-tooled fillet are still there to see.
 *
 * The crop is DERIVED — the cover's four corners projected through the live
 * camera and inset. A hand-typed box measured the black table top at every lift
 * and produced five identical rows, which is what a crop that misses looks
 * like. So is a stride read off the file rather than assumed: stepping 4 over a
 * 3-byte RGB buffer rotates the channels and averages to three equal numbers,
 * which looks exactly like a neutral surface.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('jlum');
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({viewport:{width:900,height:520}});
await p.addInitScript(() => { const R=window.WebSocket; window.WebSocket=function(u,pr){ if(typeof u==='string'&&/[?&]token=|vite-hmr|__vite/.test(u)) return {readyState:3,url:u,close(){},send(){},addEventListener(){},removeEventListener(){},set onopen(_){},set onclose(_){},set onerror(_){},set onmessage(_){}}; return new R(u,pr); }; window.WebSocket.prototype=R.prototype; Object.assign(window.WebSocket,R); });
await p.goto('http://127.0.0.1:5199/?seed=20261018&car=camper&res=768',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
await p.evaluate(()=>{ const q=window.__poi.best('meadow')??{x:0,z:0}; window.__vehicleTeleport?.(q.x,q.z,q.yaw??0.9); });
await p.waitForTimeout(1600);
await p.keyboard.down('Space'); await p.waitForTimeout(1000); await p.keyboard.up('Space'); await p.waitForTimeout(2400);
let ok=null;
for (let i=0;i<8&&!ok;i++) ok = await p.evaluate((n)=>{ const v=window.__systems.vehicle; window.__camp.__seed=20261018+n*7919; const s=window.__camp.pitchNear(v.position.x,v.position.z,{instant:true,radius:14}); if(!s) return null; if(!window.__camp.props.some(q=>q.item.kind==='table')){window.__camp.strike(); return null;} return true; }, i);
// ── the lift sweep ──────────────────────────────────────────────────────────
// `HIDE_LIFT` is a gain on the leather's albedo, so it can be swept at runtime
// by writing the two leather materials' `color` — which is exactly what
// `journalMaterials` sets it to. Crop is the book alone, taken from the close
// plan framing, so the black table is not in the average.
const sweep = async (hour) => {
  await p.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
  await p.waitForTimeout(1000);
  console.log(`\n  hour ${hour}`);
  for (const k of [1, 1.6, 2.0, 2.6, 3.2]) {
    await p.evaluate(async ({ k }) => {
      const T = window.__THREE, e = window.__engine;
      const t = window.__camp.props.find((q) => q.item.kind === 'table');
      const h = t.obj.userData.journalBook;
      t.obj.updateMatrixWorld(true);
      const c = h.getWorldPosition(new T.Vector3());
      h.traverse((o) => {
        // The two leather materials, by their published envMapIntensity — the
        // only two that carry a leather map.
        if (o.isMesh && o.material.map && (o.material.envMapIntensity === 0.42 ||
            o.material.envMapIntensity === 0.38)) o.material.color.setScalar(k);
      });
      const a = t.item.yaw + 0.20;
      e.camera.fov = 36; e.camera.updateProjectionMatrix();
      e.camera.position.set(c.x + Math.sin(a) * 0.42, t.item.y + 0.90, c.z + Math.cos(a) * 0.42);
      e.camera.lookAt(c); window.__forceCamera = true;
      if (window.__settleStable) await window.__settleStable(500, 20);
      // The crop, derived rather than guessed: the cover's own four corners
      // projected through the live camera, inset 22% so the sample is cover and
      // not silhouette. The first run of this used a hand-typed box and
      // measured the black table top at every lift — five identical rows of
      // rgb(44,44,44), which is what a crop that misses looks like.
      const half = [0.157 / 2, 0.219 / 2];
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
        const v = new T.Vector3(sx * half[0] * 0.56, 0.017, sy * half[1] * 0.56);
        h.localToWorld(v);
        v.project(e.camera);
        return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
      });
      const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
      window.__crop = {
        x: Math.round(Math.min(...xs)), y: Math.round(Math.min(...ys)),
        width: Math.max(4, Math.round(Math.max(...xs) - Math.min(...xs))),
        height: Math.max(4, Math.round(Math.max(...ys) - Math.min(...ys))),
      };
    }, { k });
    await p.waitForTimeout(350);
    const path = `/tmp/_jlift_${hour}_${k}.png`;
    await p.screenshot({ path, clip: await p.evaluate(() => window.__crop) });
    const { readPNG } = await import('../_pngread.mjs');
    const img = readPNG(path);
    // The stride is DERIVED. `_pngread` hands back whatever the file has, and
    // stepping 4 over a 3-byte RGB buffer rotates the channels — which averages
    // to three identical numbers and looks exactly like a neutral surface. Five
    // rows of rgb(47,47,47) off a visibly red leather crop is what that is.
    const st = Math.round(img.px.length / (img.w * img.h));
    let r = 0, g = 0, b = 0, n = 0;
    const L = [];
    for (let i = 0; i < img.px.length; i += st) {
      r += img.px[i]; g += img.px[i + 1]; b += img.px[i + 2]; n++;
      L.push(0.2126 * img.px[i] + 0.7152 * img.px[i + 1] + 0.0722 * img.px[i + 2]);
    }
    r /= n; g /= n; b /= n;
    const mu = L.reduce((a, v) => a + v, 0) / L.length;
    // The GRAIN, as a number. The lift is a gain on the leather's own signal
    // and the atmosphere adds a pedestal that it does not touch, so what moves
    // most is not the mean — it is the spread, i.e. whether the pebble and the
    // blind-tooled fillet are still there to see.
    const sd = Math.sqrt(L.reduce((a, v) => a + (v - mu) ** 2, 0) / L.length);
    console.log(`    lift ${String(k).padEnd(4)}  cover rgb(${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)})` +
      `  luma ${mu.toFixed(1)}  grain sd ${sd.toFixed(2)}  ${path}`);
  }
};
await sweep(13.0);
await sweep(18.6);
await sweep(20.4);
await b.close();
