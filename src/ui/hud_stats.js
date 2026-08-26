// ─────────────────────────────────────────────────────────────────────────────
//  hud_stats — the logbook page in the settings sheet.
//
//  A third page beside the settings themselves and the controls reference, and
//  built the same way: it is not a second dialog, it swaps into the same sheet,
//  so focus, Esc and the gamepad keep working without a second set of rules.
//
//  ── what this page is, and what it deliberately is not ─────────────────────
//
//  It is a logbook. Every row is a thing the player has already done, phrased
//  the way they would say it, with the lifetime figure first and this visit's
//  contribution beside it in a fainter ink. There are no targets, no bars
//  filling toward anything, and nothing anywhere on it goes down — the one
//  exception is "closest a bear came", which is a story rather than a score.
//
//  Nothing here shows what has NOT happened yet, and that rule runs all the way
//  up: a row appears when it has a number, a whole section appears when one of
//  its rows does. A player who has never put a boat in the water has no "On the
//  water" heading with seven dashes under it, and the sky catalogue does not
//  greet a fresh logbook with eight rows of homework under a heading reading
//  "0 of 8" (user, 2026-08-24). Both of those are to-do lists, which is the one
//  thing this game does not have. The night an object is found it appears, by
//  name, with the description of what was actually at the eyepiece — and how
//  many more there are to find is not this page's business to say.
//
//  ── refreshing ────────────────────────────────────────────────────────────
//
//  The rows are re-rendered wholesale a few times a second while the page is
//  open, which is cheap (about seventy spans) and keeps the numbers live as the
//  player watches their own drive time tick. The two real controls — back and
//  reset — live OUTSIDE the rebuilt region, so a rebuild can never pull focus
//  out from under the keyboard or the gamepad.
// ─────────────────────────────────────────────────────────────────────────────
import { el, button } from './hud_dom.js';
import { CARS } from '../vehicle/vehicle_models.js';
import { SKY_OBJECTS } from '../game/sky_objects.js';
import { SPECIES } from '../wildlife/animal_species.js';
import {
  stats, fmtDuration, fmtSeconds, fmtDistance, fmtMetres, fmtSpeed, fmtCount, fmtDate,
} from '../game/stats_store.js';

// How often the open page re-reads the ledger. Fast enough that a drive-time
// row visibly moves, slow enough to be free.
const REFRESH = 0.4;

// One row: [label, kind, key]. `kind` decides both which bucket of the ledger
// the key is read from and how the number is spoken.
//
//   n     a counter or an accumulator, formatted by the second word
//   hi    a maximum
//   lo    a minimum — only "closest a bear came" uses it
//   set   how many members of a named set have been found — the form every
//         "distinct things" row takes, because a counter cannot tell four
//         waterfalls from one waterfall seen four times
//
// The session column is only ever shown for `n` rows: "you drove another
// 4 km today" is a sentence, "your top speed today was also your top speed
// ever" is not, and a record is worth more when it is not annotated.
//
// A group may carry a third field saying when it is worth showing at all. A row
// with nothing in it prints '—', and that is what both modes are counting:
//
//   (none)  always on the page — the valley, the driving, the camp: things
//           anyone who got this far has done
//   'group' the whole section stays away until ONE of its rows has a value,
//           then arrives whole. For the places a player might never go, where
//           the individual rows only make sense read together.
//   'row'   each row waits for its own value, and the heading arrives with the
//           first of them. For the two sections that are made OF discoveries —
//           the animals and the valley's own features — where naming a thing
//           the player has not met yet is half of telling them it is there.
//           A waterfall should be something you came over a rise and found,
//           not a line that was sitting in the logbook waiting for a number.
const GROUPS = [
  ['Logbook', [
    ['Time in the valley', 'n dur', 'time.total'],
    ['Longest visit', 'hi dur', 'session.long'],
    ['Visits', 'sessions'],
    ['First drive', 'first'],
  ]],
  ['Driving', [
    ['Time driving', 'n dur', 'drive.time'],
    ['Distance', 'n dist', 'drive.dist'],
    ['After dark', 'n dur', 'drive.night'],
    ['Top speed', 'hi speed', 'speed.top'],
    ['Highest ground', 'hi metres', 'alt.high'],
    ['Furthest from the start', 'hi dist', 'range.far'],
    ['Rescues', 'n count', 'drive.rescues'],
  ]],
  ['In the air', [
    ['Total airtime', 'n dur', 'air.time'],
    ['Jumps', 'n count', 'air.jumps'],
    ['Longest hang', 'hi secs', 'air.long'],
  ], 'group'],
  ['On the water', [
    ['Time afloat', 'n dur', 'water.time'],
    ['Distance paddled', 'n dist', 'water.dist'],
    ['Paddle strokes', 'n count', 'water.strokes'],
    ['Canoes launched', 'n count', 'boat.launch.canoe'],
    ['Kayaks launched', 'n count', 'boat.launch.kayak'],
    ['Time in a canoe', 'n dur', 'water.time.canoe'],
    ['Time in a kayak', 'n dur', 'water.time.kayak'],
  ], 'group'],
  ['Camp', [
    ['Camps made', 'n count', 'camp.made'],
    ['Pitched after dark', 'n count', 'camp.night'],
    ['Time at camp', 'n dur', 'camp.time'],
    ['Marshmallows roasted', 'n count', 'roast.made'],
    // The result's own words, from `RESULTS` in marshmallow_toast.js. It is a
    // count of a thing that happened, phrased the way the player was told it
    // happened — the same rule the sky rows follow, where the line reads back
    // the description that was at the eyepiece.
    ['Golden all over', 'n count', 'roast.perfect'],
  ]],
  // The mammal rows walk `SPECIES` — the same deal the vehicle rows make with
  // CARS and the sky rows with SKY_OBJECTS. Stats.js already credits
  // `seen.<key>` for whatever is in the wildlife pool, so a new species added
  // to the table arrives here (and earns its row, 'row' mode below) with no
  // edit to this file. `plural` lives on the species because that is the one
  // word a table walk cannot derive.
  ['Wildlife', [
    ...Object.values(SPECIES).map((sp) => [`${sp.plural} seen`, 'n count', `seen.${sp.key}`]),
    // The perch-and-fly birds (birds/tree_birds.js) are not pooled mammals — each
    // credits its own key and keeps a hand-written row here.
    ['Bald eagles seen', 'n count', 'seen.baldEagle'],
    ['Blue herons seen', 'n count', 'seen.heron'],
    ['Flamingos seen', 'n count', 'seen.flamingo'],
    // Only ever creditable after dark — see `nocturnal` in TREE_BIRD_SPECIES.
    ['Great horned owls seen', 'n count', 'seen.owl'],
    ['Bird flocks', 'n count', 'seen.flocks'],
    ['Birds startled', 'n count', 'birds.startled'],
    ['Closest a bear came', 'lo metres', 'bear.near'],
  ], 'row'],
  // 'Valleys visited' is marked the moment Stats boots, so this section always
  // has its one honest row and never disappears entirely — what it does not
  // have, until the player earns them, is the four rows underneath.
  ['The valley', [
    ['Valleys visited', 'set', 'seeds'],
    ['Waterfalls found', 'set', 'falls'],
    ['Landmarks found', 'set', 'poi'],
    ['Photos taken', 'n count', 'photo.taken'],
    ['Time in photo mode', 'n dur', 'photo.time'],
  ], 'row'],
];

const FMT = {
  dur: fmtDuration, secs: fmtSeconds, dist: fmtDistance,
  metres: fmtMetres, speed: fmtSpeed, count: fmtCount,
};

/** The session suffix for a counter, or '' when nothing was added this visit. */
function sessionText(kind, key) {
  let v, f, total;
  if (kind === 'set') { v = stats.sessionCount(key); total = stats.count(key); f = fmtCount; }
  else if (kind.startsWith('n ')) {
    v = stats.session(key); total = stats.get(key); f = FMT[kind.slice(2)] ?? fmtCount;
  } else return '';
  if (!(v > 0)) return '';
  // On a first visit every figure was earned today, and a row reading
  // "+13 s  13 s" is the same number printed twice. The chip is only worth
  // showing when it is telling the player something the total does not.
  if (v >= total - 1e-6) return '';
  const txt = f(v);
  // Every formatter answers '—' for a value too small to be worth a word, and
  // "+—" is not a thing to show anyone.
  if (txt === '—') return '';
  // Durations and distances read as "+12 min"; a count reads as "+3".
  return `+${txt}`;
}

function valueText(kind, key) {
  if (kind === 'sessions') return fmtCount(stats.sessions);
  if (kind === 'first') return fmtDate(stats.firstPlayed);
  if (kind === 'set') return fmtCount(stats.count(key));
  const [bucket, form] = kind.split(' ');
  const f = FMT[form] ?? fmtCount;
  if (bucket === 'hi') return f(stats.getHi(key));
  if (bucket === 'lo') {
    const v = stats.getLo(key);
    return v === null ? '—' : f(v);
  }
  return f(stats.get(key));
}

export class StatsPage {
  /**
   * @param page  the sheet page element to fill
   * @param hud   for the toast on reset, and nothing else
   */
  constructor(page, hud) {
    this.hud = hud;
    this.rows = el('div', 'pa-stats');
    page.appendChild(this.rows);

    // Reset is two clicks and the second one is labelled differently, which is
    // the whole of the confirmation. A modal for it would be the only modal in
    // the game, and this deletes a logbook, not a save.
    this._armed = false;
    this.resetBtn = button('pa-stats-reset', 'Reset logbook', () => this._reset(),
      'Erase every recorded statistic');
    const foot = el('div', 'pa-foot');
    foot.appendChild(this.resetBtn);
    page.appendChild(foot);

    this._t = 0;
    this.refresh();
  }

  _reset() {
    if (!this._armed) {
      this._armed = true;
      this.resetBtn.textContent = 'Erase everything?';
      this.resetBtn.classList.add('pa-warn');
      clearTimeout(this._armT);
      this._armT = setTimeout(() => this._disarm(), 4000);
      return;
    }
    stats.reset();
    this._disarm();
    this.refresh();
    this.hud?.toast?.('Logbook erased');
  }

  _disarm() {
    this._armed = false;
    this.resetBtn.textContent = 'Reset logbook';
    this.resetBtn.classList.remove('pa-warn');
  }

  /** Called every frame while the page is showing; throttles itself. */
  tick(dt) {
    this._t -= dt;
    if (this._t <= 0) { this._t = REFRESH; this.refresh(); }
  }

  refresh() {
    const out = [];
    for (const [label, rows, mode] of GROUPS) {
      // '—' is a row with nothing to say, and it is the same test both modes
      // ask: one about itself, one about the section it belongs to.
      const filled = rows.filter(([, kind, key]) => valueText(kind, key) !== '—');
      if (mode && !filled.length) continue;
      const shown = mode === 'row' ? filled : rows;
      out.push(`<div class="pa-group"><div class="pa-label">${label}</div>`);
      for (const [name, kind, key] of shown) {
        out.push(this._row(name, valueText(kind, key), sessionText(kind, key)));
      }
      out.push('</div>');
      // The vehicles group has one row per car and the cars are a table
      // elsewhere, so it is generated rather than written out — adding a car is
      // one entry in vehicle_models.js and nothing here.
      if (label === 'Driving') out.push(this._vehicles());
    }
    out.push(this._sky());
    this.rows.innerHTML = out.join('');
  }

  _row(name, value, extra) {
    const s = extra ? `<span class="pa-stat-add">${extra}</span>` : '';
    return `<div class="pa-row"><div class="pa-row-name">${name}</div>` +
           `<div class="pa-row-val">${s}${value}</div></div>`;
  }

  _vehicles() {
    const out = ['<div class="pa-group"><div class="pa-label">Vehicles</div>'];
    for (const c of CARS) {
      const t = stats.get(`drive.time.${c.id}`);
      const d = stats.get(`drive.dist.${c.id}`);
      const v = t < 1 ? 'not yet driven' : `${fmtDuration(t)} · ${fmtDistance(d)}`;
      out.push(this._row(c.label, v, ''));
    }
    out.push('</div>');
    return out.join('');
  }

  /**
   * The night sky: the eyepiece, then everything found through it.
   *
   * Nothing until the telescope has actually been used — the section is hand
   * written rather than a GROUPS entry, so it does its own version of the
   * 'group' test above.
   *
   * `SKY_OBJECTS` order rather than discovery order, so the list does not
   * reshuffle itself between visits — a record that reorders is harder to read
   * than one that grows. There is no "n of eight" over it: a total is a
   * denominator, and a denominator turns a list of nights into a checklist.
   */
  _sky() {
    const found = stats.count('sky');
    const uses = fmtCount(stats.get('scope.uses'));
    const time = fmtDuration(stats.get('scope.time'));
    if (!found && uses === '—' && time === '—') return '';
    const out = ['<div class="pa-group"><div class="pa-label">The night sky</div>'];
    // "Visits", not "nights": stepping up to the telescope twice in one
    // evening is two of these, and calling them nights would be a small lie
    // told by a logbook whose only job is to be true.
    out.push(this._row('Visits to the eyepiece', uses, sessionText('n count', 'scope.uses')));
    out.push(this._row('Time at the eyepiece', time, sessionText('n dur', 'scope.time')));
    if (found) {
      out.push('<div class="pa-sky">');
      for (const o of SKY_OBJECTS) {
        if (!stats.has('sky', o.id)) continue;
        out.push('<div class="pa-sky-row">' +
                 `<span class="pa-sky-name">${o.label}</span>` +
                 `<span class="pa-sky-note">${o.note}</span></div>`);
      }
      out.push('</div>');
    }
    out.push('</div>');
    return out.join('');
  }

  dispose() { clearTimeout(this._armT); }
}
