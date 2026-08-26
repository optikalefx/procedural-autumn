/**
 * Boat launch gate acceptance, before/after, over the whole map.
 *
 * Sweeps every launch-band point (the shore band the pointer path actually
 * offers a boat in) and reports what the gate says for each hull, split by
 * lake vs river. The lake numbers are the regression guard: they must not move.
 *
 *   node tools/_scratch/gatecheck.mjs
 */
import { chromium } from 'playwright';
import { materialiseBase } from './_baseof.mjs';
const BASE = materialiseBase('src/boat/boat_site.js', 'boat_site');
console.log('baseline:', BASE.ref.slice(0,8));

const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5263';
const SEED = process.env.SEED || '20261018';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 500, height: 400 } });
p.on('pageerror', e => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState:3, url, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
        set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype; Object.assign(window.WebSocket, RealWS);
});
console.log('booting…');
await p.goto(`${URL}/?seed=${SEED}&car=camper&res=768`, { timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
const out = await p.evaluate(async ({BASEURL}) => {
  const w = window.__world;
  const { validateLaunch, shoreSnap, MAX_RIVER } = await import('/src/boat/boat_site.js');
  const BASEFN = (await import(BASEURL)).validateLaunch;
  const KDEPTH = 0.11 + 0.15, CDEPTH = 0.15 + 0.15;
  const lake = { kayak: 0, canoe: 0, base: 0, n: 0 }, river = { kayak: 0, canoe: 0, base: 0, n: 0 };
  let lakeVerdictMismatch = 0, lakePoseMismatch = 0; const lakeReasons = {};
  const reasons = {};
  for (let x = -1200; x <= 1200; x += 16) for (let z = -1200; z <= 1200; z += 16) {
    if (!w.isInBounds(x, z)) continue;
    const s0 = w.getHydro(x, z).sdf;
    if (s0 < -6 || s0 > 2) continue;                     // the launch band
    const s = shoreSnap(w, x, z);
    const isRiver = w.getRiver(s.x, s.z) > MAX_RIVER;
    const k = validateLaunch(w, x, z, null, 'kayak', KDEPTH);
    const c = validateLaunch(w, x, z, null, 'canoe', CDEPTH);
    const base = BASEFN(w, x, z, null);
    const bucket = isRiver ? river : lake;
    bucket.n++;
    if (k.ok) bucket.kayak++;
    if (c.ok) bucket.canoe++;
    if (base.ok) bucket.base++;
    // Lake regression: the new gate must agree with the base commit's, point
    // for point, on standing water — same verdict AND the same pose.
    if (!isRiver) {
      if (base.ok !== k.ok) lakeVerdictMismatch++;
      else if (base.ok && (Math.hypot(base.x - k.x, base.z - k.z) > 1e-6
                        || Math.abs(base.heading - k.heading) > 1e-6)) lakePoseMismatch++;
      if (base.ok !== k.ok && base.reason !== k.reason) lakeReasons[`${base.reason} -> ${k.reason}`] =
        (lakeReasons[`${base.reason} -> ${k.reason}`] || 0) + 1;
    }
    if (isRiver && !k.ok) reasons[k.reason] = (reasons[k.reason] || 0) + 1;
  }
  const pct = (a, b2) => +(a / Math.max(1, b2)).toFixed(3);
  return {
    lake: { points: lake.n, kayakAccepted: pct(lake.kayak, lake.n),
            canoeAccepted: pct(lake.canoe, lake.n), baseAccepted: pct(lake.base, lake.n) },
    lakeVerdictMismatch, lakePoseMismatch, lakeReasons,
    river: { points: river.n, kayakAccepted: pct(river.kayak, river.n),
             canoeAccepted: pct(river.canoe, river.n), baseAccepted: pct(river.base, river.n) },
    riverRefusalReasons: reasons,
  };
}, {BASEURL:BASE.url});
console.log(JSON.stringify(out, null, 1));
await b.close();
