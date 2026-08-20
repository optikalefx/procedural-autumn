// Replay the dry half of _layerShore gate by gate and count where it dies.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await p.goto('http://localhost:5178/?res=768');
await p.waitForFunction(() => window.__ready, null, { timeout: 180000 });

const out = await p.evaluate(async () => {
  const W = window.__world;
  const cs = await import('/src/vegetation/cover_scatter.js');
  const mu = await import('/src/core/MathUtils.js');
  const nz = await import('/src/core/Noise.js');
  const SF = cs.shoreField(W);
  const sc = new cs.CoverScatter(W, 20261018, { mul: 1 });
  const N = sc.noise;

  // fbm range, sampled over the world
  let lo = 9, hi = -9, sum = 0, cnt = 0;
  for (let i = 0; i < 40000; i++) {
    const x = (Math.random() * 2 - 1) * 1400, z = (Math.random() * 2 - 1) * 1400;
    const v = N.fbm(x * 0.042 - 88.3, z * 0.042 + 27.6, 2, 2.2, 0.5, 1);
    if (v < lo) lo = v; if (v > hi) hi = v; sum += v; cnt++;
  }
  const fbmRange = { lo: +lo.toFixed(3), hi: +hi.toFixed(3), mean: +(sum / cnt).toFixed(3) };

  const a = window.__anchorAt('river', 3);
  const c = { dry: 0, dampThin: 0, widthNeg: 0, members: 0, msdFar: 0, sedgeTry: 0, sedgeGround: 0,
              matTry: 0, matGround: 0, emitSedge: 0, emitMat: 0 };
  const sdHist = {};
  for (let k = 0; k < 60000; k++) {
    const x = a.x - 144 + Math.random() * 288, z = a.z - 144 + Math.random() * 288;
    const sd = SF.at(x, z);
    if (sd > 4.2) continue;
    if (sc._shoreGround(x, z, 0.60) < 0.10) continue;
    const depth = W.getWaterDepth(x, z);
    if (depth > 0.55 || depth > 0.04) continue;
    c.dry++;
    const bin = Math.floor(sd);
    sdHist[bin] = (sdHist[bin] || 0) + 1;
    const edge = N.fbm(x * 0.042 - 88.3, z * 0.042 + 27.6, 2, 2.2, 0.5, 1);
    const width = 1.5 + edge * 1.9;
    if (width <= 0.2) c.widthNeg++;
    const damp = mu.clamp01(1 - mu.smoothstep(width * 0.35, width, sd));
    if (damp < 0.06) { c.dampThin++; continue; }
    const q = 2.0;
    const ax = SF.at(x - q, z) - SF.at(x + q, z);
    const az = SF.at(x, z - q) - SF.at(x, z + q);
    const toWater = Math.atan2(az, ax);
    const members = 1 + ((Math.random() * (1.5 + damp * 4.5)) | 0);
    for (let m = 0; m < members; m++) {
      c.members++;
      const su = (Math.random() + Math.random() - 1) * 3.2;
      const sv = (Math.random() - 0.5) * 1.4;
      const mx = x - Math.sin(toWater) * su + Math.cos(toWater) * sv;
      const mz = z + Math.cos(toWater) * su + Math.sin(toWater) * sv;
      const msd = SF.at(mx, mz);
      if (msd > width * 1.25) { c.msdFar++; continue; }
      const mdamp = mu.clamp01(1 - mu.smoothstep(width * 0.35, width, msd));
      if (msd < 0.95 && Math.random() < 0.30 + mdamp * 0.55) {
        c.sedgeTry++;
        if (sc._shoreGround(mx, mz, 0.09) < 0.10) { c.sedgeGround++; continue; }
        c.emitSedge++;
      } else {
        c.matTry++;
        if (sc._shoreGround(mx, mz, 0.02) < 0.10) { c.matGround++; continue; }
        c.emitMat++;
      }
    }
  }
  return { fbmRange, c, sdHist };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
