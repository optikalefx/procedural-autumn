// ─────────────────────────────────────────────────────────────────────────────
//  stats_store — what the player has done, kept between sessions.
//
//  This is step one of making the valley a game: before there is anything to
//  win there has to be a record of having been somewhere. Nothing in here
//  judges the player — there are no goals, no percentages of completion and no
//  streaks to break. It is a logbook.
//
//  ── the shape ───────────────────────────────────────────────────────────────
//  Four buckets, because four different questions get asked of a number:
//
//    n     counters and accumulators — "how many", "how long", "how far"
//    hi    maxima — top speed, longest hang time, highest ground reached
//    lo    minima — the one that matters is the closest a bear ever came
//    sets  named things found — sky objects, individual waterfalls, seeds
//
//  A set is not a counter with extra steps: "seen four waterfalls" and "seen
//  the same waterfall four times" are different sentences, and only the set can
//  tell them apart across sessions.
//
//  ── why a module singleton and not a System ────────────────────────────────
//  Half the events worth recording happen inside a click handler three files
//  deep (a photo saved, a camp pitched). Threading `ctx` down to those would be
//  a bigger change to this codebase than the feature is worth, and every one of
//  those call sites wants exactly one line. `Stats` (src/game/Stats.js) is the
//  System that samples everything continuous; this is the ledger both it and
//  those one-liners write to.
//
//  Storage is localStorage and is deliberately forgiving: a corrupt or
//  half-written record loses the log, never the game. Writes are debounced —
//  the drive-time accumulator moves every frame and localStorage is
//  synchronous.
// ─────────────────────────────────────────────────────────────────────────────

const STORE = 'pa.stats';
const VERSION = 1;

// How long after a change the record is written, and the hard ceiling between
// writes while something (drive time) is changing continuously.
// Time in the valley accumulates every frame, so the record is ALWAYS dirty
// and the debounce is really a write interval. 15 s keeps a synchronous
// stringify-and-store off the frame budget four times a minute, and the most a
// crash can cost is fifteen seconds of logbook.
const SAVE_DEBOUNCE = 15.0;
const SAVE_MAX_GAP = 45.0;

const blank = () => ({
  v: VERSION,
  firstPlayed: 0,
  lastPlayed: 0,
  sessions: 0,
  n: {},
  hi: {},
  lo: {},
  sets: {},
});

class StatsStore {
  constructor() {
    this.data = blank();
    this._dirty = false;
    this._since = 0;      // seconds since the last write
    this._pending = 0;    // seconds since the first unwritten change
    this._load();

    // The session baseline: every counter's value at boot. "This session" is
    // then a subtraction rather than a second set of counters to keep in step.
    this._base = { ...this.data.n };
    this._baseSets = {};
    for (const k of Object.keys(this.data.sets)) this._baseSets[k] = this.data.sets[k].length;

    this.data.sessions++;
    const now = Date.now();
    if (!this.data.firstPlayed) this.data.firstPlayed = now;
    this.data.lastPlayed = now;
    this._dirty = true;

    // A tab closed or backgrounded is the common way a session ends, and
    // neither fires `unload` reliably any more.
    if (typeof window !== 'undefined') {
      const flush = () => this.flush();
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s || s.v !== VERSION) return;   // a future format is not ours to read
      this.data = {
        ...blank(),
        ...s,
        n: { ...s.n }, hi: { ...s.hi }, lo: { ...s.lo }, sets: { ...s.sets },
      };
    } catch { /* an unreadable log is not worth a broken boot */ }
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /** Add to a counter or an accumulator. Ignores anything that is not finite. */
  add(key, amount = 1) {
    if (!Number.isFinite(amount) || amount === 0) return;
    this.data.n[key] = (this.data.n[key] ?? 0) + amount;
    this._touch();
  }

  /** Keep the largest value ever seen for `key`. */
  hi(key, value) {
    if (!Number.isFinite(value)) return;
    if (value > (this.data.hi[key] ?? -Infinity)) { this.data.hi[key] = value; this._touch(); }
  }

  /** Keep the smallest value ever seen for `key`. */
  lo(key, value) {
    if (!Number.isFinite(value)) return;
    if (value < (this.data.lo[key] ?? Infinity)) { this.data.lo[key] = value; this._touch(); }
  }

  /**
   * Record that `id` has been found in the set `key`.
   *
   * Returns true only the FIRST time, which is what makes it usable as the
   * trigger for a toast: the caller does not have to keep its own "have I
   * already congratulated them for this" flag.
   */
  mark(key, id) {
    const list = this.data.sets[key] ??= [];
    const s = String(id);
    if (list.includes(s)) return false;
    list.push(s);
    this._touch();
    return true;
  }

  _touch() {
    if (!this._dirty) this._pending = 0;
    this._dirty = true;
  }

  // ── reading ────────────────────────────────────────────────────────────────

  get(key) { return this.data.n[key] ?? 0; }
  getHi(key) { return this.data.hi[key] ?? 0; }
  getLo(key) { return Number.isFinite(this.data.lo[key]) ? this.data.lo[key] : null; }
  set(key) { return this.data.sets[key] ?? []; }
  has(key, id) { return this.set(key).includes(String(id)); }
  count(key) { return this.set(key).length; }

  /** The part of a counter earned since this page loaded. */
  session(key) { return this.get(key) - (this._base[key] ?? 0); }
  /** How many members of a set were found since this page loaded. */
  sessionCount(key) { return this.count(key) - (this._baseSets[key] ?? 0); }

  get sessions() { return this.data.sessions; }
  get firstPlayed() { return this.data.firstPlayed; }

  // ── persistence ────────────────────────────────────────────────────────────

  /** Called once a frame by the Stats system. Writes at most every few seconds. */
  tick(dt) {
    this._since += dt;
    if (!this._dirty) return;
    this._pending += dt;
    if (this._pending >= SAVE_DEBOUNCE || this._since >= SAVE_MAX_GAP) this.flush();
  }

  flush() {
    if (!this._dirty) return;
    this.data.lastPlayed = Date.now();
    try { localStorage.setItem(STORE, JSON.stringify(this.data)); }
    catch { /* quota or private mode: the session still counts, it just won't keep */ }
    this._dirty = false;
    this._pending = 0;
    this._since = 0;
  }

  /** Throw the whole logbook away. The session baseline goes with it. */
  reset() {
    this.data = blank();
    this.data.sessions = 1;
    this.data.firstPlayed = this.data.lastPlayed = Date.now();
    this._base = {};
    this._baseSets = {};
    this._dirty = true;
    this.flush();
  }
}

/** The one ledger. Import it and write to it; nobody owns it. */
export const stats = new StatsStore();

// ── formatting ───────────────────────────────────────────────────────────────
//
// The units a person would use out loud, not the units the simulation stores.
// A drive is hours and minutes, a distance is kilometres once it stops being
// paces, and a hang time is tenths of a second because that is the scale at
// which it is impressive.

export function fmtDuration(s) {
  if (!Number.isFinite(s) || s < 1) return '—';
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} m`;
}

export function fmtSeconds(s) {
  if (!Number.isFinite(s) || s <= 0) return '—';
  return `${s.toFixed(1)} s`;
}

export function fmtDistance(m) {
  if (!Number.isFinite(m) || m < 1) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export function fmtMetres(m) {
  if (!Number.isFinite(m) || m === 0) return '—';
  return `${Math.round(m)} m`;
}

/** Metres per second as the speedo reads it. */
export function fmtSpeed(mps) {
  if (!Number.isFinite(mps) || mps <= 0) return '—';
  return `${Math.round(mps * 3.6)} km/h`;
}

export function fmtCount(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  return String(Math.round(n));
}

export function fmtDate(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return '—'; }
}
