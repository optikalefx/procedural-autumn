// One browser, one bake, one settle: render the `vehicle` framing under several
// shadow configurations so the cause of the missing cast shadow — and of the
// blue patch under the camper — can be isolated.
//
//   node tools/_scratch/vshadowtest.mjs --dir shots/fix/sh --res 768
//
// The camper is settled ONCE and then left alone, so the frames are directly
// comparable; only the named toggle changes between them.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const RES = arg('res', '768');
const DIR = arg('dir', 'shots/fix/sh');
const W = +arg('w', '1200'), H = +arg('h', '750');
const ONLY = arg('only', null)?.split(',');

// force: clamp the shadow extent to this many metres (0 = leave alone)
// off:   list of things to hide — 'contact' | 'tracks' | 'particles'
const ALL = [
  { name: 'a-h17-base', hour: 17.0 },
  { name: 'b-h12-base', hour: 12.0 },
  { name: 'c-h12-extent150', hour: 12.0, force: 150 },
  { name: 'd-h12-nocontact', hour: 12.0, off: ['contact'] },
  { name: 'e-h12-notracks', hour: 12.0, off: ['tracks'] },
  { name: 'f-h12-nocontact-notracks', hour: 12.0, off: ['contact', 'tracks'] },
  { name: 'g-h17-nocontact', hour: 17.0, off: ['contact'] },
  { name: 'h-h17-extent150', hour: 17.0, force: 150 },
  { name: 'i-h12-contactx3', hour: 12.0, boost: 3.0 },
  { name: 'j-dawn-base', hour: 7.4 },
  { name: 'k-dawn-nocontact', hour: 7.4, off: ['contact'] },
];
const CASES = ONLY ? ALL.filter((c) => ONLY.includes(c.name)) : ALL;

mkdirSync(resolve(DIR), { recursive: true });
await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

// ── pose once ───────────────────────────────────────────────────────────────
await page.evaluate(async () => {
  const e = window.__engine, wd = window.__world;
  window.__lighting.cycleSpeed = 0;
  if (window.__atmosphere) window.__atmosphere.params.cloudShadow = 0;
  window.__forceCamera = true;
  if (window.__settle) await window.__settle(240);
  const anchor = window.__cameraAnchors.vehicle();
  const yaw = anchor.yaw ?? 0, dist = 11, height = 2.6;
  const gx = anchor.x - Math.sin(yaw) * dist, gz = anchor.z - Math.cos(yaw) * dist;
  e.camera.fov = 44; e.camera.updateProjectionMatrix();
  e.camera.position.set(gx, wd.getHeight(gx, gz) + height, gz);
  e.camera.lookAt(anchor.x, wd.getHeight(anchor.x, anchor.z) + (anchor.lookY ?? 1.4), anchor.z);
  window.__shotCam = { gx, gz, ax: anchor.x, az: anchor.z, ly: anchor.lookY ?? 1.4, h: height };
});

for (const c of CASES) {
  const info = await page.evaluate(async ({ hour, force, off, boost }) => {
    const e = window.__engine, wd = window.__world, L = window.__lighting, sun = L.sun;
    const V = window.__systems?.vehicle;
    const CS = e.scene.getObjectByName('camperContactShadow');
    if (L.__origUpdate) { L.update = L.__origUpdate; L.__origUpdate = null; }
    if (V?.contactShadow) V.contactShadow.enabled = true;
    if (CS) CS.visible = true;
    if (V?.tracks?.meshes) for (const m of V.tracks.meshes) m.visible = true;
    if (V?.particles?.points) V.particles.points.visible = true;
    for (const o of off ?? []) {
      // Vehicle.update() rewrites CS.visible every frame from the wheel
      // count, so the system has to be disabled, not just the mesh hidden.
      if (o === 'contact') { if (V?.contactShadow) V.contactShadow.enabled = false; if (CS) CS.visible = false; }
      if (o === 'tracks' && V?.tracks?.meshes) for (const m of V.tracks.meshes) m.visible = false;
      if (o === 'particles' && V?.particles?.points) V.particles.points.visible = false;
    }
    L.hour = hour;
    // Hold the camera exactly where the pose put it.
    const S = window.__shotCam;
    e.camera.position.set(S.gx, wd.getHeight(S.gx, S.gz) + S.h, S.gz);
    e.camera.lookAt(S.ax, wd.getHeight(S.ax, S.az) + S.ly, S.az);
    if (force) {
      // Lighting.update() rewrites the extent and both biases every frame from
      // the camera altitude, so the override has to ride on the tail of it.
      L.__origUpdate = L.update;
      L.update = function (dt, f) {
        L.__origUpdate.call(this, dt, f);
        this._setShadowExtent(force);
        const tw = (force * 2) / this.preset.shadowMapSize;
        sun.shadow.normalBias = Math.min(Math.max(tw * 1.7, 0.12), 0.90);
        sun.shadow.bias = -0.00018 - tw * 0.0004;
      };
    }
    if (boost) {
      // uStrength is rewritten by Vehicle.update() every frame, so ride on it.
      const V2 = window.__systems.vehicle;
      if (!V2.__origCU) { V2.__origCU = V2.contactShadow.update.bind(V2.contactShadow); }
      V2.contactShadow.update = (x, z, h, g) => {
        V2.__origCU(x, z, h, g);
        V2.contactShadow.material.uniforms.uStrength.value = boost;
      };
    } else if (window.__systems.vehicle.__origCU) {
      window.__systems.vehicle.contactShadow.update = window.__systems.vehicle.__origCU;
      window.__systems.vehicle.__origCU = null;
    }
    await new Promise((r) => setTimeout(r, 450));
    return {
      hour: L.hour, extent: L.shadowExtent,
      normalBias: +sun.shadow.normalBias.toFixed(4),
      sunElevDeg: +(Math.asin(L.sunDir.y) * 57.2958).toFixed(1),
      contactVisible: CS ? CS.visible : null,
      contactStrength: CS ? +CS.material.uniforms.uStrength.value.toFixed(2) : null,
    };
  }, { hour: c.hour, force: c.force ?? 0, off: c.off ?? [], boost: c.boost ?? 0 });
  writeFileSync(resolve(DIR, c.name + '.png'), await page.screenshot({ type: 'png' }));
  console.log(c.name, JSON.stringify(info));
}
await browser.close();
