/**
 * cliff — the camper drives off a bluff at walking pace, falls, lands, and sits
 * there. One joke, one beat, filmed with `--only cliff`.
 *
 * ── why this does not reuse the ridge beat's bluff finder ───────────────────
 *
 * `setups.ridge` scores for a CAMP WITH A VIEW: flat enough to pitch on, with
 * the ground falling away somewhere in 25-160 m. That is a vista, and a vista
 * is usually a long grade — the camper trundles down it, and a trundle is not
 * a joke. What this shot needs is a LIP: drivable ground that ends, so the
 * wheels leave and the fall is a fall. So the NEAR drop (10-30 m) is measured
 * separately from the total drop (30-140 m), and the near one is what ranks.
 *
 * ── the rehearsal is the gate, not the score ────────────────────────────────
 *
 * The trap table's oldest entry: four rounds went into predicting whether a
 * start was drivable — slope, run-out, raycasts, water queries — and every
 * proxy passed a corridor the camper then failed. So a candidate that scores
 * well is DRIVEN, for real, and kept only if the camper actually left the
 * ground and ended materially below where it started. A lip the camper stops
 * on, slides down sideways, or never reaches is discarded on evidence.
 *
 * Cheap first: the rehearsal runs at whatever the capture fps is, but nothing
 * is photographed, so it costs world time and not frames.
 *
 * ── the camera tracks, it does not perform ──────────────────────────────────
 *
 * Physics decides where the camper goes; it may tumble, bounce, or slide out
 * of any composed frame. A designed move that loses its subject is not a shot,
 * so the stand is FIXED (the fall reads as a fall against stationary ground)
 * and the aim point chases the camper with damping, so a tumble does not shake
 * the lens. The stand goes on whichever side of the fall line has the LOWER
 * ground, so the lens looks across the drop rather than into the hillside.
 */

export function makeCliffShot({ page, arg, hold, step, settle, FPS }) {
  const BACK = parseFloat(arg('cliff-back', '34'));
  const SIDE = parseFloat(arg('cliff-side', '30'));
  const EYE  = parseFloat(arg('cliff-eye', '4'));
  const STEP = parseFloat(arg('cliff-step', '24'));

  const beat = {
    name: 'cliff',
    secs: parseFloat(arg('cliff-secs', '7.0')),
    // Golden rather than dusk: the drop has to be LEGIBLE. At 20.4 the valley
    // floor is one value and the fall reads as the camper vanishing.
    hour: parseFloat(arg('cliff-hour', '17.2')),
    fov: 70,
    pose: true,
  };

  const setup = async () => {
    const cands = await page.evaluate(({ STEP, RUNUP }) => {
      const w = window.__world;
      const flat = [];
      for (let x = -1150; x <= 1150; x += STEP) {
        for (let z = -1150; z <= 1150; z += STEP) {
          if (!w.isInBounds(x, z)) continue;
          const y = w.getHeight(x, z);
          if (y < 30 || y > 200) continue;
          let sl = 0;
          for (let a = 0; a < 8; a++) {
            sl += w.getSlope(x + Math.cos(a * 0.785) * 8, z + Math.sin(a * 0.785) * 8);
          }
          if (sl / 8 < 0.22) flat.push({ x, z, y });
        }
      }
      const out = [];
      for (const c of flat) {
        for (let a = 0; a < 16; a++) {
          const ang = a * (Math.PI / 8);
          const sx = Math.sin(ang), sz = Math.cos(ang);
          let near = 0;
          for (let d = 10; d <= 30; d += 5) {
            near = Math.max(near, c.y - w.getHeight(c.x + sx * d, c.z + sz * d));
          }
          let far = 0;
          for (let d = 30; d <= 140; d += 12) {
            far = Math.max(far, c.y - w.getHeight(c.x + sx * d, c.z + sz * d));
          }
          if (near < 12 || far < 35) continue;
          // The run-up must be drivable or the camper never reaches the lip.
          let ok = true;
          for (let d = 6; d <= RUNUP; d += 6) {
            const bx = c.x - sx * d, bz = c.z - sz * d;
            if (!w.isInBounds(bx, bz) || Math.abs(w.getHeight(bx, bz) - c.y) > 6) { ok = false; break; }
          }
          if (!ok) continue;
          out.push({ x: c.x, z: c.z, y: c.y, yaw: ang, near, far });
        }
      }
      out.sort((a, b) => (b.near * 2 + b.far) - (a.near * 2 + a.far));
      const spread = [];
      for (const c of out) {
        if (spread.every((k) => Math.hypot(k.x - c.x, k.z - c.z) > 150)) spread.push(c);
        if (spread.length >= 6) break;
      }
      return spread;
    }, { STEP, RUNUP: BACK });

    console.log(`[cliff]   ${cands.length} lip candidate(s)` +
      (cands.length ? `, best near ${cands[0].near.toFixed(0)}m far ${cands[0].far.toFixed(0)}m` : ''));
    if (!cands.length) {
      throw new Error('no drivable lip on this seed — try --cliff-step 16, a smaller --cliff-back, or another --seed');
    }

    for (const c of cands) {
      const sx = Math.sin(c.yaw), sz = Math.cos(c.yaw);
      const startX = c.x - sx * BACK, startZ = c.z - sz * BACK;
      await page.evaluate(({ x, z, yaw }) => {
        window.__camp?.strike?.();
        window.__vehicleTeleport?.(x, z, yaw);
      }, { x: startX, z: startZ, yaw: c.yaw });
      await settle(1.8);

      const y0 = await page.evaluate(() => window.__systems.vehicle.position.y);
      await hold('w', true);
      let minY = y0;
      for (let i = 0; i < Math.round(FPS * 6.0); i++) {
        await step();
        minY = Math.min(minY, await page.evaluate(() => window.__systems.vehicle.position.y));
      }
      await hold('w', false);
      const fell = y0 - minY;
      console.log(`[cliff]   rehearsal at (${c.x.toFixed(0)}, ${c.z.toFixed(0)}): fell ${fell.toFixed(1)}m` +
                  ` ${fell > 20 ? '— went over' : '— did NOT go over, next candidate'}`);
      if (fell <= 20) continue;

      // Put it back on the hill: the rehearsal left the camper at the bottom of
      // the drop it just proved, and the beat has to film the approach.
      await page.evaluate(({ x, z, yaw }) => window.__vehicleTeleport?.(x, z, yaw),
        { x: startX, z: startZ, yaw: c.yaw });
      await settle(1.8);

      await page.evaluate(({ c2, SIDE, EYE }) => {
        const w = window.__world;
        const sx = Math.sin(c2.yaw), sz = Math.cos(c2.yaw);
        const px = sz, pz = -sx;
        const lo = w.getHeight(c2.x + px * SIDE, c2.z + pz * SIDE);
        const hi = w.getHeight(c2.x - px * SIDE, c2.z - pz * SIDE);
        const sgn = lo <= hi ? 1 : -1;
        const cx = c2.x + px * SIDE * sgn - sx * 6;
        const cz = c2.z + pz * SIDE * sgn - sz * 6;
        window.__tCliff = {
          cx, cz,
          cy: Math.max(w.getHeight(cx, cz) + 2.2, c2.y + EYE),
          aim: null,
        };
      }, { c2: c, SIDE, EYE });

      // Throttle on for the whole beat. There is nothing to re-assert per frame
      // — a held key IS the drive — and the main loop releases held keys when
      // the beat ends.
      await hold('w', true);
      return { ...c, startX, startZ, fell };
    }
    throw new Error('no candidate actually drove off — try a smaller --cliff-back, or another --seed');
  };

  const camera = () => page.evaluate(() => {
    const c = window.__tCliff, e = window.__engine, p = window.__systems.vehicle.position;
    if (!c.aim) c.aim = { x: p.x, y: p.y, z: p.z };
    const k = 0.12;
    c.aim.x += (p.x - c.aim.x) * k;
    c.aim.y += (p.y - c.aim.y) * k;
    c.aim.z += (p.z - c.aim.z) * k;
    e.camera.position.set(c.cx, c.cy, c.cz);
    e.camera.lookAt(c.aim.x, c.aim.y + 0.8, c.aim.z);
  });

  return { beat, setup, camera, driver: null };
}
