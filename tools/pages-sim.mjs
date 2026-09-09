#!/usr/bin/env node
/**
 * Serve dist/ the way Cloudflare Pages will — applying public/_headers.
 *
 * The production bake path cannot be exercised any other way locally: the
 * bakes in dist/ are brotli bytes that only decode because `_headers` sets
 * `Content-Encoding: br`, and neither `vite preview` nor the dev server reads
 * `_headers`. Without this, a compression mistake is only visible after a
 * deploy. (Under `vite preview` the bakes fail their magic check and the game
 * falls back to a live bake — correct, but not what production does.)
 *
 *   npm run build && node tools/pages-sim.mjs        # http://127.0.0.1:5224
 *
 * It reads dist/_headers, not public/_headers, so it tests the file that
 * actually shipped — Vite copies public/ verbatim, and a build that failed to
 * copy it should fail here too rather than be papered over from source.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || 'dist');
const PORT = +(process.argv[3] || 5224);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.map': 'application/json' };

// Cloudflare's _headers: an unindented path pattern, then indented `Key: Value`
// lines until the next pattern. `*` matches any run of characters; `:name`
// placeholders are not used here and are matched the same way.
const rules = [];
let cur = null;
for (const raw of (await readFile(join(ROOT, '_headers'), 'utf8')).split('\n')) {
  const line = raw.trimEnd();
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  if (!/^\s/.test(line)) {
    const re = new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    cur = { re, headers: [] };
    rules.push(cur);
  } else if (cur) {
    const i = line.indexOf(':');
    if (i > 0) cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
}

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  let file = join(ROOT, path);
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); }
  catch { file = join(ROOT, 'index.html'); }          // SPA fallback, as Pages does
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404).end('not found'); return; }

  const h = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' };
  for (const r of rules) if (r.re.test(path)) for (const [k, v] of r.headers) h[k] = v;
  res.writeHead(200, h);
  res.end(body);
}).listen(PORT, '127.0.0.1', () => console.log(`pages-sim: ${ROOT} on http://127.0.0.1:${PORT}`));
