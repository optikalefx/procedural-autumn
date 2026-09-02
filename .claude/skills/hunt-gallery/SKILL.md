---
name: hunt-gallery
description: >-
  Look at the photographs a player has actually taken in the game, pulled out of
  PostHog and rendered as a contact sheet. Use whenever someone wants to SEE
  captured hunt photos rather than count them — "show me the images for
  <user-id>", "render the gallery for that player", "what did they photograph",
  "contact sheet", "the photos in PostHog", "who has photos" — and when asked
  which players have any. Not for counting, funnels or win rates: those are
  ordinary PostHog queries on hunt_item_awarded / hunt_completed and need no
  skill. Not for the in-game journal either (src/journal/ draws that from
  localStorage).
---

# Hunt gallery

`hunt_photo` events carry the photograph itself — a base64 JPEG data URL, about
9–16 KB, written by `src/game/hunt_analytics.js`. PostHog's own event view will
not render one; it shows you the string. So the pictures are in there and
effectively invisible, and this is how you look at them.

## Two routes. Pick by whether you want it *now* or *repeatably*.

### A. Through the user's own Chrome — no API key at all

The fastest route, and the right one for "show me the photos for X". The user's
Chrome is already signed in to PostHog, so the page's own session can call the
query API and render the images itself. **The image bytes never enter the
conversation** — the browser fetches and paints them.

Drive it with the `claude-in-chrome` tools (NOT the Browser pane, which is a
separate profile and is not signed in):

1. `navigate` a tab to `https://us.posthog.com/project/<id>/sql` — you must be
   on a PostHog origin for the cookie to be sent.
2. `javascript_tool`: read the CSRF cookie (`posthog_csrftoken`, falling back to
   `csrftoken`), then `fetch('/api/projects/<id>/query/', {method:'POST',
   credentials:'include', headers:{'X-CSRFToken':csrf}, body: {query:{kind:'HogQLQuery',
   query:'…'}}})`. A 200 means signed in; 403 means the CSRF header is missing.
3. Build the sheet as an HTML string in the page and show it with
   `URL.createObjectURL(new Blob([html],{type:'text/html'}))` → `location.href`.

Caveat worth saying out loud: a blob URL dies with the tab. It is a look, not a
file. Use route B when the sheet has to persist.

### B. The script — repeatable, and writes a real file

```bash
node tools/hunt_gallery.mjs --list                 # who has photographs
node tools/hunt_gallery.mjs <player-id>            # their contact sheet
```

It writes `shots/gallery/<player-id>.html` and prints the path. Open that.

Options: `--days N` (default 90), `--out PATH`, `--all` (every exposure rather
than the newest print per line).

## Whichever route: never move the image bytes through the conversation

Fetching them with `execute-sql` and retyping them into an HTML file is the
obvious third option and it does not work. A finished sheet is twenty-one
photographs, ~275 KB of base64; retyping that truncated the very first image at
8,539 of 15,867 characters — **silently**, because a truncated data URL is still
a valid-looking string, so nothing errors and the picture is simply wrong.

Both routes above exist to keep the bytes out of the middle: A hands them
browser-to-browser, B hands them API-to-file.

## One-time setup: a personal API key

The `VITE_POSTHOG_KEY` in `.env` is the **project** key. It is write-only —
fine for the game sending events, useless for reading them back. Reading needs a
**personal** key:

1. PostHog → Settings → Personal API keys → **Create**
2. Scope: **`query:read`** — the only one needed, `--list` included, since everything
   here queries the `events` table. Do not grant more.
3. Put it in `.env` (which is gitignored — keep it that way):

```
POSTHOG_PERSONAL_API_KEY=phx_...
```

The script says all of this if the key is missing, so a first run is
self-explanatory rather than a 401.

`POSTHOG_PROJECT_ID` defaults to the Camping Season project; set it to point
somewhere else. `POSTHOG_API_HOST` defaults to the app host derived from
`VITE_POSTHOG_HOST` — note those are **different hosts**: events are ingested at
`us.i.posthog.com` and the query API is at `us.posthog.com`. Sending the query
to the ingest host is the first mistake everyone makes.

## What you get, and how to read it

A dark contact sheet in the game's own palette, one frame per crossed-off line,
numbered in **award order** — so the sheet reads as the journey, not as a bag of
files. Under each frame: the subject as the journal words it, the item id, and
the stored size.

Two things on it are worth actually reading:

- **`distinct images`** in the header. If it is lower than the print count, the
  same photograph is filed against several lines. In real play that is a player
  shooting a wide frame that satisfied more than one line; in test data it
  usually means someone drove the sheet with `__dbg` and a rotating handful of
  canvases.
- **the `synthetic` flag.** It appears when any event carries
  `synthetic: true`, meaning the sheet was driven from `window.__dbg` or a
  `?hunt=` URL rather than played. Treat such a gallery as a pipeline check, not
  as a player.

## Finding an id when you only have a person

`--list` gives distinct ids, which for this game **are** the player id: the UUID
in `pa.player`, bootstrapped as the PostHog `distinct_id` (see
`src/player_id.js`). One id is one browser. The Persons table also carries
`player_id`, `hunt_won` and one `hunt_photographed_<item>` boolean per line
earned, so "who photographed a bear" is a person filter, not a query over these
events — use the gallery to look at what they got, not to find them.

## If it comes back empty

Check in this order, because each is more likely than the next: the id is a
person UUID rather than a distinct id (they differ — `--list` prints the right
one); the photos are older than `--days`; photo upload was off for that session
(`VITE_POSTHOG_PHOTOS=0`); or the player genuinely crossed lines off without
keeping prints, which is legitimate — `hunt_item_awarded` fires with
`has_photo: false` when a photograph fails to encode or store.
