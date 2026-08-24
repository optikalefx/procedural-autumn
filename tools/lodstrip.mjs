#!/usr/bin/env node
/**
 * ONE tree, walked across its own LOD boundaries, measured as a silhouette.
 *
 * The player's report is that a tree changes shape when it crosses a LOD
 * radius. That is a claim about a single tree's outline, so this measures a
 * single tree's outline and nothing else:
 *
 *   · every scene object except the Trees group is hidden, the post chain is
 *     bypassed and the clear colour is set to a hue no tree can produce, so
 *     "tree" is exactly "not the clear colour";
 *   · the binning is restricted to ONE placed instance by rewriting
 *     `trees.trees.order` / `bucketStart` — the tree still goes through the
 *     game's own `_rebuild`, so it is binned by the game's rules, not by the
 *     harness's idea of them;
 *   · wind is frozen (`uWindStrength = 0`, `uTime = 0`) so two frames a metre
 *     apart differ by LOD and by nothing else;
 *   · the camera FOV is set per frame to `2*atan(k*H / d)`, so the tree
 *     subtends the SAME angle at every distance. A silhouette IoU between two
 *     frames is therefore a shape comparison, not a size comparison.
 *
 * Reported per adjacent pair of distances: IoU of the two masks, and the
 * signed change in the mask's height, width and centroid. Across a boundary
 * those numbers are the pop, in the units the eye reads it in.
 *
 *   node tools/lodstrip.mjs --dir shots/lod/before --url http://127.0.0.1:5204
 *   node tools/lodstrip.mjs --trees 4:2,2:3 --dir shots/lod/x
 *
 * `--trees` is a comma-separated list of `species:variant` selectors; the tool
 * picks the placed tree closest to `--scale` (default 1.0) matching each.
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
import { readPNG } from './_pngread.mjs';
import { writePNG } from './_png.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const URL = arg('url', process.env.AUTUMN_URL || 'http://localhost:5178');
const DIR = resolve(arg('dir', 'shots/lod/run'));
const W = +arg('w', 512), H = +arg('h', 512);
const SEL = arg('trees', '0:0,0:2,1:3,2:2,3:4,4:2,4:3').split(',').map((s) => s.split(':').map(Number));
const WANT_SCALE = +arg('scale', 1.0);
const HOUR = +arg('hour', 12.0);

// Distances. Dense either side of the two boundaries the game actually uses
// (84 m near->mid, 255 m mid->far) plus a coarse walk so the strip reads.
// Symmetric 1 m steps either side of each boundary, so every boundary pair has
// a same-LOD CONTROL pair of identical spacing next to it. A 3D tree seen from
// two different distances never scores IoU 1.0 even inside one LOD — the
// perspective changes — so the boundary number is only meaningful against that
// control.
const DISTS = [];
for (const d of [30, 60, 81, 82, 83, 84, 85, 86, 120, 200, 252, 253, 254,
                 255, 256, 257, 320]) DISTS.push(d);

const CLEAR = [0, 0, 255];

// ── silhouette from a frame ────────────────────────────────────────────────
function mask(path) {
  const { w, h, px } = readPNG(path); const bpp = 3;
  // The four corners must be the key colour. If they are not, something is
  // being composited over the frame and every number below is about it.
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
    const o = (y * w + x) * bpp;
    const d = Math.abs(px[o] - CLEAR[0]) + Math.abs(px[o + 1] - CLEAR[1]) + Math.abs(px[o + 2] - CLEAR[2]);
    if (d > 24) throw new Error(`!! ${path}: corner (${x},${y}) is ${px[o]},${px[o + 1]},${px[o + 2]}, ` +
      `not the ${CLEAR} key. Something is drawn over the frame.`);
  }
  const m = new Uint8Array(w * h);
  let n = 0, sx = 0, sy = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * bpp;
      // "not the clear colour", with room for the blend at an alpha edge.
      const d = Math.abs(px[o] - CLEAR[0]) + Math.abs(px[o + 1] - CLEAR[1]) + Math.abs(px[o + 2] - CLEAR[2]);
      if (d > 96) {
        m[y * w + x] = 1; n++; sx += x; sy += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return {
    w, h, m, area: n,
    cx: n ? sx / n : 0, cy: n ? sy / n : 0,
    width: n ? maxX - minX + 1 : 0, height: n ? maxY - minY + 1 : 0,
    minX, maxX, minY, maxY,
  };
}

function iou(a, b) {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.m.length; i++) {
    const p = a.m[i], q = b.m[i];
    if (p | q) uni++;
    if (p & q) inter++;
  }
  return uni ? inter / uni : 1;
}

// ── run ────────────────────────────────────────────────────────────────────
await acquire('lodstrip');
mkdirSync(DIR, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 200)));
// The seed is PINNED. `public/bakes/` holds worlds for 20261018 while
// `WorldConfig.SEED` is 20262018, so an unpinned boot misses the bake cache
// and grows a different forest — different trees, different variants, and a
// before/after comparison of different objects.
await p.goto(`${URL}/?res=${arg('res', '768')}&seed=${arg('seed', '20261018')}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

// One-time page setup: isolate the trees, kill everything that is not shape.
const setup = await p.evaluate(({ hour }) => {
  const e = window.__engine, scene = e.scene, renderer = e.renderer;
  e.adaptive = false; e.autoQuality = false;
  window.__lighting.hour = hour; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;

  // Every DOM node except the canvas goes. The loading screen fades to
  // opacity 0 but stays in the tree, and a screenshot composites it: the
  // second version of this tool photographed a faint "Camping Season"
  // over a blue key and scored the whole frame as tree.
  for (const n of Array.from(document.body.children)) if (n.id !== 'app') n.remove();
  document.body.style.background = '#00f';

  for (const c of scene.children) if (c.name !== 'Trees') c.visible = false;
  // Re-asserted every frame: Sky and the engine both write `scene.background`
  // and the clear colour, and a harness that sets them once measured a brown
  // background and scored every pair IoU 1.000 — the whole frame was "tree".
  // `renderer.autoClear` is FALSE in this engine — the composer's RenderPass
  // owns the clear. Rendering straight to the framebuffer without turning it
  // back on leaves the last composited frame underneath, which is how the
  // first version of this tool measured a brown background as foliage.
  renderer.autoClear = true;
  e.setRenderCallback(() => {
    scene.background = null;
    renderer.autoClear = true;
    renderer.setClearColor(0x0000ff, 1);
    renderer.render(scene, e.camera);
  });

  const t = window.__systems.trees;
  // Freeze wind and time: two frames a metre apart must differ by LOD alone.
  const orig = t.update.bind(t);
  t.update = (dt) => { orig(dt, 0); t.shared.uWindStrength.value = 0; t.shared.uTime.value = 0; };

  window.__lod = {
    // Restrict the binning to one placed instance, through the game's own
    // _rebuild. bucketStart is rewritten so exactly one bucket holds one tree.
    isolate(ti) {
      const T = t.trees, half = T.half, BS = T.BS, BW = T.BW;
      if (!T._order0) { T._order0 = T.order; T._bs0 = T.bucketStart; }
      const bx = Math.min(BW - 1, Math.max(0, ((T.px[ti] + half) / BS) | 0));
      const bz = Math.min(BW - 1, Math.max(0, ((T.pz[ti] + half) / BS) | 0));
      const bi = bz * BW + bx;
      const bs = new Int32Array(BW * BW + 1);
      for (let i = 0; i <= BW * BW; i++) bs[i] = i <= bi ? 0 : 1;
      T.order = new Int32Array([ti]); T.bucketStart = bs;
      return { x: T.px[ti], y: T.py[ti], z: T.pz[ti], scale: T.pscale[ti],
               spec: T.pspec[ti], vari: T.pvar[ti] };
    },
    // Nearest placed tree to the requested species/variant/scale.
    pick(spec, vari, wantScale) {
      const T = t.trees; let best = -1, bd = 1e9;
      for (let i = 0; i < T.n; i++) {
        if (T.pspec[i] !== spec || T.pvar[i] !== vari) continue;
        const d = Math.abs(T.pscale[i] - wantScale);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    },
    protoHeight(spec, vari) { return t.protos[spec][vari].height; },
    // The framing extent, in metres, for one tree. Deliberately computed from
    // the NEAR prototypes only — the widest near crown of the species — so
    // that changing what the mid LOD is made of cannot move the frame and
    // make a before/after comparison meaningless. A maple's crown is twice as
    // wide as it is tall, so framing on height alone put the crown outside the
    // frame and the silhouette measurement then had no edge to measure.
    extent(spec, vari) {
      let w = 0;
      for (const v of t.protos[spec]) w = Math.max(w, v.halfWidth);
      return Math.max(t.protos[spec][vari].height, 2 * w) * 1.18;
    },
    // Place the camera at a horizontal distance d, framing the tree to a
    // constant angular size.
    place(tree, d, hAbs, ext) {
      const cam = e.camera;
      const midY = tree.y + hAbs * 0.5;
      cam.position.set(tree.x + d, midY, tree.z);
      cam.lookAt(tree.x, midY, tree.z);
      cam.fov = 2 * Math.atan((ext * 0.5) / d) * 180 / Math.PI;
      cam.updateProjectionMatrix();
      t._lastRebuildPos.set(1e9, 0, 1e9);        // force the re-bin at this step
    },
    stats() { const s = window.__systems.trees.stats; return { near: s.near, mid: s.mid, far: s.far }; },
  };
  return { species: window.__systems.trees.protos.length };
}, { hour: HOUR });

const report = [];
for (const [spec, vari] of SEL) {
  const info = await p.evaluate(({ spec, vari, wantScale }) => {
    const ti = window.__lod.pick(spec, vari, wantScale);
    if (ti < 0) return null;
    const tree = window.__lod.isolate(ti);
    const hAbs = window.__lod.protoHeight(spec, vari) * tree.scale;
    const ext = window.__lod.extent(spec, vari) * tree.scale;
    window.__lod._tree = tree; window.__lod._h = hAbs; window.__lod._ext = ext;
    return { ti, ...tree, hAbs, ext };
  }, { spec, vari, wantScale: WANT_SCALE });
  if (!info) { console.log(`no tree for ${spec}:${vari}`); continue; }

  const tag = `s${spec}v${vari}`;
  const frames = [];
  for (const d of DISTS) {
    await p.evaluate(async (d) => {
      window.__lod.place(window.__lod._tree, d, window.__lod._h, window.__lod._ext);
      await window.__settle(6);
    }, d);
    const out = `${DIR}/${tag}-${String(d).padStart(4, '0')}.png`;
    await p.screenshot({ path: out });
    const st = await p.evaluate(() => window.__lod.stats());
    frames.push({ d, out, lod: st.near ? 'near' : st.mid ? 'mid' : st.far ? 'far' : 'none', st });
  }

  // Measure. Assert the mask is a tree and not the whole frame or nothing —
  // the first version of this tool failed to hold the clear colour and scored
  // every boundary IoU 1.000 with the background counted as foliage.
  const ms = frames.map((f) => ({ ...f, mask: mask(f.out) }));
  for (const f of ms) {
    const cov = f.mask.area / (f.mask.w * f.mask.h);
    if (cov < 0.005 || cov > 0.75) {
      throw new Error(`!! ${f.out}: silhouette covers ${(cov * 100).toFixed(1)}% of the frame ` +
        `(lod=${f.lod}). The mask is not a tree — check the clear colour.`);
    }
    if (f.lod === 'none') throw new Error(`!! ${f.out}: no tree binned at ${f.d} m`);
  }
  const pairs = [];
  for (let i = 1; i < ms.length; i++) {
    const a = ms[i - 1], c = ms[i];
    pairs.push({
      from: a.d, to: c.d, lod: `${a.lod}->${c.lod}`, boundary: a.lod !== c.lod,
      iou: +iou(a.mask, c.mask).toFixed(4),
      dHeight: +((c.mask.height / (a.mask.height || 1) - 1) * 100).toFixed(1),
      dWidth: +((c.mask.width / (a.mask.width || 1) - 1) * 100).toFixed(1),
      dArea: +((c.mask.area / (a.mask.area || 1) - 1) * 100).toFixed(1),
      dCy: +(c.mask.cy - a.mask.cy).toFixed(1),
    });
  }
  report.push({ tag, spec, vari, tree: info, frames: frames.map((f) => ({ d: f.d, lod: f.lod })), pairs });

  // Strip: the frames butted together, so the pop is visible and not only
  // tabulated.
  const cols = ms.length;
  const sw = ms[0].mask.w, sh = ms[0].mask.h;
  const px = Buffer.alloc(cols * sw * sh * 3);
  for (let i = 0; i < cols; i++) {
    const im = readPNG(ms[i].out);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const s = (y * im.w + x) * 3, o = (y * cols * sw + i * sw + x) * 3;
        px[o] = im.px[s]; px[o + 1] = im.px[s + 1]; px[o + 2] = im.px[s + 2];
      }
    }
  }
  writePNG(`${DIR}/${tag}-STRIP.png`, { w: cols * sw, h: sh, px });

  console.log(`\n${tag}  scale=${info.scale.toFixed(2)} h=${info.hAbs.toFixed(1)}m`);
  for (const q of pairs) {
    if (q.to - q.from > 1) continue;              // only the 1 m steps read
    console.log(`  ${String(q.from).padStart(4)}->${String(q.to).padStart(4)} m ${q.lod.padEnd(11)}` +
      ` IoU ${q.iou.toFixed(3)}  dH ${String(q.dHeight).padStart(6)}%  dW ${String(q.dWidth).padStart(6)}%` +
      `  dArea ${String(q.dArea).padStart(6)}%${q.boundary ? ' <<<' : ''}`);
  }
}

writeFileSync(`${DIR}/report.json`, JSON.stringify(report, null, 2));

// Headline. Every figure is a 1 m step; a boundary step is compared against
// the same-LOD control steps on either side of it, because a 3D tree changes
// its own outline slightly over a metre and that is not a pop.
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / (xs.length || 1);
const step1 = (r) => r.pairs.filter((q) => q.to - q.from === 1);
const bs = report.flatMap((r) => step1(r).filter((q) => q.boundary).map((q) => ({ tag: r.tag, ...q })));
const ctl = report.flatMap((r) => step1(r).filter((q) => !q.boundary).map((q) => ({ tag: r.tag, ...q })));
console.log('\n── boundary summary (1 m steps) ──');
for (const q of bs) {
  console.log(`  ${q.tag.padEnd(6)} ${q.lod.padEnd(11)} IoU ${q.iou.toFixed(3)}` +
    `  |dH| ${Math.abs(q.dHeight).toFixed(1)}%  |dW| ${Math.abs(q.dWidth).toFixed(1)}%  |dArea| ${Math.abs(q.dArea).toFixed(1)}%`);
}
const line = (name, xs) => console.log(`  ${name.padEnd(22)} IoU ${mean(xs.map((q) => q.iou)).toFixed(3)}` +
  `  |dH| ${mean(xs.map((q) => Math.abs(q.dHeight))).toFixed(1)}%` +
  `  |dW| ${mean(xs.map((q) => Math.abs(q.dWidth))).toFixed(1)}%` +
  `  |dArea| ${mean(xs.map((q) => Math.abs(q.dArea))).toFixed(1)}%   n=${xs.length}`);
line('CONTROL (same LOD)', ctl);
line('near->mid', bs.filter((q) => q.lod === 'near->mid'));
line('mid->far', bs.filter((q) => q.lod === 'mid->far'));
line('ALL boundaries', bs);

if (has('keep')) await p.waitForTimeout(2000);
await b.close();
console.log('\nwrote', `${DIR}/report.json`);
