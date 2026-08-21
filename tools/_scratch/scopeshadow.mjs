#!/usr/bin/env node
/**
 * scopeshadow — does the telescope actually cast?
 *
 * The round-2 critic measured zero ground darkening under either variant at
 * every angle, while the chair three metres away measures −45%. That is either
 * a flag that is not set, a shadow camera that does not reach, or a critic
 * measuring the wrong pixels. This asks the scene directly rather than
 * inferring it from a PNG: it reports `castShadow` on every mesh of the
 * telescope AND of a chair placed by the same code path, the renderer's shadow
 * settings, and the directional light's shadow-camera bounds against the
 * prop's own world position.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const release = await acquire('scopeshadow');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {},
               set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1600);
await page.keyboard.down('Space'); await page.waitForTimeout(700); await page.keyboard.up('Space');
await page.waitForTimeout(2000);

const out = await page.evaluate(async () => {
  const THREE = window.__THREE;
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  if (!s) return { error: 'no site' };
  const mod = await import('/src/camp/camp_telescope.js');
  const site = await import('/src/camp/camp_site.js');
  const { mulberry32 } = await import('/src/core/MathUtils.js');
  const camp = (window.__camp.camps ?? [window.__camp])[(window.__camp.camps ?? [0]).length - 1];
  const props = camp.props ?? window.__camp.props;
  const chairs = props.filter((p) => p.item.kind === 'chair');
  let ax = 0, az = 0;
  for (const c of chairs) { ax += c.item.x - s.x; az += c.item.z - s.z; }
  const seat = chairs.length ? Math.atan2(az, ax) : 0;
  const R = (camp.site ?? window.__camp.site)?.radius ?? 5.8;
  const a = seat + 1.7, r = R * 0.50;
  const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
  const y = window.__world.getHeight(x, z);
  const g = mod.buildTelescope(mulberry32(0x51ed270b), { variant: 'reflector', wear: 0.45 });
  g.position.set(x, y, z);
  const q = new THREE.Quaternion();
  site.standOn(window.__world, x, z, Math.atan2(s.x - x, s.z - z), 0.22, q);
  g.quaternion.copy(q);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  (camp.root ?? window.__camp.root).add(g);
  props.push({ obj: g, item: { kind: 'telescope', x, y, z, yaw: 0 }, delay: 0 });

  const meshes = (o) => { const out = []; o.traverse((m) => { if (m.isMesh) out.push(m); }); return out; };
  const describe = (o, label) => meshes(o).map((m) => ({
    label, name: m.name, cast: m.castShadow, recv: m.receiveShadow,
    visible: m.visible, frustumCulled: m.frustumCulled,
    matShadowSide: m.material?.shadowSide ?? null,
    matTransparent: !!m.material?.transparent,
    layers: m.layers.mask,
  }));

  const rows = [...describe(g, 'telescope')];
  if (chairs[0]) rows.push(...describe(chairs[0].obj, 'chair'));

  // The lights that can cast, and whether the prop is inside their shadow camera.
  const lights = [];
  window.__engine.scene.traverse((o) => {
    if (!o.isLight) return;
    const e = { type: o.type, castShadow: o.castShadow, intensity: o.intensity };
    if (o.shadow?.camera) {
      const c = o.shadow.camera;
      e.mapSize = `${o.shadow.mapSize.width}x${o.shadow.mapSize.height}`;
      e.bias = o.shadow.bias;
      e.normalBias = o.shadow.normalBias;
      if (c.isOrthographicCamera) {
        o.updateMatrixWorld(true); c.updateMatrixWorld(true); c.updateProjectionMatrix();
        const p = new THREE.Vector3(x, y + 0.7, z).applyMatrix4(c.matrixWorldInverse);
        e.ortho = { l: c.left, r: c.right, t: c.top, b: c.bottom, n: c.near, f: c.far };
        e.propInLightSpace = { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) };
        e.insideXY = p.x > c.left && p.x < c.right && p.y > c.bottom && p.y < c.top;
        e.insideZ = -p.z > c.near && -p.z < c.far;
      }
    }
    lights.push(e);
  });

  return {
    renderer: {
      shadowsEnabled: window.__engine.renderer.shadowMap.enabled,
      type: window.__engine.renderer.shadowMap.type,
    },
    telescopeMeshes: rows.filter((r) => r.label === 'telescope'),
    chairMeshes: rows.filter((r) => r.label === 'chair'),
    lights,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
release();
