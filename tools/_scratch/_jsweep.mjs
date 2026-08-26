// Ask EVERY seat on the sheet for the close look, and report which way the
// detail patch is facing when it gets there.
//
// The close look was only ever proved on `waterfall`, which lives on page 4 —
// a RECTO. Half the sheet is on a verso (pages 1 and 3, the left-hand leaves),
// `deformPage` bends those with p = 1 so their surface normal points AWAY from
// the reader, and the leaf itself is drawn `BackSide`. So this prints, per seat:
//
//   faceDot  the patch quad's own +Z against the direction the camera is
//            looking. NEGATIVE is facing the reader; POSITIVE is facing away,
//            which on a FrontSide material means culled.
//   liftDot  the 0.9 mm hold-off the quad is given, against the same direction.
//            Negative lifts it toward the reader; positive pushes it UNDER the
//            paper it is supposed to be sitting on.
//
// `hud.openJournal({ award })` is the line `hud_photo` runs, and `_armAward`
// awards through the journal's OWN `hunt` import — so this drives an arbitrary
// id without ever touching the store from an evaluate, which is what the
// dynamic-`import()` trap (JOURNAL_NOTES 13.4) punishes. The print handed to
// each award is genuine: the shutter is fired once at a waterfall and its
// stored thumbnail is reused, so every seat gets a real 1024 px photograph.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = process.env.OUT ?? '/tmp/jsweep';
const IDS = (process.env.IDS ?? 'deer,fox,owl,highCamp').split(',');
// BROKEN=1 defeats the fix without editing a line of it: `_detailShow`'s
// half-turn is a lazily built, cached field (`_flipY ??= ...`), so seeding it
// with an IDENTITY quaternion puts the quad back exactly where it shipped —
// facing away and 0.9 mm under the paper. That is what the "before" plates are.
const BROKEN = !!process.env.BROKEN;
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

// ── one real shutter, for one real print ────────────────────────────────────
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
await page.waitForTimeout(3500);
await page.evaluate(() => window.__systems.hud.photo.capture());
await page.waitForTimeout(1500);
const print = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('pa.hunt') ?? '{}').items?.waterfall?.photo ?? null);
console.log('minted a print of', (print ?? '').length, 'chars');
await page.waitForTimeout(6000);
await page.keyboard.press('j');
await page.waitForTimeout(1400);

const facing = () => page.evaluate(() => {
  const T = window.__THREE ?? null;
  const j = window.__systems.hud.journal;
  const m = j._detail;
  if (!m || !m.visible) return { vis: false };
  // The quad's own +Z, and the hold-off it was given, both against the
  // direction the overlay camera is looking.
  const q = m.getWorldQuaternion(new m.quaternion.constructor());
  const z = { x: 0, y: 0, z: 1 };
  // rotate (0,0,1) by q by hand, so this needs no THREE import
  const { _x: qx, _y: qy, _z: qz, _w: qw } = q;
  const ix = qw * z.x + qy * z.z - qz * z.y;
  const iy = qw * z.y + qz * z.x - qx * z.z;
  const iz = qw * z.z + qx * z.y - qy * z.x;
  const iw = -qx * z.x - qy * z.y - qz * z.z;
  const n = { x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
              y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
              z: iz * qw + iw * -qz + ix * -qy - iy * -qx };
  const cam = j.camera;
  const f = { x: 0, y: 0, z: -1 };
  const cq = cam.quaternion;
  const jx = cq._w * f.x + cq._y * f.z - cq._z * f.y;
  const jy = cq._w * f.y + cq._z * f.x - cq._x * f.z;
  const jz = cq._w * f.z + cq._x * f.y - cq._y * f.x;
  const jw = -cq._x * f.x - cq._y * f.y - cq._z * f.z;
  const d = { x: jx * cq._w + jw * -cq._x + jy * -cq._z - jz * -cq._y,
              y: jy * cq._w + jw * -cq._y + jz * -cq._x - jx * -cq._z,
              z: jz * cq._w + jw * -cq._z + jx * -cq._y - jy * -cq._x };
  const dot = n.x * d.x + n.y * d.y + n.z * d.z;
  return { vis: true, faceDot: +dot.toFixed(3), side: m.material.side,
           verso: !!j._study?.verso };
});

const state = () => page.evaluate(() => {
  const j = window.__systems.hud.journal;
  const rows = [];
  for (let p = 0; p < j._pages.length; p++)
    for (const [i, r] of (j._pages[p].spec?.rows ?? []).entries()) {
      if (!r?.done) continue;
      rows.push({ seat: `${p}:${i}`, id: r.id, photo: !!r.photo, hidden: !!r.hidePrint });
    }
  return { zoom: j.zoomLevel, detailFor: j._detailFor ?? null,
           detailHidden: j._detailHidden ?? null, detailVis: !!j._detail?.visible, rows };
});

if (BROKEN) {
  await page.evaluate(() => {
    const j = window.__systems.hud.journal;
    j._flipY = j.camera.quaternion.clone().identity();
  });
  console.log('running with the half-turn defeated (the shipped bug)');
}

for (const id of IDS) {
  console.log(`\n── ${id} ──`);
  await page.evaluate(([id2, url]) => {
    window.__systems.hud.openJournal({ id: id2, photoDataURL: url });
  }, [id, print]);
  // FILM=1 strips the ceremony instead of waiting it out — the flying print
  // rides the SAME basis the detail patch does (`samplePage`'s quaternion), so
  // a verso award is where a sign error in it would show.
  if (process.env.FILM) {
    const T0 = +(process.env.FILM_T0 ?? 2600), DT = +(process.env.FILM_DT ?? 180);
    for (let f = 0; f < 22; f++) {
      await page.waitForTimeout(f === 0 ? T0 : DT);
      await page.screenshot({ path: `${OUT}/${id}_film_${String(f).padStart(2, '0')}.png` });
    }
    await page.waitForTimeout(2500);
  } else await page.waitForTimeout(8000);
  // The seat this id actually sits in, from the journal's own map, so the
  // search cannot wander onto a neighbour's print.
  const seat = await page.evaluate((id2) => {
    const j = window.__systems.hud.journal;
    const s = j._seat?.get(id2);
    if (!s) return null;
    for (let y = 0.08; y < 0.95; y += 0.01)
      for (let x = 0.03; x < 0.97; x += 0.01) {
        const cx = Math.round(x * window.innerWidth), cy = Math.round(y * window.innerHeight);
        const h = j._rowAt(cx, cy);
        if (h && h.page === s.page && h.row === s.row) return { cx, cy, ...s };
      }
    return { ...s, offscreen: true };
  }, id);
  console.log('  seat:', JSON.stringify(seat));
  if (!seat || seat.offscreen) { await page.keyboard.press('j'); await page.waitForTimeout(1000); continue; }
  // Rest on it first: the hover is what arms the detail patch now.
  await page.mouse.move(seat.cx, seat.cy);
  await page.waitForTimeout(400);
  // TRACE=1 records the move itself: the ladder position, the scale actually on
  // the book, and the fit's solve, sampled from inside the page on rAF so the
  // sampling is the renderer's own cadence rather than an evaluate round trip.
  if (process.env.TRACE) {
    await page.evaluate(() => {
      const j = window.__systems.hud.journal;
      window.__trace = [];
      const t0 = performance.now();
      const tick = () => {
        window.__trace.push([+(performance.now() - t0).toFixed(1),
          +j._studyK.toFixed(4), +j._zoomNow.toFixed(3), +j._closeZ.toFixed(3)]);
        if (performance.now() - t0 < 1200) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.mouse.click(seat.cx, seat.cy);
    await page.waitForTimeout(1600);
    const tr = await page.evaluate(() => window.__trace);
    console.log('  ms / k / scale / solve');
    for (const r of tr) console.log('   ', r.join('\t'));
  // ONE click is the whole move now — the lean is gone (JOURNAL_NOTES 16.2).
  } else await page.mouse.click(seat.cx, seat.cy);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/${id}_close.png` });
  console.log('  facing:', JSON.stringify(await facing()));
  console.log('  state :', JSON.stringify(await state()));
  for (let k = 0; k < 3; k++) { await page.keyboard.press('Escape'); await page.waitForTimeout(700); }
  await page.waitForTimeout(700);
}

await browser.close();
