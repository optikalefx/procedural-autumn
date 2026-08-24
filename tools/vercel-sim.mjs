#!/usr/bin/env node
/**
 * Serve dist/ the way Vercel will — applying vercel.json's `headers` rules.
 *
 * The production bake path cannot be exercised any other way locally: the
 * bakes in dist/ are brotli bytes that only decode because vercel.json sets
 * `Content-Encoding: br`, and neither `vite preview` nor the dev server reads
 * vercel.json. Without this, a compression mistake is only visible after a
 * deploy. (Under `vite preview` the bakes fail their magic check and the game
 * falls back to a live bake — correct, but not what production does.)
 *
 *   npm run build && node tools/vercel-sim.mjs        # http://127.0.0.1:5224
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || 'dist');
const PORT = +(process.argv[3] || 5224);
const CFG = JSON.parse(await readFile(resolve('vercel.json'), 'utf8'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.map': 'application/json' };

const rules = (CFG.headers || []).map((h) => ({ re: new RegExp(`^${h.source}$`), headers: h.headers }));

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  let file = join(ROOT, path);
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); }
  catch { file = join(ROOT, 'index.html'); }          // SPA fallback, as Vercel does
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404).end('not found'); return; }

  const h = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' };
  for (const r of rules) if (r.re.test(path)) for (const { key, value } of r.headers) h[key] = value;
  res.writeHead(200, h);
  res.end(body);
}).listen(PORT, '127.0.0.1', () => console.log(`vercel-sim: ${ROOT} on http://127.0.0.1:${PORT}`));
