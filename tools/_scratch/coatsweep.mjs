import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('coatsweep');
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178');
const OUT = process.argv[2];
const HOUR = parseFloat(process.argv[3] || '12');
const CANDS = [
  ['a-now',  0x664838, 0x9c7d61, 0x2b1d15],
  ['b-1.35', 0x87604c, 0xbb9a79, 0x3a2820],
  ['c-1.7',  0xa2755d, 0xd0ae8a, 0x48332a],
  ['d-2.1',  0xbe8b70, 0xe3c39f, 0x573f34],
];
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 460, height: 340 } });
page.on('pageerror', e => console.log('ERR', String(e)));
await page.goto(URL + '?res=640', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(async (HOUR) => {
  const e = window.__engine, W = window.__world, wl = window.__systems.wildlife;
  window.__lighting.hour = HOUR; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  const anchor = window.__cameraAnchors.meadow();
  e.camera.position.set(anchor.x, W.getHeight(anchor.x, anchor.z) + 2, anchor.z);
  e.camera.rotation.set(0, anchor.yaw ?? 0, 0, 'YXZ');
  wl.debugClear(); wl.debugThreat(null);
  wl.debugSpawn('bear', { dist: 16, clear: 9, count: 1 });
  let A = null;
  for (const per of wl.pool.bear) for (const a of per) if (a.active) A = A ?? a;
  window.__A = A; A.brain.state = 0; A.brain.timer = 1e6;
  document.querySelectorAll('#hud, .hud, canvas + div').forEach(n => { if (n.tagName !== 'CANVAS') n.style.display = 'none'; });
  e.stop(); e.clock.getDelta = () => 1/60;
  window.__place = () => {
    const p = A.brain.pos, h = A.rig.proto.height * A.scale, D = 4.2;
    const yaw = A.brain.heading + Math.PI/2;
    e.camera.position.set(p.x + Math.sin(yaw)*D*Math.cos(0.2), p.y + h*0.5 + D*Math.sin(0.2), p.z + Math.cos(yaw)*D*Math.cos(0.2));
    e.camera.lookAt(p.x, p.y + h*0.5, p.z);
    window.__postfx?.setFocus?.(D);
  };
  for (let i=0;i<50;i++){ window.__place(); e._loop(); }
  e.clock.getDelta = () => 0;
}, HOUR);
for (const [name, coat, pale, dark] of CANDS) {
  if (typeof pale !== 'number') continue;
  await page.evaluate(([coat, pale, dark]) => {
    const u = window.__A.rig.mesh.material.userData.uniforms;
    u.uCoat.value.setHex(coat); u.uPale.value.setHex(pale); u.uDark.value.setHex(dark);
    for (let i=0;i<2;i++){ window.__place(); window.__engine._loop(); }
  }, [coat, pale, dark]);
  await page.screenshot({ path: `${OUT}-${name}.png` });
  console.log('wrote', name);
}
await browser.close();
