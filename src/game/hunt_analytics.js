// ─────────────────────────────────────────────────────────────────────────────
//  hunt_analytics — the scavenger hunt, reported to PostHog.
//
//  What this exists to answer, in the order the questions were asked:
//
//    who has photographed what     `hunt_photographed_<id>` on the person, and
//                                  `hunt_items` as the ordered path they took
//    how long is a journey taking  two clocks, below — they disagree and both
//                                  are worth having
//    the photographs themselves    `hunt_photo`, one event per print
//    who has won                   `hunt_won` on the person, `hunt_completed`
//                                  as the moment
//
//  It watches; it never writes to the sheet and never judges it. `hunt_store`
//  does not know this file exists, which is deliberate and is the reason it is
//  a separate module rather than six `posthog.capture` lines added to the store
//  — see "why the store stays clean" below.
//
//  ── the trap that would have made every number wrong ────────────────────────
//
//  `hunt` is a MODULE SINGLETON and its `_load()` has already run by the time
//  anything here executes: on the second session the store is fully populated
//  before the first frame. A listener that simply reported every crossed-off
//  line it saw would therefore re-report the player's entire sheet on every
//  reload — nineteen awards a session, a completion every time the tab is
//  refreshed, and a "time to win" of about four milliseconds.
//
//  So `install` takes a BASELINE of what is already done and only ever reports
//  ids that appear after it. That single line is what makes the rest true.
//
//  ── two clocks, because they answer different questions ─────────────────────
//
//  A journey's length is genuinely ambiguous in a game nobody plays in one
//  sitting, so both are sent and neither is called "the" duration:
//
//    wall clock   `elapsed_ms` — first award to last, calendar time. This is
//                 the honest answer to "how long is it taking them", and it
//                 counts the fortnight the tab was shut.
//    play clock   `play_seconds` — `stats.time.total`, which only advances
//                 while the valley is running. This is the design number: how
//                 much game it costs to finish the sheet.
//
//  Neither is stored here. Both are derived from `doneAt`, which the store
//  already keeps on disk beside every tick, so they survive a reload and there
//  is no second copy of the truth to drift.
//
//  ── the picture goes in its own event ───────────────────────────────────────
//
//  `hunt_item_awarded` carries no image bytes. `hunt_photo` does, and it is a
//  separate capture, for three reasons that all point the same way:
//
//   1. **The tick outranks the picture** — the store's own rule, and this file
//      keeps it. Getting the image means decoding the stored print and
//      re-encoding it, which is asynchronous; hanging the award event on that
//      would risk losing a crossed-off line to a failed decode. The award goes
//      immediately and the picture catches up.
//   2. PostHog **discards** an event over 1 MB rather than truncating it. A
//      photograph is the only thing here that could approach that, and keeping
//      it out of the award event means the award event can never be the one
//      that gets dropped.
//   3. A 13 KB blob on every award event would be dragged through every funnel,
//      trend and breakdown built on it, forever. The heavy event is the one you
//      query when you actually want the pictures.
//
//  ── why the store stays clean ───────────────────────────────────────────────
//
//  `hunt_store.js` is imported by node harnesses in `tools/_scratch/`, and
//  `posthog.js` reads `import.meta.env` — which in plain node is `undefined`,
//  so the property read throws a TypeError and takes the harness with it.
//  Putting a capture call in the store would break those tools the day it
//  landed. Everything analytics is on this side of the wall.
// ─────────────────────────────────────────────────────────────────────────────
import { posthog, POSTHOG_PHOTOS } from '../posthog.js';
import { hunt, makeThumb } from './hunt_store.js';
import { stats } from './stats_store.js';
import { HUNT_ITEMS, HUNT_ANIMAL_IDS } from './hunt_items.js';

/**
 * What a photograph is re-encoded to on its way out.
 *
 * NOT the store's `THUMB_MAX` of 1024. That number is sized for the journal's
 * print, which gets most of a screen when a player leans in on one entry; this
 * one is sized for a contact sheet in an analytics tool, where the picture only
 * has to be recognisable as the shot that crossed the line off.
 *
 * Measured rather than guessed, over four real captures of this game — forest
 * canopy, backlit ridge, dawn valley, the road — because JPEG does not scale
 * with pixel count and the header's budget depends on the worst case, not the
 * mean:
 *
 *     1024 q0.72   mean 116.1 KB   worst 138.7 KB     13.5% of the event cap
 *      512 q0.72   mean  36.3 KB   worst  44.0 KB      4.3%
 *      320 q0.60   mean  12.8 KB   worst  15.4 KB      1.5%
 *      256 q0.60   mean   9.1 KB   worst  11.0 KB      1.1%
 *
 * The worst case is forest canopy in every row, which is the same frame
 * `hunt_store` names as the hardest thing this game draws for a DCT. 320 is
 * chosen over 256 because the difference in bytes is 3 KB and the difference on
 * screen is whether a rabbit in long grass is identifiable.
 *
 * A whole nineteen-line playthrough therefore uploads about 243 KB, spread over
 * nineteen events across however many weeks it takes.
 */
const PHOTO_MAX = 320;
const PHOTO_QUALITY = 0.60;

/**
 * A photograph bigger than this is dropped rather than sent.
 *
 * PostHog **discards** an event over 1 MB — it does not truncate it — so the
 * failure mode this guards is silent and total. At 320 px / q0.60 the largest
 * of four real frames was 15.4 KB, so 120 KB is roughly eight times the
 * measured worst case: comfortably out of the way of a legitimate picture, and
 * still an order of magnitude below the cliff. It is here for the day somebody
 * retunes the two numbers above, which is exactly the guard `hunt_store` keeps
 * over its own `PHOTO_MAX_CHARS` and for the same reason.
 */
const PHOTO_MAX_CHARS = 120_000;

let installed = false;
let ctxRef = null;

/**
 * Did the debug surface drive any of this?
 *
 * `__dbg.win()`, `__dbg.sheet(18)` and `?hunt=win` award real items through the
 * real `hunt.award`, which is the whole point of that file — it takes the path
 * the game takes. It also means a developer testing the ceremony is
 * indistinguishable, at the store, from a player who has finished the game.
 * Without this flag the first thing "who has won" would have reported is the
 * person who wrote it.
 *
 * Sticky for the session and sent on every event, plus set on the person, so a
 * single `synthetic is not true` filter cleans the whole picture up.
 */
let synthetic = false;

/** Ids crossed off as of the last look. THE baseline; see the header. */
let seen = new Set();
let lastTarget = null;
let wasMysteryOpen = false;
let wasWon = false;

/** Mark this session as debug-driven. Called by `hunt_debug`; see above. */
export function markSynthetic() { synthetic = true; }

// ── reading the sheet ────────────────────────────────────────────────────────
//
// Through the store's public surface (`isDone` / `doneAt`) and never through
// `hunt.data`, so nothing here can be broken by a change to how the sheet is
// held. Nineteen lookups on a change that happens at most sixteen times in a
// playthrough is not a cost worth optimising away.

/** Every crossed-off id, in the order the player crossed them off. */
function doneIds() {
  return HUNT_ITEMS
    .filter((it) => hunt.isDone(it.id))
    .map((it) => it.id)
    .sort((a, b) => hunt.doneAt(a) - hunt.doneAt(b));
}

/** The in-game hour, matching the convention `photo_taken` already uses. */
function hourOfDay() {
  const h = ctxRef?.lighting?.hour;
  return Number.isFinite(h) ? Math.round(h * 100) / 100 : null;
}

/**
 * The person-level picture of this player's hunt.
 *
 * Sent as `$set` on every hunt event AND merged into `session_started`, so a
 * player who finished the sheet on another machine — or before this file
 * existed — still shows up correctly the next time they boot, without a
 * dedicated sync event to pay for.
 */
export function huntPersonProps() {
  const ids = doneIds();
  const first = ids.length ? hunt.doneAt(ids[0]) : 0;
  const last = ids.length ? hunt.doneAt(ids[ids.length - 1]) : 0;
  const total = hunt.total;

  const props = {
    hunt_done_count: ids.length,
    hunt_total: total,
    hunt_remaining: Math.max(0, total - ids.length),
    hunt_percent: total ? Math.round((ids.length / total) * 100) : 0,
    // The ordered path, which is the one thing a per-item boolean cannot say:
    // whether the bear came first or last.
    hunt_items: ids,
    hunt_animals_done: ids.filter((id) => HUNT_ANIMAL_IDS.has(id)).length,
    hunt_animals_total: hunt.animalTotal,
    hunt_mystery_open: hunt.mysteryOpen,
    hunt_won: hunt.won,
    hunt_first_award_at: first ? new Date(first).toISOString() : null,
    hunt_last_award_at: last ? new Date(last).toISOString() : null,
    hunt_elapsed_days: first && last ? +((last - first) / 86_400_000).toFixed(2) : 0,
    hunt_play_seconds: Math.round(stats.get('time.total')),
    hunt_sessions: stats.sessions,
    hunt_photos_kept: ids.filter((id) => !!hunt.photoFor(id)).length,
  };

  // One boolean per line crossed off, and this is the property that answers
  // "who has photographed what" in one click: they cluster together in an
  // alphabetical filter dropdown, each is a cohort on its own, and a breakdown
  // over one of them is a two-bar chart of found / not found.
  //
  // Only the earned ones are set. An un-earned line is ABSENT rather than
  // `false`, so `is not set` and `= false` do not both have to be checked, and
  // a person's profile never carries nineteen keys to say nothing happened.
  for (const id of ids) props[`hunt_photographed_${id}`] = true;

  if (synthetic) props.hunt_synthetic = true;
  return props;
}

/** Properties every event in this file carries. */
function base() {
  return {
    done_count: hunt.doneCount(),
    total: hunt.total,
    play_seconds: Math.round(stats.get('time.total')),
    sessions: stats.sessions,
    synthetic,
  };
}

// ── the events ───────────────────────────────────────────────────────────────

function captureAward(item, aim) {
  const ids = doneIds();
  const first = ids.length ? hunt.doneAt(ids[0]) : 0;
  const at = hunt.doneAt(item.id);
  const index = ids.indexOf(item.id) + 1;
  const photo = hunt.photoFor(item.id);

  posthog.capture('hunt_item_awarded', {
    ...base(),
    item_id: item.id,
    item_subject: item.subject,
    item_is_animal: !!item.animal,
    item_is_mystery: !!item.mystery,
    // Where the line sits on the printed sheet. The order of `HUNT_ITEMS` is a
    // walk rather than a taxonomy — the verge, then the ones you go and find,
    // then the set-pieces and the sky — so this index already carries the
    // grouping and there is no category table here to drift from that one.
    sheet_index: HUNT_ITEMS.findIndex((it) => it.id === item.id),
    // Which line of the journey this was: 1 for the first ever, and the sheet's
    // length for the last. Deliberately not written out as a number — the sheet
    // has grown twice already and `hunt_items`' own header still says nineteen.
    //
    // Derived from the item's PLACE in `doneAt` order, never from a live
    // `doneCount()`, and the difference is not academic: two subjects can share
    // one frame — a deer at a waterfall, which `hud_photo` handles explicitly —
    // so both are awarded inside a single synchronous burst and this capture
    // runs after all of it. A live count would report the batch's final tally
    // on every event in the batch. `done_count` is corrected off the same
    // number for the same reason; on this one event the two coincide by
    // construction, and both are kept because `done_count` is what every other
    // event here means by it and `award_index` is what a funnel step reads.
    award_index: index,
    done_count: index,
    remaining: Math.max(0, hunt.total - index),
    // Both clocks, measured from the FIRST award rather than from this session,
    // so a resumed journey reads as one journey. Zero on the very first line,
    // which is correct: nothing has elapsed yet.
    elapsed_ms: first && at ? at - first : 0,
    elapsed_days: first && at ? +((at - first) / 86_400_000).toFixed(2) : 0,
    // Was the player deliberately hunting this, or did they walk into it?
    //
    // From a snapshot taken before the target block ran, NOT from `lastTarget`
    // live. `award` clears the aim in the same write as the tick — that is what
    // lets `Wildlife._nearestQuarry` trust its quarry — so by the time this
    // microtask runs the aim is already null, and reading it here would report
    // `false` for every deliberate catch: precisely the case the field exists
    // to see.
    was_target: !!aim && aim === item.id,
    hour_of_day: hourOfDay(),
    has_photo: !!photo,
    $set: huntPersonProps(),
  });

  if (photo && POSTHOG_PHOTOS) capturePhoto(item, photo);
}

/**
 * Send the photograph, re-encoded small.
 *
 * The source is the store's 1024 px print, which is a data URL string — so
 * getting pixels back out of it means an `Image` decode, which is why this is
 * asynchronous and why the award event above does not wait for it. A second
 * JPEG generation is spent here; at a 3.2x downscale the resampling dominates
 * it completely and nothing of it is visible at 320 px.
 *
 * `makeThumb` is `hunt_store`'s, imported rather than re-implemented: it is
 * already the exact canvas dance this needs, including the high-quality
 * multi-step downscale that stops a treeline aliasing, and a second copy of it
 * here would be a second thing to keep in step.
 */
function capturePhoto(item, dataUrl) {
  if (typeof Image === 'undefined') return;
  const img = new Image();
  img.onload = () => {
    try {
      const small = makeThumb(img, PHOTO_MAX, PHOTO_QUALITY);
      if (!small) return;
      if (small.length > PHOTO_MAX_CHARS) {
        console.warn('[hunt] photo not uploaded,', (small.length / 1024) | 0, 'KB >',
                     PHOTO_MAX_CHARS / 1024, 'KB');
        return;
      }
      posthog.capture('hunt_photo', {
        item_id: item.id,
        item_subject: item.subject,
        award_index: doneIds().indexOf(item.id) + 1,
        // A data URL. It is not rendered by PostHog's own event view — read it
        // out with SQL and put it in an <img src> to look at the pictures.
        photo: small,
        photo_bytes: small.length,
        photo_px: PHOTO_MAX,
        synthetic,
      });
    } catch (e) {
      // A picture is never worth an exception escaping into a store listener.
      console.warn('[hunt] photo upload failed', e);
    }
  };
  // A decode that fails costs the picture and nothing else: `hunt_item_awarded`
  // was sent before this function was called.
  img.onerror = () => { /* no picture; the line is already reported */ };
  img.src = dataUrl;
}

function captureCompleted() {
  const ids = doneIds();
  const first = ids.length ? hunt.doneAt(ids[0]) : 0;
  const last = ids.length ? hunt.doneAt(ids[ids.length - 1]) : 0;

  // The longest a single line held them up. The most useful one number on this
  // event: it names the item that nearly stopped the playthrough.
  let stall = 0, stalledOn = null;
  for (let i = 1; i < ids.length; i++) {
    const gap = hunt.doneAt(ids[i]) - hunt.doneAt(ids[i - 1]);
    if (gap > stall) { stall = gap; stalledOn = ids[i]; }
  }

  posthog.capture('hunt_completed', {
    ...base(),
    elapsed_ms: last - first,
    elapsed_days: first && last ? +((last - first) / 86_400_000).toFixed(2) : 0,
    // The path taken, in order. "What do people photograph first" and "what is
    // always last" are both breakdowns of this one array.
    //
    // NOT called `order`: that is a SQL keyword, and PostHog stores an array
    // property as a JSON STRING rather than a real array, so reading it back is
    // already the fiddly `JSONExtractArrayRaw(coalesce(properties.x, ''))' —
    // without the coalesce the value arrives Nullable and the extract throws
    // "Array(String) cannot be inside Nullable". No need to spend a reserved
    // word on top of that. The per-item `hunt_photographed_*` booleans exist
    // because of the same storage fact: they are the queryable half, this is
    // the readable one.
    item_order: ids,
    first_item: ids[0] ?? null,
    last_item: ids[ids.length - 1] ?? null,
    longest_gap_ms: stall,
    longest_gap_item: stalledOn,
    photos_kept: ids.filter((id) => !!hunt.photoFor(id)).length,
    // The store gives up photographs before it gives up ticks when localStorage
    // fills. Worth knowing how often a finished book has holes in it.
    photos_evicted: hunt.evicted,
    storage_degraded: hunt.degraded,
    $set: huntPersonProps(),
  });
}

// ── the listener ─────────────────────────────────────────────────────────────

function onChange() {
  // The sheet can go BACKWARDS. `hunt.reset()` wipes it and `__dbg.sheet(n)`
  // resets before it awards, so a baseline that only ever GREW would hold ids the
  // store no longer has — and every one of them, re-awarded, would be swallowed
  // by the diff below as "already seen". Re-syncing first is what makes that diff
  // true in both directions instead of only upwards. Deleting the current member
  // of a Set mid-iteration is defined and safe.
  for (const id of seen) if (!hunt.isDone(id)) seen.delete(id);
  if (wasWon && !hunt.won) wasWon = false;
  if (wasMysteryOpen && !hunt.mysteryOpen) wasMysteryOpen = false;

  // New awards. Driven by a diff against the baseline rather than by the id the
  // store hands the listener, because that id is also emitted for a photo
  // arriving, for a target moving and for an eviction — and because a diff
  // cannot miss one, however the sheet came to change.
  const fresh = [];
  for (const it of HUNT_ITEMS) {
    if (!hunt.isDone(it.id) || seen.has(it.id)) continue;
    seen.add(it.id);
    fresh.push(it);
  }

  if (fresh.length) {
    // The aim as it stood when the line was crossed off. Snapshotted here because
    // the target block below is about to step it; see `was_target`.
    const aim = lastTarget;
    // On a microtask, and that is the whole reason the photograph is ever
    // attached at all. `award()` writes the tick, emits, and only THEN attaches
    // the picture — emitting a second time — so a listener that captured
    // inline would read `photoFor(id)` one emit too early and every award would
    // report `has_photo: false`. By the time a microtask runs, `award()` has
    // returned and the synchronous canvas path (the one the shutter takes) has
    // stored its print.
    queueMicrotask(() => {
      for (const it of fresh) {
        try { captureAward(it, aim); }
        catch (e) { console.warn('[hunt] award capture failed', e); }
      }
      // After the awards, so the ordering of events matches the ordering of the
      // moments: the last printed line is crossed off, and *then* the book has
      // one more. Both are latched, so neither can fire twice.
      if (!wasMysteryOpen && hunt.mysteryOpen) {
        wasMysteryOpen = true;
        posthog.capture('hunt_mystery_revealed', { ...base(), $set: huntPersonProps() });
      }
      if (!wasWon && hunt.won) {
        wasWon = true;
        try { captureCompleted(); }
        catch (e) { console.warn('[hunt] completion capture failed', e); }
      }
    });
  }

  // The standing intention. This is the only signal that explains a STALLED
  // journey: a player who aims at the bear for three sessions and never crosses
  // it off is a different story from one who never looked for it, and the sheet
  // alone cannot tell the two apart.
  const t = hunt.target;
  if (t !== lastTarget) {
    const prev = lastTarget;
    lastTarget = t;
    if (t) posthog.capture('hunt_target_set', { ...base(), item_id: t });
    // A target that cleared because the line was crossed off is not the player
    // giving up on it, and `award` clears it in the same write as the tick — so
    // only report an abandonment when the item is still outstanding.
    else if (prev && !hunt.isDone(prev)) {
      posthog.capture('hunt_target_cleared', { ...base(), item_id: prev });
    }
  }
}

/**
 * Start reporting the hunt. Call once, from main.js, BEFORE `installHuntDebug`
 * — so that `?hunt=win` lands in front of a listener that is already watching
 * and is reported (marked `synthetic`) rather than swallowed into the baseline.
 *
 * @param {object} ctx  the app context; only `lighting.hour` is read, and that
 *                      optionally.
 */
export function installHuntAnalytics(ctx) {
  if (installed) return;
  installed = true;
  ctxRef = ctx ?? null;

  // THE BASELINE. Everything already on the sheet is old news; see the header.
  seen = new Set(doneIds());
  lastTarget = hunt.target;
  wasMysteryOpen = hunt.mysteryOpen;
  wasWon = hunt.won;

  // The debug flags award real items on a timer after this runs, so the URL is
  // read here rather than waiting for `hunt_debug` to mark the session itself.
  try {
    const p = new URLSearchParams(location.search);
    if (p.has('hunt') || p.has('bigfoot')) synthetic = true;
  } catch { /* no location: nothing to read */ }

  hunt.onChange(onChange);
}
