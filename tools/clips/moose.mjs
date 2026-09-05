/**
 * moose — "He was here first." A moose swings into frame and blocks your camp.
 *
 * ── the entrance is a CAMERA move, not an animal move ───────────────────────
 *
 * The spec asks for a moose that "walks in from the left and stops, blocking
 * the camper". `wildlife.debugSpawn` places an animal at a point; it does not
 * animate an entrance, and a pinned animal has idle motion only. The first cut
 * took that as a constraint and simply spawned him in view — a reviewer
 * measured the result at 0.05-0.29 luma levels of frame-to-frame change out of
 * 255 and called it, correctly, a still image with a caption.
 *
 * So the entrance is done with the lens. The camera opens ON THE CAMPER, with
 * the moose standing just outside the frame, and pans; he enters, crosses, and
 * ends dead centre with the camp behind him. Nothing about the animal changed —
 * the shot did.
 *
 * ── why the camper has to be in it ──────────────────────────────────────────
 *
 * "First" is comparative. A moose alone against mountains says wilderness, and
 * a caption claiming he was here first is then a non-sequitur — the picture
 * agrees with him instead of setting up a conflict. The camp is the second
 * party, and putting it behind him is what makes the sentence a joke.
 *
 * ── placement is explicit ───────────────────────────────────────────────────
 *
 * `debugSpawn` normally walks outward from the camera's forward vector, which
 * is fine for "photograph an animal" and useless when the animal has to stand
 * on a specific line between the lens and the camp. It accepts `opts.x/z`; this
 * uses them.
 */
export function makeMooseShot({ page, arg, step, grant, settle, FPS }) {
  const DIST = parseFloat(arg('moose-dist', '20'));   // camera back from the camp
  const NEAR = parseFloat(arg('moose-near', '11'));   // moose distance from the lens
  const SIDE = parseFloat(arg('moose-side', '8.5'));  // how far off-axis he starts
  const PAN  = parseFloat(arg('moose-pan', '1.15'));  // seconds of entrance
  const EYE  = parseFloat(arg('moose-eye', '1.45'));

  const beat = {
    name: 'moose',
    secs: parseFloat(arg('moose-secs', '4.5')),
    // Morning: he has to READ, and at dusk he is a black cut-out. The first cut
    // was backlit into a silhouette where only the antlers identified him.
    hour: parseFloat(arg('moose-hour', '9.4')),
    fov: 62,
    pose: true,
  };

  const setup = async () => {
    const at = (arg('at', null) ? String(arg('at')).split(',').map(Number) : null);
    if (!at) throw new Error('moose needs --at "x,z[,yaw]" — the camp it blocks');

    await page.evaluate(({ a }) => window.__vehicleTeleport?.(a[0], a[1], a[2] ?? 0), { a: at });
    await settle(2.0);

    const placed = await page.evaluate(({ a, DIST, NEAR, SIDE, EYE }) => {
      const e = window.__engine, wd = window.__world, wl = window.__systems.wildlife;
      const cx0 = a[0], cz0 = a[1];
      // Stand back from the camp along its own facing, so the camper reads.
      const yaw = (a[2] ?? 0) + Math.PI;
      const camX = cx0 + Math.sin(yaw) * DIST, camZ = cz0 + Math.cos(yaw) * DIST;
      const g = wd.getHeight(camX, camZ);
      e.camera.position.set(camX, g + EYE, camZ);
      e.camera.lookAt(cx0, wd.getHeight(cx0, cz0) + 1.2, cz0);
      e.camera.updateMatrixWorld(true);

      // Toward the camp from the lens, then off to one side: he starts outside
      // the frame and the pan brings him in.
      const fx = (cx0 - camX), fz = (cz0 - camZ);
      const m = Math.hypot(fx, fz) || 1;
      const ux = fx / m, uz = fz / m;
      const px = uz, pz = -ux;
      const mx = camX + ux * NEAR + px * SIDE;
      const mz = camZ + uz * NEAR + pz * SIDE;

      const sp = wl.debugSpawn('moose', { x: mx, z: mz, clear: 4 });
      if (!sp) return null;
      const camp = { x: cx0, y: wd.getHeight(cx0, cz0) + 1.2, z: cz0 };
      window.__tMoose = {
        camX, camY: g + EYE, camZ,
        a0: Math.atan2(camp.x - camX, camp.z - camZ),          // aim: the camp
        a1: Math.atan2(sp.x - camX, sp.z - camZ),              // aim: the moose
        y0: camp.y, y1: sp.y + 1.6,
        n: sp.n,
      };
      return { x: +sp.x.toFixed(1), z: +sp.z.toFixed(1), n: sp.n,
               swing: +Math.abs(window.__tMoose.a1 - window.__tMoose.a0).toFixed(2) };
    }, { a: at, DIST, NEAR, SIDE, EYE });

    if (!placed) throw new Error('no sleeping moose site to place — try another --seed or --at');
    console.log(`[moose]   at (${placed.x}, ${placed.z}) x${placed.n}, ` +
                `entrance swings ${placed.swing} rad over ${PAN}s`);
    await grant(Math.round(FPS * 0.5));
    return placed;
  };

  const camera = (u) => page.evaluate(({ k, PAN, SECS }) => {
    const t = window.__tMoose, e = window.__engine;
    // Ease the pan and then STOP. The hold is the joke: he arrives, he settles,
    // and the shot refuses to do anything else.
    const p = Math.min(1, (k * SECS) / PAN);
    const s = p * p * (3 - 2 * p);
    let d = t.a1 - t.a0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const az = t.a0 + d * s;
    const ay = t.y0 + (t.y1 - t.y0) * s;
    e.camera.position.set(t.camX, t.camY, t.camZ);
    e.camera.lookAt(t.camX + Math.sin(az) * 30, ay, t.camZ + Math.cos(az) * 30);
  }, { k: u, PAN, SECS: beat.secs });

  return { beat, setup, camera, driver: null };
}
