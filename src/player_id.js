// ─────────────────────────────────────────────────────────────────────────────
//  player_id — the one name a player has, minted on the first boot and kept.
//
//  Analytics needs a subject. "Who has photographed the bear" and "who has
//  won" are questions about a *person*, and PostHog cannot answer either about
//  an anonymous visitor: the SDK ships with `person_profiles: 'identified_only'`
//  (verified in @posthog/types, `posthog-config.d.ts`), which means no person
//  profile exists — and therefore no person property can be set or filtered on
//  — until something calls `identify`. Until this file existed, every event
//  this game sent was a fact about a session and about nobody.
//
//  So: a UUID, minted once, written to localStorage, and handed to PostHog as
//  a bootstrapped identified id before the first event leaves the page.
//
//  ── why not lean on PostHog's own distinct_id ───────────────────────────────
//
//  It would be one less key. It is the wrong one anyway, for a reason that is
//  specific to this game: the hunt sheet lives in localStorage under `pa.hunt`,
//  so a player's PROGRESS is already a property of this origin's storage box.
//  Minting the identity into the same box makes the two live and die together
//  — clear site data and you get a fresh sheet AND a fresh name, which is
//  honest, because a blank sheet *is* a new player. A distinct_id kept in a
//  cookie could outlive the sheet and would then report a player who had won
//  and then un-won.
//
//  ── it is a name, not a claim about a human ────────────────────────────────
//
//  Random, local, and tied to a browser rather than to a person: two browsers
//  are two players and always will be, and nothing here is asked of the user or
//  read from them. There is no login in this game and this is not the start of
//  one.
// ─────────────────────────────────────────────────────────────────────────────

const STORE = 'pa.player';

/** localStorage, or null where there isn't one (node, a locked-down iframe). */
function ls() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }        // some embeddings throw on the *access*
}

/**
 * A v4 UUID, by the best means this browser has.
 *
 * `crypto.randomUUID` is the one to want and is missing more often than its
 * support table suggests: it is gated on a SECURE CONTEXT, so it exists on
 * https and on localhost and is undefined the moment this game is opened from
 * a LAN address over plain http — which is exactly how it gets tested on a
 * phone. Hence two fallbacks rather than one, ending at `Math.random`: a
 * slightly weaker id is a far better outcome than a boot that throws.
 */
function mint() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fall through */ }

  const b = new Uint8Array(16);
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(b);
    } else {
      for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
    }
  } catch {
    for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
  }
  b[6] = (b[6] & 0x0f) | 0x40;          // version 4
  b[8] = (b[8] & 0x3f) | 0x80;          // variant 1
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-` +
         `${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

let cached = null;

/**
 * This player's id. Stable across sessions; the same string every call.
 *
 * Never throws and never returns null. Where there is no storage to write to
 * — Safari's private mode, an iframe with storage blocked — the id is minted
 * fresh, held in memory, and the session is simply counted as a new player.
 * That is a wrong answer, and it is the only one available; the alternative is
 * a boot that dies over analytics, which is not a trade this game makes.
 */
export function playerId() {
  if (cached) return cached;
  const store = ls();
  try {
    const seen = store?.getItem(STORE);
    // Length-checked rather than shape-checked: this only has to be a stable
    // opaque string, and refusing a legitimate id over a hyphen in the wrong
    // place would silently split one player into two.
    if (typeof seen === 'string' && seen.length >= 8 && seen.length <= 64) {
      return (cached = seen);
    }
  } catch { /* unreadable: mint a new one below */ }

  cached = mint();
  try { store?.setItem(STORE, cached); }
  catch { /* no room, or no store: the id lives for this session only */ }
  return cached;
}

/**
 * Take on an id decided elsewhere, and keep it.
 *
 * Exists for exactly one caller: PostHog reconciliation. `bootstrap.distinctID`
 * is only honoured when the SDK has no identity of its own yet — once its
 * `ph_<key>_posthog` record exists, the id stored THERE wins and the bootstrap
 * is ignored without a word. Clear `pa.player` while that record survives (or
 * arrive with one from an older build) and the two diverge permanently.
 *
 * When they disagree, PostHog's id is the right one to keep: every event the
 * player has ever sent is filed under it, so adopting it preserves the person
 * and re-minting would split them in two. Correcting it the other way is not
 * even available — PostHog refuses a merge between two already-identified ids,
 * and lists that refusal as an ingestion warning.
 */
export function adoptPlayerId(id) {
  if (typeof id !== 'string' || id.length < 8 || id.length > 64) return playerId();
  cached = id;
  try { ls()?.setItem(STORE, id); } catch { /* held for this session only */ }
  return id;
}

/** True when this id was minted this session — nobody has seen this player. */
export function isNewPlayer() {
  const store = ls();
  try { return !store?.getItem(STORE); } catch { return true; }
}
