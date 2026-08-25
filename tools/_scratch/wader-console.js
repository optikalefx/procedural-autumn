// Paste into the game's devtools console.
//
//   __waders()            -> table of the nearest wadeable shelf per species
//   __waders('flamingo')  -> warp to that shelf, facing it, and settle a flock
//   __waders('heron')     -> same for herons
//
// Why it does the placing rather than leaving it to the streamer: sites are
// picked in a ring 85-190 m out and SKIPPED if they are inside 150 m and in
// your view cone, so a shelf you have parked next to and are looking at is the
// one place a bird will not be put. debugPerchNear ignores both rules.
window.__waders = (species) => {
  const ctx = window.__ctx;
  const W = ctx.world;
  const tb = ctx.systems.wildlife.treeBirds;
  const veh = ctx.systems.vehicle;
  const all = tb.slots.map((s) => s[0].spec).filter((s) => s.habitat === 'water');
  const c = ctx.camera.position;
  const hy = {};

  // Expanding shells, 2 m between samples in both radius and arc. The step has
  // to be this fine: a wadeable spot is often a single 2 m speck on a narrow
  // fringe (most of this shore drops from dry to over-depth inside a couple of
  // metres), and both a random scatter and a 6 m shell walked straight over a
  // known shelf 155 m from the spawn.
  const STEP = 2;
  const find = (S) => {
    for (let r = 30; r <= 600; r += STEP) {
      const N = Math.ceil((2 * Math.PI * r) / STEP);
      for (let a = 0; a < N; a++) {
        const th = (a / N) * Math.PI * 2;
        const x = c.x + Math.sin(th) * r, z = c.z + Math.cos(th) * r;
        if (!W.isInBounds(x, z)) continue;
        const h = W.getHydro(x, z, hy);
        if (h.sdf < 1.2 || h.wet < 0.5) continue;
        const d = W.getWaterDepth(x, z);
        if (d < S.wade[0] || d > S.wade[1]) continue;
        if (S.minSpan && h.span < S.minSpan) continue;
        return { x: Math.round(x), z: Math.round(z), dist: Math.round(r), depth: +d.toFixed(2) };
      }
    }
    return null;
  };

  if (!species) {
    const out = {};
    for (const S of all) out[S.key] = find(S) ?? 'none within 600 m';
    console.table(out);
    console.log("call __waders('flamingo') or __waders('heron') to go and see one");
    return out;
  }

  const S = all.find((s) => s.key === species);
  if (!S) { console.warn(`no wader called "${species}" — try ${all.map((s) => s.key).join(' or ')}`); return null; }
  const site = find(S);
  if (!site) { console.warn(`no ${species} water within 600 m — drive somewhere else and retry`); return null; }

  // Land short of the shelf, facing it. warpTo keeps the current heading, so
  // the heading is set first; it lands you looking at the birds instead of
  // leaving you to guess a compass bearing. 45 m clears the startle radius
  // (30 m heron / 34 m flamingo) so parking there does not flush them.
  const STAND = 45;
  const th = Math.atan2(site.x - c.x, site.z - c.z);
  veh.heading = th;
  const landed = veh.warpTo(site.x - Math.sin(th) * STAND, site.z - Math.cos(th) * STAND);

  // Settle a group. Flamingos flock, so fill every slot; a heron is solitary.
  //
  // Placed straight onto points this function has already validated, rather
  // than through debugPerchNear: that jitters +/-18 m and takes ten throws, so
  // against a 2 m speck it lands about 3% of the time and usually reports
  // finding nothing. (It is also why the streamer takes minutes to seed one.)
  const n = S.flock ? S.live : 1;
  const spots = [];
  for (let r = 0; r <= 22 && spots.length < n; r += 1.5) {
    const N = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 1.5);
    for (let a = 0; a < N && spots.length < n; a++) {
      const t2 = (a / N) * Math.PI * 2;
      const x = site.x + (r === 0 ? 0 : Math.sin(t2) * r);
      const z = site.z + (r === 0 ? 0 : Math.cos(t2) * r);
      if (!W.isInBounds(x, z)) continue;
      const h = W.getHydro(x, z, hy);
      if (h.sdf < 1.2 || h.wet < 0.5) continue;
      const d = W.getWaterDepth(x, z);
      if (d < S.wade[0] || d > S.wade[1]) continue;
      if (S.minSpan && h.span < S.minSpan) continue;
      if (spots.some((q) => Math.hypot(q.x - x, q.z - z) < 2.5)) continue;   // no stacking
      spots.push({ x, z, gy: W.getHeight(x, z), wy: W.getWaterHeight(x, z) });
    }
  }
  const si = tb.slots.findIndex((sl) => sl[0].spec.key === species);
  const slots = tb.slots[si];
  let placed = 0;
  for (const spot of spots) {
    const bird = slots.find((s) => !s.active) ?? slots[placed % slots.length];
    tb._wadeAt(bird, spot, th + Math.PI + (Math.random() - 0.5) * 1.4);   // roughly facing you
    placed++;
  }

  console.log(`${placed} ${species}${placed === 1 ? '' : 's'} at (${site.x}, ${site.z}) in ${site.depth} m of water`
    + ` — you are ${STAND} m away at (${Math.round(landed?.x)}, ${Math.round(landed?.z)}), facing them`);
  if (!placed) console.warn('found the water but could not settle a bird on it — try running it again');
  return { site, landed, placed };
};
window.__waders();
