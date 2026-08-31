import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGEERROR', String(e)));
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await page.goto('http://localhost:5178/?res=768');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 400 });

const out = await page.evaluate(async () => {
  const e = window.__engine, W = window.__world, wl = window.__systems.wildlife;
  const { hunt } = await import('/src/game/hunt_store.js');
  const R = {};

  // ── 1. what can be tracked ────────────────────────────────────────────────
  R.canTrack = Object.fromEntries(
    ['bear','deer','fox','baldEagle','heron','owl','flamingo','campDog','moon','waterfall','highCamp']
      .map(k => [k, wl.canTrack(k)]));

  // ── 2. the store ──────────────────────────────────────────────────────────
  hunt.reset();
  const s = [];
  s.push(['start null', hunt.target === null]);
  hunt.setTracked('bear');
  s.push(['aim bear', hunt.target === 'bear']);
  hunt.setTracked('bear');
  s.push(['same again clears', hunt.target === null]);
  hunt.setTracked('deer'); hunt.setTracked('bear');
  s.push(['switch', hunt.target === 'bear']);
  hunt.award('bear', null);
  s.push(['award clears', hunt.target === null]);
  s.push(['cannot aim a done line', (hunt.setTracked('bear'), hunt.target === null)]);
  hunt.reset();
  R.store = s;

  // ── 3. the paw, parked by a bear ──────────────────────────────────────────
  window.__forceCamera = true;
  e.stop(); e.clock.getDelta = () => 1 / 30;
  const cam = e.camera;
  const park = (x, z) => {
    cam.position.set(x, W.getHeight(x, z) + 2.2, z);
    cam.lookAt(x, W.getHeight(x, z) + 2.0, z + 20);
  };
  const live = (key) => {
    const o = [];
    for (const per of wl.pool[key] ?? []) for (const a of per) if (a.active) o.push(a.brain.pos);
    return o;
  };

  park(-541, 643);
  for (let i = 0; i < 200; i++) e._loop();
  const bears = live('bear');
  R.bearsLive = bears.length;
  if (!bears.length) return R;

  const B = { x: bears[0].x, z: bears[0].z };
  // Stand 120 m off: outside the bear's 79 m hint band, well inside its 185 m
  // spawn ring. This is exactly the gap the widening is for.
  const px = B.x + 120, pz = B.z;
  park(px, pz);
  for (let i = 0; i < 90; i++) e._loop();

  const near = (p) => p ? +Math.hypot(p.x - px, p.z - pz).toFixed(1) : null;
  const whose = (p) => {
    if (!p) return null;
    let best = null, bd = 1e9;
    for (const key of wl.keys) for (const q of live(key)) {
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd) { bd = d; best = key; }
    }
    return bd < 1.0 ? best : 'bird/other';
  };

  const ambient = wl.nearestHint(px, pz, null);
  const quarry  = wl.nearestHint(px, pz, 'bear');
  R.at120 = {
    bearDist: near(B),
    ambient: ambient ? { species: whose(ambient), dist: near(ambient) } : null,
    quarry:  quarry  ? { species: whose(quarry),  dist: near(quarry)  } : null,
  };
  R.liveCounts = Object.fromEntries(wl.keys.map(k => [k, live(k).length]));

  // ── 4. _statSeen must not silence the quarry ──────────────────────────────
  for (const per of wl.pool.bear ?? []) for (const a of per) if (a.active) a._statSeen = true;
  R.seenFlagged = {
    ambient: !!wl.nearestHint(px, pz, null),
    quarry: !!wl.nearestHint(px, pz, 'bear'),
  };

  // ── 5. birds answer the same call ─────────────────────────────────────────
  const bl = wl.treeBirds.debugList();
  R.birds = { live: bl.length, keys: [...new Set(bl.map(b => b.key))] };
  if (bl.length) {
    const b = bl[0];
    park(b.x + 100, b.z);
    R.birdQuarry = wl.nearestHint(b.x + 100, b.z, b.key) ? b.key + ': pinned' : b.key + ': MISSED';
  }
  return R;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
