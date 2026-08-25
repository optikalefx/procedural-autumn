// Paste into the game's devtools console. Defines __waders():
//   __waders()        -> nearest heron + flamingo shelf to you, with bearing
//   __waders(true)    -> same, then teleports you to the nearest one
// Mirrors _findWade's own gates (hydro sdf >= 1.2, wet >= 0.5, the species'
// depth window, and the flamingo's minSpan), so a hit here is a spot the
// streamer is willing to place a bird.
window.__waders = (go) => {
  const ctx = window.__ctx, W = ctx.world, tb = ctx.systems.wildlife.treeBirds;
  const species = tb.slots.map((s) => s[0].spec).filter((s) => s.habitat === 'water');
  const c = ctx.camera.position, hy = {};
  const out = {};
  let nearest = null;
  // Expanding shells, 2 m between samples in both radius and arc. The step
  // has to be this fine: a wadeable spot is often a single 2 m speck on a
  // narrow fringe (most of this shore drops from dry to over-depth inside a
  // couple of metres), and both a random scatter and a 6 m shell walked
  // straight over the known shelf 155 m south of the spawn.
  const STEP = 2;
  for (const S of species) {
    let best = null;
    for (let r = 30; r <= 600 && !best; r += STEP) {
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
        best = { x: Math.round(x), z: Math.round(z), dist: Math.round(r),
          bearing: Math.round((th * 180 / Math.PI + 360) % 360), depth: +d.toFixed(2) };
        break;
      }
    }
    out[S.key] = best ?? 'none within 600 m';
    if (best && (!nearest || best.dist < nearest.dist)) nearest = best;
  }
  console.table(out);
  if (go && nearest) {
    // Land 70 m short of the shelf: inside the 85-190 m spawn ring, outside
    // the startle radius, and not so close that the view guard blocks placement.
    const k = Math.max(0, (nearest.dist - 70) / nearest.dist);
    window.__vehicleTeleport(c.x + (nearest.x - c.x) * k, c.z + (nearest.z - c.z) * k, 0);
    console.log('moved to within ~70 m — turn slowly, they settle behind and beside you');
  }
  return out;
};
window.__waders();
