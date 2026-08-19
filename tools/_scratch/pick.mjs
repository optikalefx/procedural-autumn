// Frame the nearest shrubDark exactly as coverframe.sh does, then raycast a
// screen point and list what is under it. Diagnostic only.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const nx = Number(process.argv[2] ?? 0.20);
const ny = Number(process.argv[3] ?? -0.40);

await acquire('cover-pick');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('console', (m) => { if (m.text().startsWith('PICK')) console.log(m.text()); });
await page.goto('http://localhost:5178/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
await page.evaluate(({ nx, ny }) => {
  const T = window.__THREE, gc = window.__systems.groundCover, cam = window.__engine.camera;
  const m = new T.Matrix4(), p = new T.Vector3();
  let best = null, bd = 1e9;
  for (const mesh of gc.meshes) {
    if (!mesh.count || mesh.name.indexOf('cover_shrubDark_') !== 0) continue;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m); p.setFromMatrixPosition(m);
      const d = p.distanceTo(cam.position);
      if (d < bd) { bd = d; best = p.clone(); }
    }
  }
  const sd = window.__lighting.sunDir.clone();
  const h = new T.Vector3(sd.x, 0, sd.z).normalize();
  cam.position.set(best.x + h.x * 2.6, best.y + 1.1, best.z + h.z * 2.6);
  cam.lookAt(best.x, best.y + 0.45, best.z);
  cam.updateMatrixWorld(true);
  const rc = new T.Raycaster();
  rc.setFromCamera(new T.Vector2(nx, ny), cam);
  const hits = rc.intersectObjects(window.__engine.scene.children, true);
  console.log('PICK ' + hits.slice(0, 8).map((x) =>
    `${x.object.name || x.object.type}@${x.distance.toFixed(2)}`).join(' | '));
}, { nx, ny });
await browser.close();
