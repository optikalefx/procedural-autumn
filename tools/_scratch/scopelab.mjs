#!/usr/bin/env node
/**
 * scopelab — turntable a camp telescope that the layout only rolls 1 time in 6.
 *
 *   node tools/_scratch/scopelab.mjs --dir shots/camp/scope/r1 --variant reflector
 *   node tools/_scratch/scopelab.mjs --dir shots/camp/scope/r1 --variant refractor --small
 *
 * Same argument as `chairlab.mjs`, one step further along. `campshot
 * --turntable telescope` needs the layout to have placed one, and the whole
 * point of this prop is that it usually has not — waiting for the RNG is not a
 * capture strategy. So: pitch the camp exactly as campshot does, then build the
 * telescope directly and drop it where the layout would have put it (on the
 * flank behind the seats), keeping campshot's own framings so a lab frame and a
 * contact-sheet frame of the same object are the same picture.
 *
 * `--wide` also shoots the hearth framing with the scope in it, which is the
 * only frame that says whether the thing belongs in the camp at all — a prop
 * that is beautiful in a turntable and wrong in the wide shot is a failed prop.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
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

const DIR = arg('dir', 'shots/camp/scope/lab');
const VARIANT = arg('variant', 'reflector');
const PREFIX = arg('prefix', VARIANT);
const RES = arg('res', '768');
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const WEAR = parseFloat(arg('wear', '0.45'));

// campshot's PROP.telescope framing, verbatim.
const P = { az: 0.85, dist: 2.90, elev: 1.30, fov: 36, aim: 0.72 };
const SMALL_P = { az: 0.85, dist: 2.00, elev: 0.95, fov: 36, aim: 0.48 };

const release = await acquire('scopelab');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
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
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });

await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1600);

// ── latch the park brake BEFORE pitching, and leave it latched ─────────────
//
// This is not harness hygiene, it is the difference between photographing the
// game and photographing something no player can reach.
//
// The camper carries two 190-intensity spot lights that ramp on as the sun
// goes down and reach 68 m. A camp is pitched 8-18 m away, i.e. squarely in the
// beam. Latching the park brake dips them to 6% — and latching the park brake
// is the ONLY way a player can make a camp, so every camp a player has ever
// seen at dusk has been lit by dipped lamps. `pitchNear` skips the input path
// entirely, so this harness had been shooting every dusk frame under full
// headlights: a blown-out warm pool across the meadow that clipped the grass,
// the tripod and the tube alike.
//
// Two rounds of this telescope's albedo were spent darkening a white object
// until it read as steel-blue, chasing that pool. Cost of the missing line
// below: about two hours and a wrong answer that measured beautifully.
//
// Pressed as a real key, because `Vehicle.update` recomputes `brakeHold` from
// `axes.handbrake` every frame and overwrites anything set from outside. The
// latch survives the key coming back up — only driving clears it.
await page.keyboard.down('Space');
await page.waitForTimeout(700);
await page.keyboard.up('Space');
await page.waitForTimeout(2200);        // the dip eases in
const held = await page.evaluate(() => !!window.__systems.vehicle.brakeHold);
console.log(`park brake latched: ${held}${held ? '' : '  <-- headlights are UP, frames are wrong'}`);

const site = await page.evaluate(async ({ variant, wear, small, bearing }) => {
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14, small });
  if (!s) return null;
  const THREE = window.__THREE;
  const mod = await import('/src/camp/camp_telescope.js');
  const site = await import('/src/camp/camp_site.js');
  const { mulberry32 } = await import('/src/core/MathUtils.js');

  // Where the layout would have put it: on the flank behind the seats.
  const chairs = window.__camp.props.filter((p) => p.item.kind === 'chair');
  let ax = 0, az = 0;
  for (const c of chairs) { ax += c.item.x - s.x; az += c.item.z - s.z; }
  const seat = chairs.length ? Math.atan2(az, ax) : 0;
  const R = window.__camp.site?.radius ?? 5.8;
  const a = seat + (bearing ?? 1.7);
  const r = R * (small ? 0.48 : 0.50);
  const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
  const y = window.__world.getHeight(x, z);

  const g = mod.buildTelescope(mulberry32(0x51ed270b), { variant, wear });
  g.position.set(x, y, z);
  const q = new THREE.Quaternion();
  site.standOn(window.__world, x, z, Math.atan2(s.x - x, s.z - z), 0.22, q);
  g.quaternion.copy(q);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  window.__camp.root.add(g);
  window.__camp.props.push({ obj: g, item: { kind: 'telescope', x, y, z, yaw: Math.atan2(s.x - x, s.z - z) }, delay: 0 });

  const bb = new THREE.Box3().setFromObject(g);
  // Explicit fields, NOT `{ ...s }`.
  //
  // `pitchAt` returns the live camp record now, and that record carries `root`,
  // `fire` and `ground` — Object3Ds with parent pointers back into the scene
  // graph. Spreading it into a value that has to cross the Playwright boundary
  // serialises a circular structure and throws, which is how campshot's
  // SITE.json broke. Nothing here needs anything off the record except where
  // the fire is.
  return { fireX: s.x, fireZ: s.z, x, z, y, yaw: Math.atan2(s.x - x, s.z - z),
           height: bb.max.y - bb.min.y, minY: bb.min.y - y,
           foot: g.userData.footprint,
           vehAxis: Math.atan2(v.position.x - s.x, v.position.z - s.z) };
}, { variant: VARIANT, wear: WEAR, small: has('small'),
     bearing: arg('bearing', null) === null ? null : parseFloat(arg('bearing')) });

if (!site) { console.error('scopelab: no valid site'); await browser.close(); release(); process.exit(2); }
console.log(`scopelab: ${VARIANT} at ${site.x.toFixed(1)},${site.z.toFixed(1)} ` +
            `height ${site.height.toFixed(3)} m  minY ${site.minY.toFixed(4)}  foot ${site.foot.toFixed(3)}`);
mkdirSync(resolve(DIR), { recursive: true });

// The placement reticle used to need silencing here — the park brake is latched
// for the whole capture, which put the camp in its aiming state, and the ring
// was drawn wherever the capture camera happened to be pointed. That is fixed
// properly in `Camp.js` now (the reticle's visibility is gated on
// `__forceCamera`, with `window.__campForceAim` to opt back in), so the stub
// this file used to carry is gone.
//
// Worth remembering why it was a bad stub even while it worked: it suppressed
// the ring in MY frames and therefore removed the only evidence that a shared
// bug existed. Somebody else was shipping contact sheets with a cyan ring
// through the middle of them the whole time.

const F = VARIANT === 'refractor' ? SMALL_P : P;
const AZ = [
  ['front', 0.00, F.elev], ['fq', 0.75, F.elev], ['side', 1.57, F.elev],
  ['bq', 2.35, F.elev], ['back', 3.14, F.elev], ['high', 0.90, F.elev + F.dist * 0.75],
];
// Every job names its own hour. `--hour` on one frame freezes the cycle for the
// whole session, so a job list where only the dusk frame sets one shoots every
// frame AFTER it at dusk too — which is how the first run produced a "midday"
// camp frame lit by the fire.
const DAY = parseFloat(arg('hour', '11.0'));
const jobs = AZ.map(([name, az, elev]) => ({ name: `${PREFIX}-${name}`, f: { ...F, az, elev }, hour: DAY }));
jobs.push({ name: `${PREFIX}-dusk`, f: { ...F, az: 0.85 }, hour: 20.4 });
if (has('wide')) {
  jobs.push({ name: `${PREFIX}-camp`, f: { az: 0.85, dist: 8.2, elev: 2.2, fov: 46, aim: 1.1 }, hour: DAY });
  jobs.push({ name: `${PREFIX}-campdusk`, f: { az: 0.85, dist: 8.2, elev: 2.2, fov: 46, aim: 1.1 }, hour: 20.4 });
}

// Every frame is written with a `.rect.json` beside it: the telescope's own
// bounding box, projected into pixels, so `scopevalue.mjs` can measure THIS
// PROP rather than whatever else in the frame happens to be bright.
//
// Two instruments were tried before this one and both lied.
//
//  · A chroma mask found 37,000 near-neutral bright pixels in a camp frame
//    where the telescope occupies about 5,000. What it was reporting was a
//    large blown-out warm pool on the grass that has nothing to do with this
//    prop, and on that evidence a full stop was taken off the enamel for no
//    reason.
//  · Hiding the object and differencing two captures — which is the textbook
//    answer — found 300,000 to 1,100,000 "prop" pixels. The world is animated:
//    grass moves, leaves fall, the fire flickers, and the temporal resolve
//    never lands on the same pixel twice. A difference mask in a living scene
//    measures the wind.
//
// A projected rectangle cannot be fooled by either, costs one matrix per frame,
// and is exact.

for (const job of jobs) {
  const rect = await page.evaluate(async ({ f, hour, W, H }) => {
    const THREE = window.__THREE, e = window.__engine;
    if (hour !== null) { window.__lighting.hour = hour; window.__lighting.cycleSpeed = 0; }
    const prop = window.__camp.props.find((q) => q.item.kind === 'telescope');
    const p = prop.item;
    const a = p.yaw + f.az;
    e.camera.fov = f.fov;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(p.x + Math.sin(a) * f.dist, p.y + f.elev, p.z + Math.cos(a) * f.dist);
    e.camera.lookAt(new THREE.Vector3(p.x, p.y + f.aim, p.z));
    window.__forceCamera = true;
    if (window.__settleStable) await window.__settleStable(600, 24);

    // Project the prop's eight bounding-box corners after the camera is posed.
    e.camera.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(prop.obj);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
      v.project(e.camera);
      const px = (v.x * 0.5 + 0.5) * W, py = (-v.y * 0.5 + 0.5) * H;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
    const pad = 3;
    return {
      x: Math.max(0, Math.floor(x0 - pad)), y: Math.max(0, Math.floor(y0 - pad)),
      w: Math.min(W, Math.ceil(x1 + pad)) - Math.max(0, Math.floor(x0 - pad)),
      h: Math.min(H, Math.ceil(y1 + pad)) - Math.max(0, Math.floor(y0 - pad)),
    };
  }, { f: job.f, hour: job.hour, W, H });
  await page.waitForTimeout(600);

  // Assert the frame is clean before taking it.
  //
  // `CampPrompt.set` early-outs on an unchanged string, so a prompt that was
  // already showing when `__forceCamera` went up never asks about it again and
  // stays visible for every frame of a capture. "E pack up this camp" is
  // legible across the middle of at least one shipped contact sheet. This
  // harness latches the park brake, which is exactly the state that raises a
  // prompt, so it is the most likely tool in the project to reproduce it.
  const dirt = await page.evaluate(() => {
    const p = document.querySelector('.pa-camp-prompt');
    return { text: p?.textContent?.trim() ?? '', op: p ? +getComputedStyle(p).opacity : 0 };
  });
  if (dirt.op > 0.02 && dirt.text) {
    console.log(`  !! prompt visible in frame: "${dirt.text}" (opacity ${dirt.op})`);
  }

  const out = resolve(DIR, `${job.name}.png`);
  await page.screenshot({ path: out });
  writeFileSync(resolve(DIR, `${job.name}.rect.json`), JSON.stringify(rect));

  // A twin with the contact pool hidden, so its effect on the GROUND can be
  // measured by difference instead of argued about. Only worth taking on the
  // plan view, which is the frame the float is judged from.
  if (job.name.endsWith('-high')) {
    await page.evaluate(async () => {
      const p = window.__camp.props.find((q) => q.item.kind === 'telescope');
      p.obj.traverse((o) => { if (o.name?.startsWith('telescope_contact')) o.visible = false; });
      if (window.__settleStable) await window.__settleStable(400, 20);
    });
    await page.waitForTimeout(350);
    await page.screenshot({ path: resolve(DIR, `${job.name}.nocontact.png`) });
    await page.evaluate(async () => {
      const p = window.__camp.props.find((q) => q.item.kind === 'telescope');
      p.obj.traverse((o) => { if (o.name?.startsWith('telescope_contact')) o.visible = true; });
      if (window.__settleStable) await window.__settleStable(300, 16);
    });
    await page.waitForTimeout(250);
  }
  console.log(`shot: ${out}  rect ${rect.w}x${rect.h}`);

  // ── the mask frame ──────────────────────────────────────────────────────
  //
  // The third instrument, and the one that works. The projected rectangle
  // narrowed the search but could not say which pixels inside it are the prop:
  // at dusk this camp has a large blown-out warm pool on the grass, blown-out
  // grass is white, white is near-neutral, and the neutral test cheerfully
  // counted it as telescope. It reported 40% of the prop clipped in a frame
  // whose tube is visibly fine.
  //
  // So the prop paints itself flat magenta for one extra frame, from the same
  // camera pose. Magenta appears nowhere in this game's palette, so the mask is
  // unambiguous, and it is a real render — anything occluding the telescope
  // (grass in front of a leg) correctly fails to be masked. `scopevalue.mjs`
  // then measures exactly those pixels in the real frame.
  if (!has('nomask')) {
    await page.evaluate(async () => {
      const T = window.__THREE;
      const p = window.__camp.props.find((q) => q.item.kind === 'telescope');
      window.__scopeMaskSaved = [];
      p.obj.traverse((o) => {
        if (!o.isMesh) return;
        // The contact pool is NOT the prop. It is a darkening laid on the
        // ground, so painting it magenta would put a square metre of "prop" on
        // the floor and every value the mask reports would be a blend of the
        // telescope and its own shadow.
        if (o.name.startsWith('telescope_contact')) return;
        window.__scopeMaskSaved.push([o, o.material]);
        o.material = new T.MeshBasicMaterial({ color: 0xff00ff, fog: false });
      });
      if (window.__settleStable) await window.__settleStable(400, 20);
    });
    await page.waitForTimeout(350);
    await page.screenshot({ path: resolve(DIR, `${job.name}.mask.png`) });
    await page.evaluate(async () => {
      for (const [o, m] of window.__scopeMaskSaved) { o.material.dispose(); o.material = m; }
      window.__scopeMaskSaved = null;
      if (window.__settleStable) await window.__settleStable(300, 16);
    });
    await page.waitForTimeout(250);
  }
}

if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));
await browser.close();
release();
