#!/usr/bin/env node
/**
 * Sleeping in the tent, end to end.
 *
 *   node tools/_scratch/sleepcheck.mjs --dir shots/sleep
 *
 * Drives the REAL path — a real keypress for the handbrake, a real mouse over
 * the tent, a real click — because everything this change adds lives in the
 * pointer chain and a harness that pokes `sleep.begin()` would prove none of it.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/sleep');
const URL = `${process.env.AUTUMN_URL || 'http://localhost:5178'}?car=camper`;

const ok = [], bad = [];
const check = (name, pass, detail = '') => (pass ? ok : bad).push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);

async function main() {
  const release = await acquire('campshot');
  mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  // Stub the HMR socket: another author saving a file mid-run reloads the page
  // and throws out whatever is in flight. Copied from campshot.mjs.
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
        return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
                 send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
      }
      return new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });

  // The journal opens itself on a first run (`HUD.maybeShowIntro`), and a fresh
  // playwright profile is always a first run. `_interact` returns at its
  // `bookOpen` guard while it is up, so without this the harness measures the
  // book and nothing else.
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const hud = window.__systems.hud;
    if (hud?.journal?.visible) hud.toggleJournal();
  });
  await page.waitForTimeout(900);
  check('journal intro closed', await page.evaluate(() => !window.__systems.hud?.journal?.visible));

  // Park somewhere open, then latch the park brake with a real key — brakeHold
  // is written by the physics and an assignment survives one frame.
  await page.evaluate(() => {
    const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
  });
  await page.waitForTimeout(1800);
  await page.keyboard.down('Space');
  await page.waitForTimeout(900);
  await page.keyboard.up('Space');
  await page.waitForTimeout(1200);

  const setup = await page.evaluate(() => {
    const L = window.__lighting, C = window.__camp, V = window.__systems.vehicle;
    L.hour = 22.0; L.cycleSpeed = 0;
    const camp = C.pitchNear(V.position.x, V.position.z);
    return { brakeHold: !!V.brakeHold, pitched: !!camp, camps: C.camps.length };
  });
  await page.waitForTimeout(900);
  check('handbrake latched', setup.brakeHold);
  check('camp pitched', setup.pitched, `camps ${setup.camps}`);

  // Where the tent is on screen, and where a point safely OFF it is.
  const geo = await page.evaluate(() => {
    const C = window.__camp, cam = window.__ctx.camera, THREE = window.__THREE;
    const camp = C.camps[0];
    const t = camp.props.find((p) => p.item.kind === 'tent');
    const proj = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(cam);
      return { x: Math.round((v.x * 0.5 + 0.5) * innerWidth), y: Math.round((-v.y * 0.5 + 0.5) * innerHeight) };
    };
    return {
      raise: camp.raise, style: t?.item.opts?.style, focus: C._focusCamp === camp,
      tent: proj(t.item.x, t.item.y + 0.62, t.item.z),
      // Six metres to the side of the tent, on the ground: open meadow.
      off: proj(t.item.x + 6, t.item.y, t.item.z + 6),
      toFire: +Math.hypot(t.item.x - camp.x, t.item.z - camp.z).toFixed(2),
      held: window.__systems.vehicle.controlsHeldBy,
      bike: (() => {
        const B = window.__systems.bike, b = B?.bike;
        if (!b) return { none: true, claim: B?.pointerClaim, riding: B?._riding };
        const p = b.phys;
        return {
          claim: B.pointerClaim, riding: B._riding, active: B.active,
          toTent: +Math.hypot(p.x - t.item.x, p.z - t.item.z).toFixed(2),
          toCam: +Math.hypot(p.x - cam.position.x, p.z - cam.position.z).toFixed(2),
          screen: proj(p.x, p.y + 0.62, p.z),
        };
      })(),
      cam: { x: +cam.position.x.toFixed(1), y: +cam.position.y.toFixed(1), z: +cam.position.z.toFixed(1) },
    };
  });
  console.log('geo', JSON.stringify(geo));
  check('camp fully raised', geo.raise >= 1, `raise ${geo.raise}`);
  check('camera focused on the camp', geo.focus);
  check('nobody else holds the pedals', geo.held == null, `held ${geo.held}`);

  // Camp's OWN prompt. There are three `CampPrompt`s in the DOM — the bike's
  // and the boat's are built first (see SYSTEMS in main.js) — so a
  // `querySelector` on the class reads the bike's and reports on a system this
  // change never touched. `others` is how the "one prompt per frame" rule the
  // SYSTEMS ordering exists to keep gets checked at the same time.
  // ── the window ──────────────────────────────────────────────────────────
  //
  // `lighting.update(0, …)` rather than waiting a frame per hour: it is the same
  // call main.js makes and it rewrites the whole sky state synchronously, so
  // twenty hours cost one evaluate instead of twenty round trips.
  const HOURS = [12, 16, 17.5, 17.9, 18.0, 18.5, 19, 20, 22, 0.5, 3, 5.2, 5.3, 5.4, 6.2, 7.1, 9];
  const window_ = await page.evaluate((hours) => {
    const L = window.__lighting, C = window.__camp, cam = window.__ctx.camera;
    const was = L.hour;
    const out = hours.map((h) => { L.hour = h; L.update(0, cam.position); return [h, C.sleep.ready()]; });
    L.hour = was; L.update(0, cam.position);
    return out;
  }, HOURS);
  const offered = window_.filter(([, r]) => r).map(([h]) => h);
  const refused = window_.filter(([, r]) => !r).map(([h]) => h);
  check('offered from 18:00', offered[0] === 18.0 && !refused.includes(18.5),
    `offered ${offered.join(',')} | refused ${refused.join(',')}`);
  check('not offered in daylight', ![12, 16, 17.5, 17.9, 6.2, 7.1, 9].some((h) => offered.includes(h)),
    `offered ${offered.join(',')}`);
  check('closes before dawn', offered.includes(5.2) && !offered.includes(5.4),
    `offered ${offered.join(',')}`);

  const prompt = () => page.evaluate(() => {
    const mine = window.__camp.prompt.el;
    const txt = (el) => (el?.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      text: txt(mine), opacity: mine.style.opacity,
      others: [...document.querySelectorAll('.pa-camp-prompt')]
        .filter((e) => e !== mine && e.style.opacity === '1').map(txt),
    };
  });

  // ── the offer ───────────────────────────────────────────────────────────
  //
  // Swept across the tent's silhouette rather than poked at its centre. The
  // layout parks the camp's bicycle on the same ring as the tent and Bike.js
  // claims the pointer with a 0.95 m sphere of its own, so on some seeds the
  // projected centre of the tent is inside the bike's claim — which is a fact
  // about the affordance worth measuring, not a harness inconvenience.
  const grid = [];
  for (const dy of [-34, 0, 34]) for (const dx of [-46, 0, 46]) grid.push([dx, dy]);
  // Projected FRESH for every hover. The chase boom is still easing onto the
  // camp for seconds after the pitch and the camper settles on its springs, so
  // a screen position taken once at setup is 2.7 m off the tent by the time the
  // pointer gets there — measured, and it is what made the first three runs of
  // this harness report an affordance that was working.
  const tentScreen = () => page.evaluate(() => {
    const C = window.__camp, cam = window.__ctx.camera;
    const t = C.camps[0].props.find((p) => p.item.kind === 'tent');
    const v = new window.__THREE.Vector3(t.item.x, t.item.y + 0.62, t.item.z).project(cam);
    return { x: Math.round((v.x * 0.5 + 0.5) * innerWidth), y: Math.round((-v.y * 0.5 + 0.5) * innerHeight) };
  });
  const hoverAt = async (dx = 0, dy = 0) => {
    const c = await tentScreen();
    await page.mouse.move(c.x + dx, c.y + dy);
    await page.waitForTimeout(200);
    return c;
  };
  const sweep = async () => {
    const out = [];
    for (const [dx, dy] of grid) {
      await hoverAt(dx, dy);
      out.push({ dx, dy, ...(await prompt()) });
    }
    return out;
  };

  // ── arm 1: the bike outranks the tent ───────────────────────────────────
  //
  // Every FULL camp parks a bicycle (camp_site.js `if (!small)`) on the same
  // ring as the tent, and Bike.js claims the pointer for it with a sphere of
  // its own. Pointed at the BIKE, the camp must say nothing at all — not the
  // sleep offer and not the pack-up.
  const bikeScreen = () => page.evaluate(() => {
    const B = window.__systems.bike, cam = window.__ctx.camera;
    const ph = B?.bike?.phys;
    if (!ph || !Number.isFinite(ph.y)) return null;
    const v = new window.__THREE.Vector3(ph.x, ph.y + 0.62, ph.z).project(cam);
    return { x: Math.round((v.x * 0.5 + 0.5) * innerWidth), y: Math.round((-v.y * 0.5 + 0.5) * innerHeight) };
  });
  const onBike = await bikeScreen();
  check('the bike has a finite position', !!onBike,
    onBike ? '' : 'phys.y is NaN — see bike_physics.js, the shadowed `G`');
  if (onBike) {
    // Converge on it. The camper is still creeping on its springs with the
    // brake held, so the boom keeps moving and a single project-then-move lands
    // 1.19 m off a 0.95 m sphere — measured. Re-aim until the target stops
    // moving under the cursor.
    for (let i = 0; i < 5; i++) {
      const b = await bikeScreen();
      await page.mouse.move(b.x, b.y);
      await page.waitForTimeout(140);
      const after = await bikeScreen();
      if (Math.hypot(after.x - b.x, after.y - b.y) < 4) break;
    }
    await page.waitForTimeout(160);
    const atBike = await page.evaluate(() => {
      const B = window.__systems.bike, ph = B.bike.phys, cam = window.__ctx.camera;
      const V = window.__systems.vehicle;
      const C = window.__camp;
      const ray = C._pointerRay();
      const cx = ph.x - ray.o.x, cy = ph.y + 0.62 - ray.o.y, cz = ph.z - ray.o.z;
      const along = cx * ray.d.x + cy * ray.d.y + cz * ray.d.z;
      const px = cx - ray.d.x * along, py = cy - ray.d.y * along, pz = cz - ray.d.z * along;
      return {
        claim: !!B.pointerClaim,
        camp: (C.prompt.el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(),
        campOn: C.prompt.el.style.opacity,
        perp: +Math.sqrt(px * px + py * py + pz * pz).toFixed(3), along: +along.toFixed(2),
        brakeHold: !!V.brakeHold, held: V.controlsHeldBy, riding: B._riding,
        bikePrompt: (B.prompt.el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(),
      };
    });
    check('the bike claims its own pointer', atBike.claim, JSON.stringify(atBike));
    check('camp defers to the bike\'s claim', !/sleep/.test(atBike.camp) && atBike.campOn !== '1',
      JSON.stringify(atBike));
  }

  // ── arm 2: on the tent, with the bike still parked beside it ────────────
  const swept = await sweep();
  const offers = swept.filter((s) => /sleep until morning/.test(s.text));

  // Why, when it does not fire.
  await hoverAt(0, 0);
  console.log('why', JSON.stringify(await page.evaluate(() => {
    const C = window.__camp, V = window.__systems.vehicle, cam = window.__ctx.camera;
    const camp = C.camps[0];
    const t = camp.props.find((p) => p.item.kind === 'tent');
    const ray = C._pointerRay();
    const centre = new window.__THREE.Vector3(t.item.x, t.item.y + 0.62, t.item.z);
    const o = ray.o, d = ray.d;
    const ox = centre.x - o.x, oy = centre.y - o.y, oz = centre.z - o.z;
    const along = ox * d.x + oy * d.y + oz * d.z;
    const px = ox - d.x * along, py = oy - d.y * along, pz = oz - d.z * along;
    return {
      ready: C.sleep.ready(), forceCam: !!window.__forceCamera,
      tentHit: !!C._tentUnderPointer(),
      perp: +Math.sqrt(px * px + py * py + pz * pz).toFixed(3), along: +along.toFixed(2),
      mouse: { x: +window.__ctx.input.mouse.x.toFixed(3), y: +window.__ctx.input.mouse.y.toFixed(3) },
      focus: C._focusCamp === camp, held: V.controlsHeldBy,
      dist: +Math.hypot(V.position.x - camp.x, V.position.z - camp.z).toFixed(2),
      raise: camp.raise, visible: t.obj.visible, kind: t.item.kind,
      objScale: +t.obj.scale.x.toFixed(3),
      claims: { bike: window.__systems.bike?.pointerClaim, boat: window.__systems.boat?.pointerClaim },
      camps: C.camps.length,
    };
  })));
  check('night: the tent offers a sleep', offers.length > 0,
    `${offers.length}/9 points — ${swept.map((s) => `${s.dx},${s.dy}:"${s.text}"`).join(' | ')}`);
  check('one prompt at a time', offers.every((s) => s.others.length === 0),
    JSON.stringify(offers.map((s) => s.others)));
  // The centre-most hit, never `offers[0]`. The grid corners sit right on the
  // edge of a 1.05 m sphere at 17 m, so a corner that answered during the sweep
  // has fallen off it by the time the camera has eased another metre.
  const hit = offers.find((o) => o.dx === 0 && o.dy === 0) ?? offers[0] ?? { dx: 0, dy: 0 };
  const hoverTentHit = async () => { await hoverAt(hit.dx, hit.dy); await page.waitForTimeout(80); };
  await hoverTentHit();
  await page.screenshot({ path: `${DIR}/01-offer.png` });

  // Off the tent, the camp's own pack-up prompt comes back.
  await page.evaluate(() => {
    const C = window.__camp, cam = window.__ctx.camera;
    const t = C.camps[0].props.find((p) => p.item.kind === 'tent');
    const v = new window.__THREE.Vector3(t.item.x + 6, t.item.y, t.item.z + 6).project(cam);
    window.__off = { x: Math.round((v.x * 0.5 + 0.5) * innerWidth), y: Math.round((-v.y * 0.5 + 0.5) * innerHeight) };
  });
  const off = await page.evaluate(() => window.__off);
  await page.mouse.move(off.x, off.y);
  await page.waitForTimeout(260);
  const beside = await prompt();
  check('off the tent: no sleep offer', !/sleep/.test(beside.text), JSON.stringify(beside));

  // ── by day it is not offered, and does not swallow the pack-up ──────────
  await page.evaluate(() => { window.__lighting.hour = 12.0; });
  await page.waitForTimeout(500);
  await hoverTentHit();
  const day = await prompt();
  check('day: no sleep offer', !/sleep/.test(day.text), JSON.stringify(day));
  check('day: falls through to pack up', /pack up this camp/.test(day.text), JSON.stringify(day));
  await page.screenshot({ path: `${DIR}/02-day-fallthrough.png` });

  // ── back to night, and go to bed ────────────────────────────────────────
  await page.evaluate(() => { window.__lighting.hour = 22.0; });
  await page.waitForTimeout(500);
  await hoverTentHit();
  const armed = await prompt();
  check('armed to click', /sleep until morning/.test(armed.text), JSON.stringify(armed));
  const t0 = Date.now();
  await page.mouse.down(); await page.mouse.up();

  const shots = [[520, '03-falling.png'], [1500, '04-black.png'], [2600, '05-rising.png'], [4200, '06-morning.png']];
  const trace = [];
  const sample = () => page.evaluate(() => {
    const el = document.querySelector('.pa-sleep-fade');
    return { op: +(el?.style.opacity || 0), disp: el?.style.display, hour: +window.__lighting.hour.toFixed(2),
             active: !!window.__camp.sleep.active, held: window.__systems.vehicle.controlsHeldBy };
  });
  let next = 0;
  while (Date.now() - t0 < 5200) {
    const el = Date.now() - t0;
    trace.push({ ms: el, ...(await sample()) });
    if (next < shots.length && el >= shots[next][0]) {
      await page.screenshot({ path: `${DIR}/${shots[next][1]}` });
      next++;
    }
    await page.waitForTimeout(120);
  }

  const peak = Math.max(...trace.map((s) => s.op));
  const wasActive = trace.some((s) => s.active);
  const wasHeld = trace.some((s) => s.held === 'sleep');
  const last = trace[trace.length - 1];
  const warpAt = trace.find((s) => s.hour < 12);
  check('the screen went fully black', peak >= 0.999, `peak ${peak}`);
  check('the sleep ran', wasActive);
  check('the pedals were held while asleep', wasHeld);
  check('the clock was wound to morning', Math.abs(last.hour - 7.1) < 0.02, `hour ${last.hour}`);
  check('the warp happened under the black', !warpAt || warpAt.ms >= 1000,
    warpAt ? `first morning sample at ${warpAt.ms} ms` : 'never');
  check('it finished and let go', !last.active && last.op === 0 && last.disp === 'none' && last.held == null,
    JSON.stringify(last));

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  writeFileSync(`${DIR}/trace.json`, JSON.stringify(trace, null, 1));
  console.log(`\ntent -> screen ${geo.tent.x},${geo.tent.y}   style ${geo.style}   tent-to-fire ${geo.toFire} m\n`);
  console.log([...ok, ...bad].join('\n'));
  if (geo.bike && !Number.isFinite(geo.bike.toCam)) console.log('bike: absent');
  console.log(`\nbike at pitch: claim=${geo.bike?.claim} screen=${JSON.stringify(geo.bike?.screen)} ` +
    `(a null screen position means phys.y is NaN — see bike_physics.js:421)`);
  console.log(`\n${ok.length} passed, ${bad.length} failed   shots in ${DIR}/`);
  const band = trace.filter((s) => s.ms < 5000).map((s) => `${(s.ms / 1000).toFixed(1)}s ${s.op.toFixed(2)} h${s.hour}`);
  console.log(`\nfade:  ${band.join('  ')}`);

  await browser.close();
  release();
  process.exit(bad.length ? 1 : 0);
}
main();
