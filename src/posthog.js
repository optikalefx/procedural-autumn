// ─────────────────────────────────────────────────────────────────────────────
//  PostHog analytics — initialised once, exported for use across the app.
//
//  Only production builds send anything. `vite dev` would otherwise pollute
//  the live project with local driving, so the SDK is not initialised there
//  and the export is a no-op stub instead; every capture call across the app
//  stays valid and simply goes nowhere. To exercise the real pipeline from a
//  dev server, set VITE_POSTHOG_DEV=1 in .env.
//
//  Uses VITE_POSTHOG_KEY and VITE_POSTHOG_HOST from the environment. When
//  analytics are meant to be on and those are missing the module says so
//  loudly, so misconfiguration is never silent; the app boots either way.
//
//  ── the player is identified from the first event ───────────────────────────
//
//  `bootstrap` rather than a `posthog.identify()` call after init, and that is
//  load-bearing rather than tidy. The SDK defaults to
//  `person_profiles: 'identified_only'`, so events sent before an identify
//  create no person profile at all — and a person property set against a
//  profile that does not exist is simply dropped. Identifying *after* init
//  would therefore leave a hole at the front of every session exactly where
//  `session_started` lives. Bootstrapping puts the id on the SDK before it can
//  send anything, so there is no such window.
//
//  `isIdentifiedID: true` says the id is already the final one and suppresses
//  the anonymous->identified merge. There is nothing to merge: this game has no
//  login, and `playerId()` is the only name a player ever has.
// ─────────────────────────────────────────────────────────────────────────────
import posthogSdk from 'posthog-js';
import { playerId, adoptPlayerId } from './player_id.js';

const key  = import.meta.env.VITE_POSTHOG_KEY;
const host = import.meta.env.VITE_POSTHOG_HOST;

// Dev is off by default; the override lets a local session opt back in.
const wanted = import.meta.env.PROD || import.meta.env.VITE_POSTHOG_DEV === '1';

/**
 * Whether a photograph is uploaded alongside the hunt line it crossed off.
 *
 * On unless it is explicitly switched off, because the pictures are the point
 * of the sheet and they are affordable. Measured over four real captures of
 * this game — forest canopy, backlit ridge, dawn valley and the road — at the
 * 320 px / q0.60 that `hunt_analytics` re-encodes to:
 *
 *      mean 12.8 KB of data URL, worst case 15.4 KB (forest canopy)
 *
 * against PostHog's **1 MB hard limit, over which an event is DISCARDED**
 * rather than truncated (docs: "Discarded event exceeding 1MB limit"). So the
 * worst frame this game draws spends 1.5% of the cap, and a full nineteen-line
 * playthrough uploads about 243 KB in total. Set VITE_POSTHOG_PHOTOS=0 to send
 * the ticks and the timings without the pictures.
 */
export const POSTHOG_PHOTOS = import.meta.env.VITE_POSTHOG_PHOTOS !== '0';

// Anything with a .capture() the app can call. Swapped for the real SDK below
// when analytics are on — a stub keeps posthog-js from logging an
// "uninitialized" warning at every call site.
//
// The stub RECORDS rather than merely swallowing, and that is worth the six
// lines. Analytics is the only subsystem in this game with no visible output:
// a property that is undefined, an event that never fires and an event that
// fires nineteen times a reload all look exactly like everything working. In
// dev the calls land on `window.__posthog`, alongside `__hunt` and `__stats`,
// so what the game WOULD send can be read without sending it anywhere.
const devLog = [];
let posthog = new Proxy({}, {
  get: (_t, name) => (...args) => {
    devLog.push({ name: String(name), args });
    if (devLog.length > 300) devLog.shift();
  },
});

if (!wanted) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.info('PostHog disabled in dev. Set VITE_POSTHOG_DEV=1 in .env to enable. ' +
                 'Calls are recorded on window.__posthog instead.');
  }
} else if (!key || !host) {
  // eslint-disable-next-line no-console
  console.error(
    'VITE_POSTHOG_KEY variable required by PostHog is missing or un-configured, ' +
    'this causes events to be silently missed. ' +
    'This error stops appearing once VITE_POSTHOG_KEY is configured.',
  );
} else {
  const id = playerId();
  posthogSdk.init(key, {
    api_host: host,
    defaults: '2026-05-30',
    bootstrap: { distinctID: id, isIdentifiedID: true },
  });
  // Reconcile, and do not skip this because the bootstrap above "should" have
  // worked. It is honoured ONLY when the SDK has no identity of its own; once
  // `ph_<key>_posthog` exists in storage, the distinct_id in there wins and the
  // bootstrap is discarded silently. Verified by sending: with a surviving
  // PostHog record and a cleared `pa.player`, the two ids disagreed and the
  // `player_id` property named a different person from the one the events were
  // filed under. PostHog's id wins — see `adoptPlayerId`.
  const finalId = adoptPlayerId(posthogSdk.get_distinct_id?.() ?? id);

  // Belt to the bootstrap's braces: this is what actually guarantees the person
  // profile exists under `identified_only`, and it is where the id becomes a
  // property you can read in the Persons table rather than only a distinct_id.
  // `$set_once`, so a returning player keeps the date they first arrived.
  posthogSdk.setPersonProperties(undefined, {
    player_id: finalId,
    first_seen_at: new Date().toISOString(),
  });
  posthog = posthogSdk;

  // With VITE_POSTHOG_DEV=1 the SDK is live — and the recorder stays on in front
  // of it, forwarding every call rather than swallowing it. Without this the one
  // mode you most want to watch (really sending, from a dev server) is the one
  // mode `__posthog.captured()` goes blank in, because the stub it records
  // through has just been replaced. DEV only; production exports the bare SDK.
  if (import.meta.env.DEV) {
    posthog = new Proxy(posthogSdk, {
      get: (target, name) => {
        const v = Reflect.get(target, name);
        if (typeof v !== 'function') return v;
        return (...args) => {
          devLog.push({ name: String(name), args });
          if (devLog.length > 300) devLog.shift();
          // `apply` on the real instance, so the SDK's own `this` is untouched.
          return v.apply(target, args);
        };
      },
    });
  }
}

// The dev recorder's window seat. Not exposed in production: there the export
// IS the SDK and `devLog` never receives anything.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__posthog = {
    events: devLog,
    /** Just the captures, newest last. `__posthog.captured()` in the console. */
    captured: (name = null) => devLog
      .filter((c) => c.name === 'capture' && (!name || c.args[0] === name))
      .map((c) => ({ event: c.args[0], props: c.args[1] })),
    clear: () => { devLog.length = 0; },
  };
}

export { posthog };
