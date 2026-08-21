#!/usr/bin/env node
/**
 * Camp contact sheet.
 *
 *   node tools/campshot.mjs --dir shots/camp/r1
 *   node tools/campshot.mjs --dir shots/camp/r1 --only chair,tent
 *   node tools/campshot.mjs --dir shots/camp/r1 --turntable chair   # 7 angles, one load
 *   node tools/campshot.mjs --dir shots/camp/r1 --small        # the compact camp
 *   node tools/campshot.mjs --dir shots/camp/r1 --hour 20.4
 *   node tools/campshot.mjs --dir shots/camp/r1 --studio        # props only, in situ
 *   node tools/campshot.mjs --dir shots/camp/r1 --reticle       # the placement UI
 *
 * One browser, one bake, one camp — then every framing the set needs judging
 * from. Six people are authoring props in this round and each of them would
 * otherwise pay a 25-second bake per look.
 *
 * Two kinds of framing:
 *
 *   · **site** framings look at the whole camp, and are what decides whether
 *     the arrangement is calm. Judge these first; a set of beautiful props in a
 *     bad arrangement is a bad camp, and it is easy to spend a whole round
 *     polishing a cooler while the layout is what is wrong.
 *   · **prop** framings are close on one object. `az` is measured from the
 *     prop's own facing, so a chair is always shot three-quarter-front no
 *     matter which way the layout happened to turn it.
 *
 * The camp is pitched through `window.__camp.pitchNear()` rather than by
 * synthesising a handbrake and a mouse click. That is deliberate: a harness
 * that has to drive the input mapping breaks whenever the input mapping is
 * touched, and then six authors are debugging a capture tool instead of
 * looking at their work.
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

// ── site framings: the camp as a place ───────────────────────────────────────
// `az` is measured from the camp's own seating axis, so `front` is always the
// view across the fire from behind the chairs — the shot the feature is for.
//
// `ref` picks what `az` is measured from: the camp's own seating axis by
// default, or `vehicle` — the bearing from the fire to the camper. The second
// exists because the first put the camera *inside* the camper on the very
// first run: the seating axis has no relationship to where the player happened
// to park, so a framing that wants the camper in the background has to be told
// where the camper is.
const SITE = {
  // The frame this whole round is judged on: eye level, chairs and fire, the
  // camper in the background.
  //
  // az is measured from the bearing fire -> camper, so az 0 stands BETWEEN the
  // fire and the camper — which, with the camper 8 m out and the camera 8.5 m
  // out, is inside the camper. That is exactly what the first two runs of this
  // framing produced: a full-frame photograph of a red door panel. pi puts the
  // camera on the far side of the fire with the camper behind it, which is the
  // shot this framing was always described as.
  hearth:  { az: 3.14, dist: 8.5,  elev: 1.55, fov: 46, aim: 0.55, ref: 'vehicle' },
  // Three-quarter from the tent side, so the tent has a silhouette against the
  // valley rather than being seen end-on.
  tentside:{ az: 2.05, dist: 9.5,  elev: 1.75, fov: 44, aim: 0.7 },
  // Low and close: the fire fills the lower third. Where the flame is judged.
  fireside:{ az: 0.75, dist: 3.3,  elev: 0.62, fov: 40, aim: 0.35 },

  // From behind the camper's own door, which is the angle the player actually
  // arrives at: az 0 is the camper's side of the fire, pushed out past it.
  arrival: { az: 0.0,  dist: 15.0, elev: 2.6,  fov: 50, aim: 0.8, ref: 'vehicle' },
  // Overhead-ish: reads the *arrangement* with nothing else to look at. If the
  // layout is a ring of evenly spaced objects, this is the frame that says so.
  plan:    { az: 1.2,  dist: 11.0, elev: 9.5,  fov: 46, aim: 0.0 },
  // Wide, with the camper: the scale check. Every prop in this set is small,
  // and scale errors are invisible until something known is beside them.
  wide:    { az: 2.35, dist: 22.0, elev: 5.0,  fov: 42, aim: 0.9, ref: 'vehicle' },
};

// ── prop framings: one object, three-quarter front, close ────────────────────
const PROP = {
  tent:     { az: 0.80, dist: 3.9, elev: 1.35, fov: 38, aim: 0.55 },
  chair:    { az: 0.75, dist: 1.85, elev: 0.85, fov: 36, aim: 0.42 },
  cooler:   { az: 0.65, dist: 1.35, elev: 0.55, fov: 34, aim: 0.24 },
  table:    { az: 0.70, dist: 1.55, elev: 0.72, fov: 34, aim: 0.30 },
  woodpile: { az: 0.85, dist: 1.45, elev: 0.62, fov: 34, aim: 0.20 },
  fire:     { az: 0.60, dist: 1.90, elev: 0.75, fov: 36, aim: 0.30 },
};

const RES = arg('res', '768');
const HOUR = arg('hour', null);
const DIR = arg('dir', 'shots/camp/r');
const ONLY = arg('only', null) === true ? null : arg('only', null)?.split(',');
const PARK = arg('park', 'meadow');
const SEED = arg('seed', null);
const TURNTABLE = arg('turntable', null);
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const URL = `${arg('url', 'http://localhost:5178')}?res=${RES}`;

async function main() {
  const release = await acquire('campshot');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  // Six authors share one dev server this round; every save reloads the page
  // and throws out whatever evaluate was in flight. Stub the HMR socket so a
  // contact sheet is not a coin toss. `--hmr` keeps live reload.
  if (!has('hmr')) {
    await page.addInitScript(() => {
      const Real = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
          return {
            readyState: 3, url, protocol: '',
            addEventListener() {}, removeEventListener() {}, send() {}, close() {},
            set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {},
          };
        }
        return new Real(url, protocols);
      };
      window.WebSocket.prototype = Real.prototype;
    });
  }
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle,
    null, { timeout: 30000 });

  // Park somewhere open. Judging a camp while the camper is buried in a thicket
  // tells you about the thicket — the same lesson vshot.mjs learned.
  await page.evaluate((kind) => {
    const p = window.__poi.best(kind) ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
  }, PARK === true ? 'meadow' : PARK);
  await page.waitForTimeout(1600);          // springs settle, streaming catches up

  if (has('small')) await page.evaluate(() => { window.__campSmall = true; });
  const site = await page.evaluate((seed) => {
    const v = window.__systems.vehicle;
    if (seed !== null) window.__camp.__seed = parseInt(seed, 10);
    const s = window.__camp.pitchNear(v.position.x, v.position.z,
      { instant: true, radius: 14, small: window.__campSmall === true });
    if (!s) return null;
    // The seating axis, so every framing below is relative to the camp's own
    // orientation rather than to whichever way the world happens to face.
    const chairs = window.__camp.props.filter((p) => p.item.kind === 'chair');
    let ax = 0, az = 0;
    for (const c of chairs) { ax += c.item.x - s.x; az += c.item.z - s.z; }
    const axis = chairs.length ? Math.atan2(ax, az) : 0;
    return { ...s, radius: window.__camp.site?.radius ?? 5.8,
      small: !!window.__camp.site?.small, axis,
      vehAxis: Math.atan2(v.position.x - s.x, v.position.z - s.z),
      props: window.__camp.props.map((p) => ({
      kind: p.item.kind, x: p.item.x, y: p.item.y, z: p.item.z, yaw: p.item.yaw })) };
  }, SEED);

  if (!site) {
    console.error((has('small') ? 'camp: no COMPACT-only site near the camper — try another --park. '
                                : 'camp: pitchNear found no valid site near the camper. ') +
                  'Try --park road, or --park vista.');
    await browser.close(); release(); process.exit(2);
  }
  console.log(`camp at ${site.x.toFixed(1)}, ${site.z.toFixed(1)} — ` +
              site.props.map((p) => p.kind).join(', '));

  mkdirSync(resolve(DIR), { recursive: true });
  writeFileSync(resolve(DIR, 'SITE.json'), JSON.stringify(site, null, 1));

  const jobs = [];

  // ── turntable ─────────────────────────────────────────────────────────────
  //
  // `--turntable chair` shoots ONE prop from every angle that decides whether
  // it is any good, plus a dusk frame, in a single page load.
  //
  // This exists for throughput and the arithmetic is the whole argument. Six
  // authors are iterating on this set at once, the capture pool holds two
  // slots, and a page load is most of a minute. An author who wants six angles
  // by running `--only chair` six times pays six lock acquisitions and six page
  // loads for six frames, and with five peers queued ahead of them that is
  // twenty minutes for one look at their work. One acquisition, one load, seven
  // frames — and the frames are of the *same* camp, which also means an author
  // is never comparing two angles that were shot on two different layouts.
  if (TURNTABLE) {
    const kind = TURNTABLE === true ? 'chair' : TURNTABLE;
    const P = PROP[kind];
    if (!P) { console.error(`no such prop: ${kind}. one of: ${Object.keys(PROP).join(', ')}`); process.exit(2); }
    if (kind !== 'fire' && !site.props.some((p) => p.kind === kind)) {
      console.error(`this layout placed no ${kind}. Try a different --seed or --park.`);
      await browser.close(); release(); process.exit(2);
    }
    // Front, three-quarter, side, back-three-quarter, back, and a high plan.
    // Six azimuths rather than four: the failure the four-view sheet misses is
    // a prop that is beautiful from the front and hollow from behind, and the
    // player drives around a camp rather than standing in front of it.
    const AZ = [
      ['front',   0.00, P.elev],
      ['fq',      0.75, P.elev],
      ['side',    1.57, P.elev],
      ['bq',      2.35, P.elev],
      ['back',    3.14, P.elev],
      ['high',    0.90, P.elev + P.dist * 0.9],
    ];
    for (const [name, az, elev] of AZ) {
      jobs.push({ name: `${kind}-${name}`, kind, f: { ...P, az, elev } });
    }
    // Dusk, because the fire is the only light after sundown and every one of
    // these props is judged twice: once against the sun and once against the
    // flame. A prop that reads at 17:00 and goes to mush at 20:30 is not done.
    jobs.push({ name: `${kind}-dusk`, kind, f: { ...P, az: 0.75 }, hour: 20.4 });
  } else {
    if (!has('studio')) {
      for (const [name, f] of Object.entries(SITE)) {
        if (ONLY && !ONLY.includes(name)) continue;
        jobs.push({ name, f, kind: null });
      }
    }
    for (const [kind, f] of Object.entries(PROP)) {
      if (ONLY && !ONLY.includes(kind)) continue;
      // The fire is not in `props` — it is the camp's own centre.
      if (kind !== 'fire' && !site.props.some((p) => p.kind === kind)) {
        console.log(`skip ${kind}: this layout did not place one`);
        continue;
      }
      jobs.push({ name: `prop-${kind}`, f, kind });
    }
  }

  for (const job of jobs) {
    await page.evaluate(async ({ f, kind, site, hour }) => {
      const THREE = window.__THREE, e = window.__engine;
      if (hour !== null) { window.__lighting.hour = parseFloat(hour); window.__lighting.cycleSpeed = 0; }

      // Site framings are quoted against the full 5.8 m camp. A compact camp
      // is 4.2 m across the same furniture, so a fixed 8.5 m boom stands
      // outside its clearing — the first compact capture was a photograph of
      // knee-high grass with the camp somewhere behind it. Scale the boom with
      // the camp, floored so a close framing does not end up inside the tent.
      const K = Math.max(0.62, (site.radius ?? 5.8) / 5.8);
      let cx, cy, cz, base;
      if (kind && kind !== 'fire') {
        const p = window.__camp.props.find((q) => q.item.kind === kind)?.item;
        cx = p.x; cy = p.y; cz = p.z; base = p.yaw;
      } else {
        cx = site.x; cy = site.y; cz = site.z;
        base = f.ref === 'vehicle' ? site.vehAxis : site.axis;
      }
      const a = base + f.az;
      const centre = new THREE.Vector3(cx, cy + f.aim, cz);
      // DISTANCE scales with the camp; HEIGHT does not. Scaling both put the
      // lens at 1.1 m, which is inside a half-metre meadow's grass canopy once
      // you allow for the blades nearest the camera — the compact capture came
      // back as a photograph of grass with a camp somewhere behind it. The eye
      // stays above the canopy and only the boom comes in.
      const dist = f.dist * (kind ? 1 : K);
      const pos = new THREE.Vector3(
        cx + Math.sin(a) * dist, cy + f.elev, cz + Math.cos(a) * dist);
      e.camera.fov = f.fov;
      e.camera.updateProjectionMatrix();
      e.camera.position.copy(pos);
      e.camera.lookAt(centre);
      window.__forceCamera = true;
      // Converged settle, not a fixed frame count. A fixed count is what
      // quietly corrupted every contact sheet in review/ — see the note on
      // __settleStable in main.js.
      if (window.__settleStable) await window.__settleStable(600, 24);
    }, { f: job.f, kind: job.kind, site, hour: job.hour ?? HOUR });
    await page.waitForTimeout(600);
    const out = resolve(DIR, `${job.name}.png`);
    await page.screenshot({ path: out });
    console.log(`shot: ${out}`);
  }

  // ── the placement UI ──────────────────────────────────────────────────────
  // Shot last, because it strikes the camp to get the reticle back.
  if (has('reticle')) {
    await page.evaluate(async () => {
      const THREE = window.__THREE, e = window.__engine;
      const camp = window.__camp, v = window.__systems.vehicle;
      camp.strike();
      // Drive the aim directly. `__forceCamera` suppresses the mouse path in
      // `_aimAt`, so this is the camera-forward branch — which is also what a
      // gamepad player gets, and therefore worth photographing.
      const a = v.heading + 0.9;
      e.camera.fov = 52; e.camera.updateProjectionMatrix();
      e.camera.position.set(v.position.x - Math.sin(a) * 9, v.position.y + 4.2, v.position.z - Math.cos(a) * 9);
      e.camera.lookAt(v.position.x + Math.sin(a) * 10, v.position.y - 1.4, v.position.z + Math.cos(a) * 10);
      window.__forceCamera = true;
      camp.state = 'aiming';
      for (let i = 0; i < 40; i++) { camp.update(1 / 60, i / 60); await new Promise(requestAnimationFrame); }
      if (window.__settleStable) await window.__settleStable(400, 20);
    });
    await page.waitForTimeout(500);
    const out = resolve(DIR, 'reticle.png');
    await page.screenshot({ path: out });
    console.log(`shot: ${out}`);
  }

  const stats = await page.evaluate(() => ({
    fps: window.__fps ?? null,
    calls: window.__engine?.renderer?.info?.render?.calls ?? null,
    tris: window.__engine?.renderer?.info?.render?.triangles ?? null,
  }));
  console.log('stats:', JSON.stringify(stats));
  if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));
  await browser.close();
  release();
}

main().catch((e) => { console.error(e); process.exit(1); });
