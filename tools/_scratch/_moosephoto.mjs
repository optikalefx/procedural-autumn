import { chromium } from 'playwright';
const BASE = process.env.AUTUMN_URL || 'http://localhost:5178';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
p.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log('[page]', m.text().slice(0, 200)); });
await p.goto(`${BASE}/?seed=20261018&car=camper`, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
console.log(JSON.stringify(await p.evaluate(async () => {
  const S = window.__systems, W = window.__world, e = window.__engine, T = window.__THREE;
  S.hud?.journal?.close();
  const j = S.hud?.journal; for (let i = 0; i < 200 && j?._visible; i++) j.update(0.05);
  S.wildlife.debugThreat(1e5, 1e5, 0);
  S.wildlife.debugClear();
  S.wildlife.debugSpawn('moose', { dist: 22, clear: 9 });
  const a = S.wildlife.pool.moose.flat().find((m) => m.active);
  const { _internals, detectSubjects } = await import('/src/game/hunt_detect.js');
  const out = [];
  for (const d of [10, 16, 22, 30, 45]) {
    const cx = a.brain.pos.x + d, cz = a.brain.pos.z;
    e.camera.position.set(cx, W.getHeight(cx, cz) + 1.7, cz);
    e.camera.lookAt(new T.Vector3(a.brain.pos.x, a.brain.pos.y + 1.4, a.brain.pos.z));
    window.__forceCamera = true;
    e.camera.updateMatrixWorld(true);
    const f = _internals.frameOf(window.__ctx);
    const r = _internals.meshHeight(a.mesh);
    const bb = a.mesh.geometry.boundingBox;
    const sy = Math.abs(a.mesh.scale?.y) || 1;
    const pos = new T.Vector3(a.mesh.position.x,
      a.mesh.position.y + (bb.min.y + bb.max.y) * 0.5 * sy, a.mesh.position.z);
    out.push({
      d, halfH: +r.toFixed(3), fov: e.camera.fov,
      share: +(_internals.share(f, pos, r, 0, Infinity) || 0).toFixed(4),
      passShare: !!_internals.share(f, pos, r, _internals.MIN_SHARE, Infinity),
      visible: _internals.visible(f, pos, r),
      clearLine: _internals.clearLine(f.world, f.eye, pos, r),
      subjects: detectSubjects(window.__ctx),
    });
  }
  return {
    variant: a.rig?.proto?.variant?.name ?? null,
    meshScaleY: a.mesh?.scale?.y, meshPos: [+a.mesh.position.x.toFixed(2), +a.mesh.position.y.toFixed(2)],
    bboxY: a.mesh?.geometry?.boundingBox ? [+a.mesh.geometry.boundingBox.min.y.toFixed(3), +a.mesh.geometry.boundingBox.max.y.toFixed(3)] : null,
    MIN_SHARE: _internals.MIN_SHARE, out,
  };
}), null, 1));
await b.close();
