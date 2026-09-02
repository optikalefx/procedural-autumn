import { BoatPhysics } from '../../src/boat/boat_physics.js';

const world = {
  getRiver: () => 0,
  getFlow: (x, z, out) => { out.vx = 0; out.vz = 0; out.q = 0; out.turb = 0; return out; },
  getHeight: () => 0,
  getWaterHeight: () => 5,
  getHydro: () => ({ sdf: 100, span: 100, wet: 1 }),
  _water: null,
};

function run(label, pressSchedule, duration = 20, dt = 1 / 60, maxSpeed = 3.8) {
  const phys = new BoatPhysics(world, { length: 4, beam: 0.8, draft: 0.15 }, { maxSpeed });
  phys.place(0, 0, 0);
  let t = 0;
  let nextEventIdx = 0;
  let fwd = 0;
  const trace = [];
  while (t < duration) {
    // pressSchedule: list of [tStart, tEnd] windows where fwd=1
    fwd = 0;
    for (const [a, b] of pressSchedule) if (t >= a && t < b) { fwd = 1; break; }
    phys.step(dt, t, { fwd, back: 0, turn: 0 });
    t += dt;
    if (Math.floor(t * 10) % 20 === 0) trace.push([t.toFixed(1), phys.speed.toFixed(3), phys.rhythm.toFixed(3)]);
  }
  console.log(`\n== ${label} ==`);
  console.log('t, speed, rhythm (sampled):');
  for (const row of trace) console.log(row.join('  '));
  console.log(`final speed=${phys.speed.toFixed(3)} rhythm=${phys.rhythm.toFixed(3)}`);
}

// 1) Hold W the whole time.
run('HOLD (continuous W)', [[0, 999]]);

// 2) Tap W every ~1.0s, each press held 0.15s (on-beat).
{
  const sched = [];
  for (let s = 0; s < 20; s++) sched.push([s * 1.0, s * 1.0 + 0.15]);
  run('TAP on-beat (1.0s apart)', sched);
}

// 3) Tap too fast, every 0.4s.
{
  const sched = [];
  for (let s = 0; s < 50; s++) sched.push([s * 0.4, s * 0.4 + 0.1]);
  run('TAP too fast (0.4s apart)', sched);
}

// 4) Tap too slow, every 2.2s.
{
  const sched = [];
  for (let s = 0; s < 9; s++) sched.push([s * 2.2, s * 2.2 + 0.15]);
  run('TAP too slow (2.2s apart)', sched);
}

// 5) Canoe (maxSpeed 3.2), hold vs on-beat tap.
run('CANOE HOLD', [[0, 999]], 20, 1 / 60, 3.2);
{
  const sched = [];
  for (let s = 0; s < 20; s++) sched.push([s * 1.0, s * 1.0 + 0.15]);
  run('CANOE TAP on-beat (1.0s apart)', sched, 20, 1 / 60, 3.2);
}
