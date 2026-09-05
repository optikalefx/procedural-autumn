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
  const SIDE = parseFloat(arg('cliff-side', '26'));
  const FWD  = parseFloat(arg('cliff-fwd', '10'));    // out past the lip, over the void
  // Metres short of the lip where filming starts. Everything before this is
  // driven on the granted clock with no frames written.
  const LEAD = parseFloat(arg('cliff-lead', '13'));
  const DROP = parseFloat(arg('cliff-drop', '0.30')); // fraction of the fall to sit below the lip
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
    const cands = await page.evaluate(({ STEP, RUNUP, WANT }) => {
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
          if (near < 9 || far < 20) continue;
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
      // PREFER A DROP THE FRAME CAN HOLD, not the biggest one.
      //
      // Ranking by size put the camper off a 28 m lip, and 28 m of fall with a
      // 4 m vehicle in a 9:16 frame is a few dozen pixels travelling further
      // than any fixed lens can follow — seven camera placements failed on it.
      // A 12-16 m drop keeps lip and landing in one frame at a distance where
      // the camper still reads. Rank on closeness to that, not on magnitude.
      out.sort((a, b) => (Math.abs(a.near - WANT) + a.far * 0.02)
                       - (Math.abs(b.near - WANT) + b.far * 0.02));
      const spread = [];
      for (const c of out) {
        if (spread.every((k) => Math.hypot(k.x - c.x, k.z - c.z) > 150)) spread.push(c);
        if (spread.length >= 6) break;
      }
      return spread;
    }, { STEP, RUNUP: BACK, WANT: parseFloat(arg('cliff-want', '14')) });

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
      // Where it ended up. Read BEFORE teleporting back — the stand search needs
      // to see the landing, not just the lip.
      const land = await page.evaluate(() => {
        const p = window.__systems.vehicle.position;
        return { x: p.x, y: p.y, z: p.z };
      });
      console.log(`[cliff]   rehearsal at (${c.x.toFixed(0)}, ${c.z.toFixed(0)}): fell ${fell.toFixed(1)}m` +
                  ` ${fell > 20 ? '— went over' : '— did NOT go over, next candidate'}`);
      if (fell <= 20) continue;

      // Put it back on the hill: the rehearsal left the camper at the bottom of
      // the drop it just proved, and the beat has to film the approach.
      await page.evaluate(({ x, z, yaw }) => window.__vehicleTeleport?.(x, z, yaw),
        { x: startX, z: startZ, yaw: c.yaw });
      await settle(1.8);

      // SEARCH FOR THE STAND. Do not place it.
      //
      // Three hand-placed stands failed in three different ways: behind the lip
      // filmed the plateau, 18 m out lost the camper after it landed, and 42 m
      // out put the lens inside a rock face. The heuristic they shared was
      // "pick the side with lower ground", which never asks the only question
      // that matters — is anything BETWEEN the camera and the fall?
      //
      // `getHeight` answers that with no scene and no streaming, so sweep a
      // grid of stands and keep the one that can see BOTH ends of the drop: the
      // lip the camper leaves and the ground it lands on. Same segment test the
      // camp orbit uses to keep a hillside out of a shot.
      const stand = await page.evaluate(({ lip, land, fell }) => {
        const w = window.__world;
        const sx = Math.sin(lip.yaw), sz = Math.cos(lip.yaw);
        const px = sz, pz = -sx;
        const clear = (cx, cy, cz, tx, ty, tz) => {
          let worst = 0;
          for (let t = 0.05; t < 0.98; t += 0.03) {
            const gx = cx + (tx - cx) * t, gz = cz + (tz - cz) * t;
            worst = Math.max(worst, w.getHeight(gx, gz) - (cy + (ty - cy) * t));
          }
          return worst;                       // <=0 means nothing in the way
        };
        let best = null;
        for (const sgn of [1, -1]) {
          for (const side of [16, 22, 28, 34, 40]) {
            for (const fwd of [-4, 4, 12, 20]) {
              // Past 1.0 the lens is BELOW the landing looking up the face,
              // which is the framing a fall wants: the camper comes down toward
              // the camera instead of away from it.
              for (const dropF of [0.35, 0.65, 0.95, 1.15]) {
                const cx = lip.x + px * side * sgn + sx * fwd;
                const cz = lip.z + pz * side * sgn + sz * fwd;
                if (!w.isInBounds(cx, cz)) continue;
                const g = w.getHeight(cx, cz);
                const cy = Math.max(g + 3.0, lip.y - fell * dropF);
                const a = clear(cx, cy, cz, lip.x, lip.y + 1.5, lip.z);
                const b = clear(cx, cy, cz, land.x, land.y + 1.5, land.z);
                const d = Math.hypot(cx - lip.x, cz - lip.z);
                if (d < 14 || d > 40) continue;             // too close looms, too far is a dot
                // SCORE the blockage, do not veto on it.
                //
                // The first version required the sight line to clear the ground
                // by half a metre for its whole length, which rejected every
                // stand on every candidate — because the line to the lip grazes
                // the lip, and the lip is terrain. A cliff edge is always
                // "blocking" the view of itself. So take the worst intrusion on
                // the two lines and prefer the least of it, with distance as a
                // tie-break; a stand is only refused when something stands
                // metres proud of the line, which is a hill, not an edge.
                const worst = Math.max(a, b);
                if (worst > 3.0) continue;
                const score = -worst - Math.abs(d - 30) * 0.05;
                if (!best || score > best.score) best = { cx, cy, cz, d, score, side, fwd, dropF, sgn,
                                                          worst: +worst.toFixed(2) };
              }
            }
          }
        }
        if (!best) return null;
        window.__tCliff = { cx: best.cx, cy: best.cy, cz: best.cz, aim: null };
        return best;
      }, { lip: c, land, fell });
      if (!stand) {
        console.log('[cliff]   no stand can see both the lip and the landing — next candidate');
        continue;
      }
      console.log(`[cliff]   stand ${stand.d.toFixed(0)}m out ` +
                  `(side ${stand.side}, fwd ${stand.fwd}, drop ${stand.dropF}, ` +
                  `worst intrusion ${stand.worst}m)`);

      // Throttle on for the whole beat. There is nothing to re-assert per frame
      // — a held key IS the drive — and the main loop releases held keys when
      // the beat ends.
      await hold('w', true);

      // SPEND THE APPROACH OFF CAMERA.
      //
      // The run-up has to be long enough that the camper is at speed and
      // tracking straight when it reaches the lip, and a 34 m approach at
      // walking pace is four seconds of empty meadow — filmed, that was 60% of
      // the clip with no camper in it, and the fall crammed into the last
      // second. Same trick as the drive beat's preroll: advance on the granted
      // clock until the lip is `LEAD` metres away, photographing nothing, so
      // frame 1 is already rolling and the wheels leave at about 1.4 s.
      for (let i = 0; i < Math.round(FPS * 10); i++) {
        const d = await page.evaluate(({ x, z }) => {
          const p = window.__systems.vehicle.position;
          return Math.hypot(p.x - x, p.z - z);
        }, { x: c.x, z: c.z });
        if (d <= LEAD) break;
        await step();
      }
      return { ...c, startX, startZ, fell };
    }
    throw new Error('no candidate actually drove off — try a smaller --cliff-back, or another --seed');
  };

  const camera = () => page.evaluate(() => {
    const c = window.__tCliff, e = window.__engine, w = window.__world;
    const p = window.__systems.vehicle.position;
    if (!c.aim) { c.aim = { x: p.x, y: p.y, z: p.z }; c.y = c.cy; }
    const k = 0.12;
    c.aim.x += (p.x - c.aim.x) * k;
    c.aim.y += (p.y - c.aim.y) * k;
    c.aim.z += (p.z - c.aim.z) * k;
    // THE STAND HOLDS IN PLAN, THE HEIGHT RIDES DOWN.
    //
    // A stand fixed in all three axes is what the shot wants in principle — the
    // fall reads against stationary ground — and it is why the camper vanished
    // in four separate takes: it drops 28 m, and a lens that stays level with
    // the lip ends up looking down through the hillside it is standing beside.
    // Keeping x and z fixed preserves the stationary-ground read; letting y
    // trail the camper (damped, and never below the local ground) keeps the
    // subject in the picture, which outranks it.
    const want = Math.max(w.getHeight(c.cx, c.cz) + 3.0, c.aim.y + 7.0);
    c.y += (want - c.y) * 0.10;
    e.camera.position.set(c.cx, c.y, c.cz);
    e.camera.lookAt(c.aim.x, c.aim.y + 0.8, c.aim.z);
  });

  return { beat, setup, camera, driver: null };
}
