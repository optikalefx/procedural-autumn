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
// ─────────────────────────────────────────────────────────────────────────────
import posthogSdk from 'posthog-js';

const key  = import.meta.env.VITE_POSTHOG_KEY;
const host = import.meta.env.VITE_POSTHOG_HOST;

// Dev is off by default; the override lets a local session opt back in.
const wanted = import.meta.env.PROD || import.meta.env.VITE_POSTHOG_DEV === '1';

// Anything with a .capture() the app can call. Swapped for the real SDK below
// when analytics are on — a stub keeps posthog-js from logging an
// "uninitialized" warning at every call site.
let posthog = new Proxy({}, { get: () => () => {} });

if (!wanted) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.info('PostHog disabled in dev. Set VITE_POSTHOG_DEV=1 in .env to enable.');
  }
} else if (!key || !host) {
  // eslint-disable-next-line no-console
  console.error(
    'VITE_POSTHOG_KEY variable required by PostHog is missing or un-configured, ' +
    'this causes events to be silently missed. ' +
    'This error stops appearing once VITE_POSTHOG_KEY is configured.',
  );
} else {
  posthogSdk.init(key, {
    api_host: host,
    defaults: '2026-05-30',
  });
  posthog = posthogSdk;
}

export { posthog };
