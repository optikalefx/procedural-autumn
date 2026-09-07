/**
 * The reported bug, in the running valley: a photograph of the river that
 * counted the moose standing behind the rocks.
 *
 * Teleports to each of the three moose sites, waits for one to stream in, then
 * for every big drawn rock near the animal builds TWO camera stations at the
 * same range and the same framing:
 *
 *   BEHIND  — on the far side of the rock from the moose, so the boulder is
 *             squarely between the lens and the animal.
 *   BESIDE  — the same distance out, swung round to a clear bearing.
 *
 * A correct gate answers "no moose" from the first and "moose" from the second.
 * Prints both verdicts through `detectSubjects` itself, plus the terrain
 * march's own answer, so a refusal caused by the ground is not read as a win.
 */
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5178';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
page.on('console', (m) => { if (/hunt|rock/i.test(m.text())) console.log('  page:', m.text()); });
await page.addInitScript(() => {
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
await page.goto(URL);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

const sites = await page.evaluate(() => {
  const S = window.__ctx.systems.wildlife.sites, K = window.__ctx.systems.wildlife.keys;
  const out = [];
  for (let i = 0; i < S.n; i++) if (K[S.spec[i]] === 'moose') out.push({ i, x: S.x[i], z: S.z[i] });
  return out;
});
console.log(`moose sites: ${sites.map((s) => `(${s.x.toFixed(0)}, ${s.z.toFixed(0)})`).join('  ')}`);

for (const site of sites) {
  // Streaming — wildlife sites, rock cells — follows the CAMERA, and the
  // camera does not follow the camper on a page that nobody is driving. So the
  // camper is teleported to keep the sim honest and the camera is placed by
  // hand, which is also how it has to be for the stations below.
  await page.evaluate((s) => {
    window.__forceCamera = true;
    window.__vehicleTeleport?.(s.x + 30, s.z + 30, 0);
    const c = window.__ctx;
    c.camera.position.set(s.x + 30, c.world.getHeight(s.x + 30, s.z + 30) + 1.7, s.z + 30);
    c.camera.lookAt(s.x, c.world.getHeight(s.x, s.z) + 1.5, s.z);
    c.camera.updateMatrixWorld(true);
  }, site);
  // Let the site wake and the rock cells stream in.
  await page.waitForTimeout(12000);

  const r = await page.evaluate(async (site) => {
    const M = await import('/src/game/hunt_detect.js'), I = M._internals;
    const c = window.__ctx, e = window.__engine, T = window.__THREE;
    window.__forceCamera = true;
    e.camera.fov = 50; e.camera.updateProjectionMatrix();

    // The animal, and its half-height, exactly as `mammals` reads them.
    const wl = c.systems.wildlife;
    const pool = wl.pool.moose;
    // The NEAREST awake moose, and only if it is actually here: `debugSpawn`
    // pins its group, so the animal left behind at the previous site is still
    // active 2 km away and was being measured against rock that is not
    // streamed anywhere near it.
    const near = () => {
      let best = null, bd = 150 * 150;
      for (const per of pool) for (const m of per) {
        if (!m.active || !m.mesh) continue;
        const d = (m.mesh.position.x - c.camera.position.x) ** 2
                + (m.mesh.position.z - c.camera.position.z) ** 2;
        if (d < bd) { bd = d; best = m; }
      }
      return best;
    };
    let a = near();
    if (!a) {
      // Nothing woke on its own: put one down at the site and pin it. Same
      // record, same seed — `debugSpawn` reuses the nearest sleeping site.
      const sp = wl.debugSpawn('moose', { x: site.x, z: site.z });
      a = near();
      if (!a) return { site, err: `no moose awake (debugSpawn ${JSON.stringify(sp)}, `
        + `cam ${c.camera.position.toArray().map((v) => v.toFixed(0)).join()})` };
    }
    const r = I.meshHeight(a.mesh);              // also writes the mid-point
    const P = new T.Vector3(a.mesh.position.x, a.mesh.position.y + r, a.mesh.position.z);

    const rocks = c.systems.rocks;
    const hits = rocks.drawnRocksAround(P.x, P.z, 60, 0, []);
    const big = hits
      .map((inst) => ({ inst, reach: rocks.reachOf(inst), top: rocks.topOf(inst),
                        d: Math.hypot(inst.x - P.x, inst.z - P.z) }))
      // Tall enough to hide a moose's shoulder, and clear of the animal itself.
      .filter((h) => h.top - c.world.getHeight(h.inst.x, h.inst.z) > 1.6
                  && h.d > h.reach + 2 && h.d < 40)
      .sort((a, b) => b.top - a.top);
    if (!big.length) {
      return { site, err: `no rock big enough near the moose (${hits.length} drawn within 60 m; `
        + `moose at ${P.x.toFixed(0)},${P.z.toFixed(0)}; cam ${c.camera.position.x.toFixed(0)},`
        + `${c.camera.position.z.toFixed(0)}; ${rocks.cells.size} live cells)` };
    }

    const look = (x, z) => {
      const y = c.world.getHeight(x, z) + 1.7;
      if (!Number.isFinite(y)) return { err: `ground at ${x.toFixed(0)},${z.toFixed(0)} is ${y}` };
      e.camera.position.set(x, y, z);
      e.camera.lookAt(P); e.camera.updateMatrixWorld(true);
      const f = I.frameOf(c);
      return {
        at: `${x.toFixed(0)},${y.toFixed(1)},${z.toFixed(0)}`,
        depth: +e.camera.position.distanceTo(P).toFixed(1),
        share: +I.share(f, P, r, I.MIN_SHARE, Infinity).toFixed(4),
        ground: I.clearLine(f.world, f.eye, P, r),
        rock: I.clearRocks(f.rocks, f.eye, P, r),
        moose: M.detectSubjects(c).includes('moose'),
      };
    };

    const rows = [];
    for (const h of big.slice(0, 3)) {
      // BEHIND: on the far side of the rock, one rock-radius plus a little out.
      const ux = (h.inst.x - P.x) / h.d, uz = (h.inst.z - P.z) / h.d;
      const stand = h.d + h.reach + 6;
      const behind = look(P.x + ux * stand, P.z + uz * stand);
      // BESIDE: same range, swung 90 deg.
      const beside = look(P.x - uz * stand, P.z + ux * stand);
      rows.push({ top: +(h.top).toFixed(2), reach: +h.reach.toFixed(2),
                  d: +h.d.toFixed(1), stand: +stand.toFixed(1), behind, beside });
    }
    return { site, r: +r.toFixed(2), rocks: hits.length, rows };
  }, site);

  if (r.err) { console.log(`site ${r.site.i}: ${r.err}`); continue; }
  console.log(`\nsite ${r.site.i}: moose half-height ${r.r} m, ${r.rocks} drawn rocks within 60 m`);
  for (const row of r.rows) {
    const f = (v) => (v.err ? v.err : `at ${v.at} d ${v.depth} share ${String(v.share).padEnd(6)} ground ${v.ground ? 'clear' : 'BLOCKED'} `
      + `rock ${v.rock ? 'clear' : 'BLOCKED'} -> ${v.moose ? 'MOOSE' : 'nothing'}`);
    console.log(`  rock top ${row.top} reach ${row.reach} at ${row.d} m; stand-off ${row.stand} m`);
    console.log(`    behind: ${f(row.behind)}`);
    console.log(`    beside: ${f(row.beside)}`);
  }
}
await browser.close();
