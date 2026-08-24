#!/usr/bin/env node
/**
 * The press gesture, checked without a browser.
 *
 *   node tools/gesturetest.mjs
 *
 * `core/Input.js` resolves every pointer press into one of three answers — a
 * TAP (pick a thing), a COMMIT (a hold released in place: put something here),
 * or nothing at all (the press moved, so it was a look drag). Getting that
 * split wrong is the difference between "hold the meadow to make camp" and
 * "brush the screen and a camp appears in the lake", and it cannot be checked
 * in the capture harness: headless frames here run for whole seconds, so every
 * press performed through CDP lasts longer than HOLD_TIME and arrives as a
 * hold. The distinction only exists on a clock the harness does not have.
 *
 * So: no renderer, no world, no browser. A stub `window` that records the
 * listeners `Input` installs, and then the exact event sequences a thumb makes.
 */
const listeners = new Map();
const canvas = { tagName: 'CANVAS', closest: () => null };

class FakeCanvas {}
globalThis.HTMLCanvasElement = FakeCanvas;
Object.setPrototypeOf(canvas, FakeCanvas.prototype);

let clock = 0;
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => clock }, configurable: true, writable: true,
});
// Node 22 ships a real `navigator` with only a getter, so it has to be
// redefined rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: { maxTouchPoints: 5, getGamepads: () => [] }, configurable: true, writable: true,
});
globalThis.window = {
  innerWidth: 400, innerHeight: 800,
  addEventListener: (t, fn) => {
    if (!listeners.has(t)) listeners.set(t, []);
    listeners.get(t).push(fn);
  },
  matchMedia: () => ({ matches: true }),
};

const { Input } = await import('../src/core/Input.js');
const fire = (type, ev) => (listeners.get(type) ?? []).forEach((fn) => fn(ev));
const pointer = (x, y, extra = {}) => ({
  pointerId: 1, pointerType: 'touch', button: 0, target: canvas,
  clientX: x, clientY: y, movementX: 0, movementY: 0,
  preventDefault() {}, ...extra,
});

const input = new Input();
/** Run one frame: systems read, then Input.update clears the edges. */
const frame = (ms = 16) => { clock += ms; input.update(ms / 1000); };
/** What a system reading `press` this frame would see. */
const read = () => ({ tap: input.press.tap, commit: input.press.commit, holding: input.press.holding });

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`}`);
};

// A press resolves on release, so the answer is read on the frame AFTER the
// pointerup — which is exactly when a system polls it.
const press = ({ holdMs, dx = 0, cancel = false }) => {
  fire('pointerdown', pointer(200, 400));
  let waited = 0;
  while (waited < holdMs) { frame(16); waited += 16; }
  if (dx) fire('pointermove', pointer(200 + dx, 400));
  fire(cancel ? 'pointercancel' : 'pointerup', pointer(200 + dx, 400));
  const seen = read();
  frame();                      // the edge is consumed and cleared here
  return { seen, after: read() };
};

// ── a quick press is a TAP: pick the thing under it ─────────────────────────
check('80 ms press → tap', press({ holdMs: 80 }).seen,
      { tap: true, commit: false, holding: false });

// ── a long press in place is a COMMIT, and never also a tap ─────────────────
check('600 ms press → commit', press({ holdMs: 600 }).seen,
      { tap: false, commit: true, holding: false });

// ── the hold is live BEFORE release, which is what draws the preview ────────
fire('pointerdown', pointer(200, 400));
frame(200);
check('200 ms in → not holding yet', input.press.holding, false);
frame(300);
check('500 ms in → holding', input.press.holding, true);
fire('pointerup', pointer(200, 400));
frame();

// ── a press that MOVED is a look drag and nothing else ─────────────────────
check('600 ms press + 60 px drag → nothing', press({ holdMs: 600, dx: 60 }).seen,
      { tap: false, commit: false, holding: false });
check('80 ms press + 60 px drag → nothing', press({ holdMs: 80, dx: 60 }).seen,
      { tap: false, commit: false, holding: false });

// ── a cancelled press commits nothing ──────────────────────────────────────
check('cancelled hold → nothing', press({ holdMs: 600, cancel: true }).seen,
      { tap: false, commit: false, holding: false });

// ── the edges last exactly one frame, like `justPressed` ───────────────────
check('edge cleared next frame', press({ holdMs: 600 }).after,
      { tap: false, commit: false, holding: false });

// ── a menu opening over a held placement disarms it ────────────────────────
fire('pointerdown', pointer(200, 400));
frame(500);
input.suppressed = true;
frame();
check('suppressed → hold disarmed', input.press.holding, false);
input.suppressed = false;
fire('pointerup', pointer(200, 400));
check('suppressed release → no commit', read(), { tap: false, commit: false, holding: false });
frame();

// ── a press that starts on a CONTROL is not a press on the world ───────────
const chip = { tagName: 'DIV', closest: () => ({}) };
fire('pointerdown', pointer(200, 400, { target: chip }));
check('press on the HUD → ignored', input.press.down, false);

// ── the vocabulary never names a key on touch ──────────────────────────────
const verbs = await import('../src/core/verbs.js');
for (const [name, fn] of [['pickVerb', verbs.pickVerb], ['placeVerb', verbs.placeVerb], ['actVerb', verbs.actVerb]]) {
  const touch = fn();
  const named = /\b(click|E|K|R|C|Esc|Space|WASD)\b/.test(touch.replace(/<[^>]+>/g, ''));
  check(`${name}() on touch names no key — ${touch}`, named, false);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
