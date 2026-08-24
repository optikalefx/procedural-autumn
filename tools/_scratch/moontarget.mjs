import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('moon');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 800, height: 500 } });
p.on('pageerror', (e) => console.log('PAGEERR', e.message));
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
        set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
  try { localStorage.removeItem('pa.stats'); } catch {}
});
await p.goto(`${process.env.AUTUMN_URL}/?seed=20261018&res=512&car=camper&quality=low`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });

console.log(await p.evaluate(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const camp = window.__systems.camp;
  const { SKY_STATE } = await import('/src/render/Lighting.js');
  // Walk the clock until the moon is well clear of the skyline.
  let hour = null;
  for (let h = 0; h < 24; h += 0.25) {
    window.__lighting.hour = h;
    await frame();
    if (SKY_STATE.moonDir.y > 0.45) { hour = h; break; }
  }
  if (hour === null) return { error: 'the moon never rose' };

  // The pointing test on its own first — the moon is the only target resolved
  // from a live uniform rather than a fixed direction, and that branch is what
  // this script exists to prove.
  const { skyTargetAt } = await import('/src/game/sky_objects.js');
  const aim = SKY_STATE.moonDir.clone();
  const hit = skyTargetAt(aim, 18, SKY_STATE)?.id ?? null;
  // …and the horizon gate, which must refuse a moon that has set.
  const down = { ...SKY_STATE, moonDir: { x: aim.x, y: -0.5, z: aim.z } };
  const hitDown = skyTargetAt(aim, 18, down)?.id ?? null;

  // Then the whole path through a real eyepiece. Camps are struck between
  // pitches and moved 40 m each time: the site scorer refuses ground that
  // overlaps an existing camp, so pitching repeatedly in one spot simply
  // fails, and a run that did that reported "no telescope" fourteen times.
  let prop = null;
  const v = window.__systems.vehicle.position.clone();
  for (let i = 0; i < 14 && !prop; i++) {
    camp.strike();
    for (let f = 0; f < 6; f++) await frame();
    camp.pitchNear(v.x + i * 40, v.z + i * 40, {});
    for (let f = 0; f < 30; f++) await frame();
    prop = camp.camps.flatMap((c) => c.props)
      .find((pp) => pp.item?.kind === 'telescope' && pp.obj?.userData?.telescope)?.obj ?? null;
  }
  if (!prop) return { error: 'no telescope in 14 pitches', hit, hitDown };

  // Park properly first. `Camp._interact` drops the player out of the eyepiece
  // the moment the camper is doing more than 0.6 m/s — correct behaviour, and
  // the reason the first version of this script found nothing: it left the
  // camper creeping down a hillside, so the scope closed on the frame after it
  // opened. A rescue puts it on clear, level ground.
  window.__systems.vehicle.rescue();
  for (let i = 0; i < 120; i++) await frame();
  const settled = Math.abs(window.__systems.vehicle.speed);

  const scope = camp.scope;
  scope.enter(prop);
  for (let i = 0; i < 60; i++) await frame();
  const stayedOpen = scope.active;
  const d = SKY_STATE.moonDir;
  scope.yaw = Math.atan2(-d.x, -d.z);
  scope.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
  for (let i = 0; i < 40; i++) await frame();
  scope.leave();
  for (let i = 0; i < 30; i++) await frame();
  return { hour, moonY: +d.y.toFixed(2), aimHit: hit, setMoonHit: hitDown,
           settled: +settled.toFixed(2), stayedOpen,
           found: window.__stats.set('sky') };
}));
await b.close();
