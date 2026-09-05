/**
 * Does the telescope render the world, or only the sky?
 *
 * Three loads, one question. The capture harness reports sky-only through the
 * eyepiece while an ordinary camera in the same run sees terrain — but "the
 * harness breaks it" was an inference from that plus one screenshot, so this
 * takes the harness apart: a PLAIN page load with no capture URL params and no
 * granted clock, versus the harness URL, versus the harness URL with the clock
 * replaced the way trailer.mjs replaces it.
 */
import { chromium } from 'playwright';
const AT = [909.28, -160.15, -1.529];
const URLS = {
  plain:   'http://127.0.0.1:5193/?seed=5',
  params:  'http://127.0.0.1:5193/?seed=5&car=roamer&quality=high&pixelratio=native&iscale=1',
  clocked: 'http://127.0.0.1:5193/?seed=5&car=roamer&quality=high&pixelratio=native&iscale=1',
};
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
for (const [name, url] of Object.entries(URLS)) {
  const p = await b.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
  await p.addInitScript(() => {
    try { const k='pa.hud'; const s=JSON.parse(localStorage.getItem(k)??'{}')||{};
      s.introSeen=true; s.seenHint=true; s.escSeen=true; localStorage.setItem(k, JSON.stringify(s)); } catch {}
  });
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  if (name === 'clocked') {
    await p.evaluate(() => {                       // exactly what trailer.mjs does
      const e = window.__engine; e.adaptive = false; e.autoQuality = false;
      const DT = 1 / 60; let budget = 0;
      window.__grant = () => { budget += DT; };
      e.clock.getDelta = () => { if (budget <= 1e-9) return 0; budget -= DT; return DT; };
    });
  }
  const grant = async (n) => {
    for (let i = 0; i < n; i++) {
      await p.evaluate(() => new Promise((r) => {
        window.__grant?.(); requestAnimationFrame(() => requestAnimationFrame(() => r(1)));
      }));
    }
  };
  await p.evaluate((a) => window.__vehicleTeleport?.(a[0], a[1], a[2]), AT);
  await (name === 'clocked' ? grant(120) : p.waitForTimeout(2500));
  // A camp with a telescope in it: the prop is a 0.40 roll, so jitter and probe.
  const got = await p.evaluate(() => {
    const v = window.__systems.vehicle;
    for (let i = 0; i < 28; i++) {
      const a = i * 0.9, r = (i % 7) * 3.0;
      const c = window.__camp.pitchNear(v.position.x + Math.cos(a) * r,
                                        v.position.z + Math.sin(a) * r,
                                        { instant: true, radius: 24 });
      if (c) {
        const camp = window.__camp.camps[window.__camp.camps.length - 1];
        const t = (camp?.props ?? []).find((pr) => pr.obj?.userData?.telescope);
        if (t) { window.__systems.camp.scope.enter(t.obj); return true; }
      }
      window.__camp.strike();
    }
    return false;
  });
  await (name === 'clocked' ? grant(90) : p.waitForTimeout(1800));
  const st = await p.evaluate(() => {
    const s = window.__systems?.camp?.scope;
    return { entered: !!s?.active, fov: s?.fov, tier: window.__postfx?.tier,
             preset: window.__postfx?.preset };
  });
  // Aim just below level, where terrain must be if it renders at all.
  await p.evaluate(() => {
    const s = window.__systems.camp.scope;
    s._aim.set(-0.3744, -0.1045, 0.9213).normalize();
    s.fov = s.fovTarget = 34;
  });
  await (name === 'clocked' ? grant(30) : p.waitForTimeout(700));
  await p.screenshot({ path: `shots/trailer/scopecheck-${name}.png` });
  console.log(name.padEnd(8), 'telescope:', got, JSON.stringify(st));
  await p.close();
}
await b.close();
