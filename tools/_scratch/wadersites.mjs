// Where can a wader actually stand? Replays _findWade's own gates over a grid
// of the whole map and clusters the hits, per species.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('probe');

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});

await p.goto(process.env.AUTUMN_URL || 'http://localhost:5199');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });

const out = await p.evaluate(async (STEP) => {
  const ctx = window.__ctx;
  const W = ctx.world;
  const tb = ctx.systems.wildlife.treeBirds;
  const SPECIES = (await import('/src/wildlife/birds/tree_birds.js')).TREE_BIRD_SPECIES
    .filter((s) => s.habitat === 'water');

  // Map extent
  const half = W.half ?? W.size / 2 ?? 2048;
  const hits = {};
  const hy = {};
  for (const S of SPECIES) hits[S.key] = [];

  let inBounds = 0, wetCells = 0;
  for (let z = -half; z <= half; z += STEP) {
    for (let x = -half; x <= half; x += STEP) {
      if (!W.isInBounds(x, z)) continue;
      inBounds++;
      const h = W.getHydro(x, z, hy);
      if (h.sdf < 1.2 || h.wet < 0.5) continue;
      wetCells++;
      const d = W.getWaterDepth(x, z);
      for (const S of SPECIES) {
        if (d < S.wade[0] || d > S.wade[1]) continue;
        if (S.minSpan && h.span < S.minSpan) continue;
        hits[S.key].push({ x, z, d: +d.toFixed(2), span: +h.span.toFixed(1), sdf: +h.sdf.toFixed(1) });
      }
    }
  }

  // Cluster hits on a coarse grid so we report places, not thousands of points.
  const cluster = (arr, CELL) => {
    const m = new Map();
    for (const p of arr) {
      const k = `${Math.round(p.x / CELL)},${Math.round(p.z / CELL)}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return [...m.values()]
      .map((g) => ({
        n: g.length,
        x: Math.round(g.reduce((s, q) => s + q.x, 0) / g.length),
        z: Math.round(g.reduce((s, q) => s + q.z, 0) / g.length),
        span: +(g.reduce((s, q) => s + q.span, 0) / g.length).toFixed(1),
      }))
      .sort((a, b) => b.n - a.n);
  };

  // Does the live system actually place them? Step it by hand — the sim clock
  // barely advances under a headless harness, so waiting on wall time returns
  // nothing.
  const camStart = { x: ctx.camera.position.x, z: ctx.camera.position.z };
  for (let i = 0; i < 200; i++) tb.update(1.0, ctx.camera, null);
  const live = tb.debugList();

  return {
    mapHalf: half, gridStep: STEP, sampledInBounds: inBounds, standingWaterCells: wetCells,
    camStart,
    perSpecies: Object.fromEntries(SPECIES.map((S) => [S.key, {
      wade: S.wade, minSpan: S.minSpan ?? null,
      totalSites: hits[S.key].length,
      topClusters: cluster(hits[S.key], 120).slice(0, 8),
    }])),
    liveAfter200Steps: live,
    stats: tb.stats,
  };
}, 16);

console.log(JSON.stringify(out, null, 1));
await b.close();
