// Frame the nearest shrubDark exactly as coverframe.sh does, then raycast a
// screen point and list what is under it. Diagnostic only.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const nx = Number(process.argv[2] ?? 0.20);
const ny = Number(process.argv[3] ?? -0.40);
const POS = (process.argv[4] || '').split(',').map(Number);
const LOOK = (process.argv[5] || '').split(',').map(Number);

await acquire('cover-pick');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('console', (m) => { if (m.text().startsWith('PICK')) console.log(m.text()); });
await page.goto('http://localhost:5178/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
await page.waitForFunction(() => window.__settle === undefined || window.__ready === true);
await new Promise(r => setTimeout(r, 6000));
await page.evaluate(({ nx, ny, POS, LOOK }) => {
  const T = window.__THREE, gc = window.__systems.groundCover, cam = window.__engine.camera;
  cam.position.set(POS[0], POS[1], POS[2]);
  cam.lookAt(LOOK[0], LOOK[1], LOOK[2]);
  cam.updateMatrixWorld(true);
  for (let i = 0; i < 90; i++) gc.update(0.016, i * 0.016);
  const rc = new T.Raycaster();
  rc.setFromCamera(new T.Vector2(nx, ny), cam);
  const hits = rc.intersectObjects(window.__engine.scene.children, true);
  console.log('PICK ' + hits.slice(0, 8).map((x) =>
    `${x.object.name || x.object.type}@${x.distance.toFixed(2)}`).join(' | '));
}, { nx, ny, POS, LOOK });
await browser.close();
