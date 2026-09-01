// One posed capture of the nineteenth line, standing in the timber.
//   AUTUMN_URL=http://127.0.0.1:5178 node tools/_scratch/bfshot.mjs --out /tmp/bf.png --dist 40 --fov 24
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
await acquire('bfshot');

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: +arg('w', 1280), height: +arg('h', 720) } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
  Object.assign(window.WebSocket, R);
});
await p.goto((process.env.AUTUMN_URL || 'http://127.0.0.1:5178') + '?car=camper');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const info = await p.evaluate(async (o) => {
  const THREE = window.__THREE, e = window.__engine, wd = window.__world;
  const { HUNT_SHEET } = await import('/src/game/hunt_items.js');
  const hunt = window.__hunt;
  hunt.reset(); for (const it of HUNT_SHEET) hunt.award(it.id);

  // Somewhere deep and wet. The forest anchor is scored on the tree field, and
  // `Bigfoot._trySpawn` asks the same field at the camera, so the two agree.
  const a = window.__anchorAt('forest', o.anchor);
  const pos = new THREE.Vector3(a.x, wd.getHeight(a.x, a.z) + 1.75, a.z);
  e.camera.position.copy(pos);
  e.camera.lookAt(pos.x + Math.sin(a.yaw ?? 0) * 50, pos.y, pos.z + Math.cos(a.yaw ?? 0) * 50);
  window.__forceCamera = true;
  window.dispatchEvent(new Event('resize'));

  const bf = window.__ctx.systems.wildlife.bigfoot;
  bf.armed = true;
  const at = bf.debugSpawn(e.camera);
  if (!at) return { err: 'no spawn', moisture: wd.getMoisture(pos.x, pos.z) };

  // Stand off at the range asked for, on the bearing he was placed on, and put
  // the lens on him. `_look`/`_moving` are driven by hand so the capture is of
  // a NAMED pose rather than of whatever frame the state machine was on.
  const ang = Math.atan2(pos.x - bf.pos.x, pos.z - bf.pos.z);
  const cx = bf.pos.x + Math.sin(ang) * o.dist, cz = bf.pos.z + Math.cos(ang) * o.dist;
  e.camera.position.set(cx, wd.getHeight(cx, cz) + 1.75, cz);
  e.camera.fov = o.fov;
  e.camera.updateProjectionMatrix();
  e.camera.lookAt(bf.pos.x, bf.pos.y + 1.15, bf.pos.z);
  bf.state = o.state;
  bf._moving = o.moving; bf._look = o.look;
  bf.rig.update(0.4, o.moving, o.look);
  bf.rig.place(bf.pos, bf.heading, wd, 1);

  if (window.__settleStable) await window.__settleStable();
  else await window.__settle(90);

  // …and freeze, so the settle's frames have not walked him out of the shot.
  bf.state = o.state; bf._moving = o.moving; bf._look = o.look;
  bf.rig.update(0.0001, o.moving, o.look);
  bf.rig.place(bf.pos, bf.heading, wd, 1);
  window.__ctx.systems.wildlife._frozen = true;
  await window.__settle(2);

  const { detectSubjects } = await import('/src/game/hunt_detect.js');
  return {
    variant: at.variant, dist: o.dist, fov: o.fov,
    moisture: +wd.getMoisture(bf.pos.x, bf.pos.z).toFixed(2),
    counts: detectSubjects(window.__ctx).includes('bigfoot'),
  };
}, {
  dist: +arg('dist', 40), fov: +arg('fov', 24), anchor: +arg('anchor', 0),
  state: +arg('state', 0), moving: +arg('moving', 0), look: +arg('look', 0),
});
console.log(JSON.stringify(info));
await p.screenshot({ path: arg('out', '/tmp/bf.png') });
await b.close();
