// ─────────────────────────────────────────────────────────────────────────────
//  hunt_store — which lines of the scavenger hunt are crossed off, and the
//  photograph taped beside each one. Kept between sessions.
//
//  Sibling of `stats_store.js` and built to the same three rules: a module
//  singleton because the writes come from click handlers three files deep, a
//  forgiving parse because a corrupt record must lose the log and never the
//  game, and nothing in here judges the player.
//
//  It differs from the logbook in one way that dominates the whole design:
//  **it stores images.** `stats` is a few hundred bytes of numbers and will
//  never come close to a storage limit. This holds up to fifteen photographs in
//  a ~5 MB shared box that `pa.stats` and `pa.audio` are already sitting in.
//
//  ── the thing that had to be got right: quota ───────────────────────────────
//
//  Photo mode saves a PNG at the display's NATIVE resolution — the mode pins
//  the render scale to it precisely so the file is sharp (see the resolution
//  block in `hud_photo.setActive`). Measured on this machine: 2.5 MB per shot,
//  and a data URL is base64, so the string is a third larger again. Two of them
//  would fill localStorage; three would take the logbook down with them.
//
//  So every photograph is re-encoded before it is stored: longest edge 512 px,
//  JPEG at q 0.72. Measured on ten real 2560x1600 captures of this game —
//  meadow, lake, forest and ridge, across the day from 06:30 to 21:30 — the
//  source PNGs ran 4.4 to 7.1 MB and the thumbnails came out at
//
//      9.9 - 45.2 KB of data URL, mean 29.9 KB
//
//  a reduction of about 180x. A whole sheet — fifteen ticks and ten photos —
//  measured 299 KB of stored string, which is 6% of the box and leaves the
//  logbook alone. The spread is real and it is the picture, not the encoder:
//  the 9.9 KB frame is a ridge at dusk (sky and silhouette), the 45 KB ones are
//  forest canopy, which is the hardest thing this game draws for a DCT.
//
//  ── what happens when the write fails anyway ────────────────────────────────
//
//  It still can: another origin-mate can fill the box, Safari's private mode
//  refuses every write, and a user can arrive with 4.9 MB already spent. A
//  `catch {}` here would be a bug with a long fuse — the player would cross off
//  the bear, close the tab, and find the bear un-crossed tomorrow.
//
//  The rule is therefore **the tick outranks the picture**, and the write path
//  is a ladder rather than a try/catch:
//
//    1. write the whole record
//    2. on quota: drop the OLDEST photo and try again, repeatedly
//    3. with no photos left: write the ticks alone
//    4. if even that fails: keep everything in memory, set `degraded`, and
//       carry on. The session still plays; it just will not keep.
//
//  Tested by filling the box on purpose rather than by reading the spec, twice:
//
//   · **5.00 MB of ballast, no room at all.** Six items awarded with photos:
//     six ticks written (a 0.3 KB record), six photographs evicted, `pa.stats`
//     untouched, and a reload from disk still shows all six lines crossed off.
//     Rung 3 of the ladder, reached and survived.
//   · **room for about four photographs.** Six awarded: six ticks, the two
//     OLDEST photos dropped and the four newest kept — the store reported
//     `evicted: 2` and the disk record carried `001111`. Rung 2, and it evicts
//     in the direction the header claims rather than the other one.
//
//  Dropping the oldest rather than the newest is the deliberate half of it. The
//  photograph the player is looking at *right now* — the one the journal is in
//  the middle of taping in — is the one they care about; a thumbnail of a
//  rabbit from three weeks ago is not. An evicted photo leaves its tick and its
//  date behind, so the line stays crossed off forever and only the picture goes.
//
//  A single thumbnail larger than `PHOTO_MAX_CHARS` is refused outright instead
//  of being stored, because storing it would evict every other photo on the
//  sheet and then fail anyway. That cannot happen at 512 px / q 0.72 and the
//  guard is there for the day somebody retunes those two numbers.
//
//  ── why `award` is synchronous and the photo is not ─────────────────────────
//
//  The downscale needs the pixels, and the only way to get pixels out of a data
//  URL is to decode it through an `Image`, which is asynchronous. `award()`
//  still returns synchronously — it records the tick and flushes it in the same
//  task, which is the part that must not be lost — and the picture is attached
//  a frame or two later when the decode lands.
//
//  There IS a synchronous path and the integrator should take it: hand `award`
//  the **canvas** instead of the data URL. `PhotoMode.capture()` already draws
//  the WebGL canvas into a scratch 2D canvas inside the shutter task (its
//  64x36 frame probe), so it is holding drawable pixels at exactly the moment
//  it would call this. A canvas is downscaled inline and the photo is in the
//  record before `award` returns.
//
//  Written before the version above and thrown away: a `store.awardAsync()`
//  returning a promise. It made every call site think about ordering — and the
//  one thing a call site must NOT be able to get wrong is losing the tick.
// ─────────────────────────────────────────────────────────────────────────────
import { HUNT_ITEMS, HUNT_BY_ID } from './hunt_items.js';

const STORE = 'pa.hunt';
const VERSION = 1;

/**
 * Longest edge of a stored photograph, in pixels.
 *
 * 1024, up from 512, because the journal can now be leaned in on a single entry
 * and the print gets most of the screen — at which point 512 is being stretched
 * about two and a half times and it shows.
 *
 * The constraint on this number is localStorage, which is ~5 MB for the whole
 * origin and shared with `pa.stats`. Measured over five real frames of this
 * game rather than assumed, because JPEG does not scale with pixel count:
 *
 *     512  q0.72   26.8 KB a print   0.39 MB for a full sheet of fifteen
 *     1024 q0.72   74.2 KB a print   1.09 MB for a full sheet
 *
 * So four times the pixels costs 2.8 times the bytes — this game's flat-shaded
 * art compresses the extra detail cheaply — and a completed sheet takes about a
 * fifth of the budget. That is affordable outright, and the eviction path below
 * is still there for the case where it is not.
 */
export const THUMB_MAX = 1024;
/** JPEG quality. Below ~0.65 the grain in the grass turns to mush. */
export const THUMB_QUALITY = 0.72;

// A thumbnail this big is not a thumbnail. At 512 px / q 0.72 the largest of
// ten real captures was 45.2 KB; 400 KB is an order of magnitude of headroom
// and still small enough that one bad encode cannot eat the sheet.
const PHOTO_MAX_CHARS = 400_000;

const blank = () => ({ v: VERSION, items: {}, target: null });

/**
 * Is this the browser saying "no room", rather than something we broke?
 *
 * Every engine spells it differently and two of them do not set `name` at all,
 * so all three tells are checked. Firefox's `NS_ERROR_DOM_QUOTA_REACHED` and
 * Safari private mode's bare `QuotaExceededError` both land here.
 */
function isQuota(e) {
  if (!e) return false;
  return e.name === 'QuotaExceededError'
      || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
      || e.code === 22 || e.code === 1014
      || /quota|exceed|storage/i.test(String(e.message ?? ''));
}

/** localStorage, or null where there isn't one (node, a locked-down iframe). */
function ls() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }        // some embeddings throw on the *access*
}

/**
 * Re-encode a drawable source down to `THUMB_MAX` on its longest edge.
 *
 * Returns a data URL, or null if there is nothing to draw to (no DOM) or the
 * source has no size yet. Never throws — a failed thumbnail costs a picture,
 * and this is called from a path where the tick is already safe.
 */
export function makeThumb(src, max = THUMB_MAX, quality = THUMB_QUALITY) {
  try {
    if (typeof document === 'undefined' || !src) return null;
    const w0 = src.naturalWidth ?? src.videoWidth ?? src.width ?? 0;
    const h0 = src.naturalHeight ?? src.videoHeight ?? src.height ?? 0;
    if (!(w0 > 0) || !(h0 > 0)) return null;
    const k = Math.min(1, max / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k));
    const h = Math.max(1, Math.round(h0 * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (!g) return null;
    // A one-step downscale of a 2560 px frame to 512 aliases badly on the
    // thin high-frequency geometry this game is full of — a tripod, a radiator
    // grille, the far treeline. `imageSmoothingQuality: 'high'` is the browser's
    // own multi-step path and costs nothing here.
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality);
  } catch { return null; }
}

/**
 * Is `p` something `drawImage` will take, rather than a data URL string?
 *
 * Duck-typed rather than `instanceof HTMLCanvasElement`, because the three
 * things the integrator might plausibly hand over — a canvas, an
 * `OffscreenCanvas`, an `ImageBitmap` — do not share a base class, and the
 * check has to work in a worker and in node without any of them existing.
 */
function isDrawable(p) {
  return !!p && typeof p === 'object'
      && Number.isFinite(p.width) && Number.isFinite(p.height)
      && p.width > 0 && p.height > 0;
}

class HuntStore {
  constructor() {
    this.data = blank();
    /** True once a write has failed for good. The session plays; it won't keep. */
    this.degraded = false;
    /** How many photographs this store has had to drop to make room, ever. */
    this.evicted = 0;
    this._subs = new Set();
    this._warned = null;
    this._load();
  }

  _load() {
    const store = ls();
    if (!store) return;
    try {
      const raw = store.getItem(STORE);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s || s.v !== VERSION) return;     // a future format is not ours to read
      const items = {};
      for (const [id, rec] of Object.entries(s.items ?? {})) {
        // An id that is no longer on the sheet is dropped rather than kept. It
        // cannot be shown, it cannot be un-ticked, and keeping it would mean a
        // renamed item quietly paying rent forever.
        if (!HUNT_BY_ID[id] || !rec) continue;
        items[id] = {
          at: Number.isFinite(rec.at) ? rec.at : 0,
          photo: typeof rec.photo === 'string' && rec.photo.startsWith('data:') ? rec.photo : null,
        };
      }
      // The target survives a reload, because it is a standing intention
      // ("I am out looking for the bear") rather than a thing about this
      // session. A target naming a line that has since been crossed off — or
      // that is no longer on the sheet at all — is dropped on the way in, so
      // the invariant `setTracked` enforces holds from the first frame.
      const t = typeof s.target === 'string' && HUNT_BY_ID[s.target] && !items[s.target]
        ? s.target : null;
      this.data = { v: VERSION, items, target: t };
    } catch { /* an unreadable sheet is not worth a broken boot */ }
  }

  // ── reading ────────────────────────────────────────────────────────────────

  /** The checklist itself, in page order. */
  get items() { return HUNT_ITEMS; }
  /** How many lines there are to cross off. */
  get total() { return HUNT_ITEMS.length; }

  isDone(id) { return !!this.data.items[id]; }
  /**
   * The line the player is out looking for, or null.
   *
   * One at a time, on purpose. "Which am I hunting right now" is the question
   * the compass paw answers, and a set of three targets turns that back into
   * the ambient nearest-of-everything the player asked to get away from.
   */
  get target() { return this.data.target; }
  /** The stored thumbnail, or null — either never had one, or it was evicted. */
  photoFor(id) { return this.data.items[id]?.photo ?? null; }
  /** When this line was crossed off, ms since epoch, or 0. */
  doneAt(id) { return this.data.items[id]?.at ?? 0; }
  doneCount() { return Object.keys(this.data.items).length; }
  /** True when every line is crossed off. The journal's one moment of ceremony. */
  get complete() { return this.doneCount() >= this.total; }

  // ── writing ────────────────────────────────────────────────────────────────

  /**
   * Cross off `id`, and keep `photo` beside it.
   *
   * @param {string} id     an id from HUNT_ITEMS
   * @param {string|HTMLCanvasElement|HTMLImageElement|null} photo
   *        a canvas (downscaled inline, before this returns) or a data URL
   *        (decoded and downscaled a frame or two later). null ticks the line
   *        with no picture, which is a legitimate thing to want.
   * @returns {boolean} true only the FIRST time, exactly like `stats.mark` —
   *        so the caller does not need its own "have I already celebrated this"
   *        flag, and the journal's ceremony can be driven straight off it.
   */
  /**
   * Aim at `id`, or clear the aim with null. Passing the current target again
   * clears it — the journal's affordance is one target that toggles, so the
   * way to stop looking for the bear is to press the same thing twice.
   *
   * A line already crossed off cannot be aimed at: there is nothing left to
   * find, and a pin over it would outlive its own purpose. `award` enforces
   * the other half of that, which together are what let `Wildlife` skip the
   * logbook check entirely for a quarry — see `_nearestQuarry`.
   *
   * @returns {boolean} whether the target moved.
   */
  setTracked(id) {
    const next = !id || this.data.items[id] || !HUNT_BY_ID[id] || id === this.data.target
      ? null : id;
    if (next === this.data.target) return false;
    this.data.target = next;
    this._persist();
    this._emit(id ?? null);
    return true;
  }

  award(id, photo = null) {
    if (!HUNT_BY_ID[id]) {
      // Silence with no explanation is how a typo'd id ships as a line that can
      // never be crossed off. One warning per unknown id.
      if (!(this._warned ??= new Set()).has(id)) {
        this._warned.add(id);
        console.warn('[hunt] no such item', id);
      }
      return false;
    }
    if (this.data.items[id]) return false;

    // The tick, first and on its own. Everything below this line is the
    // picture, and the picture is allowed to fail.
    this.data.items[id] = { at: Date.now(), photo: null };
    // Photographing your quarry is the end of hunting it. Clearing it HERE, in
    // the same write as the tick, is what lets `Wildlife._nearestQuarry` trust
    // that anything it is handed is still outstanding.
    if (this.data.target === id) this.data.target = null;
    this._persist();
    this._emit(id);

    if (photo) this._attach(id, photo);
    return true;
  }

  /**
   * Give an already-crossed-off line a photograph — or replace the one it has.
   *
   * Separate from `award` because they are different events: `award` is the
   * moment, this is the housekeeping after it. It is also the door the async
   * decode comes back through.
   */
  setPhoto(id, photo) {
    if (!this.data.items[id] || !photo) return false;
    this._attach(id, photo);
    return true;
  }

  _attach(id, photo) {
    if (isDrawable(photo)) {
      // The synchronous path. See the header: the integrator should be here.
      const url = makeThumb(photo);
      if (url) this._store(id, url);
      return;
    }
    if (typeof photo !== 'string') return;
    // Already small enough to be a thumbnail somebody else made? Take it as is
    // rather than round-tripping it through a decode and a second JPEG encode,
    // which would cost a generation of quality for nothing.
    if (photo.length <= 80_000 && photo.startsWith('data:image/jpeg')) {
      this._store(id, photo);
      return;
    }
    if (typeof Image === 'undefined') return;
    const img = new Image();
    img.onload = () => {
      const url = makeThumb(img);
      if (url) this._store(id, url);
    };
    // A decode that fails costs the picture and nothing else — the tick was
    // written before this function was called.
    img.onerror = () => { /* no picture; the line stays crossed off */ };
    img.src = photo;
  }

  _store(id, url) {
    const rec = this.data.items[id];
    if (!rec) return;
    if (url.length > PHOTO_MAX_CHARS) {
      console.warn('[hunt] thumbnail refused,', (url.length / 1024) | 0, 'KB >', PHOTO_MAX_CHARS / 1024, 'KB');
      return;
    }
    rec.photo = url;
    this._persist();
    this._emit(id);
  }

  // ── persistence ────────────────────────────────────────────────────────────

  /**
   * Write, and climb down the ladder in the header if there is no room.
   *
   * Synchronous and immediate, unlike `stats_store`'s debounced write. That
   * file writes every frame because a drive-time accumulator is always dirty;
   * this one writes at most sixteen times in a playthrough (fifteen ticks and
   * their pictures), and every one of them is an event the player just caused.
   * Debouncing it would buy nothing and would put a crossed-off bear at risk
   * for fifteen seconds.
   */
  _persist() {
    const store = ls();
    if (!store) { this.degraded = true; return false; }

    for (;;) {
      try {
        store.setItem(STORE, JSON.stringify(this.data));
        this.degraded = false;
        return true;
      } catch (e) {
        if (!isQuota(e)) {
          // Not a space problem — a locked-down or disabled store. There is no
          // ladder to climb; stop, say so once, and let the session play.
          if (!this.degraded) console.warn('[hunt] cannot save:', e?.name ?? e);
          this.degraded = true;
          return false;
        }
        if (!this._evictOldestPhoto()) {
          // No photos left to give up. One last attempt is not needed — the
          // loop already retried after the final eviction and we are here
          // because that failed too.
          if (!this.degraded) console.warn('[hunt] out of storage; progress kept in memory only');
          this.degraded = true;
          return false;
        }
      }
    }
  }

  /**
   * Give up the oldest photograph still held. Returns false when there are
   * none left, which is the ladder's bottom rung.
   *
   * "Oldest" is by `at`, the moment the line was crossed off — not by when the
   * picture was attached, which for the async path is a couple of frames later
   * and would order two photos from the same session by decode speed.
   */
  _evictOldestPhoto() {
    let oldest = null, oldestAt = Infinity;
    for (const [id, rec] of Object.entries(this.data.items)) {
      if (!rec.photo) continue;
      if (rec.at < oldestAt) { oldestAt = rec.at; oldest = id; }
    }
    if (!oldest) return false;
    this.data.items[oldest].photo = null;
    this.evicted++;
    this._emit(oldest);
    return true;
  }

  /** Throw the whole sheet away — every tick and every photograph. */
  reset() {
    this.data = blank();
    this.evicted = 0;
    this.degraded = false;
    const store = ls();
    try { store?.removeItem(STORE); } catch { /* nothing left to lose */ }
    this._emit(null);
  }

  // ── notification ───────────────────────────────────────────────────────────
  //
  // The journal is built once and then looked at repeatedly, and a photograph
  // arrives a frame or two after the tick it belongs to (see the header). Ask
  // to be told rather than polling fifteen ids every frame of an open book.

  /** @returns {() => void} unsubscribe */
  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    this._subs.add(cb);
    return () => this._subs.delete(cb);
  }

  _emit(id) {
    for (const cb of this._subs) {
      // A listener that throws must not be able to stop the next one, or lose
      // the write that is already safely on disk.
      try { cb(id, this); } catch (e) { console.warn('[hunt] listener threw', e); }
    }
  }

  /** How much of the box this sheet is using, in bytes of string. For tools. */
  bytes() { try { return JSON.stringify(this.data).length; } catch { return 0; } }
}

/** The one sheet. Import it and read it; nobody owns it. */
export const hunt = new HuntStore();
