#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  hunt_gallery — the photographs one player has taken, pulled out of PostHog
//  and written to a contact sheet you can open.
//
//  PostHog stores a hunt photograph as a base64 data URL on the `hunt_photo`
//  event (see src/game/hunt_analytics.js). Its own event view will not render
//  one — you get the string — so the pictures are there and invisible.
//
//  ── why this is a script and not a thing an agent does by hand ──────────────
//
//  Because doing it by hand does not work, and that was established by trying:
//  a photograph is 9-16 KB of base64, a finished sheet is twenty-one of them,
//  and moving ~275 KB of that through a conversation to retype it into an HTML
//  file truncated the very first image at 8,539 of 15,867 characters. The bytes
//  must go from the API to the file without a language model in the middle.
//
//  ── usage ───────────────────────────────────────────────────────────────────
//
//    node tools/hunt_gallery.mjs --list           who has photographs
//    node tools/hunt_gallery.mjs <player-id>      their contact sheet
//
//  Options: --days N (default 90), --out PATH, --all (every take, not just the
//  latest print per line).
//
//  ── the one thing you have to set up ────────────────────────────────────────
//
//  A PERSONAL API KEY, which is not the key the game ships with. `.env` holds
//  VITE_POSTHOG_KEY, a *project* key: write-only, ingest-only, and useless for
//  reading anything back. Reading needs a personal key (`phx_…`), made at
//    PostHog -> Settings -> Personal API keys -> Create,
//  scoped to `query:read` — that is the only scope needed, --list included,
//  because everything here queries the events table. Put it in `.env` as
//  POSTHOG_PERSONAL_API_KEY. `.env` is gitignored; keep it that way.
//
//  Note the two different hosts: VITE_POSTHOG_HOST is the INGEST host
//  (us.i.posthog.com) and the query API is not on it. Hence POSTHOG_API_HOST,
//  defaulting to the matching app host.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');

// ── config ───────────────────────────────────────────────────────────────────

/** Parse .env by hand rather than adding a dependency for five lines. */
function env() {
  const out = { ...process.env };
  try {
    for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
      if (m) out[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env: process.env may still carry everything */ }
  return out;
}

const E = env();
const KEY = E.POSTHOG_PERSONAL_API_KEY;
const PROJECT = E.POSTHOG_PROJECT_ID || '573452';
// The ingest host (us.i.posthog.com) does not serve the query API. Strip the
// `i.` rather than making the user configure a second URL they will get wrong.
const API = (E.POSTHOG_API_HOST
  || (E.VITE_POSTHOG_HOST || 'https://us.posthog.com').replace('//us.i.', '//us.'))
  .replace(/\/$/, '');

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

// ── the query ────────────────────────────────────────────────────────────────

/**
 * Refuse clearly, and only when a query is actually attempted.
 *
 * Deliberately not a top-level check: this module exports `render`, and a
 * module that calls `process.exit` while merely being imported cannot be
 * tested or reused.
 */
function requireKey() {
  if (KEY) return;
  die('POSTHOG_PERSONAL_API_KEY is not set.\n\n' +
      '  The VITE_POSTHOG_KEY in .env is the project key — write-only, and it\n' +
      '  cannot read events back. Make a PERSONAL key instead:\n\n' +
      `    ${API}/settings/user-api-keys  ->  Create personal API key\n` +
      '    scope: query:read  (the only one needed)\n\n' +
      '  then add it to .env:\n\n' +
      '    POSTHOG_PERSONAL_API_KEY=phx_...');
}

async function hogql(query) {
  requireKey();
  let res;
  try {
    res = await fetch(`${API}/api/projects/${PROJECT}/query/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    });
  } catch (e) {
    // Node prints a raw undici stack for a refused connection, which tells the
    // reader nothing about the one thing that is usually wrong: the host.
    die(`could not reach ${API}\n\n  ${e.cause?.message ?? e.message}\n\n` +
        '  Events are ingested at us.i.posthog.com but the query API is at\n' +
        '  us.posthog.com — set POSTHOG_API_HOST if yours differs.');
  }
  const text = await res.text();
  if (!res.ok) {
    die(`PostHog said ${res.status}.\n\n  ${text.slice(0, 600)}\n\n` +
        (res.status === 401 || res.status === 403
          ? '  That is usually the key: wrong key, or missing the query:read scope.'
          : `  Host ${API}, project ${PROJECT}.`));
  }
  return JSON.parse(text).results ?? [];
}

/** Single-quoted HogQL literal. Ids come from a CLI arg, so quote them. */
const lit = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// ── modes ────────────────────────────────────────────────────────────────────

async function list(days) {
  const rows = await hogql(`
    SELECT distinct_id,
           count() AS photos,
           uniq(properties.item_id) AS lines,
           max(timestamp) AS latest
    FROM events
    WHERE event = 'hunt_photo'
      AND timestamp >= now() - INTERVAL ${days} DAY
    GROUP BY distinct_id
    ORDER BY latest DESC
    LIMIT 100`);
  if (!rows.length) return console.log(`\n  no hunt_photo events in the last ${days} days\n`);
  console.log(`\n  ${'player'.padEnd(38)} ${'lines'.padStart(5)} ${'photos'.padStart(6)}  latest`);
  for (const [id, photos, lines, latest] of rows) {
    console.log(`  ${String(id).padEnd(38)} ${String(lines).padStart(5)} ${String(photos).padStart(6)}  ${String(latest).slice(0, 19)}`);
  }
  console.log(`\n  node tools/hunt_gallery.mjs <player>\n`);
}

async function gallery(player, { days, out, all }) {
  const rows = await hogql(`
    SELECT properties.item_id       AS item,
           properties.item_subject  AS subject,
           properties.award_index   AS n,
           properties.photo_bytes   AS bytes,
           properties.photo         AS photo,
           timestamp                AS at,
           properties.synthetic     AS synthetic
    FROM events
    WHERE event = 'hunt_photo'
      AND distinct_id = ${lit(player)}
      AND timestamp >= now() - INTERVAL ${days} DAY
    ORDER BY timestamp`);

  if (!rows.length) {
    die(`no photographs for ${player} in the last ${days} days.\n\n` +
        '  node tools/hunt_gallery.mjs --list   to see who has some');
  }

  // One print per line by default — the newest. A line photographed twice is
  // the player replacing the picture, which is a real thing the journal offers
  // (see hud_photo's `again` path), and the sheet shows what they settled on.
  const shots = rows.map(([item, subject, n, bytes, photo, at, synthetic]) =>
    ({ item, subject, n: Number(n) || 0, bytes: Number(bytes) || photo.length, photo, at, synthetic }));
  const kept = all ? shots : [...new Map(shots.map((s) => [s.item, s])).values()];
  kept.sort((a, b) => a.n - b.n || String(a.at).localeCompare(String(b.at)));

  const html = render(kept, { player, days, all });
  const path = resolve(ROOT, out || `shots/gallery/${player}.html`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);

  const kb = kept.reduce((a, s) => a + s.bytes, 0) / 1024;
  const distinct = new Set(kept.map((s) => s.photo)).size;
  console.log(`\n  ${kept.length} print${kept.length === 1 ? '' : 's'}` +
              `${distinct !== kept.length ? ` (${distinct} distinct image${distinct === 1 ? '' : 's'})` : ''}` +
              `, ${kb.toFixed(0)} KB\n  ${path}\n`);
}

// ── the sheet ────────────────────────────────────────────────────────────────
//
// A darkroom proof sheet rather than a page of cards: the frames butt together
// on a dark ground, the numbers are the award order (which is real sequence,
// not decoration), and the metadata is set in mono along the bottom edge the
// way it would be written on the sleeve. The palette is the GAME's, read out of
// index.html — #1b1420 is its body, #fff6ea its --ink, and the rose and amber
// are its loading-screen ridgeline — so the sheet and the thing it documents
// look like they come from the same place.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function render(shots, { player, days, all }) {
  const kb = shots.reduce((a, s) => a + s.bytes, 0) / 1024;
  const distinct = new Set(shots.map((s) => s.photo)).size;
  const synthetic = shots.some((s) => s.synthetic === true || s.synthetic === 'true');
  const dates = shots.map((s) => String(s.at).slice(0, 10)).filter(Boolean).sort();
  const span = dates.length && dates[0] !== dates[dates.length - 1]
    ? `${dates[0]} – ${dates[dates.length - 1]}` : (dates[0] ?? '—');

  const tiles = shots.map((s) => `
      <figure class="frame">
        <div class="plate"><img src="${s.photo}" alt="${esc(s.subject || s.item)}" loading="lazy"></div>
        <figcaption>
          <span class="n">${s.n || '·'}</span>
          <span class="subj">${esc(s.subject || s.item)}</span>
          <span class="meta">${esc(s.item)} · ${(s.bytes / 1024).toFixed(1)} KB</span>
        </figcaption>
      </figure>`).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Contact sheet — ${esc(player)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
  :root{
    --ground:#f1edee; --sleeve:#e4dee0; --plate:#d8d0d3;
    --ink:#241b2b; --dim:#6b5f70; --rule:#cdc3c7;
    --rose:#a8425f; --amber:#9a6420;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --ground:#1b1420; --sleeve:#241b2c; --plate:#120d16;
      --ink:#fff6ea; --dim:#a898b0; --rule:#3a2c42;
      --rose:#d1687a; --amber:#f3b077;
    }
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--ground); color:var(--ink);
    font-family:Archivo,-apple-system,"Segoe UI",system-ui,sans-serif;
    font-size:15px; line-height:1.5;
  }
  .wrap{max-width:1180px;margin:0 auto;padding:clamp(24px,5vw,64px) clamp(16px,4vw,40px) 96px}
  header{border-bottom:1px solid var(--rule);padding-bottom:28px;margin-bottom:36px}
  .eyebrow{
    font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11px;
    letter-spacing:.18em;text-transform:uppercase;color:var(--rose);margin:0 0 10px
  }
  h1{
    font-family:"Instrument Serif",Georgia,serif;font-weight:400;
    font-size:clamp(38px,6vw,60px);line-height:1.02;margin:0 0 6px;text-wrap:balance
  }
  .id{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:13px;color:var(--dim);word-break:break-all}
  .stats{display:flex;flex-wrap:wrap;gap:28px 40px;margin-top:26px}
  .stat{display:flex;flex-direction:column;gap:2px}
  .stat b{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:22px;font-weight:500;font-variant-numeric:tabular-nums}
  .stat span{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
  .flag{
    display:inline-block;margin-top:22px;padding:6px 12px;border:1px solid var(--amber);
    color:var(--amber);border-radius:2px;
    font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.1em
  }
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule)}
  .frame{margin:0;background:var(--sleeve);display:flex;flex-direction:column}
  .plate{background:var(--plate);aspect-ratio:16/9;overflow:hidden}
  .plate img{width:100%;height:100%;object-fit:cover;display:block}
  figcaption{padding:12px 14px 14px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:baseline}
  .n{
    grid-row:1/3;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:12px;
    color:var(--rose);font-variant-numeric:tabular-nums;padding-top:2px
  }
  .subj{font-family:"Instrument Serif",Georgia,serif;font-size:19px;line-height:1.2}
  .meta{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10.5px;color:var(--dim);letter-spacing:.02em}
  footer{margin-top:40px;color:var(--dim);font-size:12.5px;border-top:1px solid var(--rule);padding-top:20px}
</style></head><body>
<div class="wrap">
  <header>
    <p class="eyebrow">Camping Season · scavenger hunt</p>
    <h1>Contact sheet</h1>
    <div class="id">${esc(player)}</div>
    <div class="stats">
      <div class="stat"><b>${shots.length}</b><span>${all ? 'exposures' : 'prints'}</span></div>
      <div class="stat"><b>${kb.toFixed(0)}<small> KB</small></b><span>stored</span></div>
      <div class="stat"><b>${distinct}</b><span>distinct images</span></div>
      <div class="stat"><b>${esc(span)}</b><span>taken</span></div>
    </div>
    ${synthetic ? '<div class="flag">synthetic — driven from __dbg or ?hunt=, not real play</div>' : ''}
  </header>
  <div class="grid">${tiles}
  </div>
  <footer>
    Every photograph PostHog holds for this player, newest print per line, over the last ${days} days.
    Numbers are the order the lines were crossed off. Generated by <code>tools/hunt_gallery.mjs</code>.
  </footer>
</div>
</body></html>`;
}

// ── cli ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const days = Number(flag('days', 90)) || 90;
const player = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--days' && argv[argv.indexOf(a) - 1] !== '--out');

// Guarded, so `render` can be imported and exercised without the CLI firing.
// This file has top-level await and calls `die()` on a missing argument, so an
// unguarded body would make the module impossible to test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (argv.includes('--list')) await list(days);
  else if (!player) die('usage: node tools/hunt_gallery.mjs <player-id>\n' +
                        '         node tools/hunt_gallery.mjs --list');
  else await gallery(player, { days, out: flag('out'), all: argv.includes('--all') });
}
