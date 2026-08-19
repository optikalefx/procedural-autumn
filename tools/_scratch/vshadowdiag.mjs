// Why does the camper cast no shadow in the `vehicle` view?
// Reproduces the shot.mjs vehicle framing, then reports the shadow-camera
// state, whether the camper enters the shadow pass, and where its bbox lands
// in the shadow camera's clip volume.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const RES = arg('res', '768');
const HOUR = parseFloat(arg('hour', '17.0'));
await acquire('probe');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const out = await page.evaluate(async (HOUR) => {
  const THREE = window.__THREE, e = window.__engine, wd = window.__world;
  const api = window.__cameraAnchors || {};
  window.__lighting.hour = HOUR;
  window.__lighting.cycleSpeed = 0;
  const anchor = (api.vehicle || api.vista)();
  const yaw = anchor.yaw ?? 0, dist = 11, height = 2.6;
  const gx = anchor.x - Math.sin(yaw) * dist, gz = anchor.z - Math.cos(yaw) * dist;
  const gy = wd.getHeight(gx, gz) + height;
  e.camera.fov = 44; e.camera.updateProjectionMatrix();
  e.camera.position.set(gx, gy, gz);
  e.camera.lookAt(anchor.x, wd.getHeight(anchor.x, anchor.z) + (anchor.lookY ?? 1.4), anchor.z);
  window.__forceCamera = true;
  if (window.__settle) await window.__settle(120);

  // instrument the shadow pass
  const seen = {};
  e.scene.traverse(o => {
    if (!(o.isMesh || o.isInstancedMesh)) return;
    let p = o, root = o; while (p.parent && p.parent !== e.scene) { p = p.parent; }
    root = p.name || p.type;
    o.onBeforeShadow = function () { seen[root] = (seen[root] || 0) + 1; };
  });
  await new Promise(r => setTimeout(r, 400));

  const L = window.__lighting, sun = L.sun;
  const sc = sun.shadow.camera;
  const veh = window.__ctx?.systems?.vehicle ?? null;
  const rig = e.scene.getObjectByName('vehicleRig');
  const box = new THREE.Box3();
  const casters = [];
  if (rig) {
    rig.updateMatrixWorld(true);
    box.setFromObject(rig);
    rig.traverse(o => { if (o.isMesh) casters.push([o.name, o.castShadow, o.visible, o.frustumCulled]); });
  }
  // clip-space extent of the camper bbox in the shadow camera
  sc.updateMatrixWorld(true); sc.updateProjectionMatrix();
  const vp = new THREE.Matrix4().multiplyMatrices(sc.projectionMatrix, sc.matrixWorldInverse);
  const clip = { x: [1e9, -1e9], y: [1e9, -1e9], z: [1e9, -1e9] };
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    v.applyMatrix4(vp);
    clip.x[0] = Math.min(clip.x[0], v.x); clip.x[1] = Math.max(clip.x[1], v.x);
    clip.y[0] = Math.min(clip.y[0], v.y); clip.y[1] = Math.max(clip.y[1], v.y);
    clip.z[0] = Math.min(clip.z[0], v.z); clip.z[1] = Math.max(clip.z[1], v.z);
  }
  // ground under the camper
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const gh = wd.getHeight(cx, cz);

  // wheel contact report
  let wheels = null;
  if (veh?.wheels) wheels = veh.wheels.map(w => ({
    grounded: w.grounded, y: +w.pos.y.toFixed(3),
    ground: +wd.getHeight(w.pos.x, w.pos.z).toFixed(3),
    clear: +(w.pos.y - 0.44 - wd.getHeight(w.pos.x, w.pos.z)).toFixed(3),
  }));

  return {
    hour: L.hour,
    camY: +e.camera.position.y.toFixed(2),
    groundAtCam: +wd.getHeight(gx, gz).toFixed(2),
    shadowExtent: L.shadowExtent,
    mapSize: sun.shadow.mapSize.width,
    texelWorld: +((L.shadowExtent * 2) / sun.shadow.mapSize.width).toFixed(4),
    normalBias: +sun.shadow.normalBias.toFixed(4),
    bias: sun.shadow.bias,
    intensity: sun.shadow.intensity,
    sunCastShadow: sun.castShadow,
    sunIntensity: +sun.intensity.toFixed(3),
    sunDir: [+L.sunDir.x.toFixed(3), +L.sunDir.y.toFixed(3), +L.sunDir.z.toFixed(3)],
    sunPos: [+sun.position.x.toFixed(1), +sun.position.y.toFixed(1), +sun.position.z.toFixed(1)],
    target: [+sun.target.position.x.toFixed(1), +sun.target.position.y.toFixed(1), +sun.target.position.z.toFixed(1)],
    scNear: sc.near, scFar: sc.far, scL: sc.left, scR: sc.right, scT: sc.top, scB: sc.bottom,
    camperBox: { min: box.min.toArray().map(n => +n.toFixed(2)), max: box.max.toArray().map(n => +n.toFixed(2)) },
    groundUnderCamper: +gh.toFixed(2),
    clip,
    casters: casters.length, castersOff: casters.filter(c => !c[1]).map(c => c[0]),
    shadowPass: seen,
    wheels,
  };
}, HOUR);
await browser.close();
console.log(JSON.stringify(out, null, 1));
