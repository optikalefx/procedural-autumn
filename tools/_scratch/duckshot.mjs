// Scratch: are there eight ducks on the dash, and do they read as ducks?
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1200, height: 700 } });
await p.goto((process.env.AUTUMN_URL || 'http://127.0.0.1:5205') + '/?res=768&car=adventurer', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await p.waitForFunction(() => !!window.__vehicle, null, { timeout: 30000 });
await p.evaluate(() => {
  const q = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport(q.x, q.z, q.yaw ?? 0.9);
  window.__lighting.hour = 15.5; window.__lighting.cycleSpeed = 0;
});
await p.waitForTimeout(1800);
await p.evaluate(async () => {
  const THREE = window.__THREE, e = window.__engine, v = window.__vehicle;
  // local (0.0, 0.85, 2.4) -> just in front of the windscreen, looking in
  const eye = new THREE.Vector3(0.30, 1.15, 2.35).applyQuaternion(v.quaternion).add(v.position);
  const aim = new THREE.Vector3(0.0, 0.72, 0.90).applyQuaternion(v.quaternion).add(v.position);
  e.camera.fov = 30; e.camera.updateProjectionMatrix();
  e.camera.position.copy(eye); e.camera.lookAt(aim);
  window.__forceCamera = true;
  if (window.__settle) await window.__settle(30);
});
await p.waitForTimeout(900);
await p.screenshot({ path: '/tmp/ducks.png' });
console.log('duck meshes:', await p.evaluate(() => {
  let n = 0;
  window.__vehicle.root.traverse((o) => { if (o.isMesh && /duck|beak/.test(o.name)) n++; });
  return n;
}));
await b.close();
