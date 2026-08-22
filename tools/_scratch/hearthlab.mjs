#!/usr/bin/env node
/**
 * Hearth lab — one camp, N runtime variants, N framings, N hours.
 *
 *   node tools/_scratch/hearthlab.mjs --dir review/x --variants base,l14
 *   node tools/_scratch/hearthlab.mjs --dir review/x --hours 8,12,16.7,20.4,23
 *
 * Exists to answer "which stage turns the fire's pool lavender" without paying
 * a 60 s page load per hypothesis. Variants are plain snippets evaluated in the
 * page against window.__postfx / window.__fireTune, so this can sweep the
 * shipping look without editing a source file.
 *
 * `--hours` is the second axis and it is the one that catches the failure a
 * night-only sweep cannot see: a fire tuned until it reads at 23:00 is a fire
 * nobody has looked at with the sun up, and the whole point of the light is
 * that the camp has one at every hour.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); if (i === -1) return d;
  const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true; };

const DIR = arg('dir', 'review/fire-night/lab');
const HOURS = (arg('hours', null) === true || arg('hours', null) === null
  ? [parseFloat(arg('hour', '23'))]
  : String(arg('hours')).split(',').map(parseFloat));
const URL = `${arg('url', 'http://localhost:5180')}?res=${arg('res', '768')}`;
const W = parseInt(arg('w', '1280'), 10), H = parseInt(arg('h', '720'), 10);
const VARIANTS = (arg('variants', 'base') === true ? 'base' : arg('variants', 'base')).split(',');
const FRAMINGS = (arg('framings', 'hearth') === true ? 'hearth' : arg('framings', 'hearth')).split(',');

const SITE_F = {
  hearth:  { az: 3.14, dist: 8.5, elev: 1.55, fov: 46, aim: 0.55, ref: 'vehicle' },
  fireside:{ az: 0.75, dist: 3.3, elev: 0.62, fov: 40, aim: 0.35 },
  tentside:{ az: 2.05, dist: 9.5, elev: 1.75, fov: 44, aim: 0.7 },
  plan:    { az: 1.2,  dist: 11.0, elev: 9.5, fov: 46, aim: 0.0 },
};

// Each variant is a body evaluated in the page. `reset` runs first every time.
const APPLY = `
  const P = window.__postfx, L = P?.look;
  window.__fireTune = { gain:1, light:1, dist:1, decay:NaN, bed:1, ember:1, smoke:1, knee:1, elev:NaN };
  if (L) { L.rodAmount = 0.50; }
`;

const V = {
  base:      '',
  norod:     'window.__postfx.look.rodAmount = 0.0;',
  nolight:   'window.__fireTune.light = 0.0001;',
};
// d<I>r<R>: the DAY end of the intensity ramp at I/10, day reach at R/10 m.
// The knob that matters with the sun up, and the one a night-only ladder never
// touches — the fire is a fifth of the sun at noon and the tone curve is
// already compressing the ground it would land on.
for (const i of [9, 15, 22, 30, 40, 55, 75]) {
  for (const r of [60, 86, 110]) {
    V[`d${i}r${r}`] = `window.__fireTune.dayI = ${i / 10}; ` +
      `window.__fireTune.dist = ${(r / 10) / (8.6 * 0.70)};`;
  }
}
// l<N>d<D>: intensity multiplier N/10, reach multiplier D/10.
for (const li of [10, 14, 18, 22, 28, 36]) {
  for (const di of [10, 13, 16, 20]) {
    V[`l${li}d${di}`] = `window.__fireTune.light = ${li / 10}; window.__fireTune.dist = ${di / 10};`;
  }
}
// k<K>l<N>d<D>: decay K/10 with the same two multipliers.
for (const k of [12, 14, 16, 18]) {
  for (const li of [6, 8, 10, 13]) {
    for (const di of [13, 16]) {
      V[`k${k}l${li}d${di}`] =
        `window.__fireTune.decay = ${k / 10}; window.__fireTune.light = ${li / 10}; ` +
        `window.__fireTune.dist = ${di / 10};`;
    }
  }
}

async function main() {
  const release = await acquire('hearthlab');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (String(protocols).includes('vite')) return { readyState: 3, url, protocol: '',
        addEventListener(){}, removeEventListener(){}, send(){}, close(){},
        set onopen(_){}, set onmessage(_){}, set onclose(_){}, set onerror(_){} };
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

  await page.evaluate(() => {
    const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
  });
  await page.waitForTimeout(1600);
  await page.keyboard.down('Space'); await page.waitForTimeout(1000);
  await page.keyboard.up('Space'); await page.waitForTimeout(2400);

  const site = await page.evaluate(() => {
    const v = window.__systems.vehicle;
    const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
    if (!s) return null;
    const chairs = window.__camp.props.filter((p) => p.item.kind === 'chair');
    let ax = 0, az = 0;
    for (const c of chairs) { ax += c.item.x - s.x; az += c.item.z - s.z; }
    return { x: s.x, y: s.y, z: s.z, radius: s.radius,
      axis: chairs.length ? Math.atan2(ax, az) : 0,
      vehAxis: Math.atan2(v.position.x - s.x, v.position.z - s.z) };
  });
  if (!site) { console.error('no camp site'); await browser.close(); release(); process.exit(2); }
  console.log(`camp at ${site.x.toFixed(1)}, ${site.z.toFixed(1)}`);

  mkdirSync(resolve(DIR), { recursive: true });
  const probes = {};

  for (const fname of FRAMINGS) {
    const f = SITE_F[fname];
    for (const hour of HOURS) {
    for (const vname of VARIANTS) {
      if (V[vname] === undefined) { console.error(`no variant ${vname}`); continue; }
      await page.evaluate(async ({ f, site, hour, body, apply }) => {
        const THREE = window.__THREE, e = window.__engine;
        window.__lighting.hour = hour; window.__lighting.cycleSpeed = 0;
        // eslint-disable-next-line no-new-func
        new Function(apply + '\n' + body)();
        const K = Math.max(0.62, (site.radius ?? 5.8) / 5.8);
        const base = f.ref === 'vehicle' ? site.vehAxis : site.axis;
        const a = base + f.az, dist = f.dist * K;
        e.camera.fov = f.fov; e.camera.updateProjectionMatrix();
        e.camera.position.set(site.x + Math.sin(a) * dist, site.y + f.elev, site.z + Math.cos(a) * dist);
        e.camera.lookAt(new THREE.Vector3(site.x, site.y + f.aim, site.z));
        window.__forceCamera = true;
        if (window.__settleStable) await window.__settleStable(600, 24);
      }, { f, site, hour, body: V[vname], apply: APPLY });
      await page.waitForTimeout(500);
      // The hour goes in the filename only when there is more than one, so a
      // single-hour run still pairs with tools/_scratch/pxdiff.mjs, which
      // matches two directories by basename.
      const tag = HOURS.length > 1 ? `-h${String(hour).replace('.', '')}` : '';
      const name = `${fname}-${vname}${tag}`;
      await page.screenshot({ path: resolve(DIR, `${name}.png`) });
      probes[name] = await page.evaluate(() => ({
        hour: window.__lighting?.hour ?? null,
        sunElev: +(window.__lighting?.sunElev ?? window.__lighting?.state?.sunElev ?? 0).toFixed(3),
        fireI: +(window.__camp?.fireLight?.intensity ?? -1).toFixed(3),
        fireD: +(window.__camp?.fireLight?.distance ?? -1).toFixed(2),
        sunI: +(window.__lighting?.sun?.intensity ?? -1).toFixed(3),
        hemiI: +(window.__lighting?.hemi?.intensity ?? -1).toFixed(3),
        dayF: +(window.__lighting?.dayFactor ?? -1).toFixed(3),
        nightF: +(window.__lighting?.nightFactor ?? -1).toFixed(3),
      }));
      console.log(`shot ${name}`, JSON.stringify(probes[name]));
    }
    }
  }
  writeFileSync(resolve(DIR, 'PROBES.json'), JSON.stringify(probes, null, 1));
  if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 6), null, 1));
  await browser.close(); release();
}
main().catch((e) => { console.error(e); process.exit(1); });
