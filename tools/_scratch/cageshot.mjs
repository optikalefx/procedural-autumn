// Scratch: frame the Adventurer's sport bar from the angles a bad joint shows at.
//
//   node tools/_scratch/cageshot.mjs /tmp/cage
//
// Written to chase "one bar in the back is misaligned", which is not a thing
// you can reason out of a screenshot of an all-yellow cage. The way to find it
// is to give every member of the cage its own material key for one run
// (crimson legs / drum rails / olive down-tubes / orange hoop / lensTail tie /
// chrome brace), shoot these four framings, and read it straight off. Two
// members were wrong, not one.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const DIR = process.argv[2] || '/tmp/cage';
mkdirSync(DIR, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1300, height: 850 } });
p.on('pageerror', (e) => console.log('ERR', String(e)));
await p.goto((process.env.AUTUMN_URL || 'http://127.0.0.1:5205') + '/?res=768&car=adventurer', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await p.waitForFunction(() => !!window.__vehicle, null, { timeout: 30000 });
await p.evaluate(() => {
  const q = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport(q.x, q.z, q.yaw ?? 0.9);
  window.__lighting.hour = 13.0; window.__lighting.cycleSpeed = 0;
});
await p.waitForTimeout(1800);
// local-space eye/aim pairs, in the vehicle's own frame
const VIEWS = {
  rearhigh: { eye: [-1.5, 3.2, -4.2], aim: [0, 1.0, -0.6] },
  rearleft: { eye: [-3.6, 2.0, -3.2], aim: [0, 1.0, -0.4] },
  sideL:    { eye: [-4.6, 1.5, -0.6], aim: [0, 1.05, -0.7] },
  joint:    { eye: [-1.9, 1.9, -2.3], aim: [-0.81, 1.24, -0.62] },
  topdown:  { eye: [0.2, 4.6, -3.4], aim: [0, 0.9, -0.5] },
};
for (const [name, v] of Object.entries(VIEWS)) {
  await p.evaluate(async ({ v }) => {
    const THREE = window.__THREE, e = window.__engine, veh = window.__vehicle;
    const eye = new THREE.Vector3(...v.eye).applyQuaternion(veh.quaternion).add(veh.position);
    const aim = new THREE.Vector3(...v.aim).applyQuaternion(veh.quaternion).add(veh.position);
    e.camera.fov = 40; e.camera.updateProjectionMatrix();
    e.camera.position.copy(eye); e.camera.lookAt(aim);
    window.__forceCamera = true;
    if (window.__settle) await window.__settle(30);
  }, { v });
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${DIR}/${name}.png` });
  console.log('shot', name);
}
await b.close();
