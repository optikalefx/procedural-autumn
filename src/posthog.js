// ─────────────────────────────────────────────────────────────────────────────
//  PostHog analytics — initialised once, exported for use across the app.
//
//  Uses VITE_POSTHOG_KEY and VITE_POSTHOG_HOST from the environment. In
//  development the module warns loudly when those variables are missing so
//  misconfiguration is never silent; in production the SDK is simply not
//  initialised and all capture calls become no-ops. This means the app always
//  boots whether or not PostHog is configured.
// ─────────────────────────────────────────────────────────────────────────────
import posthog from 'posthog-js';

const key  = import.meta.env.VITE_POSTHOG_KEY;
const host = import.meta.env.VITE_POSTHOG_HOST;

if (!key || !host) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.error(
      'VITE_POSTHOG_KEY variable required by PostHog is missing or un-configured, ' +
      'this causes events to be silently missed. ' +
      'This error stops appearing once VITE_POSTHOG_KEY is configured.',
    );
  }
} else {
  posthog.init(key, {
    api_host: host,
    defaults: '2026-05-30',
  });
}

export { posthog };
