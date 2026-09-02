// ─────────────────────────────────────────────────────────────────────────────
//  Object Gallery — the page.
//
//  Everything on screen comes from `discover()`. This file lays it out, drives
//  one Stage, and owns the build cache; it knows nothing about what a chair or
//  a spruce is, which is the property that stops the gallery going stale.
//
//  The build cache is keyed by (id, seed, options) and is shared with the
//  thumbnail queue, so an object is grown exactly once whether you looked at
//  its card or clicked it.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { discover, BUILD_CTX } from './registry.js';
import { Stage, BACKDROPS } from './stage.js';
import { Thumbs } from './thumbs.js';
import { SEED } from '../../world/WorldConfig.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────────────────────────────────────

const stage = new Stage($('#stage'));
BUILD_CTX.renderer = stage.renderer;

const t0 = performance.now();
const { entries, notShown, scanned } = discover();
const byId = new Map(entries.map((e) => [e.id, e]));
console.log(`[gallery] ${entries.length} objects from ${scanned} modules in ${(performance.now() - t0).toFixed(0)} ms`);

// ── build cache ──────────────────────────────────────────────────────────────
//
// One entry can exist several times over: a chair in colourway 2 at seed 9 is a
// different object from the same chair at seed 4. The key carries all of it.

const cache = new Map();
const state = new Map();   // id -> { seed, opts } — what the page last asked for

const keyOf = (id, seed, opts) => `${id}|${seed}|${JSON.stringify(opts)}`;

function want(id) {
  let s = state.get(id);
  if (!s) { s = { seed: SEED, opts: {} }; state.set(id, s); }
  return s;
}

async function acquire(id, override) {
  const entry = byId.get(id);
  if (!entry) throw new Error('no such object');
  const s = override ?? want(id);
  const key = keyOf(id, s.seed, s.opts);
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const built = await entry.build(s.seed, s.opts);
    if (!built?.root) throw new Error('builder returned nothing');
    built.root.updateMatrixWorld(true);
    built.stats = measure(built.root);
    return built;
  })();
  cache.set(key, p);
  try { return await p; } catch (e) { cache.delete(key); throw e; }
}

/** Triangles, vertices, meshes, materials and metric bounds. */
function measure(root) {
  let tris = 0, verts = 0, meshes = 0;
  const mats = new Set(), geos = new Set();
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    const g = o.geometry;
    if (!g) return;
    meshes++;
    geos.add(g);
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m) mats.add(m);
    const count = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
    const n = o.isInstancedMesh ? o.count : 1;
    if (o.isMesh) tris += (count / 3) * n;
    verts += (g.attributes.position?.count ?? 0) * n;
    if (!g.boundingBox) g.computeBoundingBox();
    box.union(g.boundingBox.clone().applyMatrix4(o.matrixWorld));
  });
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  return { tris: Math.round(tris), verts, meshes, materials: mats.size, geometries: geos.size, size, box };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sidebar
// ─────────────────────────────────────────────────────────────────────────────

const thumbs = new Thumbs(stage, (id) => acquire(id));
const cards = new Map();
let current = null;

const observer = new IntersectionObserver((rows) => {
  for (const r of rows) if (r.isIntersecting) thumbs.prioritise(r.target.dataset.id);
}, { root: $('#list'), rootMargin: '400px' });

function buildSidebar() {
  const list = $('#list');
  list.innerHTML = '';

  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.group)) groups.set(e.group, new Map());
    const fams = groups.get(e.group);
    if (!fams.has(e.family)) fams.set(e.family, []);
    fams.get(e.family).push(e);
  }

  for (const [group, fams] of groups) {
    const count = [...fams.values()].reduce((n, a) => n + a.length, 0);
    const sec = el('section', 'group');
    const h = el('button', 'grouphead');
    h.append(el('span', 'gname', group), el('span', 'gcount', String(count)));
    h.addEventListener('click', () => sec.classList.toggle('collapsed'));
    sec.append(h);

    for (const [family, items] of fams) {
      if (fams.size > 1 || family !== group) sec.append(el('h3', 'fam', family));
      const grid = el('div', 'grid');
      for (const e of items) grid.append(makeCard(e));
      sec.append(grid);
    }
    list.append(sec);
  }

  $('#count').textContent = `${entries.length} objects · ${scanned} modules scanned`;
}

function makeCard(e) {
  const card = el('button', 'card');
  card.dataset.id = e.id;
  card.dataset.search = `${e.group} ${e.family} ${e.label} ${e.sub ?? ''} ${e.file}`.toLowerCase();
  const cv = el('canvas', 'thumb');
  const cap = el('span', 'cap');
  cap.append(el('b', null, e.label));
  if (e.sub) cap.append(el('i', null, e.sub));
  card.append(cv, cap);
  card.addEventListener('click', () => select(e.id));
  cards.set(e.id, card);
  thumbs.add(e.id, cv);
  observer.observe(card);
  return card;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Selection
// ─────────────────────────────────────────────────────────────────────────────

let live = null;   // the built object currently on the stage

async function select(id) {
  const entry = byId.get(id);
  if (!entry) return;
  current = id;
  for (const [cid, c] of cards) c.classList.toggle('on', cid === id);
  cards.get(id)?.scrollIntoView({ block: 'nearest' });

  $('#subject').textContent = entry.label;
  $('#subjectSub').textContent = [entry.family, entry.sub].filter(Boolean).join(' · ');
  $('#subjectFile').textContent = entry.file.replace(/^\//, '');
  $('#call').textContent = entry.call ?? '';

  buildOptionBar(entry);

  $('#stats').innerHTML = '';
  $('#stats').append(el('div', 'wait', 'building…'));

  let built;
  try {
    built = await acquire(id);
  } catch (e) {
    $('#stats').innerHTML = '';
    $('#stats').append(el('div', 'bad', `build failed: ${e.message}`));
    stage.show(null);
    return;
  }
  if (current !== id) return;   // the user clicked on past it

  live = built;
  stage.show(built.root);
  stage.setWireframe($('#wire').checked);
  showStats(entry, built);
  location.hash = encodeURIComponent(id);
}

function showStats(entry, built) {
  const s = built.stats;
  const box = $('#stats');
  box.innerHTML = '';
  const row = (k, v) => {
    const d = el('div', 'stat');
    d.append(el('span', 'k', k), el('span', 'v', v));
    box.append(d);
  };
  row('triangles', s.tris.toLocaleString());
  row('vertices', s.verts.toLocaleString());
  row('meshes', `${s.meshes} · ${s.materials} material${s.materials === 1 ? '' : 's'}`);
  row('size', `${s.size.x.toFixed(2)} × ${s.size.y.toFixed(2)} × ${s.size.z.toFixed(2)} m`);
  row('height', `${s.size.y.toFixed(2)} m`);
  if (entry.seeded) row('seed', String(want(entry.id).seed));
  if (entry.allOptions?.length) {
    // Every option the builder reads, including the ones this page could not
    // work out how to offer. A control nobody can render is still a fact.
    row('options', entry.allOptions.map((o) => o.name + (o.kind === 'unknown' ? '?' : '')).join(', '));
  }
  for (const n of built.notes ?? []) {
    const d = el('div', 'note', n);
    box.append(d);
  }
}

// ── per-object options, all of them discovered ──────────────────────────────

function buildOptionBar(entry) {
  const bar = $('#opts');
  bar.innerHTML = '';
  const s = want(entry.id);

  if (entry.colorways) {
    const sel = el('select');
    const labels = entry.colorways.labels;
    for (let i = 0; i < entry.colorways.count; i++) {
      sel.append(new Option(labels?.[i] ?? `Colourway ${i + 1}`, String(i)));
    }
    sel.value = String(s.opts.colorway ?? 0);
    sel.addEventListener('change', () => {
      s.opts = { ...s.opts, colorway: +sel.value };
      select(entry.id);
    });
    bar.append(labelled(entry.colorways.key, sel));
  }

  // Options read out of the builder itself (see readOptions in registry.js).
  // These are the axes the card did NOT expand over — flags and numbers — so
  // every option a builder accepts is reachable from somewhere.
  for (const o of entry.options ?? []) {
    if (o.kind === 'bool') {
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!s.opts[o.name];
      cb.addEventListener('change', () => {
        s.opts = { ...s.opts, [o.name]: cb.checked };
        select(entry.id);
      });
      bar.append(labelled(o.name, cb));
    } else if (o.kind === 'number') {
      // Range from the builder's own default: a 0..1 factor stays 0..1, and
      // anything larger gets a band either side of what it ships with.
      const unit = o.def <= 1;
      const r = el('input');
      r.type = 'range';
      r.min = '0';
      r.max = String(unit ? 1 : Math.max(2, Math.round(o.def * 2)));
      r.step = unit ? '0.02' : '1';
      r.value = String(s.opts[o.name] ?? o.def);
      const read = el('span', 'val', r.value);
      let timer = null;
      r.addEventListener('input', () => {
        read.textContent = r.value;
        s.opts = { ...s.opts, [o.name]: +r.value };
        clearTimeout(timer);
        timer = setTimeout(() => select(entry.id), 140);   // rebuilds; don't do it per pixel
      });
      const w = labelled(o.name, r);
      w.append(read);
      bar.append(w);
    } else if (o.kind === 'enum' || o.kind === 'index') {
      const sel = el('select');
      const values = o.kind === 'index'
        ? o.labels.map((l, i) => [l, String(i)])
        : o.values.map((v) => [v, v]);
      for (const [label, value] of values) sel.append(new Option(label, value));
      sel.value = String(s.opts[o.name] ?? values[0][1]);
      sel.addEventListener('change', () => {
        s.opts = { ...s.opts, [o.name]: o.kind === 'index' ? +sel.value : sel.value };
        select(entry.id);
      });
      bar.append(labelled(o.name, sel));
    }
  }

  if (entry.poses) {
    const sel = el('select');
    for (const p of entry.poses) sel.append(new Option(p.label, p.key));
    // The entry's own first pose, not the literal 'stand'. `ANIMAL_POSES` does
    // begin with `stand`, so the animals are unaffected; the birds' lists never
    // had it, so their select rendered blank while the card behind it was
    // correctly showing pose[0] — the control disagreeing with the card.
    sel.value = s.opts.pose ?? entry.poses[0].key;
    sel.addEventListener('change', () => {
      s.opts = { ...s.opts, pose: sel.value };
      select(entry.id);
    });
    bar.append(labelled('pose', sel));
  }

  if (entry.palette) {
    // Filled in asynchronously: the palette lives behind the cover kit, which
    // is only built when the first cover object is.
    entry.palette().then(({ all, pair }) => {
      if (current !== entry.id) return;
      const mk = (which, def) => {
        const sel = el('select');
        for (const k of Object.keys(all)) sel.append(new Option(k, k));
        sel.value = s.opts[which] ?? def ?? Object.keys(all)[0];
        sel.addEventListener('change', () => {
          s.opts = { ...s.opts, [which]: sel.value };
          select(entry.id);
        });
        return sel;
      };
      bar.append(labelled('deep', mk('colA', pair?.deep)));
      bar.append(labelled('lit', mk('colB', pair?.lit)));
    }).catch(() => {});
  }

  if (entry.seeded) {
    const b = el('button', 'mini', 'Re-roll ⟳');
    b.title = 'Rebuild with a different seed — every random choice in the builder moves (R)';
    b.addEventListener('click', () => reroll());
    bar.append(b);
  }
}

function labelled(text, node) {
  const w = el('label', 'opt');
  w.append(el('span', null, text), node);
  return w;
}

function reroll() {
  if (!current) return;
  const entry = byId.get(current);
  if (!entry?.seeded) return;
  const s = want(current);
  s.seed = (s.seed * 1664525 + 1013904223) >>> 0;
  select(current);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Controls
// ─────────────────────────────────────────────────────────────────────────────

for (const b of BACKDROPS) {
  const btn = el('button', 'chip', b.label);
  btn.dataset.bg = b.key;
  btn.addEventListener('click', () => {
    stage.setBackdrop(b.key);
    for (const o of document.querySelectorAll('[data-bg]')) o.classList.toggle('on', o === btn);
  });
  $('#backdrops').append(btn);
}
$('[data-bg="studio"]').classList.add('on');

$('#turn').addEventListener('change', (e) => { stage.turntable = e.target.checked; });
stage.onTurntable = (v) => { $('#turn').checked = v; };
$('#grid').addEventListener('change', (e) => stage.setGridVisible(e.target.checked));
$('#figure').addEventListener('change', (e) => stage.setFigureVisible(e.target.checked));
$('#wire').addEventListener('change', (e) => stage.setWireframe(e.target.checked));
$('#sunAz').addEventListener('input', () => sun());
$('#sunEl').addEventListener('input', () => sun());
$('#exposure').addEventListener('input', (e) => stage.setExposure(+e.target.value));
function sun() { stage.setSun(+$('#sunAz').value, +$('#sunEl').value); }
$('#reframe').addEventListener('click', () => stage.frame());

$('#search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  let shown = 0;
  for (const [, card] of cards) {
    const hit = !q || card.dataset.search.includes(q);
    card.style.display = hit ? '' : 'none';
    if (hit) shown++;
  }
  for (const sec of document.querySelectorAll('.group')) {
    sec.style.display = sec.querySelector('.card:not([style*="none"])') ? '' : 'none';
  }
  $('#count').textContent = q
    ? `${shown} of ${entries.length} objects`
    : `${entries.length} objects · ${scanned} modules scanned`;
});

// Step through the gallery without leaving the viewer.
addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const visible = entries.filter((x) => cards.get(x.id)?.style.display !== 'none');
  const i = visible.findIndex((x) => x.id === current);
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); select(visible[Math.min(visible.length - 1, i + 1)]?.id ?? visible[0]?.id); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); select(visible[Math.max(0, i - 1)]?.id ?? visible[0]?.id); }
  else if (e.key === 'r' || e.key === 'R') reroll();
  else if (e.key === ' ') { e.preventDefault(); stage.turntable = !stage.turntable; $('#turn').checked = stage.turntable; }
  else if (e.key === 'f' || e.key === 'F') stage.frame();
});

// ─────────────────────────────────────────────────────────────────────────────
//  "Not shown" — the self-audit
// ─────────────────────────────────────────────────────────────────────────────

function buildNotShown() {
  const hard = notShown.filter((n) => !n.soft);
  const soft = notShown.filter((n) => n.soft);
  $('#missCount').textContent = String(hard.length);
  $('#missBtn').classList.toggle('warn', hard.length > 0);

  const box = $('#missBody');
  box.innerHTML = '';
  box.append(el('p', 'lead',
    'Everything that looks like it makes an object and did not end up on a card. '
    + 'This list is the point: when somebody adds a builder the conventions do not '
    + 'cover, it turns up here instead of quietly going missing.'));

  const table = (title, rows) => {
    if (!rows.length) return;
    box.append(el('h3', null, title));
    const t = el('div', 'miss');
    for (const r of rows) {
      const d = el('div', 'missrow');
      d.append(el('code', null, `${r.file.replace(/^\//, '')} · ${r.name}`));
      d.append(el('span', null, r.why));
      t.append(d);
    }
    box.append(t);
  };
  if (!hard.length) {
    const ok = el('div', 'allclear',
      'Nothing unexplained. Every export that looks like an object producer is '
      + 'either on a card or listed below with a reason.');
    box.append(ok);
  }
  table('Looked like an object producer, was not usable', hard);
  table('Known and deliberate', soft);
}

$('#missBtn').addEventListener('click', () => $('#miss').classList.toggle('open'));
$('#missClose').addEventListener('click', () => $('#miss').classList.remove('open'));

// ─────────────────────────────────────────────────────────────────────────────
//  Loop
// ─────────────────────────────────────────────────────────────────────────────

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // Thumbnails first — they borrow a corner of the canvas, and the stage render
  // below is what the compositor actually sees. `flush` must be the statement
  // immediately before `stage.update`, with nothing awaited between them; see
  // the header of thumbs.js for what happens otherwise.
  if (thumbs.remaining) { thumbs.prepare(); thumbs.flush(); }

  try { live?.update?.(dt, stage.camera); } catch (e) { console.warn('[gallery] update threw', e); }
  stage.update(dt);
  requestAnimationFrame(frame);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Go
// ─────────────────────────────────────────────────────────────────────────────

buildSidebar();
buildNotShown();

// A handle for the console and for anything in tools/ that wants to drive this
// page headlessly, in the same spirit as window.__bakeCached in main.js.
window.__gallery = { entries, notShown, byId, stage, thumbs, cache, state, select, acquire };
thumbs.onProgress = (done, total) => {
  const bar = $('#progress');
  bar.style.width = `${(done / total) * 100}%`;
  bar.parentElement.classList.toggle('done', done >= total);
};
sun();
requestAnimationFrame(frame);

const initial = decodeURIComponent(location.hash.slice(1));
select(byId.has(initial) ? initial : entries[0]?.id);
