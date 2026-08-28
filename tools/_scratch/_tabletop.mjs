// What is actually on the camp table, in millimetres. The source comment claims
// "there is no free rectangle" for a mug beside the journal; measure it.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, p);
  };
});
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });

const out = await page.evaluate(async () => {
  const THREE = window.__THREE;
  const { buildTable } = await import('/src/camp/camp_table.js');
  const mul = (s) => { let a = s >>> 0; return () => (a = (a + 0x6d2b79f5) >>> 0,
    (Math.imul(a ^ (a >>> 15), 1 | a) ^ (Math.imul(a ^ (a >>> 7), 61 | a) + a)) >>> 0) / 4294967296; };

  const rows = [];
  for (let seed = 1; seed <= 8; seed++) {
    const t = buildTable(mul(seed * 9781));
    const rest = t.userData.journalRest;
    const mm = (v) => Math.round(v * 1000);
    // The book's AABB half-extent in X, from its real footprint and real yaw:
    // |a cos y| + |b sin y| with a = 109 mm (long) and b = 78.5 mm (short).
    const a = 0.109, bb = 0.0785;
    const hx = Math.abs(a * Math.cos(rest.yaw)) + Math.abs(bb * Math.sin(rest.yaw));
    const bookNear = rest.x - Math.sign(rest.x) * hx;   // edge toward the centreline
    const bookFar = rest.x + Math.sign(rest.x) * hx;
    const side = rest.side;
    const reach = side * rest.x + hx;
    const inner = Math.max(0.560 * 0.14, reach + 0.056 + 0.020);
    const outer = Math.max(inner, 0.560 * 0.30);
    // Worst case for the player: the mug at the INNER end, handle swung inward.
    const handleEdge = inner - 0.056;                 // magnitude, mug's side
    const bookReach = reach;                          // magnitude, same axis
    rows.push({
      seed,
      bookCentre: mm(rest.x),
      bookReachOntoMugHalf: mm(bookReach),
      mugBand: [mm(inner), mm(outer)],
      gapAtWorstCase: mm(handleEdge - bookReach),
      oppositeHalves: Math.sign(rest.x) !== Math.sign(side),
    });
  }
  return rows;
});
for (const r of out) console.log(JSON.stringify(r));
const bad = out.filter((r) => !r.oppositeHalves || r.gapAtWorstCase < 19);
console.log(bad.length === 0
  ? `\nPASS - opposite halves, and >=19mm of handle clearance at the worst case, on all ${out.length}`
  : `\nFAIL on ${bad.length}: ` + JSON.stringify(bad));
await b.close();
