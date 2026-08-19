// Does the sky behave like it is at infinity?
//
// A still cannot answer that. This poses the camera inside ONE page load, with
// time frozen and the cloud wind stopped, and measures the sky in four ways:
//
//   translate  camera moved 300 m with the SAME orientation. A sky at infinity
//              barely changes; a sky that is really a nearby object slides.
//   lag        the pose is applied from a lateUpdate callback, exactly where
//              CameraRig applies it in the real game, and the frame rendered
//              immediately after a single small camera step is compared with
//              the same pose once everything has settled. Any difference is
//              the sky being drawn for a camera that is no longer there.
//   rotate     yaw stepped in equal increments; consecutive frame diffs should
//              be equal-ish. A jump is one step much larger than its
//              neighbours.
//   orbitseq   the chase boom: camera swung around a 12 m circle at mouse-drag
//              speed, one frame per step, which is what the player is doing
//              when they say the sky jumps.
//
// Only the sky and the cloud deck are drawn (--all keeps the world) so the
// numbers are the sky's and not the terrain's. Pixels come from readPixels on
// the default framebuffer immediately after the render, so no compositor sits
// between the measurement and the frame.
//
//   node tools/_scratch/skyrig.mjs
//   node tools/_scratch/skyrig.mjs --hour 16.7 --all
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);
const W = parseInt(arg('w', '640'), 10), H = parseInt(arg('h', '400'), 10);
const HOUR = parseFloat(arg('hour', '16.7'));
const RES = arg('res', '640');

await acquire('skyrig');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const out = await page.evaluate(async ({ HOUR, ALL }) => {
  const THREE = window.__THREE, e = window.__engine, wd = window.__world;
  const cam = e.camera;
  window.__forceCamera = true;
  window.__lighting.hour = HOUR;
  window.__lighting.cycleSpeed = 0;
  if (window.__settle) await window.__settle(600);

  // Freeze every clock the sky can read: elapsed stops advancing, so the cloud
  // wind uv, the star scintillation and the weather all hold still.
  e.stop();
  e.clock.getDelta = () => 0;
  const clouds = window.__systems.clouds;
  if (clouds) clouds.wind.set(0, 0);

  // Sky only, unless asked otherwise: terrain moving correctly would otherwise
  // swamp the sky's own numbers.
  const hidden = [];
  if (!ALL) {
    for (const c of e.scene.children) {
      if (c.name === 'Sky' || c.name === 'Clouds') continue;
      if (c.visible) { hidden.push(c); c.visible = false; }
    }
  }

  // The pose is applied from a lateUpdate, which is exactly where CameraRig
  // applies it (CameraRig._apply is called from its lateUpdate). Anything that
  // reads camera.position during the normal update phase therefore sees the
  // PREVIOUS frame's pose — the real game's ordering, reproduced.
  const pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  const eul = new THREE.Euler(0, 0, 0, 'YXZ');
  e.onLateUpdate(() => { cam.position.copy(pose.pos); cam.quaternion.copy(pose.quat); });
  const setPose = (x, y, z, yaw, pitch) => {
    pose.pos.set(x, y, z);
    eul.set(pitch, yaw, 0, 'YXZ');
    pose.quat.setFromEuler(eul);
  };

  const gl = e.renderer.getContext();
  const step = (n = 1) => { for (let i = 0; i < n; i++) e._loop(); };
  const grab = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { w, h, px };
  };
  // Step then read in the same task, so the drawing buffer is still the frame
  // we just rendered.
  const shot = (n = 1) => { step(n); return grab(); };
  const diff = (a, b) => {
    let sum = 0, max = 0, cnt = 0, n = 0;
    for (let i = 0; i < a.px.length; i += 4) {
      const d = (Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) +
                 Math.abs(a.px[i + 2] - b.px[i + 2])) / 3;
      sum += d; if (d > max) max = d; if (d > 6) cnt++; n++;
    }
    return { mean: +(sum / n).toFixed(3), max: +max.toFixed(1), pct: +(100 * cnt / n).toFixed(2) };
  };

  const a = (window.__cameraAnchors.road || window.__cameraAnchors.vista)();
  const X = a.x, Z = a.z, Y = wd.getHeight(X, Z) + 4.0;
  const YAW = a.yaw ?? 0;
  cam.fov = 55; cam.updateProjectionMatrix();

  const R = {};

  // ── 1. translation, both poses fully settled ────────────────────────────────
  // 300 m sideways with the orientation untouched. Also a look-up variant,
  // because the zenith is where a 1.5 km deck legitimately does shift.
  const tr = (pitch) => {
    const nx = Math.cos(YAW), nz = -Math.sin(YAW);         // lateral to the view
    setPose(X, Y, Z, YAW, pitch); const p0 = shot(4);
    setPose(X + nx * 300, Y, Z + nz * 300, YAW, pitch); const p1 = shot(4);
    setPose(X + nx * 30, Y, Z + nz * 30, YAW, pitch); const p2 = shot(4);
    return { d300: diff(p0, p1), d30: diff(p0, p2) };
  };
  R.translate_level = tr(-0.06);
  R.translate_up = tr(0.55);

  // ── 2. the lag: one small camera step, rendered now vs rendered settled ─────
  const lag = (dx, dy, dz, dyaw, label) => {
    setPose(X, Y, Z, YAW, -0.06); shot(4);
    setPose(X + dx, Y + dy, Z + dz, YAW + dyaw, -0.06);
    const now = shot(1);                 // the frame the player actually sees
    const settled = shot(4);             // where the sky should have been
    return { [label]: diff(now, settled) };
  };
  // 22 m/s at 60 fps is 0.37 m of camera travel in one frame.
  Object.assign(R, lag(0.37 * Math.sin(YAW), 0, 0.37 * Math.cos(YAW), 0, 'lag_drive_0m37'));
  // A mouse drag swings the 12 m chase boom several degrees in a frame: 3° of
  // boom is 0.63 m of camera travel plus the rotation.
  Object.assign(R, lag(0.63, 0.0, 0.0, 0.052, 'lag_orbit_3deg'));
  // Pure rotation, no translation at all — the control.
  Object.assign(R, lag(0, 0, 0, 0.052, 'lag_pureyaw_3deg'));

  // ── 3. rotation continuity, settled ────────────────────────────────────────
  const rotSeq = [];
  let prev = null;
  for (let i = 0; i <= 12; i++) {
    setPose(X, Y, Z, YAW + i * 0.0131, -0.06);   // 0.75° per step
    const f = shot(3);
    if (prev) rotSeq.push(diff(prev, f).mean);
    prev = f;
  }
  R.rotate_settled = rotSeq;

  // ── 4. the chase boom under a mouse drag, one frame per step ───────────────
  // Same 0.75° per step, but swung around a 12 m boom and given one frame each,
  // which is what the player is doing when the sky "jumps all around".
  const orbSeq = [], orbErr = [];
  prev = null;
  const BOOM = 12;
  for (let i = 0; i <= 12; i++) {
    const yaw = YAW + i * 0.0131;
    const px = X + Math.sin(yaw) * BOOM - Math.sin(YAW) * BOOM;
    const pz = Z + Math.cos(yaw) * BOOM - Math.cos(YAW) * BOOM;
    setPose(px, Y, pz, yaw, -0.06);
    const f = shot(1);
    const ideal = shot(4);
    orbErr.push(diff(f, ideal).mean);
    if (prev) orbSeq.push(diff(prev, f).mean);
    prev = f;
    setPose(px, Y, pz, yaw, -0.06);   // leave settled for the next step
  }
  R.orbit_step_delta = orbSeq;
  R.orbit_err_vs_ideal = orbErr;

  // ── 5. small steps, varying speed: is the delta continuous? ────────────────
  // Pulling away and slowing down again, one frame per step. Every step is a
  // different distance, so anything that renders the sky for the wrong camera
  // shows up as a delta that has nothing to do with the step that produced it.
  const SPEEDS = [0, 0.06, 0.12, 0.25, 0.5, 0.75, 0.75, 0.75, 0.4, 0.18, 0.06, 0];
  const driveSeq = [];
  setPose(X, Y, Z, YAW, -0.06); shot(4);
  let dx = 0, dz = 0;
  prev = grab();
  for (const s of SPEEDS) {
    dx += Math.sin(YAW) * s; dz += Math.cos(YAW) * s;
    setPose(X + dx, Y, Z + dz, YAW, -0.06);
    const f = shot(1);
    driveSeq.push(diff(prev, f).mean);
    prev = f;
  }
  R.drive_speeds = SPEEDS;
  R.drive_step_delta = driveSeq;

  for (const c of hidden) c.visible = true;
  R.buffer = `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`;
  return R;
}, { HOUR, ALL: has('all') });

const f3 = (a) => a.map((v) => v.toFixed(2)).join(' ');
console.log('buffer', out.buffer);
console.log('translate level  300m', JSON.stringify(out.translate_level.d300), ' 30m', JSON.stringify(out.translate_level.d30));
console.log('translate up     300m', JSON.stringify(out.translate_up.d300), ' 30m', JSON.stringify(out.translate_up.d30));
console.log('lag drive 0.37m     ', JSON.stringify(out.lag_drive_0m37));
console.log('lag orbit 3deg      ', JSON.stringify(out.lag_orbit_3deg));
console.log('lag pure yaw 3deg   ', JSON.stringify(out.lag_pureyaw_3deg));
console.log('rotate settled  Δ/step', f3(out.rotate_settled));
console.log('orbit  1frame   Δ/step', f3(out.orbit_step_delta));
console.log('orbit  err vs ideal   ', f3(out.orbit_err_vs_ideal));
console.log('drive  m/frame        ', f3(out.drive_speeds));
console.log('drive  Δ/step         ', f3(out.drive_step_delta));
if (errs.length) console.log('page-errors:', JSON.stringify(errs.slice(0, 5)));
await browser.close();
