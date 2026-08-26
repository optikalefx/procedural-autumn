// The player driving the book: pan, tilt and zoom, through real pointer and
// wheel events on the real game.
//
// What it has to answer, in order:
//   · do the three gestures move the book the way photo mode's do
//   · does a DRAG still turn a page (it must not — that is the whole reason the
//     click moved from pointerdown to pointerup)
//   · do the clamps hold, and does the book still read as a book at each of
//     them — which is a capture, not a number
//   · does one Escape put it back, and does the SECOND one then do what Escape
//     always did
//
// Traps obeyed: ANGLE/Metal, the HMR stub, the book opened with `J` so the
// driving chrome goes away, and no dynamic `import()` of the store.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = process.env.OUT ?? '/tmp/jpan';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
});
page.on('console', (m) => { const t = m.text();
  if (m.type() === 'error' && !t.includes('POSTHOG')) console.log('  [page error]', t); });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0]));

await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
await page.evaluate(() => { window.__systems.hud.toast = () => {}; localStorage.removeItem('pa.hunt'); });

// One real print, so there is something to go in on.
console.log('posed:', JSON.stringify(await page.evaluate(async () => {
  const { detectSubjects } = await import('/src/game/hunt_detect.js');
  const cam = window.__ctx.camera;
  window.__forceCamera = true; window.__hudForce = true;
  const falls = window.__ctx.world?.waterfalls ?? [];
  for (let f = 0; f < Math.min(falls.length, 6); f++) {
    const wf = falls[f];
    const mid = [(wf.top[0] + wf.bottom[0]) / 2, (wf.top[1] + wf.bottom[1]) / 2,
                 (wf.top[2] + wf.bottom[2]) / 2];
    for (const r of [50, 90, 150]) for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      cam.position.set(mid[0] + Math.sin(ang) * r, mid[1] + r * 0.25, mid[2] + Math.cos(ang) * r);
      cam.lookAt(mid[0], mid[1], mid[2]); cam.updateMatrixWorld(true);
      if (detectSubjects(window.__ctx).includes('waterfall')) return { fall: f, radius: r };
    }
  }
  return { none: true };
})));
await page.waitForTimeout(3000);
await page.evaluate(() => window.__systems.hud.photo.capture());
// ── the ceremony has right of way ──────────────────────────────────────────
// Shove the camera while the print is still in the air. `_panBy` refuses on the
// same test `leaf()` and `study()` use, and it has to: the flying print aims at
// a page it locates with `samplePage` every frame.
await page.waitForTimeout(2200);
await page.mouse.move(800, 450);
await page.mouse.down();
for (let i = 1; i <= 10; i++) { await page.mouse.move(800 + i * 20, 450 + i * 10); await page.waitForTimeout(16); }
await page.mouse.up();
await page.mouse.wheel(0, -600);
await page.waitForTimeout(300);
const midCeremony = await page.evaluate(() => window.__systems.hud.journal.panned);
console.log(midCeremony ? '  FAIL — the camera moved mid-ceremony'
                        : '  PASS — the ceremony kept right of way');
await page.waitForTimeout(6000);
await page.keyboard.press('j');                 // shut the ceremony's book
await page.waitForTimeout(1400);
await page.keyboard.press('j');                 // and open it cold, through the HUD
await page.waitForTimeout(2500);

const state = () => page.evaluate(() => {
  const j = window.__systems.hud.journal;
  const P = j._pan;
  const c = j.camera;
  // The page's angle off face-on, which is what the pitch clamp is written on:
  // the leaf's own normal against the direction the camera is looking.
  const mesh = j._J.pageRight;
  let face = null;
  if (mesh?.visible) {
    const n = new c.quaternion.constructor();
    mesh.getWorldQuaternion(n);
    const v = { x: 0, y: 0, z: 1 };
    const rot = (q, u) => {
      const ix = q._w * u.x + q._y * u.z - q._z * u.y;
      const iy = q._w * u.y + q._z * u.x - q._x * u.z;
      const iz = q._w * u.z + q._x * u.y - q._y * u.x;
      const iw = -q._x * u.x - q._y * u.y - q._z * u.z;
      return { x: ix * q._w + iw * -q._x + iy * -q._z - iz * -q._y,
               y: iy * q._w + iw * -q._y + iz * -q._x - ix * -q._z,
               z: iz * q._w + iw * -q._z + ix * -q._y - iy * -q._x };
    };
    const nn = rot(n, v);
    const d = rot(c.quaternion, { x: 0, y: 0, z: -1 });
    const dot = -(nn.x * d.x + nn.y * d.y + nn.z * d.z);
    face = +(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI).toFixed(1);
  }
  return {
    panned: j.panned, zoom: j.zoomLevel, leaf: +(j._pose?.leaf ?? -1).toFixed(2),
    yaw: +P.yaw.toFixed(4), pitch: +P.pitch.toFixed(4), z: +P.zoom.toFixed(3),
    x: +P.x.toFixed(4), y: +P.y.toFixed(4),
    camY: +c.position.y.toFixed(4), face,
  };
});

const drag = async (btn, dx, dy, steps = 10) => {
  const x0 = 800, y0 = 450;
  await page.mouse.move(x0, y0);
  await page.mouse.down({ button: btn });
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + (dx * i) / steps, y0 + (dy * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up({ button: btn });
  await page.waitForTimeout(400);
};

console.log('\nsquare    :', JSON.stringify(await state()));
await page.screenshot({ path: `${OUT}/p0_square.png` });

// ── does a DRAG turn a page? ────────────────────────────────────────────────
const leaf0 = (await state()).leaf;
await drag('left', 260, 0);
const afterDrag = await state();
console.log('drag right:', JSON.stringify(afterDrag));
console.log(afterDrag.leaf === leaf0
  ? '  PASS — a drag did not turn a page' : '  FAIL — the drag turned a page');
await page.screenshot({ path: `${OUT}/p1_yaw.png` });

await page.keyboard.press('Escape');
await page.waitForTimeout(600);
console.log('escape #1 :', JSON.stringify(await state()));

// ── tilt ────────────────────────────────────────────────────────────────────
await drag('left', 0, 220);
console.log('drag down :', JSON.stringify(await state()));
await page.screenshot({ path: `${OUT}/p2_tilt_up.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// ── the clamps, by shoving hard at each ─────────────────────────────────────
await drag('left', 3000, 0, 40);
console.log('yaw clamp :', JSON.stringify(await state()));
await page.screenshot({ path: `${OUT}/p3_yaw_clamp.png` });
await page.keyboard.press('Escape'); await page.waitForTimeout(700);

await drag('left', 0, 3000, 40);
console.log('face min  :', JSON.stringify(await state()));
await page.screenshot({ path: `${OUT}/p4_face_min.png` });
await page.keyboard.press('Escape'); await page.waitForTimeout(700);

await drag('left', 0, -3000, 40);
console.log('face max  :', JSON.stringify(await state()));
await page.screenshot({ path: `${OUT}/p5_face_max.png` });
await page.keyboard.press('Escape'); await page.waitForTimeout(700);

// ── the wheel ───────────────────────────────────────────────────────────────
await page.mouse.move(800, 450);
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
await page.waitForTimeout(400);
console.log('wheel in  :', JSON.stringify(await state()));
await page.screenshot({ path: `${OUT}/p6_zoom_in.png` });
for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(20); }
await page.waitForTimeout(400);
console.log('wheel out :', JSON.stringify(await state()));
await page.screenshot({ path: `${OUT}/p7_zoom_out.png` });
await page.keyboard.press('Escape'); await page.waitForTimeout(700);

// ── the pan, and its edge clamp ─────────────────────────────────────────────
await drag('middle', 900, 500, 30);
console.log('pan clamp :', JSON.stringify(await state()));
await page.screenshot({ path: `${OUT}/p8_pan_clamp.png` });

// ── one Escape home, the next does what Escape always did ───────────────────
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
const home = await state();
console.log('escape #1 :', JSON.stringify(home));
const openAfter = await page.evaluate(() => window.__systems.hud.journal.active);
await page.keyboard.press('Escape');
await page.waitForTimeout(900);
const shut = await page.evaluate(() => window.__systems.hud.journal.active);
console.log(`escape ladder: home -> panned ${home.panned}, open ${openAfter}; again -> open ${shut}`);
console.log(!home.panned && openAfter && !shut
  ? '  PASS — one press squares it, the next shuts the book'
  : '  FAIL');

// ── and the same three on the close look ────────────────────────────────────
await page.keyboard.press('j');
await page.waitForTimeout(2200);
for (let n = 0; n < 6; n++) {
  const seat = await page.evaluate(() => {
    const j = window.__systems.hud.journal;
    for (let y = 0.1; y < 0.95; y += 0.01)
      for (let x = 0.03; x < 0.97; x += 0.01) {
        const cx = Math.round(x * window.innerWidth), cy = Math.round(y * window.innerHeight);
        const s = j._rowAt(cx, cy);
        if (s) return { cx, cy, ...s };
      }
    return null;
  });
  if (seat) {
    await page.mouse.move(seat.cx, seat.cy);
    await page.waitForTimeout(400);
    await page.mouse.click(seat.cx, seat.cy);
    await page.waitForTimeout(1400);
    console.log('\nclose look:', JSON.stringify(await state()));
    await page.screenshot({ path: `${OUT}/q0_close.png` });
    await drag('left', 0, 3000, 40);
    console.log('  face min :', JSON.stringify(await state()));
    await page.screenshot({ path: `${OUT}/q1_close_face_min.png` });
    await page.keyboard.press('Escape'); await page.waitForTimeout(700);
    await page.mouse.move(800, 450);
    for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
    await page.waitForTimeout(400);
    console.log('  wheel in :', JSON.stringify(await state()));
    await page.screenshot({ path: `${OUT}/q2_close_zoom.png` });
    break;
  }
  await page.mouse.click(1300, 450);
  await page.waitForTimeout(1100);
}

await browser.close();
