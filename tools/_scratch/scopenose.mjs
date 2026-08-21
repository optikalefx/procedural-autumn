#!/usr/bin/env node
/**
 * scopenose — why is the refractor's black dew shield BRIGHTER than its white
 * tube at dusk?
 *
 * Two rounds have now been spent on a knob in `camp_telescope.js` that provably
 * cannot move this number. `skyGrad` is multiplicative on the tint, `T_SHELL`
 * is about 0.02 linear, and no multiplier on 0.02 produces an on-screen L of
 * 134. The lifting term is additive and albedo-independent, so it is in the
 * lighting, not in the prop — and `Stylize.js` documents exactly one term of
 * that shape: the golden-hour rim, added to `directSpecular` so that "a rim
 * through that path on a near-black conifer would be near-black".
 *
 * So: shoot the dusk frame five times, zeroing one suspect each time, and
 * report the measured shield-vs-tube values. Whichever restores the black nose
 * is the mechanism. Nothing gets edited on the strength of a hunch again.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = 'shots/camp/scope/nose';
const release = await acquire('scopenose');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
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
await page.waitForTimeout(2200);

// Pitch, inject the refractor, and remember the two sample points in WORLD
// space: a spot on the black dew shield and a spot on the white tube.
const info = await page.evaluate(async () => {
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  if (!s) return null;
  const THREE = window.__THREE;
  const mod = await import('/src/camp/camp_telescope.js');
  const site = await import('/src/camp/camp_site.js');
  const { mulberry32 } = await import('/src/core/MathUtils.js');
  const camp = (window.__camp.camps ?? [window.__camp]).slice(-1)[0];
  const props = camp.props ?? window.__camp.props;
  const chairs = props.filter((p) => p.item.kind === 'chair');
  let ax = 0, az = 0;
  for (const c of chairs) { ax += c.item.x - s.x; az += c.item.z - s.z; }
  const seat = chairs.length ? Math.atan2(az, ax) : 0;
  const R = (camp.site ?? window.__camp.site)?.radius ?? 5.8;
  const a = seat + 1.7, r = R * 0.50;
  const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
  const y = window.__world.getHeight(x, z);
  const g = mod.buildTelescope(mulberry32(0x51ed270b), { variant: 'refractor', wear: 0.45 });
  g.position.set(x, y, z);
  const q = new THREE.Quaternion();
  site.standOn(window.__world, x, z, Math.atan2(s.x - x, s.z - z), 0.22, q);
  g.quaternion.copy(q);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  (camp.root ?? window.__camp.root).add(g);
  props.push({ obj: g, item: { kind: 'telescope', x, y, z, yaw: Math.atan2(s.x - x, s.z - z) }, delay: 0 });
  window.__noseProp = g;
  return { x, y, z, yaw: Math.atan2(s.x - x, s.z - z) };
});
if (!info) { console.error('scopenose: no site'); await browser.close(); release(); process.exit(2); }
mkdirSync(resolve(DIR), { recursive: true });

// Pose the camera on the side framing at dusk, and take a MASK frame so the
// prop's own pixels can be found without hand-picking coordinates. The first
// version of this tool projected two guessed offsets along the optical axis and
// put both of them off-screen; the numbers it printed were of the night sky.
await page.evaluate(({ p }) => {
  const THREE = window.__THREE, e = window.__engine;
  window.__lighting.hour = 20.4; window.__lighting.cycleSpeed = 0;
  const f = { az: 0.85, dist: 2.00, elev: 0.95, fov: 36, aim: 0.48 };
  const a = p.yaw + f.az;
  e.camera.fov = f.fov; e.camera.updateProjectionMatrix();
  e.camera.position.set(p.x + Math.sin(a) * f.dist, p.y + f.elev, p.z + Math.cos(a) * f.dist);
  e.camera.lookAt(new THREE.Vector3(p.x, p.y + f.aim, p.z));
  window.__forceCamera = true;
}, { p: info });
await page.waitForTimeout(900);

await page.evaluate(async () => {
  const T = window.__THREE;
  window.__noseSaved = [];
  window.__noseProp.traverse((o) => {
    if (!o.isMesh || o.name.startsWith('telescope_contact')) return;
    window.__noseSaved.push([o, o.material]);
    o.material = new T.MeshBasicMaterial({ color: 0xff00ff, fog: false });
  });
  if (window.__settleStable) await window.__settleStable(400, 20);
});
await page.waitForTimeout(400);
const maskPath = resolve(DIR, 'mask.png');
await page.screenshot({ path: maskPath });
await page.evaluate(async () => {
  for (const [o, m] of window.__noseSaved) { o.material.dispose(); o.material = m; }
  window.__noseSaved = null;
  if (window.__settleStable) await window.__settleStable(300, 16);
});
await page.waitForTimeout(300);
const MASK = readFileSync(maskPath).toString('base64');

const sample = async (name, mutate) => {
  await page.evaluate(async (m) => {
    // The stylize uniforms are injected into THREE.UniformsLib.lights, shared
    // by every lit material in the scene — that is the handle, not anything
    // hanging off the Stylize instance.
    const u = window.__THREE.UniformsLib.lights;
    if (m) for (const [k, v] of Object.entries(m)) if (u[k]) u[k].value = v;
    // The post chain's own additive terms. These are the shape of thing the
    // arithmetic actually points at: veiling glare is a heavily-filtered,
    // luminance-thresholded copy of the frame added back at its own gain, and
    // PostFX's own comments say it and the bloom both key off how low the sun
    // is. An additive low-frequency wash is exactly what lifts a narrow dark
    // band sitting between a white tube and bright grass while leaving a larger
    // dark mass alone.
    const fx = window.__postfx;
    if (m && m.__veil !== undefined && fx?.veil) fx.veil.gain = m.__veil;
    if (m && m.__bloom !== undefined && fx?.bloom) fx.bloom.intensity = m.__bloom;
    if (window.__settleStable) await window.__settleStable(500, 22);
  }, mutate);
  await page.waitForTimeout(500);
  const png = resolve(DIR, `${name}.png`);
  await page.screenshot({ path: png });
  const r = await page.evaluate(async ({ b64 }) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
    const d = c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
    // A fixed box on the dew shield, located from a build with SHELL forced to
    // red so there is no doubt which pixels are the shield. Measuring the whole
    // prop's histogram was the previous mistake: the shield is about 8% of it,
    // so zeroing the term that lifts it moved the median by one and the bisect
    // cleared five innocent suspects.
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 96; y <= 118; y++) for (let x = 928; x <= 954; x++) {
      const i = ((y * img.width) + x) * 4;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    r /= n; g /= n; b /= n;
    return { n, p05: 0, p25: 0, med: 0.2126 * r + 0.7152 * g + 0.0722 * b,
             p90: 0, rgb: [Math.round(r), Math.round(g), Math.round(b)] };
  }, { b64: readFileSync(png).toString('base64') });
  // If the black nose is black, the dark tail of the prop's own histogram sits
  // far below its median. If it is being lifted, the tail rises to meet it.
  console.log(`${name.padEnd(22)} dew-shield L ${r.med.toFixed(1).padStart(6)}  ` +
              `rgb ${JSON.stringify(r.rgb)}` + (r.med < 45 ? '   <-- BLACK NOSE RESTORED' : ''));
  return { name, ...r };
};

const rows = [];
rows.push(await sample('00-baseline', null));
rows.push(await sample('01-rim-off', { uStyleRim: 0 }));
rows.push(await sample('02-spec-off-too', { uStyleSpecular: 0 }));
rows.push(await sample('03-cool-off-too', { uShadowCoolAmt: 0 }));
rows.push(await sample('04-floor-off-too', { uStyleFloor: 0 }));
rows.push(await sample('05-banding-off-too', { uStyleBanding: 0, uStyleWrap: 0 }));
// Put the lighting back, then walk the post chain.
rows.push(await sample('06-stylize-restored',
  { uStyleRim: 0.5, uStyleSpecular: 1, uShadowCoolAmt: 0.62, uStyleFloor: 0.05,
    uStyleBanding: 0.52, uStyleWrap: 0.48 }));
rows.push(await sample('07-veil-off', { __veil: 0 }));
rows.push(await sample('08-bloom-off-too', { __bloom: 0 }));
writeFileSync(resolve(DIR, 'RESULT.json'), JSON.stringify(rows, null, 1));
await browser.close();
release();
