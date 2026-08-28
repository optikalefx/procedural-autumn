#!/usr/bin/env node
/**
 * Screenshot any page on this worktree's dev server (5199) with playwright.
 *
 *   node tools/_scratch/_jshot.mjs --url /tools/_scratch/_journalfont.html --out /tmp/f.png
 *
 * Deliberately NOT tools/shot.mjs: that boots the game and waits on a world
 * bake, which a font specimen and the journal overlay have no use for. It also
 * takes the cross-checkout capture lock; this does not touch the GPU-heavy
 * path, so it stays out of the way of anyone measuring.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const flag = (k) => argv.includes(`--${k}`);

const base = arg('base', 'http://127.0.0.1:5199');
const url = arg('url', '/');
const out = arg('out', '/tmp/_jshot.png');
const w = +arg('w', 1600), h = +arg('h', 900);
const dpr = +arg('dpr', 1);
const waitMs = +arg('wait', 900);
const waitFor = arg('waitfor', null);      // JS expression polled until truthy
const evalJs = arg('eval', null);          // run after --waitfor, before the wait
const full = flag('full');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(base + url, { waitUntil: 'load', timeout: 90_000 });
if (waitFor) await page.waitForFunction(waitFor, null, { timeout: 90_000 });
if (evalJs) await page.evaluate(evalJs);
await page.waitForTimeout(waitMs);

mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out, fullPage: full });
console.log('wrote', out);
await browser.close();
