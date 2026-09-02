// ─────────────────────────────────────────────────────────────────────────────
//  hunt_debug — `window.__dbg`, so the last two hours of the game can be
//  reached in one line instead of by playing it.
//
//  The scavenger sheet is eighteen photographs long and the interesting part is
//  what happens after the eighteenth. Everything below the "get all eighteen"
//  wall — the mystery leaf writing itself, the book leafing to it, the creature
//  that only exists once it has, the win — is unreachable in a dev session
//  without either a finished save or a great deal of driving. That is a bad
//  trade for the person who has to change any of it.
//
//  ── the rule this file is built to ──────────────────────────────────────────
//
//  **Every helper takes the same path the game takes.** `reveal()` awards
//  seventeen lines and then hands the eighteenth to `HUD.openJournal`, which is
//  the function the shutter calls, in the order the shutter calls it in — so
//  what you watch is the real ceremony and not a reconstruction of it. The one
//  place that would have been easy to cheat is `bigfoot()`, which does skip the
//  habitat search; it says so, and `debugSpawn()` with no argument still runs
//  the real one.
//
//  Nothing here is loaded by the game. `main.js` calls `installHuntDebug`
//  inside its existing capture/debug block, next to `__cameraAnchors` and
//  `__settle`, and that is the whole integration.
// ─────────────────────────────────────────────────────────────────────────────
import { hunt } from './hunt_store.js';
import { HUNT_SHEET, HUNT_MYSTERY } from './hunt_items.js';

/** A print, so a debug tick looks like a real one on the page. */
function fakePrint(seed = 0) {
  try {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 200;
    const g = c.getContext('2d');
    // Enough of a picture that the taped slot is not a grey rectangle: a sky,
    // a horizon and a treeline, in the journal's own palette.
    const sky = g.createLinearGradient(0, 0, 0, 200);
    sky.addColorStop(0, '#8fb4d8'); sky.addColorStop(1, '#e8cfa4');
    g.fillStyle = sky; g.fillRect(0, 0, 320, 200);
    g.fillStyle = '#6b4a2a'; g.fillRect(0, 138, 320, 62);
    g.fillStyle = '#3d5136';
    for (let i = 0; i < 22; i++) {
      const x = ((i * 47 + seed * 13) % 330) - 10;
      const h = 26 + ((i * 31 + seed * 7) % 34);
      g.beginPath();
      g.moveTo(x, 140); g.lineTo(x + 9, 140 - h); g.lineTo(x + 18, 140);
      g.closePath(); g.fill();
    }
    return c;
  } catch { return null; }
}

/**
 * @param {object} ctx  the app context — needs `systems.hud` and
 *                      `systems.wildlife`, both of which exist by the time
 *                      main.js calls this.
 */
export function installHuntDebug(ctx) {
  const hud = () => ctx.systems?.hud ?? null;
  const journal = () => hud()?.journal ?? null;
  const bf = () => ctx.systems?.wildlife?.bigfoot ?? null;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Award `id` and open the book on it, the way the shutter does — but shut
   * the book first if it is open.
   *
   * `Journal.open` begins `if (this._active && !this._closing) return;`, which
   * is correct for the game (you cannot press the shutter with the book in
   * front of your face) and is exactly the trap for a console helper: the
   * first-run popup opens the journal at boot, so a `reveal()` typed into a
   * fresh session was returning silently and doing nothing at all. It cost
   * twenty minutes of looking at a ceremony that had never been asked to run.
   *
   * The 0.55 s is `SCRIPT.close` (0.46 s) with a beat on top.
   */
  async function openWith(id, photo) {
    const j = journal();
    if (j?.active) { j.close(); await wait(550); }
    hunt.award(id, photo);
    hud()?.openJournal({ id, photoDataURL: hunt.photoFor(id) });
    return id;
  }

  const state = () => ({
    found: `${hunt.doneCount()} of ${hunt.total}`,
    animals: `${hunt.animalCount()} of ${hunt.animalTotal}`,
    mysteryOpen: hunt.mysteryOpen,
    won: hunt.won,
    bigfoot: bf() ? { armed: bf().armed, present: bf().present } : 'no wildlife',
  });

  const dbg = {
    /** What the save thinks, in one line. */
    state,

    /**
     * Cross off the first `n` PRINTED lines, with a print beside each.
     *
     * 17 by default, which is the interesting number: one short, so the next
     * award is the one that opens the mystery. Pass 18 to arm the creature
     * without watching the ceremony, or 0 to clear the sheet.
     */
    sheet(n = 17) {
      hunt.reset();
      HUNT_SHEET.slice(0, Math.max(0, Math.min(n, HUNT_SHEET.length)))
        .forEach((it, i) => hunt.award(it.id, fakePrint(i)));
      journal()?._decorate?.({ force: true });
      return state();
    },

    /**
     * The whole reveal, from one line short.
     *
     * Seventeen crossed off silently, then the eighteenth handed to
     * `HUD.openJournal` — the same call `hud_photo` makes after a shutter, with
     * the award written to the store FIRST, in that order, because that order
     * is what lets the journal notice the mystery opening under it. Returns a
     * promise: it shuts the book first if the book is open (see `openWith`).
     * Watch for:
     * the book leafing to the award, the strike, the tick, the print, and then
     * — 0.9 s later — the book carrying on to a leaf at the back that was blank
     * the last time anybody looked at it.
     */
    async reveal() {
      dbg.sheet(17);
      const last = HUNT_SHEET[HUNT_SHEET.length - 1];
      await openWith(last.id, fakePrint(17));
      return { awarded: last.id, ...state() };
    },

    /** Turn to the mystery leaf with the book already open, and stay there. */
    mysteryLeaf() {
      const j = journal();
      if (!j) return 'no journal';
      if (!j._active) { hud()?.toggleJournal?.(); }
      const page = j._mysteryPage;
      if (page == null) return 'no mystery leaf';
      const to = Math.min(Math.ceil(page / 2), j._sheets - 1);
      j._holdTitle = false;
      j._pose.leaf = to; j._leafFrom = to; j._leafTo = to; j._leafT = 1;
      j._revealPending = false; j._seekQueue = 0;
      return { leaf: to, page, open: j._pages[page].spec.open };
    },

    /**
     * Put one `d` metres in front of the camera, whatever the ground is doing.
     *
     * **This skips the habitat search**, which is the one thing in this file
     * that is not the game's own path — the real spawner wants deep timber, an
     * unlucky slope, and you out of the frame, and none of that is any help
     * when what you want is to look at him. `debugSpawn()` with no argument
     * still runs the real search, and `bfsim.mjs` tests it.
     *
     * He is placed in WAIT, so the four beats play out from here exactly as
     * they would in the woods: look at him for half a second, and go.
     */
    bigfoot(d = 55) {
      const b = bf();
      if (!b) return 'no wildlife system';
      hunt.mysteryOpen || dbg.sheet(18);
      b.armed = true;
      return b.debugSpawn({ dist: d, ahead: true }) ?? 'could not place';
    },

    /** Cross off the last line too. The book is finished. */
    async win() {
      if (!HUNT_MYSTERY) return 'no mystery item';
      if (!hunt.mysteryOpen) dbg.sheet(18);
      await openWith(HUNT_MYSTERY.id, fakePrint(18));
      return state();
    },

    /** Throw the sheet away — every tick and every print. */
    resetHunt() {
      hunt.reset();
      journal()?._decorate?.({ force: true });
      return state();
    },

    help() {
      const lines = [
        '__dbg.sheet(n=17)   cross off the first n printed lines, with prints',
        '__dbg.reveal()      17 done, then the 18th through the book — the ceremony',
        '                    (async: shuts the book first if it is open)',
        '__dbg.mysteryLeaf() open the book at the mystery leaf and stay there',
        '__dbg.bigfoot(d=55) put one d metres in front of you (skips habitat)',
        '__dbg.win()         cross off the last line too',
        '__dbg.resetHunt()   wipe the sheet',
        '__dbg.state()       what the save thinks',
        '',
        'URL flags:  ?hunt=17       set the sheet at boot',
        '            ?hunt=reveal   play the mystery reveal on load',
        '            ?hunt=win      play the win, stamp and all',
        '            ?bigfoot=55    put one 55 m in front of you',
      ];
      console.log(lines.join('\n'));
      return lines.length;
    },
  };

  window.__dbg = dbg;

  // ── the URL flags ──────────────────────────────────────────────────────────
  // Because the thing you want nine times in ten is to boot straight into the
  // state under test, and typing into a console every reload is how a debug
  // surface stops being used.
  const p = new URLSearchParams(location.search);
  if (p.has('hunt')) {
    const v = (p.get('hunt') ?? '').trim();
    const n = parseInt(v, 10);
    // `reveal` and `win` are the two CEREMONIES, and they run on a timer rather
    // than inline: `HUD.maybeShowIntro` opens the book by itself on a first
    // run, and both of these shut it before they start (see `openWith`).
    // Shutting a book on the frame it opened is a fight nobody wins, so they
    // wait for it to have had its moment first.
    if (v === 'reveal' || v === 'win') setTimeout(() => dbg[v](), 1400);
    else if (Number.isFinite(n)) dbg.sheet(n);
  }
  if (p.has('bigfoot')) {
    const d = parseFloat(p.get('bigfoot'));
    // After a frame, so the camera is where the player will actually be rather
    // than wherever it was on the frame the systems finished booting.
    setTimeout(() => dbg.bigfoot(Number.isFinite(d) && d > 0 ? d : 55), 400);
  }

  return dbg;
}
